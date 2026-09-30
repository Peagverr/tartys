// Комната онлайн-матча. Сервер — единственный источник правды: он сам крутит
// движок, принимает от игроков только намерения («рывок», «упор») и решает,
// допустимы ли они. Итог матча клиент подделать не может.

import { DurableObject } from 'cloudflare:workers';
import { createMatch, forfeit, other, sendCommand, stepMatch, type GameEvent, type MatchState, type Side } from '../src/engine/match';
import { TICK_HZ } from '../src/engine/rules';
import { TeamInput } from '../src/engine/team';
import type { ClientMsg, LobbyInfo, LobbyPlayer, OverInfo, RatingChange, Role, RoomConfig, ServerMsg, Snap } from '../src/net/protocol';
import { recordMatch, userByToken, type Env } from './db';

const TICK_MS = 1000 / TICK_HZ;
/** Сколько ждём отключившегося, прежде чем засчитать техническое поражение. */
const RECONNECT_MS = 15_000;
const SNAP_EVERY_TICKS = 3;
const MAX_MSGS_PER_SEC = 40;

interface Client {
  ws: WebSocket;
  id: string;
  role: Role;
  hello: boolean;
  windowStart: number;
  count: number;
}

interface Player {
  id: string;
  name: string;
  side: Side;
  connected: boolean;
  ready: boolean;
  userId: string | null;
  pro: boolean;
  rating: number | null;
}

const cleanName = (s: unknown) =>
  (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 20);

