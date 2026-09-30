import { describe, expect, it } from 'vitest';
import type { FighterStats } from '../src/engine/match';
import { CHALLENGES, evaluate } from '../src/store/challenges';
import { summarize, type MatchRecord } from '../src/store/storage';

const stats = (o: Partial<FighterStats> = {}): FighterStats => ({
  yanks: 10,
  landed: 8,
  blockedByOpp: 0,
  blocks: 0,
  punishes: 0,
  partial: 0,
  clashes: 0,
  exhaustions: 0,
  ...o,
});

const rec = (o: Partial<MatchRecord> = {}, me: Partial<FighterStats> = {}): MatchRecord => ({
  at: Date.now(),
  mode: 'bot',
  difficulty: 'easy',
  winner: 0,
  reason: 'line',
  durationSec: 50,
  stats: [stats(me), stats()],
  ...o,
});

const ids = (r: MatchRecord, h: MatchRecord[] = [r]) => evaluate(r, h).map((c) => c.id);

describe('испытания', () => {
  it('победа над лёгким ботом — только «Первая победа»', () => {
    expect(ids(rec())).toEqual(['first-win']);
  });

  it('быстрая победа над Батыром без изнеможения закрывает несколько испытаний', () => {
    const got = ids(rec({ difficulty: 'hard', durationSec: 30 }, { blocks: 3, punishes: 2 }));
    expect(got).toEqual(expect.arrayContaining(['wall', 'punisher', 'fast', 'cool', 'batyr']));
  });

  it('поражение и режим вдвоём не засчитываются', () => {
    expect(ids(rec({ winner: 1 }))).toEqual([]);
    expect(ids(rec({ mode: 'local' }, { blocks: 5 }))).toEqual([]);
  });

  it('серия — три победы подряд', () => {
    const h = [rec(), rec(), rec()];
    expect(summarize(h).streak).toBe(3);
    expect(CHALLENGES.find((c) => c.id === 'streak')!.check(h[0], h)).toBe(true);
    expect(CHALLENGES.find((c) => c.id === 'streak')!.check(h[0], [rec(), rec({ winner: 1 }), rec()])).toBe(false);
  });
});
