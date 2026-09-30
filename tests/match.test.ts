import { describe, expect, it } from 'vitest';
import { Bot, BOT_PROFILES, type Difficulty } from '../src/engine/bot';
import { createMatch, sendCommand, stepMatch, type GameEvent, type MatchState } from '../src/engine/match';
import { RULES, TICK_HZ, ticks } from '../src/engine/rules';

/** Матч сразу в живой фазе. */
const live = (opts = {}) => createMatch({ countdownSec: 0, ...opts });

function run(s: MatchState, n: number, onTick?: (s: MatchState) => void): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    onTick?.(s);
    stepMatch(s);
    all.push(...s.events);
  }
  return all;
}

const settle = ticks(RULES.windupSec + RULES.recoverSec + 1);

describe('старт и финал', () => {
  it('ввод во время отсчёта не влияет на матч', () => {
    const s = createMatch();
    expect(s.phase).toBe('countdown');
    for (let i = 0; i < ticks(3) - 1; i++) {
      expect(sendCommand(s, { side: 0, kind: 'yank' })).toBe(false);
      sendCommand(s, { side: 1, kind: 'brace', on: true });
      stepMatch(s);
    }
    stepMatch(s);
    expect(s.phase).toBe('live');
    expect(s.rope).toBe(0);
    expect(s.fighters[0].stamina).toBe(RULES.staminaMax);
    expect(s.fighters[1].braceHeld).toBe(false);
  });

  it('отсчёт 3-2-1 и старт', () => {
    const ev = run(createMatch(), ticks(3));
    const counts = ev.filter((e) => e.type === 'countdown').map((e) => (e as { n: number }).n);
    expect(counts).toEqual([3, 2, 1]);
    expect(ev.at(-1)).toEqual({ type: 'start' });
  });

  it('после победы ввод игнорируется и состояние не меняется', () => {
    const s = live();
    s.rope = -99.5;
    sendCommand(s, { side: 0, kind: 'yank' });
    run(s, settle);
    expect(s.phase).toBe('over');
    expect(s.result?.winner).toBe(0);
    expect(s.result?.reason).toBe('line');
    const frozen = JSON.stringify([s.rope, s.fighters, s.result]);
    expect(sendCommand(s, { side: 1, kind: 'yank' })).toBe(false);
    run(s, 120);
    expect(JSON.stringify([s.rope, s.fighters, s.result])).toBe(frozen);
  });

  it('время вышло: побеждает сторона, где отметка; у центра — ничья', () => {
    const a = live({ matchSec: 1 });
    a.rope = 20;
    run(a, TICK_HZ);
    expect(a.result).toMatchObject({ winner: 1, reason: 'time' });

    const b = live({ matchSec: 1 });
    b.rope = -2;
    run(b, TICK_HZ);
    expect(b.result).toMatchObject({ winner: null, reason: 'time' });
  });

  it('новый матч начинается с чистого состояния', () => {
    const s = live();
    sendCommand(s, { side: 0, kind: 'yank' });
    run(s, 60);
    const fresh = createMatch();
    expect(fresh.rope).toBe(0);
    expect(fresh.fighters[0].stats.yanks).toBe(0);
    expect(fresh.fighters[0].stamina).toBe(RULES.staminaMax);
  });
});

