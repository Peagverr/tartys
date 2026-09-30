// HTTP API: аккаунты, история, рейтинг, тестовые покупки, создание комнат.

import type { FighterStats } from '../src/engine/match';
import {
  ARENAS,
  FREE_ARENAS,
  FREE_CROWD_PER_SIDE,
  FREE_SKINS,
  PLANS,
  PRO_CROWD_PER_SIDE,
  SKINS,
  type Branding,
  type HistoryItem,
  type LeaderRow,
  type Plan,
  type RoomConfig,
  type RoomMode,
} from '../src/net/protocol';
import { ensureSchema, hashPassword, publicUser, randomHex, recordMatch, safeEqual, userByToken, type Env, type UserRow } from './db';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const NAME_RE = /^[\p{L}\p{N}_\- ]{2,20}$/u;

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

async function body<T>(req: Request): Promise<Partial<T>> {
  if (Number(req.headers.get('content-length') ?? 0) > 16_000) return {};
  try {
    const data = await req.json();
    return data && typeof data === 'object' ? (data as Partial<T>) : {};
  } catch {
    return {};
  }
}

const cleanName = (s: unknown) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');

async function newSession(env: Env, userId: string): Promise<string> {
  const token = randomHex(24);
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').bind(token, userId, Date.now()).run();
  return token;
}

const STAT_KEYS: (keyof FighterStats)[] = ['yanks', 'landed', 'blockedByOpp', 'blocks', 'punishes', 'partial', 'clashes', 'exhaustions'];
function cleanStats(x: unknown): FighterStats | null {
  if (!x || typeof x !== 'object') return null;
  const out = {} as FighterStats;
  for (const k of STAT_KEYS) {
    const v = (x as Record<string, unknown>)[k] ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) return null;
    out[k] = Math.round(v);
  }
  return out;
}

function roomCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

