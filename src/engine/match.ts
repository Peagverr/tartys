// Логика матча. Никакого DOM и времени браузера: состояние меняется только
// в stepMatch() — ровно один тик за вызов. Команды игроков ставятся в очередь
// и применяются в начале следующего тика, до старта и после финала — отбрасываются.

import { DT, MATCH_DEFAULTS, RULES, TICK_HZ, ticks, type MatchOptions } from './rules';

/** 0 — левая команда (синие, тянут влево), 1 — правая (красные, тянут вправо). */
export type Side = 0 | 1;
export type Phase = 'countdown' | 'live' | 'over';
export type Action = 'none' | 'windup' | 'recover' | 'stunned' | 'exhausted';
export type YankOutcome = 'landed' | 'partial' | 'blocked' | 'punish' | 'clash';
/** forfeit — соперник отключился и не вернулся (только онлайн). */
export type OverReason = 'line' | 'time' | 'forfeit';

/**
 * mult и sync выставляет только сервер командного режима (см. team.ts);
 * от клиентов эти поля не принимаются.
 */
export type Command =
  | { side: Side; kind: 'yank'; mult?: number; sync?: boolean }
  | { side: Side; kind: 'brace'; on: boolean };

export interface FighterStats {
  yanks: number;
  /** Прошедшие рывки (полные, частичные и добивания). */
  landed: number;
  /** Мои рывки, которые соперник принял на упор. */
  blockedByOpp: number;
  /** Рывки соперника, которые я принял на упор. */
  blocks: number;
  punishes: number;
  clashes: number;
  exhaustions: number;
}

export interface Fighter {
  stamina: number;
  /** Игрок держит кнопку упора. */
  braceHeld: boolean;
  /** Насколько упор встал: 0..1. */
  brace: number;
  action: Action;
  actionTicks: number;
  /** Сила текущего рывка: 1 — обычный; меньше, если не хватало сил; больше — дружный рывок команды. */
  yankPower: number;
  yankSync: boolean;
  stats: FighterStats;
}

export type GameEvent =
  | { type: 'countdown'; n: number }
  | { type: 'start' }
  | { type: 'windup'; side: Side; sync: boolean }
  | { type: 'yank'; side: Side; outcome: YankOutcome; distance: number; sync: boolean }
  | { type: 'stun'; side: Side }
  | { type: 'exhausted'; side: Side }
  | { type: 'nostamina'; side: Side }
  | { type: 'final' }
  | { type: 'over'; winner: Side | null; reason: OverReason };

export interface MatchResult {
  winner: Side | null;
  reason: OverReason;
  durationSec: number;
  rope: number;
}

export interface MatchState {
  opts: MatchOptions;
  phase: Phase;
  /** Тиков с начала живой игры. */
  tick: number;
  countdownTicks: number;
  timeLeftTicks: number;
  /** Положение отметки: < 0 — на стороне синих, > 0 — красных. */
  rope: number;
  ropeVel: number;
  fighters: [Fighter, Fighter];
  pending: Command[];
  /** События последнего тика — для звука и эффектов. */
  events: GameEvent[];
  result: MatchResult | null;
  finalAnnounced: boolean;
  lastCount: number;
}

/** Направление, в котором тянет сторона. */
export const dir = (side: Side): -1 | 1 => (side === 0 ? -1 : 1);
export const other = (side: Side): Side => (side === 0 ? 1 : 0);

function newFighter(): Fighter {
  return {
    stamina: RULES.staminaMax,
    braceHeld: false,
    brace: 0,
    action: 'none',
    actionTicks: 0,
    yankPower: 0,
    yankSync: false,
    stats: { yanks: 0, landed: 0, blockedByOpp: 0, blocks: 0, punishes: 0, clashes: 0, exhaustions: 0 },
  };
}

export function createMatch(options: Partial<MatchOptions> = {}): MatchState {
  const opts = { ...MATCH_DEFAULTS, ...options };
  const countdownTicks = ticks(opts.countdownSec);
  return {
    opts,
    phase: countdownTicks > 0 ? 'countdown' : 'live',
    tick: 0,
    countdownTicks,
    timeLeftTicks: Number.isFinite(opts.matchSec) ? ticks(opts.matchSec) : Infinity,
    rope: 0,
    ropeVel: 0,
    fighters: [newFighter(), newFighter()],
    pending: [],
    events: [],
    result: null,
    finalAnnounced: false,
    lastCount: 0,
  };
}

