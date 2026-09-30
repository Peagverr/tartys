import { describe, expect, it } from 'vitest';
import { createMatch, sendCommand, stepMatch, type GameEvent, type MatchState } from '../src/engine/match';
import { RULES, ticks } from '../src/engine/rules';
import { TeamInput } from '../src/engine/team';

function setup(size: number) {
  const s = createMatch({ countdownSec: 0 });
  const team = new TeamInput(0);
  const ids = Array.from({ length: size }, (_, i) => `p${i}`);
  team.setMembers(ids);
  return { s, team, ids };
}

function tick(s: MatchState, team: TeamInput): GameEvent[] {
  for (const c of team.update(s.tick)) sendCommand(s, c);
  stepMatch(s);
  return s.events;
}

function runFor(s: MatchState, team: TeamInput, n: number): GameEvent[] {
  const ev: GameEvent[] = [];
  for (let i = 0; i < n; i++) ev.push(...tick(s, team));
  return ev;
}

describe('командный рывок', () => {
  it('дружный рывок (≥70% команды в окне) сильнее обычного', () => {
    const { s, team, ids } = setup(4);
    for (const id of ids.slice(0, 3)) team.yank(id, s.tick, s.fighters[0]);
    const ev = runFor(s, team, 60);
    const y = ev.find((e) => e.type === 'yank');
    expect(y).toMatchObject({ sync: true, outcome: 'landed' });
    expect(-s.rope).toBeGreaterThan(RULES.yankDistance * 1.3);
  });

  it('вразнобой — слабый рывок', () => {
    const { s, team, ids } = setup(4);
    team.yank(ids[0], s.tick, s.fighters[0]);
    runFor(s, team, ticks(RULES.syncWindowSec) + 2);
    team.yank(ids[1], s.tick, s.fighters[0]);
    const ev = runFor(s, team, 60);
    const yanks = ev.filter((e) => e.type === 'yank');
    // Второй игрок опоздал: пока идёт первый рывок, его нажатие не считается.
    expect(yanks.length).toBe(1);
    expect(yanks[0]).toMatchObject({ sync: false });
    expect(-s.rope).toBeLessThan(RULES.yankDistance * 0.5);
  });

  it('повторные нажатия одного игрока не засчитываются за нескольких', () => {
    const { s, team, ids } = setup(3);
    for (let i = 0; i < 10; i++) team.yank(ids[0], s.tick, s.fighters[0]);
    const ev = runFor(s, team, 60);
    expect(ev.find((e) => e.type === 'yank')).toMatchObject({ sync: false });
    expect(s.fighters[0].stats.yanks).toBe(1);
  });

  it('игрок вне команды не влияет', () => {
    const { s, team } = setup(2);
    team.yank('stranger', s.tick, s.fighters[0]);
    team.brace('stranger', true);
    const ev = runFor(s, team, 60);
    expect(ev.some((e) => e.type === 'yank')).toBe(false);
    expect(s.fighters[0].braceHeld).toBe(false);
  });

  it('упор — когда держит хотя бы половина команды', () => {
    const { s, team, ids } = setup(4);
    team.brace(ids[0], true);
    runFor(s, team, 2);
    expect(s.fighters[0].braceHeld).toBe(false);
    team.brace(ids[1], true);
    runFor(s, team, 2);
    expect(s.fighters[0].braceHeld).toBe(true);
    team.setMembers([ids[2], ids[3]]);
    runFor(s, team, 2);
    expect(s.fighters[0].braceHeld).toBe(false);
  });

  it('команда из одного человека — обычный рывок без задержки окна', () => {
    const { s, team, ids } = setup(1);
    team.yank(ids[0], s.tick, s.fighters[0]);
    const ev = tick(s, team);
    expect(ev.find((e) => e.type === 'windup')).toMatchObject({ sync: false });
    expect(s.fighters[0].yankPower).toBe(1);
  });
});
