// Компьютерный соперник. Играет по тем же правилам, что и человек: только
// отправляет команды в очередь, сил и скорости ему не добавляется.
// Соперника он «видит» с задержкой реакции, как человек видит экран.

import { dir, other, type Action, type Command, type MatchState, type Side } from './match';
import { RULES, TICK_HZ } from './rules';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface BotProfile {
  name: string;
  title: string;
  /** Задержка восприятия, тиков. */
  reactionTicks: number;
  /** Как часто принимает решение, тиков. */
  thinkEvery: number;
  /** Шанс заметить замах и встать в упор. */
  readChance: number;
  /** Шанс ответить на замах своим рывком (размен). */
  counterChance: number;
  /** Шанс сразу после своего рывка встать в упор («рванул — упёрся»). */
  guardAfterYank: number;
  /** Шанс рвануть, когда соперник открыт (за одно решение). */
  aggression: number;
  minYankStamina: number;
  minBraceStamina: number;
  /** Шанс добить сбитого или выдохшегося. */
  punishChance: number;
  /** Учится на игроке: ритм рывков и привычку упираться после рывка. */
  learns: boolean;
  braceHoldTicks: [number, number];
}

export const BOT_PROFILES: Record<Difficulty, BotProfile> = {
  easy: {
    name: 'Бала',
    title: 'лёгкий',
    reactionTicks: 26,
    thinkEvery: 12,
    readChance: 0.2,
    counterChance: 0.45,
    guardAfterYank: 0.1,
    aggression: 0.25,
    minYankStamina: 25,
    minBraceStamina: 20,
    punishChance: 0.35,
    learns: false,
    braceHoldTicks: [20, 50],
  },
  medium: {
    name: 'Жігіт',
    title: 'средний',
    reactionTicks: 18,
    thinkEvery: 8,
    readChance: 0.45,
    counterChance: 0.25,
    guardAfterYank: 0.6,
    aggression: 0.2,
    minYankStamina: 30,
    minBraceStamina: 25,
    punishChance: 0.75,
    learns: true,
    braceHoldTicks: [18, 36],
  },
  hard: {
    name: 'Батыр',
    title: 'сложный',
    reactionTicks: 13,
    thinkEvery: 6,
    readChance: 0.7,
    counterChance: 0.6,
    guardAfterYank: 0.75,
    aggression: 0.22,
    minYankStamina: 30,
    minBraceStamina: 25,
    punishChance: 1,
    learns: true,
    braceHoldTicks: [16, 32],
  },
};

interface Seen {
  action: Action;
  brace: number;
  braceHeld: boolean;
  stamina: number;
}

