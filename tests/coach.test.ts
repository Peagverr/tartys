import { describe, expect, it } from 'vitest';
import { createMatch, type MatchState } from '../src/engine/match';
import { LiveCoach, pickHint } from '../src/game/coach';

const live = (): MatchState => createMatch({ countdownSec: 0 });

describe('живой тренер', () => {
  it('соперник сбит или выдохся — «добивай»', () => {
    const s = live();
    s.fighters[1].action = 'stunned';
    expect(pickHint(s, 0)?.id).toBe('punish');
    s.fighters[1].action = 'exhausted';
    expect(pickHint(s, 0)?.urgent).toBe(true);
  });

  it('соперник в упоре — «не рви, отдыхай»', () => {
    const s = live();
    s.fighters[1].braceHeld = true;
    s.fighters[1].brace = 1;
    expect(pickHint(s, 0)?.id).toBe('wait');
  });

  it('после своего рывка — «зажми упор»', () => {
    const s = live();
    s.fighters[0].action = 'recover';
    expect(pickHint(s, 0)?.id).toBe('guard');
  });

  it('мало сил — «передышка», у соперника мало — «рви»', () => {
    const s = live();
    s.fighters[0].stamina = 20;
    expect(pickHint(s, 0)?.id).toBe('rest');
    const t = live();
    t.fighters[1].stamina = 20;
    expect(pickHint(t, 0)?.id).toBe('attack');
  });

  it('подсказки для красных считаются с их стороны', () => {
    const s = live();
    s.fighters[0].action = 'exhausted';
    expect(pickHint(s, 1)?.id).toBe('punish');
    expect(pickHint(s, 0)?.id).not.toBe('punish');
  });

  it('с веб-камерой тренер говорит жестами', () => {
    const s = live();
    s.fighters[0].action = 'recover';
    expect(pickHint(s, 0, true)?.text).toMatch(/левый кулак/);
    const t = live();
    t.fighters[1].stamina = 20;
    expect(pickHint(t, 0, true)?.text).toMatch(/правый кулак/);
    expect(pickHint(t, 0, false)?.text).toMatch(/рви/);
  });

  it('до старта и после финала молчит', () => {
    expect(pickHint(createMatch(), 0)).toBeNull();
    const s = live();
    s.phase = 'over';
    s.fighters[1].action = 'stunned';
    expect(pickHint(s, 0)).toBeNull();
  });

  it('обычная подсказка ждёт, срочная показывается сразу', () => {
    const c = new LiveCoach();
    c.voiceOn = false;
    const s = live();
    s.fighters[0].stamina = 20;
    expect(c.update(s, 0, 0)).toBeNull();
    expect(c.update(s, 0, 2000)).toMatch(/передышка/);
    s.fighters[0].stamina = 100;
    s.fighters[1].action = 'stunned';
    expect(c.update(s, 0, 2100)).toMatch(/добивай/i);
  });
});