export class Room extends DurableObject<Env> {
  private cfg: RoomConfig | null = null;
  private code = '';
  private clients = new Set<Client>();
  private players = new Map<string, Player>();
  private stage: LobbyInfo['stage'] = 'lobby';
  private match: MatchState | null = null;
  private teams: [TeamInput, TeamInput] = [new TeamInput(0), new TeamInput(1)];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAt = 0;
  private acc = 0;
  private sinceSnap = 0;
  private events: GameEvent[] = [];
  private waitUntil = 0;
  private waitSide: Side | null = null;
  private lastLobbyAt = 0;
  private readonly loaded: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.cfg = (await ctx.storage.get<RoomConfig>('cfg')) ?? null;
      this.code = (await ctx.storage.get<string>('code')) ?? '';
    });
  }

  async fetch(req: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(req.url);
    if (url.pathname === '/init' && req.method === 'POST') {
      this.cfg = (await req.json()) as RoomConfig;
      this.code = url.searchParams.get('code') ?? '';
      await this.ctx.storage.put({ cfg: this.cfg, code: this.code });
      return new Response('ok');
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Ожидается WebSocket', { status: 426 });

    const pair = new WebSocketPair();
    const [clientSide, ws] = [pair[0], pair[1]];
    ws.accept();
    const client: Client = { ws, id: '', role: 'player', hello: false, windowStart: Date.now(), count: 0 };
    this.clients.add(client);
    if (!this.cfg) {
      this.send(client, { t: 'error', message: 'Комната не найдена или устарела' });
      ws.close(4404, 'not found');
    }
    ws.addEventListener('message', (e) => void this.onMessage(client, e.data));
    ws.addEventListener('close', () => this.onClose(client));
    ws.addEventListener('error', () => this.onClose(client));
    setTimeout(() => {
      if (!client.hello) ws.close(4400, 'no hello');
    }, 5000);
    return new Response(null, { status: 101, webSocket: clientSide });
  }

  // ---------- Сообщения ----------

  private send(c: Client, msg: ServerMsg): void {
    try {
      c.ws.send(JSON.stringify(msg));
    } catch {
      /* соединение уже закрыто */
    }
  }

  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (!c.hello) continue;
      try {
        c.ws.send(data);
      } catch {
        /* закрыто */
      }
    }
  }

  private async onMessage(c: Client, raw: unknown): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 600) return;
    // Ограничение частоты: лишние сообщения отбрасываются, флуд — отключается.
    const now = Date.now();
    if (now - c.windowStart > 1000) {
      c.windowStart = now;
      c.count = 0;
    }
    if (++c.count > MAX_MSGS_PER_SEC) {
      if (c.count > MAX_MSGS_PER_SEC * 3) c.ws.close(4429, 'flood');
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      if (!c.hello) await this.onHello(c, msg);
      return;
    }
    if (!c.hello) return;
    const p = c.role === 'player' ? this.players.get(c.id) : undefined;

    switch (msg.t) {
      case 'ping':
        this.send(c, { t: 'pong', ts: Number(msg.ts) || 0 });
        break;
      case 'cmd': {
        const m = this.match;
        if (!p || !p.connected || this.stage !== 'match' || !m || m.phase !== 'live') return;
        if (msg.kind === 'yank') this.teams[p.side].yank(p.id, m.tick, m.fighters[p.side]);
        else if (msg.kind === 'brace') this.teams[p.side].brace(p.id, msg.on === true);
        break;
      }
      case 'ready':
        if (!p || this.stage !== 'lobby' || this.cfg?.mode !== 'duel') return;
        p.ready = msg.on === true;
        this.broadcastLobby();
        this.maybeStartDuel();
        break;
      case 'side': {
        if (!p || this.stage !== 'lobby' || this.cfg?.mode !== 'crowd') return;
        const side = msg.side === 1 ? 1 : 0;
        if (side !== p.side && this.countSide(side) < this.cfg.maxPerSide) {
          p.side = side;
          this.broadcastLobby();
        }
        break;
      }
      case 'start': {
        if (this.stage !== 'lobby' || this.cfg?.mode !== 'crowd') return;
        const screens = [...this.clients].some((x) => x.hello && x.role === 'screen');
        if (c.role !== 'screen' && screens) return;
        if (this.countSide(0) > 0 && this.countSide(1) > 0) this.startMatch();
        break;
      }
    }
  }

  private async onHello(c: Client, msg: Extract<ClientMsg, { t: 'hello' }>): Promise<void> {
    if (!this.cfg) return;
    const cid = typeof msg.cid === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(msg.cid) ? msg.cid : crypto.randomUUID();
    const user = typeof msg.token === 'string' ? await userByToken(this.env.DB, msg.token).catch(() => null) : null;
    c.id = cid;
    c.role = msg.role === 'screen' ? 'screen' : 'player';
    c.hello = true;
    let note: string | undefined;

    if (c.role === 'player') {
      // Та же вкладка переподключилась — старое соединение закрываем.
      for (const other of this.clients) {
        if (other !== c && other.id === cid && other.role === 'player') {
          this.clients.delete(other);
          try {
            other.ws.close(4000, 'replaced');
          } catch {
            /* уже закрыто */
          }
        }
      }
      let p = this.players.get(cid);
      if (!p) {
        const side = this.pickSide();
        if (side === null) {
          c.role = 'screen';
          note = 'Комната заполнена — ты смотришь матч как зритель.';
        } else {
          p = {
            id: cid,
            name: user?.name ?? (cleanName(msg.name) || 'Игрок'),
            side,
            connected: true,
            ready: false,
            userId: user?.id ?? null,
            pro: !!user?.pro_player,
            rating: user?.rating ?? null,
          };
          this.players.set(cid, p);
        }
      }
      if (p) {
        p.connected = true;
        if (user) {
          p.userId = user.id;
          p.name = user.name;
          p.pro = !!user.pro_player;
          p.rating = user.rating;
        }
        this.syncTeams();
        if (this.stage === 'paused' && this.waitSide !== null && this.countConnected(this.waitSide) > 0) this.resume();
      }
    }

    const p = this.players.get(cid);
    this.send(c, { t: 'welcome', you: cid, role: c.role, side: c.role === 'player' && p ? p.side : null, note });
    this.broadcastLobby();
    if (this.match && this.stage !== 'lobby') this.send(c, { t: 'snap', s: this.snap(false) });
  }

  private onClose(c: Client): void {
    if (!this.clients.delete(c) || !c.hello) return;
    if (c.role === 'player') {
      const p = this.players.get(c.id);
      const stillHere = [...this.clients].some((x) => x.id === c.id && x.role === 'player');
      if (p && !stillHere) {
        p.connected = false;
        p.ready = false;
        if (this.stage === 'lobby') this.players.delete(p.id);
        else {
          this.syncTeams();
          if (this.stage === 'match' && this.countConnected(p.side) === 0) this.pause(p.side);
        }
      }
    }
    if (this.clients.size === 0) this.shutdown();
    else this.broadcastLobby();
  }

  // ---------- Состав ----------

  private countSide(side: Side): number {
    let n = 0;
    for (const p of this.players.values()) if (p.side === side) n++;
    return n;
  }

  private countConnected(side: Side): number {
    let n = 0;
    for (const p of this.players.values()) if (p.side === side && p.connected) n++;
    return n;
  }

  private pickSide(): Side | null {
    const max = this.cfg!.maxPerSide;
    const [a, b] = [this.countSide(0), this.countSide(1)];
    if (a >= max && b >= max) return null;
    if (a >= max) return 1;
    if (b >= max) return 0;
    return a <= b ? 0 : 1;
  }

  private syncTeams(): void {
    for (const side of [0, 1] as const) {
      const ids = [...this.players.values()].filter((p) => p.side === side && p.connected).map((p) => p.id);
      this.teams[side].setMembers(ids);
    }
  }

  private lobbyInfo(): LobbyInfo {
    const players: LobbyPlayer[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      side: p.side,
      connected: p.connected,
      ready: p.ready,
      pro: p.pro,
      rating: p.rating,
    }));
    return {
      code: this.code,
      mode: this.cfg!.mode,
      stage: this.stage,
      players,
      screens: [...this.clients].filter((c) => c.hello && c.role === 'screen').length,
      branding: this.cfg!.branding,
      maxPerSide: this.cfg!.maxPerSide,
      matchSec: this.cfg!.matchSec,
      waitMs: this.stage === 'paused' ? Math.max(0, this.waitUntil - Date.now()) : 0,
      waitSide: this.stage === 'paused' ? this.waitSide : null,
    };
  }

  private broadcastLobby(): void {
    if (!this.cfg) return;
    this.lastLobbyAt = Date.now();
    this.broadcast({ t: 'lobby', room: this.lobbyInfo() });
  }

  // ---------- Матч ----------

  private maybeStartDuel(): void {
    const ps = [...this.players.values()].filter((p) => p.connected);
    const ready = (side: Side) => ps.some((p) => p.side === side && p.ready);
    if (ready(0) && ready(1)) this.startMatch();
  }

  private startMatch(): void {
    this.match = createMatch({ matchSec: this.cfg!.matchSec });
    for (const t of this.teams) t.reset();
    this.syncTeams();
    for (const p of this.players.values()) p.ready = false;
    this.stage = 'match';
    this.events = [];
    this.lastAt = Date.now();
    this.acc = 0;
    this.sinceSnap = 0;
    this.timer ??= setInterval(() => this.loop(), TICK_MS);
    this.broadcastLobby();
    this.broadcast({ t: 'snap', s: this.snap() });
  }

  private pause(side: Side): void {
    this.stage = 'paused';
    this.waitSide = side;
    this.waitUntil = Date.now() + RECONNECT_MS;
    for (const t of this.teams) t.reset();
    this.syncTeams();
  }

  private resume(): void {
    this.stage = 'match';
    this.waitSide = null;
    this.lastAt = Date.now();
    this.acc = 0;
  }

  private loop(): void {
    const m = this.match;
    const now = Date.now();
    if (!m) return;
    if (this.stage === 'paused') {
      if (now >= this.waitUntil && this.waitSide !== null) {
        forfeit(m, other(this.waitSide));
        this.events.push(...m.events);
        this.broadcast({ t: 'snap', s: this.snap() });
        this.finish();
      } else if (now - this.lastLobbyAt > 1000) this.broadcastLobby();
      return;
    }
    if (this.stage !== 'match') return;
    this.acc += Math.min(250, now - this.lastAt);
    this.lastAt = now;
    while (this.acc >= TICK_MS && m.phase !== 'over') {
      for (const t of this.teams) for (const cmd of t.update(m.tick)) sendCommand(m, cmd);
      stepMatch(m);
      this.events.push(...m.events);
      this.acc -= TICK_MS;
      this.sinceSnap++;
    }
    if (this.sinceSnap >= SNAP_EVERY_TICKS || m.phase === 'over') {
      this.sinceSnap = 0;
      this.broadcast({ t: 'snap', s: this.snap() });
    }
    if (m.phase === 'over') this.finish();
  }

  private snap(takeEvents = true): Snap {
    const m = this.match!;
    const r = (x: number, k = 10) => Math.round(x * k) / k;
    return {
      ph: m.phase,
      tick: m.tick,
      cd: m.countdownTicks,
      tl: Number.isFinite(m.timeLeftTicks) ? m.timeLeftTicks : null,
      rope: r(m.rope, 100),
      f: [0, 1].map((i) => {
        const f = m.fighters[i];
        return { st: r(f.stamina), bh: f.braceHeld, br: r(f.brace, 100), a: f.action, yp: r(f.yankPower, 100), ys: f.yankSync };
      }) as Snap['f'],
      share: [r(this.teams[0].share, 100), r(this.teams[1].share, 100)],
      n: [this.teams[0].size, this.teams[1].size],
      ev: takeEvents ? this.events.splice(0) : [],
    };
  }

  private finish(): void {
    const m = this.match!;
    const result = m.result!;
    const ratings = this.saveResults(m);
    const info: OverInfo = { result, stats: [{ ...m.fighters[0].stats }, { ...m.fighters[1].stats }], ratings };
    this.stage = 'lobby';
    this.waitSide = null;
    for (const t of this.teams) t.reset();
    for (const p of [...this.players.values()]) {
      p.ready = false;
      if (!p.connected) this.players.delete(p.id);
    }
    this.stopTimer();
    this.broadcast({ t: 'over', info });
    this.broadcastLobby();
  }

  /** Записывает итог в историю игроков с аккаунтом; в дуэли — меняет рейтинг (Эло). */
  private saveResults(m: MatchState): RatingChange[] {
    const res = m.result!;
    const ps = [...this.players.values()];
    const changes: RatingChange[] = [];
    const deltas = new Map<string, number>();
    const mode = this.cfg!.mode;

    if (mode === 'duel') {
      const a = ps.find((p) => p.side === 0);
      const b = ps.find((p) => p.side === 1);
      if (a?.userId && b?.userId && a.userId !== b.userId && a.rating !== null && b.rating !== null) {
        const expA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
        const scoreA = res.winner === 0 ? 1 : res.winner === 1 ? 0 : 0.5;
        const dA = Math.round(32 * (scoreA - expA));
        for (const [p, d] of [
          [a, dA],
          [b, -dA],
        ] as const) {
          changes.push({ id: p.id, name: p.name, before: p.rating!, after: p.rating! + d });
          deltas.set(p.id, d);
          p.rating = p.rating! + d;
        }
      }
    }

    const db = this.env.DB;
    const jobs: Promise<unknown>[] = [];
    for (const p of ps) {
      if (!p.userId) continue;
      const outcome = res.winner === null ? 'draw' : res.winner === p.side ? 'win' : 'loss';
      const opp = mode === 'duel' ? (ps.find((x) => x.side !== p.side)?.name ?? 'Соперник') : this.cfg!.branding?.teams[other(p.side)] ?? 'Команда соперника';
      const d = deltas.get(p.id) ?? null;
      jobs.push(
        recordMatch(db, {
          userId: p.userId,
          mode: mode === 'duel' ? 'online' : 'crowd',
          opponent: opp,
          outcome,
          reason: res.reason,
          duration: res.durationSec,
          stats: m.fighters[p.side].stats,
          verified: true,
          ratingDelta: d,
        }),
      );
      if (d !== null) {
        jobs.push(
          db
            .prepare('UPDATE users SET rating = rating + ?, wins = wins + ?, losses = losses + ? WHERE id = ?')
            .bind(d, outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, p.userId)
            .run(),
        );
      }
    }
    this.ctx.waitUntil(Promise.allSettled(jobs));
    return changes;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private shutdown(): void {
    this.stopTimer();
    this.stage = 'lobby';
    this.match = null;
    this.players.clear();
    for (const t of this.teams) t.reset();
  }
}
