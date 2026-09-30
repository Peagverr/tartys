// Клиент онлайн-комнаты: держит соединение, переподключается, собирает из
// снимков сервера зеркальное состояние матча для отрисовки.

import { createMatch, type Command, type GameEvent, type MatchState, type Side } from '../engine/match';
import { DT, ticks } from '../engine/rules';
import { auth } from './api';
import type { ClientMsg, LobbyInfo, OverInfo, Role, ServerMsg, Snap } from './protocol';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RoomHandlers {
  onWelcome(role: Role, side: Side | null, note?: string): void;
  onLobby(room: LobbyInfo): void;
  onEvent(e: GameEvent, s: MatchState): void;
  onOver(info: OverInfo): void;
  onStatus(status: ConnStatus, message?: string): void;
}

/** id вкладки: одинаковый после перезагрузки (для переподключения), разный в разных вкладках. */
function tabId(): string {
  const KEY = 'tartys.cid';
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const SNAP_INTERVAL_MS = 50;

export class RoomClient {
  readonly cid = tabId();
  state: MatchState;
  prevRope = 0;
  lobby: LobbyInfo | null = null;
  snap: Snap | null = null;
  role: Role;
  side: Side | null = null;
  rtt = 0;
  paused = false;
  private ws: WebSocket | null = null;
  private snapAt = 0;
  private closed = false;
  private attempts = 0;
  private pingTimer = 0;

  constructor(
    readonly code: string,
    role: Role,
    private readonly name: string,
    private readonly h: RoomHandlers,
  ) {
    this.role = role;
    this.state = createMatch({ countdownSec: 0 });
    this.connect();
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.code}`);
    this.ws = ws;
    this.h.onStatus(this.attempts ? 'reconnecting' : 'connecting');
    ws.onopen = () => {
      this.attempts = 0;
      const hello: ClientMsg = { t: 'hello', cid: this.cid, name: this.name, role: this.role, token: auth.token ?? undefined };
      ws.send(JSON.stringify(hello));
      this.h.onStatus('open');
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed || e.code === 4404 || e.code === 4000) {
        this.h.onStatus('closed', e.code === 4404 ? 'Комната не найдена или устарела' : e.code === 4000 ? 'Комната открыта в другой вкладке' : undefined);
        return;
      }
      // Переподключаемся с нарастающей паузой; сервер держит место 15 секунд.
      this.attempts++;
      if (this.attempts > 12) {
        this.h.onStatus('closed', 'Не удаётся подключиться к комнате');
        return;
      }
      this.h.onStatus('reconnecting');
      window.setTimeout(() => !this.closed && this.connect(), Math.min(4000, 400 * this.attempts));
    };
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.role = msg.role;
        this.side = msg.side;
        this.h.onWelcome(msg.role, msg.side, msg.note);
        break;
      case 'lobby':
        this.lobby = msg.room;
        this.h.onLobby(msg.room);
        break;
      case 'snap':
        this.applySnap(msg.s);
        break;
      case 'over':
        this.h.onOver(msg.info);
        break;
      case 'pong':
        this.rtt = performance.now() - msg.ts;
        break;
      case 'error':
        this.h.onStatus('closed', msg.message);
        break;
    }
  }

  private applySnap(sn: Snap): void {
    const s = this.state;
    const fresh = sn.tick < s.tick || (s.phase === 'over' && sn.ph !== 'over');
    if (fresh) {
      // Новый матч (реванш): начисто.
      const matchSec = this.lobby?.matchSec ?? 60;
      this.state = createMatch({ countdownSec: 0, matchSec });
    }
    const st = this.state;
    this.prevRope = fresh ? sn.rope : st.rope;
    st.phase = sn.ph;
    st.tick = sn.tick;
    st.countdownTicks = sn.cd;
    st.timeLeftTicks = sn.tl ?? Infinity;
    st.opts.matchSec = this.lobby?.matchSec ?? st.opts.matchSec;
    st.rope = sn.rope;
    sn.f.forEach((f, i) => {
      const F = st.fighters[i];
      F.stamina = f.st;
      F.braceHeld = f.bh;
      F.brace = f.br;
      F.action = f.a;
      F.yankPower = f.yp;
      F.yankSync = f.ys;
    });
    this.snap = sn;
    this.snapAt = performance.now();
    for (const e of sn.ev) {
      if (e.type === 'over') st.result = { winner: e.winner, reason: e.reason, durationSec: sn.tick * DT, rope: sn.rope };
      if (e.type === 'start') st.lastCount = 0;
      this.h.onEvent(e, st);
    }
    if (st.phase !== 'over') st.result = null;
    st.finalAnnounced = st.timeLeftTicks <= ticks(15);
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Та же точка входа, что у локального Runner: команду получает сервер. */
  command(cmd: Command): void {
    if (cmd.kind === 'yank') this.send({ t: 'cmd', kind: 'yank' });
    else this.send({ t: 'cmd', kind: 'brace', on: cmd.on });
  }

  ready(on: boolean): void {
    this.send({ t: 'ready', on });
  }

  chooseSide(side: Side): void {
    this.send({ t: 'side', side });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  /** Доля между снимками — для плавного движения каната. */
  advance(_dt: number): number {
    return Math.min(1, (performance.now() - this.snapAt) / SNAP_INTERVAL_MS);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close(1000);
    this.ws = null;
  }
}