/** Команда принимается только во время живой игры. */
export function sendCommand(s: MatchState, cmd: Command): boolean {
  if (s.phase !== 'live') return false;
  s.pending.push(cmd);
  return true;
}

export const isFinalStretch = (s: MatchState): boolean => s.timeLeftTicks <= ticks(RULES.finalSec);
export const timeLeftSec = (s: MatchState): number => s.timeLeftTicks / TICK_HZ;

/** Упор держится в свободном состоянии и сразу после своего рывка («рванул — упёрся»). */
export const isGuarding = (f: Fighter): boolean => f.braceHeld && (f.action === 'none' || f.action === 'recover');

/** Сила, с которой сторона постоянно держит канат. */
export function holdForce(f: Fighter): number {
  const F = RULES.force;
  const grip = F.rest + (F.restPerStamina * f.stamina) / RULES.staminaMax;
  const guard = isGuarding(f) ? F.braceExtra * f.brace : 0;
  switch (f.action) {
    case 'none':
      return grip + guard;
    case 'windup':
      return grip;
    case 'recover':
      return grip * 0.8 + guard;
    case 'stunned':
      return F.stunned;
    case 'exhausted':
      return F.exhausted;
  }
}

export function stepMatch(s: MatchState): void {
  s.events = [];
  if (s.phase === 'over') {
    s.pending.length = 0;
    return;
  }
  if (s.phase === 'countdown') {
    s.pending.length = 0;
    const n = Math.ceil(s.countdownTicks / TICK_HZ);
    if (n !== s.lastCount) {
      s.lastCount = n;
      s.events.push({ type: 'countdown', n });
    }
    s.countdownTicks--;
    if (s.countdownTicks <= 0) {
      s.phase = 'live';
      s.events.push({ type: 'start' });
    }
    return;
  }

  for (const cmd of s.pending) applyCommand(s, cmd);
  s.pending.length = 0;

  updateFighters(s);
  moveRope(s);
  checkEnd(s);
  s.tick++;
}

function applyCommand(s: MatchState, cmd: Command): void {
  const f = s.fighters[cmd.side];
  if (cmd.kind === 'brace') {
    f.braceHeld = cmd.on;
    return;
  }
  // Рывок возможен только из свободного состояния: спам кнопкой во время
  // замаха, восстановления или сбитого хвата просто игнорируется.
  if (f.action !== 'none') return;
  if (f.stamina < RULES.yankMinStamina) {
    s.events.push({ type: 'nostamina', side: cmd.side });
    return;
  }
  const cost = Math.min(f.stamina, RULES.yankCost);
  f.stamina -= cost;
  const mult = Math.max(RULES.minTeamMul, Math.min(RULES.syncMul, cmd.mult ?? 1));
  f.yankPower = (cost / RULES.yankCost) * mult;
  f.yankSync = !!cmd.sync;
  f.action = 'windup';
  f.actionTicks = ticks(RULES.windupSec);
  f.brace = 0;
  f.stats.yanks++;
  s.events.push({ type: 'windup', side: cmd.side, sync: f.yankSync });
}

function updateFighters(s: MatchState): void {
  const toResolve: Side[] = [];
  for (const side of [0, 1] as const) {
    const f = s.fighters[side];
    if (isGuarding(f)) {
      f.brace = Math.min(1, f.brace + DT / RULES.braceRampSec);
      f.stamina -= RULES.braceDrain * DT;
      if (f.stamina <= 0) {
        f.stamina = 0;
        f.brace = 0;
        f.action = 'exhausted';
        f.actionTicks = ticks(RULES.exhaustSec);
        f.stats.exhaustions++;
        s.events.push({ type: 'exhausted', side });
        continue;
      }
    } else {
      f.brace = Math.max(0, f.brace - DT / RULES.braceReleaseSec);
      if (f.action === 'none' || f.action === 'exhausted') {
        f.stamina = Math.min(RULES.staminaMax, f.stamina + RULES.restRegen * DT);
      }
    }
    if (f.action === 'none') continue;
    f.actionTicks--;
    if (f.actionTicks <= 0) {
      if (f.action === 'windup') toResolve.push(side);
      else f.action = 'none';
    }
  }
  for (const side of toResolve) {
    // Рывок мог уже разрешиться столкновением с рывком соперника.
    if (s.fighters[side].action === 'windup') resolveYank(s, side);
  }
}

