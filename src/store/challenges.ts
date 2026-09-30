// Испытания против бота: конкретные цели, которые учат пользоваться механикой.

import { summarize, type MatchRecord } from './storage';

export interface Challenge {
  id: string;
  title: string;
  desc: string;
  check(r: MatchRecord, history: MatchRecord[]): boolean;
}

const won = (r: MatchRecord) => r.mode === 'bot' && r.winner === 0;

export const CHALLENGES: Challenge[] = [
  { id: 'first-win', title: 'Первая победа', desc: 'Победи любого бота.', check: won },
  { id: 'wall', title: 'Стена', desc: 'Прими на упор 3 рывка соперника за один матч.', check: (r) => r.mode === 'bot' && r.stats[0].blocks >= 3 },
  { id: 'punisher', title: 'Добивание', desc: 'Сделай 2 добивания за матч — рывок по сбитому или выдохшемуся.', check: (r) => r.mode === 'bot' && r.stats[0].punishes >= 2 },
  { id: 'fast', title: 'Молния', desc: 'Перетяни ленту за линию быстрее чем за 40 секунд.', check: (r) => won(r) && r.reason === 'line' && r.durationSec < 40 },
  {
    id: 'cool',
    title: 'Холодная голова',
    desc: 'Победи Жігіта или Батыра, ни разу не выдохнувшись.',
    check: (r) => won(r) && r.difficulty !== 'easy' && r.stats[0].exhaustions === 0,
  },
  { id: 'batyr', title: 'Батыр', desc: 'Победи сложного бота — он запоминает твой ритм.', check: (r) => won(r) && r.difficulty === 'hard' },
  { id: 'streak', title: 'Серия', desc: 'Выиграй 3 матча у ботов подряд.', check: (_r, h) => summarize(h).streak >= 3 },
];

const KEY = 'tartys.challenges.v1';

export function loadDone(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Проверить матч; вернуть только что выполненные испытания. */
export function evaluate(r: MatchRecord, history: MatchRecord[]): Challenge[] {
  const done = loadDone();
  const fresh = CHALLENGES.filter((c) => !done.has(c.id) && c.check(r, history));
  if (fresh.length) {
    for (const c of fresh) done.add(c.id);
    try {
      localStorage.setItem(KEY, JSON.stringify([...done]));
    } catch {
      /* без сохранения */
    }
  }
  return fresh;
}