export async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  await ensureSchema(env.DB);
  const method = req.method;

  if (path === '/api/register' && method === 'POST') {
    const b = await body<{ name: string; password: string }>(req);
    const name = cleanName(b.name);
    const password = typeof b.password === 'string' ? b.password : '';
    if (!NAME_RE.test(name)) return fail('Имя: 2–20 символов — буквы, цифры, пробел, _ или -');
    if (password.length < 4 || password.length > 100) return fail('Пароль: от 4 символов');
    const key = name.toLowerCase();
    const exists = await env.DB.prepare('SELECT 1 FROM users WHERE name_key = ?').bind(key).first();
    if (exists) return fail('Это имя уже занято', 409);
    const id = crypto.randomUUID();
    const salt = randomHex(16);
    const pass = await hashPassword(password, salt);
    await env.DB.prepare('INSERT INTO users (id, name, name_key, pass, salt, created) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, name, key, pass, salt, Date.now())
      .run();
    const user = (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>())!;
    return json({ token: await newSession(env, id), user: publicUser(user) });
  }

  if (path === '/api/login' && method === 'POST') {
    const b = await body<{ name: string; password: string }>(req);
    const key = cleanName(b.name).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    const user = await env.DB.prepare('SELECT * FROM users WHERE name_key = ?').bind(key).first<UserRow>();
    if (!user || !safeEqual(await hashPassword(password, user.salt), user.pass)) return fail('Неверное имя или пароль', 401);
    return json({ token: await newSession(env, user.id), user: publicUser(user) });
  }

  if (path === '/api/leaderboard' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT name, rating, wins, losses, pro_player FROM users WHERE wins + losses > 0 ORDER BY rating DESC LIMIT 20',
    ).all<{ name: string; rating: number; wins: number; losses: number; pro_player: number }>();
    const leaders: LeaderRow[] = rows.results.map((r) => ({ name: r.name, rating: r.rating, wins: r.wins, losses: r.losses, pro: !!r.pro_player }));
    return json({ leaders });
  }

  const user = await userByToken(env.DB, bearer(req));

  if (path === '/api/rooms' && method === 'POST') {
    const b = await body<{ mode: RoomMode; branding: Branding; matchSec: number }>(req);
    const mode: RoomMode = b.mode === 'crowd' ? 'crowd' : 'duel';
    const org = !!user?.pro_org;
    let branding: Branding | null = null;
    if (mode === 'crowd' && org && b.branding && typeof b.branding === 'object') {
      const t = cleanName(b.branding.title).slice(0, 40);
      const teams = Array.isArray(b.branding.teams) ? b.branding.teams.map((x) => cleanName(x).slice(0, 24)) : [];
      branding = { title: t, teams: [teams[0] || 'Синие', teams[1] || 'Красные'] };
    }
    const matchSec = [45, 60, 90].includes(Number(b.matchSec)) ? Number(b.matchSec) : 60;
    const cfg: RoomConfig = {
      mode,
      branding,
      maxPerSide: mode === 'duel' ? 1 : org ? PRO_CROWD_PER_SIDE : FREE_CROWD_PER_SIDE,
      matchSec,
      createdAt: Date.now(),
    };
    const code = roomCode();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    await stub.fetch(`https://room/init?code=${code}`, { method: 'POST', body: JSON.stringify(cfg) });
    return json({ code, config: cfg });
  }

  if (!user) return fail('Нужно войти в аккаунт', 401);

  if (path === '/api/me' && method === 'GET') {
    return json({ user: publicUser(user), wins: user.wins, losses: user.losses });
  }

  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(bearer(req)).run();
    return json({ ok: true });
  }

  if (path === '/api/history' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM matches WHERE user_id = ? ORDER BY at DESC LIMIT 50').bind(user.id).all<{
      at: number;
      mode: HistoryItem['mode'];
      opponent: string;
      outcome: HistoryItem['outcome'];
      reason: string;
      duration: number;
      stats: string;
      verified: number;
      rating_delta: number | null;
    }>();
    const items: HistoryItem[] = rows.results.map((r) => ({
      at: r.at,
      mode: r.mode,
      opponent: r.opponent,
      outcome: r.outcome,
      reason: r.reason,
      duration: r.duration,
      verified: !!r.verified,
      ratingDelta: r.rating_delta,
      stats: JSON.parse(r.stats) as FighterStats,
    }));
    return json({ items });
  }

  // Матчи против бота и вдвоём на одном экране идут в браузере — сервер их
  // только сохраняет (в истории помечены как «не проверено сервером»).
  if (path === '/api/history' && method === 'POST') {
    const b = await body<{ mode: string; opponent: string; outcome: string; reason: string; duration: number; stats: unknown }>(req);
    const mode = b.mode === 'local' ? 'local' : 'bot';
    const outcome = b.outcome === 'win' || b.outcome === 'loss' ? b.outcome : 'draw';
    const reason = b.reason === 'line' ? 'line' : 'time';
    const duration = Number(b.duration);
    const stats = cleanStats(b.stats);
    if (!stats || !Number.isFinite(duration) || duration < 0 || duration > 200) return fail('Некорректные данные матча');
    await recordMatch(env.DB, {
      userId: user.id,
      mode,
      opponent: cleanName(b.opponent) || 'Бот',
      outcome,
      reason,
      duration,
      stats,
      verified: false,
      ratingDelta: null,
    });
    return json({ ok: true });
  }

  if (path === '/api/profile' && method === 'POST') {
    const b = await body<{ skin: string; arena: string }>(req);
    const skin = SKINS.includes(b.skin as (typeof SKINS)[number]) ? b.skin! : user.skin;
    const arena = ARENAS.includes(b.arena as (typeof ARENAS)[number]) ? b.arena! : user.arena;
    // Косметика Pro — только для владельцев Pro. На силу в матче не влияет.
    if (!user.pro_player && (!FREE_SKINS.includes(skin) || !FREE_ARENAS.includes(arena))) return fail('Нужен Тартыс Pro', 403);
    await env.DB.prepare('UPDATE users SET skin = ?, arena = ? WHERE id = ?').bind(skin, arena, user.id).run();
    return json({ user: publicUser({ ...user, skin, arena }) });
  }

  // Тестовая оплата: деньги не списываются, план включается сразу.
  if (path === '/api/checkout/test' && method === 'POST') {
    const b = await body<{ plan: Plan }>(req);
    const plan: Plan | null = b.plan === 'player' || b.plan === 'organizer' ? b.plan : null;
    if (!plan) return fail('Неизвестный план');
    const col = plan === 'player' ? 'pro_player' : 'pro_org';
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET ${col} = 1 WHERE id = ?`).bind(user.id),
      env.DB.prepare('INSERT INTO purchases (user_id, plan, amount, test, at) VALUES (?, ?, ?, 1, ?)').bind(user.id, plan, PLANS[plan].price, Date.now()),
    ]);
    const fresh = (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<UserRow>())!;
    return json({ user: publicUser(fresh), receipt: { plan, amount: PLANS[plan].price, test: true, at: Date.now() } });
  }

  return fail('Не найдено', 404);
}