/** Детерминированный генератор случайных чисел — матчи бота воспроизводимы в тестах. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Bot {
  private readonly rand: () => number;
  private seen: Seen[] = [];
  private bracing = false;
  private braceUntil = 0;
  private nextThink = 0;
  private prevMine: Action = 'none';
  // Чему бот учится у игрока.
  private prevSeen: Action = 'none';
  private oppRest = 0;
  private restSamples: number[] = [];
  /** Как часто игрок упирается сразу после своего рывка (0..1). */
  private oppGuardRate = 0.3;

  constructor(
    readonly side: Side,
    readonly profile: BotProfile,
    seed = 1,
  ) {
    this.rand = mulberry32(seed);
  }

  update(s: MatchState): Command[] {
    const cmds: Command[] = [];
    if (s.phase !== 'live') {
      this.seen.length = 0;
      this.bracing = false;
      return cmds;
    }
    const side = this.side;
    const me = s.fighters[side];
    const opp = s.fighters[other(side)];
    const p = this.profile;
    const r = this.rand;

    this.seen.push({ action: opp.action, brace: opp.brace, braceHeld: opp.braceHeld, stamina: opp.stamina });
    if (this.seen.length > 90) this.seen.shift();
    const o = this.seen[this.seen.length - 1 - p.reactionTicks];

    const brace = (on: boolean) => {
      if (this.bracing === on) return;
      this.bracing = on;
      cmds.push({ side, kind: 'brace', on });
    };
    const holdBrace = (extra = 0) => {
      const [lo, hi] = p.braceHoldTicks;
      this.braceUntil = s.tick + extra + lo + Math.floor(r() * (hi - lo));
      brace(true);
    };
    const yank = () => {
      brace(false);
      cmds.push({ side, kind: 'yank' });
    };

    // Только что рванул сам — возможно, сразу упереться против ответного рывка.
    const justYanked = me.action === 'windup' && this.prevMine !== 'windup';
    this.prevMine = me.action;
    if (justYanked && me.stamina >= 12 && r() < p.guardAfterYank) holdBrace(30);

    if (this.bracing && (s.tick >= this.braceUntil || me.stamina < 10)) brace(false);
    if (!o) return cmds;
    this.learn(o);
    if (s.tick < this.nextThink || me.action !== 'none') return cmds;
    this.nextThink = s.tick + p.thinkEvery;

    const canYank = me.stamina >= p.minYankStamina;
    const canBrace = me.stamina >= p.minBraceStamina;
    const oGuarding = o.braceHeld && (o.action === 'none' || o.action === 'recover') && o.brace > 0.4;
    const oVulnerable = o.action === 'stunned' || o.action === 'exhausted';
    // Отставая в концовке, бот рискует чаще; ведя — осторожничает.
    const lead = s.rope * dir(side);
    const lateGame = s.timeLeftTicks < 15 * TICK_HZ;
    const urgency = lateGame ? (lead < 0 ? 1.8 : 0.7) : 1;

    // 1. Соперник сбит или выдохся — добить.
    if (oVulnerable) {
      if (me.stamina >= 15 && r() < p.punishChance) yank();
      return cmds;
    }
    // 2. Увидел замах: упор или ответный рывок. Умный бот не отвечает рывком тому,
    //    кто привык упираться сразу после своего рывка.
    if (o.action === 'windup') {
      const counter = p.learns ? p.counterChance * (1 - this.oppGuardRate) : p.counterChance;
      const roll = r();
      if (canYank && roll < counter) yank();
      else if (canBrace && roll < counter + p.readChance) holdBrace();
      return cmds;
    }
    // 3. Соперник в упоре — в стену не рвём, отдыхаем, пока он жжёт силы.
    if (oGuarding) {
      brace(false);
      return cmds;
    }
    // 4. Предугадать рывок по ритму игрока.
    if (p.learns && !this.bracing && canBrace && this.threat(o) && r() < p.readChance * 0.5) {
      holdBrace();
      return cmds;
    }
    // 5. Соперник открыт — рывок.
    if (!this.bracing && canYank && o.brace < 0.3 && (o.action === 'none' || o.action === 'recover')) {
      // Умный бот охотнее бьёт, когда у игрока мало сил на упор.
      const bonus = p.learns && o.stamina < RULES.yankCost ? 2 : 1;
      if (r() < p.aggression * urgency * bonus) yank();
    }
    return cmds;
  }

  private learn(o: Seen): void {
    if (o.action === 'windup' && this.prevSeen !== 'windup') {
      this.restSamples.push(this.oppRest);
      if (this.restSamples.length > 8) this.restSamples.shift();
    }
    if (o.action === 'recover' && this.prevSeen === 'windup') {
      this.oppGuardRate = this.oppGuardRate * 0.7 + (o.braceHeld ? 0.3 : 0);
    }
    if (o.action === 'none' && !o.braceHeld) this.oppRest++;
    else this.oppRest = 0;
    this.prevSeen = o.action;
  }

  /** Похоже, что игрок вот-вот рванёт: сил хватает и отдыхает он «как обычно перед рывком». */
  private threat(o: Seen): boolean {
    if (o.action !== 'none' || o.stamina < RULES.yankCost) return false;
    const samples = this.restSamples.length >= 2 ? this.restSamples : [40, 60];
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const spread = Math.max(8, Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length));
    // Бот видит мир с задержкой, поэтому встаёт в упор на reactionTicks раньше.
    const at = this.oppRest + this.profile.reactionTicks;
    return at >= mean - spread && at <= mean + spread;
  }
}