describe('Рывок / Упор / Передышка', () => {
  it('рывок по отдыхающему сдвигает канат на полную дистанцию', () => {
    const s = live();
    sendCommand(s, { side: 0, kind: 'yank' });
    const ev = run(s, 90);
    expect(ev.find((e) => e.type === 'yank')).toMatchObject({ side: 0, outcome: 'landed' });
    // Чуть меньше полной дистанции: потратив силы, атакующий держит канат слабее.
    expect(s.rope).toBeLessThan(-RULES.yankDistance * 0.9);
    expect(s.rope).toBeGreaterThan(-RULES.yankDistance - 0.5);
    expect(s.fighters[0].stamina).toBeLessThan(RULES.staminaMax);
  });

  it('рывок в полный упор блокируется и сбивает хват атакующему', () => {
    const s = live();
    sendCommand(s, { side: 1, kind: 'brace', on: true });
    run(s, 20);
    sendCommand(s, { side: 0, kind: 'yank' });
    const ev = run(s, ticks(RULES.windupSec) + 1);
    expect(ev.find((e) => e.type === 'yank')).toMatchObject({ outcome: 'blocked' });
    expect(s.fighters[0].action).toBe('stunned');
    expect(s.fighters[1].stats.blocks).toBe(1);
  });

  it('упор без передышки заканчивается изнеможением', () => {
    const s = live();
    sendCommand(s, { side: 0, kind: 'brace', on: true });
    const ev = run(s, ticks(RULES.staminaMax / RULES.braceDrain) + 5);
    expect(ev.some((e) => e.type === 'exhausted' && e.side === 0)).toBe(true);
    expect(s.fighters[0].stamina).toBeGreaterThanOrEqual(0);
  });

  it('рывок по выдохшемуся — добивание, сильнее обычного', () => {
    const s = live();
    s.fighters[1].action = 'exhausted';
    s.fighters[1].actionTicks = 60;
    sendCommand(s, { side: 0, kind: 'yank' });
    const ev = run(s, 90);
    expect(ev.find((e) => e.type === 'yank')).toMatchObject({ outcome: 'punish' });
    expect(-s.rope).toBeGreaterThan(RULES.yankDistance * 1.1);
  });

  it('одновременные рывки сталкиваются, при равных силах канат на месте', () => {
    const s = live();
    sendCommand(s, { side: 0, kind: 'yank' });
    sendCommand(s, { side: 1, kind: 'yank' });
    const ev = run(s, 90);
    expect(ev.find((e) => e.type === 'yank')).toMatchObject({ outcome: 'clash' });
    expect(Math.abs(s.rope)).toBeLessThan(0.5);
  });

  it('передышка восстанавливает силы, упор тратит', () => {
    const s = live();
    s.fighters[0].stamina = 40;
    s.fighters[1].stamina = 40;
    sendCommand(s, { side: 1, kind: 'brace', on: true });
    run(s, TICK_HZ);
    expect(s.fighters[0].stamina).toBeCloseTo(40 + RULES.restRegen, 0);
    expect(s.fighters[1].stamina).toBeCloseTo(40 - RULES.braceDrain, 0);
  });
});

describe('защита от обхода ограничений', () => {
  it('спам рывка не даёт больше рывков, чем позволяют тайминги и силы', () => {
    const s = live();
    run(s, TICK_HZ * 3, (st) => {
      for (let i = 0; i < 5; i++) sendCommand(st, { side: 0, kind: 'yank' });
    });
    const f = s.fighters[0];
    const cycle = RULES.windupSec + RULES.recoverSec;
    expect(f.stats.yanks).toBeLessThanOrEqual(Math.ceil(3 / cycle));
    expect(f.stamina).toBeGreaterThanOrEqual(0);
  });

  it('без сил рывок невозможен', () => {
    const s = live();
    s.fighters[0].stamina = 2;
    sendCommand(s, { side: 0, kind: 'yank' });
    const ev = run(s, 1);
    expect(ev.some((e) => e.type === 'nostamina')).toBe(true);
    expect(s.fighters[0].stats.yanks).toBe(0);
  });

  it('стороны обрабатываются симметрично', () => {
    const a = live();
    sendCommand(a, { side: 0, kind: 'yank' });
    run(a, 90);
    const b = live();
    sendCommand(b, { side: 1, kind: 'yank' });
    run(b, 90);
    expect(a.rope).toBeCloseTo(-b.rope, 6);
  });
});

function botDuel(d0: Difficulty, d1: Difficulty, seed: number) {
  const s = createMatch({ countdownSec: 0 });
  const bots = [new Bot(0, BOT_PROFILES[d0], seed), new Bot(1, BOT_PROFILES[d1], seed * 7919)];
  let guard = 0;
  let badStamina = false;
  while (s.phase !== 'over' && guard++ < TICK_HZ * 120) {
    for (const bot of bots) for (const c of bot.update(s)) sendCommand(s, c);
    stepMatch(s);
    for (const f of s.fighters) if (f.stamina < 0 || f.stamina > RULES.staminaMax) badStamina = true;
  }
  expect(badStamina).toBe(false);
  return s;
}

describe('бот', () => {
  it('бот тоже упирается, отдыхает и выдыхается по общим правилам', () => {
    const s = botDuel('hard', 'medium', 3);
    expect(s.phase).toBe('over');
    const [a, b] = s.fighters.map((f) => f.stats);
    expect(a.yanks + b.yanks).toBeGreaterThan(10);
    expect(a.blocks + b.blocks).toBeGreaterThan(0);
  });

  it('уровни сложности различаются по силе', () => {
    let hardWins = 0;
    let mediumWins = 0;
    const N = 30;
    for (let seed = 1; seed <= N; seed++) {
      // Меняем стороны, чтобы исключить преимущество стороны.
      const a = botDuel('hard', 'easy', seed);
      if (a.result?.winner === 0) hardWins++;
      const b = botDuel('easy', 'medium', seed);
      if (b.result?.winner === 1) mediumWins++;
    }
    expect(hardWins / N).toBeGreaterThan(0.7);
    expect(mediumWins / N).toBeGreaterThan(0.5);
  });
});
