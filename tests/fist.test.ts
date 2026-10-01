import { describe, expect, it } from 'vitest';
import { assignHands, FistGestures, type HandObs } from '../src/camera/fist-gestures';

const L = (fist: boolean): HandObs => ({ hand: 'l', fist });
const R = (fist: boolean): HandObs => ({ hand: 'r', fist });

function feed(g: FistGestures, frames: HandObs[][], t0 = 0) {
  let yanks = 0;
  const braces: boolean[] = [];
  frames.forEach((f, i) => {
    const o = g.update(f, t0 + i * 33);
    if (o.yank) yanks++;
    if (o.brace !== null) braces.push(o.brace);
  });
  return { yanks, braces };
}

const repeat = <T>(x: T, n: number): T[] => Array.from({ length: n }, () => x);

describe('жесты кулаками', () => {
  it('открытые ладони — передышка', () => {
    const r = feed(new FistGestures(), repeat([L(false), R(false)], 30));
    expect(r.yanks).toBe(0);
    expect(r.braces).toEqual([]);
  });

  it('левый кулак — упор, разжал — снят', () => {
    const g = new FistGestures();
    const r = feed(g, [...repeat([L(true), R(false)], 10), ...repeat([L(false), R(false)], 10)]);
    expect(r.braces).toEqual([true, false]);
  });

  it('правый кулак — ровно один рывок, пока не разожмешь', () => {
    const g = new FistGestures();
    const r = feed(g, [...repeat([L(false), R(true)], 20)]);
    expect(r.yanks).toBe(1);
    const r2 = feed(g, [...repeat([L(false), R(false)], 5), ...repeat([L(false), R(true)], 5)], 2000);
    expect(r2.yanks).toBe(1);
  });

  it('одиночный кадр-дрожание не срабатывает', () => {
    const g = new FistGestures();
    const frames = repeat([L(false), R(false)], 10);
    frames[5] = [L(true), R(true)];
    const r = feed(g, frames);
    expect(r.yanks).toBe(0);
    expect(r.braces).toEqual([]);
  });

  it('рука пропала из кадра — упор отпускается', () => {
    const g = new FistGestures();
    const r = feed(g, [...repeat([L(true)], 5), ...repeat([] as HandObs[], 5)]);
    expect(r.braces).toEqual([true, false]);
  });

  it('руки определяются по положению в кадре', () => {
    // В сыром (незеркальном) кадре левая рука игрока — правее.
    const two = assignHands([
      { x: 0.3, label: 'Left', fist: true },
      { x: 0.7, label: 'Right', fist: false },
    ]);
    expect(two).toEqual([
      { hand: 'l', fist: false },
      { hand: 'r', fist: true },
    ]);
    expect(assignHands([{ x: 0.5, label: 'Right', fist: true }])).toEqual([{ hand: 'l', fist: true }]);
  });
});