function push(s: MatchState, towards: Side, distance: number): void {
  // Начальная скорость подобрана так, чтобы суммарный сдвиг за время затухания
  // был ровно distance.
  const k = Math.exp(-RULES.ropeDamp * DT);
  s.ropeVel += (dir(towards) * distance * (1 - k)) / DT;
}

function resolveYank(s: MatchState, a: Side): void {
  const d = other(a);
  const A = s.fighters[a];
  const D = s.fighters[d];
  const mul = isFinalStretch(s) ? RULES.finalYankMul : 1;

  if (D.action === 'windup' && D.actionTicks <= ticks(RULES.clashWindowSec)) {
    // Оба рванули одновременно: перетягивает тот, у кого рывок был сильнее.
    const net = (A.yankPower - D.yankPower) * RULES.yankDistance * RULES.clashMul * mul;
    if (net > 0) push(s, a, net);
    else if (net < 0) push(s, d, -net);
    for (const f of [A, D]) {
      f.action = 'recover';
      f.actionTicks = ticks(RULES.recoverSec);
      f.stats.clashes++;
    }
    s.events.push({ type: 'yank', side: a, outcome: 'clash', distance: Math.abs(net), sync: A.yankSync });
    return;
  }

  let distance = RULES.yankDistance * A.yankPower * mul;
  let outcome: YankOutcome;
  A.action = 'recover';
  A.actionTicks = ticks(RULES.recoverSec);

  if (D.action === 'stunned' || D.action === 'exhausted') {
    distance *= RULES.punishMul;
    outcome = 'punish';
    A.stats.punishes++;
  } else {
    const b = isGuarding(D) ? D.brace : 0;
    if (b >= RULES.blockThreshold) {
      distance *= 1 - RULES.blockAbsorb;
      outcome = 'blocked';
      A.action = 'stunned';
      A.actionTicks = ticks(RULES.stunSec);
      A.stats.blockedByOpp++;
      D.stats.blocks++;
      D.stamina = Math.max(0, D.stamina - RULES.blockCost);
      push(s, d, RULES.blockRebound * A.yankPower);
      s.events.push({ type: 'stun', side: a });
    } else {
      distance *= 1 - b * RULES.blockAbsorb;
      outcome = b > 0.05 ? 'partial' : 'landed';
    }
  }
  if (outcome !== 'blocked') A.stats.landed++;
  push(s, a, distance);
  s.events.push({ type: 'yank', side: a, outcome, distance, sync: A.yankSync });
}

function moveRope(s: MatchState): void {
  const [f0, f1] = s.fighters;
  s.rope += (holdForce(f1) - holdForce(f0)) * RULES.creepSpeed * DT;
  s.rope += s.ropeVel * DT;
  s.ropeVel *= Math.exp(-RULES.ropeDamp * DT);
}

function checkEnd(s: MatchState): void {
  const L = s.opts.winLine;
  if (s.rope <= -L) return finish(s, 0, 'line');
  if (s.rope >= L) return finish(s, 1, 'line');
  s.timeLeftTicks--;
  if (!s.finalAnnounced && isFinalStretch(s)) {
    s.finalAnnounced = true;
    s.events.push({ type: 'final' });
  }
  if (s.timeLeftTicks <= 0) {
    const winner: Side | null = Math.abs(s.rope) < s.opts.drawZone ? null : s.rope < 0 ? 0 : 1;
    finish(s, winner, 'time');
  }
}

/** Техническая победа: сервер завершает матч, если сторона не вернулась после отключения. */
export function forfeit(s: MatchState, winner: Side): void {
  if (s.phase === 'over') return;
  s.events = [];
  finish(s, winner, 'forfeit');
}

function finish(s: MatchState, winner: Side | null, reason: OverReason): void {
  const L = s.opts.winLine;
  s.rope = Math.max(-L, Math.min(L, s.rope));
  s.ropeVel = 0;
  s.phase = 'over';
  s.result = { winner, reason, durationSec: (s.tick + 1) / TICK_HZ, rope: s.rope };
  for (const f of s.fighters) f.braceHeld = false;
  s.events.push({ type: 'over', winner, reason });
}
