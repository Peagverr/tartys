// Сообщения между браузером и сервером комнаты. Общий файл для клиента и сервера.

import type { Action, FighterStats, GameEvent, MatchResult, Phase, Side } from '../engine/match';

export type Role = 'player' | 'screen';
export type RoomMode = 'duel' | 'crowd';

export interface Branding {
  title: string;
  teams: [string, string];
}

export interface RoomConfig {
  mode: RoomMode;
  branding: Branding | null;
  maxPerSide: number;
  matchSec: number;
  createdAt: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  side: Side;
  connected: boolean;
  ready: boolean;
  pro: boolean;
  rating: number | null;
}

export interface LobbyInfo {
  code: string;
  mode: RoomMode;
  stage: 'lobby' | 'match' | 'paused';
  players: LobbyPlayer[];
  screens: number;
  branding: Branding | null;
  maxPerSide: number;
  matchSec: number;
  /** Сколько миллисекунд осталось ждать отключившегося (пауза). */
  waitMs: number;
  waitSide: Side | null;
}

/** Сжатое состояние бойца. */
export interface FighterSnap {
  st: number;
  bh: boolean;
  br: number;
  a: Action;
  yp: number;
  ys: boolean;
}

export interface Snap {
  ph: Phase;
  tick: number;
  cd: number;
  /** null — без ограничения по времени. */
  tl: number | null;
  rope: number;
  f: [FighterSnap, FighterSnap];
  /** Доля команды, дёрнувшей в текущем окне синхронности. */
  share: [number, number];
  /** Сколько людей на связи в каждой команде. */
  n: [number, number];
  ev: GameEvent[];
}

export interface RatingChange {
  id: string;
  name: string;
  before: number;
  after: number;
}

export interface OverInfo {
  result: MatchResult;
  stats: [FighterStats, FighterStats];
  ratings: RatingChange[];
}

export type ClientMsg =
  /** Первое сообщение: кто подключается. Токен входа передаётся здесь, а не в адресе. */
  | { t: 'hello'; cid: string; name: string; role: Role; token?: string }
  | { t: 'cmd'; kind: 'yank' }
  | { t: 'cmd'; kind: 'brace'; on: boolean }
  | { t: 'ready'; on: boolean }
  | { t: 'side'; side: Side }
  | { t: 'start' }
  | { t: 'ping'; ts: number };

export type ServerMsg =
  | { t: 'welcome'; you: string; role: Role; side: Side | null; note?: string }
  | { t: 'lobby'; room: LobbyInfo }
  | { t: 'snap'; s: Snap }
  | { t: 'over'; info: OverInfo }
  | { t: 'pong'; ts: number }
  | { t: 'error'; message: string };

export const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

// ---------- HTTP API ----------

export interface PublicUser {
  id: string;
  name: string;
  rating: number;
  pro: { player: boolean; organizer: boolean };
  skin: string;
  arena: string;
}

export interface HistoryItem {
  at: number;
  mode: 'bot' | 'local' | 'online' | 'crowd';
  opponent: string;
  outcome: 'win' | 'loss' | 'draw';
  reason: string;
  duration: number;
  verified: boolean;
  ratingDelta: number | null;
  stats: FighterStats;
}

export interface LeaderRow {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  pro: boolean;
}

export const SKINS = ['classic', 'gold', 'night', 'steppe'] as const;
export const ARENAS = ['steppe', 'winter', 'city'] as const;
export const FREE_SKINS = ['classic'];
export const FREE_ARENAS = ['steppe'];

export const PLANS = {
  player: { title: 'Тартыс Pro', price: 990, period: 'в месяц' },
  organizer: { title: 'Pro организатора', price: 9900, period: 'за мероприятие' },
} as const;
export type Plan = keyof typeof PLANS;

export const FREE_CROWD_PER_SIDE = 10;
export const PRO_CROWD_PER_SIDE = 50;
