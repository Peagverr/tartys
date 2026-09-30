// D1: пользователи, сессии, история матчей, тестовые покупки.

import type { FighterStats } from '../src/engine/match';
import type { HistoryItem, PublicUser } from '../src/net/protocol';

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  DB: D1Database;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    pass TEXT NOT NULL, salt TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
    pro_player INTEGER NOT NULL DEFAULT 0, pro_org INTEGER NOT NULL DEFAULT 0,
    skin TEXT NOT NULL DEFAULT 'classic', arena TEXT NOT NULL DEFAULT 'steppe', created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, at INTEGER NOT NULL, mode TEXT NOT NULL,
    opponent TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, duration REAL NOT NULL,
    stats TEXT NOT NULL, verified INTEGER NOT NULL, rating_delta INTEGER)`,
  `CREATE INDEX IF NOT EXISTS matches_user ON matches(user_id, at DESC)`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, plan TEXT NOT NULL,
    amount INTEGER NOT NULL, test INTEGER NOT NULL, at INTEGER NOT NULL)`,
];

let schemaReady: Promise<unknown> | null = null;
export function ensureSchema(db: D1Database): Promise<unknown> {
  schemaReady ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

export interface UserRow {
  id: string;
  name: string;
  pass: string;
  salt: string;
  rating: number;
  wins: number;
  losses: number;
  pro_player: number;
  pro_org: number;
  skin: string;
  arena: string;
}

export function publicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    name: u.name,
    rating: u.rating,
    pro: { player: !!u.pro_player, organizer: !!u.pro_org },
    skin: u.skin,
    arena: u.arena,
  };
}

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// На бесплатном тарифе Workers мало процессорного времени на запрос, поэтому
// итераций меньше, чем рекомендуют для боевых систем (см. «Известные ограничения»).
const PBKDF2_ITERATIONS = 20000;

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toHex(bits);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function userByToken(db: D1Database, token: string | null): Promise<UserRow | null> {
  if (!token || token.length > 128) return null;
  await ensureSchema(db);
  return db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .bind(token)
    .first<UserRow>();
}

export async function recordMatch(
  db: D1Database,
  row: {
    userId: string;
    mode: HistoryItem['mode'];
    opponent: string;
    outcome: HistoryItem['outcome'];
    reason: string;
    duration: number;
    stats: FighterStats;
    verified: boolean;
    ratingDelta: number | null;
  },
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      'INSERT INTO matches (user_id, at, mode, opponent, outcome, reason, duration, stats, verified, rating_delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      row.userId,
      Date.now(),
      row.mode,
      row.opponent.slice(0, 40),
      row.outcome,
      row.reason,
      row.duration,
      JSON.stringify(row.stats),
      row.verified ? 1 : 0,
      row.ratingDelta,
    )
    .run();
}
