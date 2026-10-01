// Локальное хранилище: настройки и история завершённых матчей.
// Все обращения обёрнуты в try/catch — в приватном режиме localStorage может не работать.

import type { Difficulty } from '../engine/bot';
import type { FighterStats, OverReason, Side } from '../engine/match';

export type ModeKind = 'bot' | 'local';

export interface MatchRecord {
  at: number;
  mode: ModeKind;
  difficulty?: Difficulty;
  winner: Side | null;
  reason: OverReason;
  durationSec: number;
  stats: [FighterStats, FighterStats];
}

export interface Settings {
  sound: boolean;
  matchSec: number;
  difficulty: Difficulty;
  tutorialDone: boolean;
  /** Живой тренер с подсказками во время матча. */
  coach: boolean;
}

const SETTINGS_KEY = 'tartys.settings.v1';
const HISTORY_KEY = 'tartys.history.v1';
const HISTORY_LIMIT = 100;

const DEFAULT_SETTINGS: Settings = { sound: true, matchSec: 60, difficulty: 'easy', tutorialDone: false, coach: true };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — играем без сохранения */
  }
}

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(SETTINGS_KEY, {}) };
}

export function saveSettings(s: Settings): void {
  write(SETTINGS_KEY, s);
}

export function loadHistory(): MatchRecord[] {
  const h = read<MatchRecord[]>(HISTORY_KEY, []);
  return Array.isArray(h) ? h : [];
}

export function addRecord(r: MatchRecord): void {
  const h = [r, ...loadHistory()].slice(0, HISTORY_LIMIT);
  write(HISTORY_KEY, h);
}

export function clearHistory(): void {
  write(HISTORY_KEY, []);
}

export interface Summary {
  wins: number;
  losses: number;
  draws: number;
  byDifficulty: Record<Difficulty, { wins: number; losses: number; draws: number }>;
  streak: number;
  bestStreak: number;
  fastestWinSec: number | null;
  blocks: number;
  yanks: number;
  landed: number;
}

/** Статистика игрока против бота (игрок всегда слева). */
export function summarize(history: MatchRecord[]): Summary {
  const blank = () => ({ wins: 0, losses: 0, draws: 0 });
  const s: Summary = {
    wins: 0,
    losses: 0,
    draws: 0,
    byDifficulty: { easy: blank(), medium: blank(), hard: blank() },
    streak: 0,
    bestStreak: 0,
    fastestWinSec: null,
    blocks: 0,
    yanks: 0,
    landed: 0,
  };
  const botGames = history.filter((r) => r.mode === 'bot');
  // История хранится от новых к старым; серию считаем в хронологическом порядке.
  let run = 0;
  for (const r of [...botGames].reverse()) {
    const d = s.byDifficulty[r.difficulty ?? 'easy'];
    s.yanks += r.stats[0].yanks;
    s.landed += r.stats[0].landed;
    s.blocks += r.stats[0].blocks;
    if (r.winner === 0) {
      s.wins++;
      d.wins++;
      run++;
      if (r.reason === 'line' && (s.fastestWinSec === null || r.durationSec < s.fastestWinSec)) {
        s.fastestWinSec = r.durationSec;
      }
    } else if (r.winner === 1) {
      s.losses++;
      d.losses++;
      run = 0;
    } else {
      s.draws++;
      d.draws++;
      run = 0;
    }
    s.bestStreak = Math.max(s.bestStreak, run);
  }
  s.streak = run;
  return s;
}
