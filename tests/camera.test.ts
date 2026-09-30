import { describe, expect, it } from 'vitest';
import { computeFeatures } from '../src/camera/features';
import { fromMediaPipe } from '../src/camera/pose/mediapipe';
import { CAM_DESK, CAM_FULL, NEUTRAL, simulate, type SimCamera, type SimPose, type SimStep } from '../src/camera/pose/simulator';
import { PullGestures, type PullOutput } from '../src/camera/pull-gestures';
import fixture from './fixtures/warrior-pose.json';

const arm = (ua: number, fa: number, uf = 0, ff = 0) => ({ ua, uf, fa, ff });
const P = (patch: Partial<SimPose>): SimPose => ({ ...NEUTRAL, ...patch });

// Руки держат «канат» перед грудью.
const GRIP = P({ l: arm(20, -30, 45, 70), r: arm(20, -30, 45, 70) });
// Обе кисти ушли влево по экрану (у зеркального кадра — влево от игрока).
const PULLED_LEFT = P({ l: arm(70, 80, 25, 25), r: arm(-20, -70, 55, 45) });
const PULLED_RIGHT = P({ r: arm(70, 80, 25, 25), l: arm(-20, -70, 55, 45) });
const LEAN_LEFT = P({ ...GRIP, shift: -0.12, lean: -18 });
const LEAN_HALF_LEFT = P({ ...GRIP, shift: -0.03, lean: -5 });

function run(steps: SimStep[], dir: -1 | 1, cam: SimCamera = CAM_DESK) {
  const g = new PullGestures(dir);
  const outs: (PullOutput & { t: number })[] = [];
  for (const fr of simulate(steps, cam)) outs.push({ ...g.update(computeFeatures(fr), fr.t), t: fr.t });
  return { g, outs, yanks: outs.filter((o) => o.yank).length, braceOn: outs.some((o) => o.brace === true) };
}

const calib: SimStep = { pose: GRIP, move: 200, hold: 1000 };

describe('жесты «Тяни руками»', () => {
  it('стоит прямо — передышка: ни рывков, ни упора', () => {
    const r = run([calib, { pose: GRIP, move: 0, hold: 2000 }], -1);
    expect(r.g.readout.calibrated).toBe(true);
    expect(r.yanks).toBe(0);
    expect(r.braceOn).toBe(false);
  });

  it('резкий рывок руками в свою сторону — ровно один рывок', () => {
    for (const cam of [CAM_DESK, CAM_FULL]) {
      const r = run([calib, { pose: PULLED_LEFT, move: 140, hold: 500 }, { pose: GRIP, move: 600, hold: 300 }], -1, cam);
      expect(r.yanks).toBe(1);
    }
  });

  it('медленное движение рук — не рывок', () => {
    const r = run([calib, { pose: PULLED_LEFT, move: 1200, hold: 400 }], -1);
    expect(r.yanks).toBe(0);
  });

  it('рывок в чужую сторону не засчитывается', () => {
    const r = run([calib, { pose: PULLED_RIGHT, move: 140, hold: 500 }], -1);
    expect(r.yanks).toBe(0);
    // А у красных, для которых право — своя сторона, засчитывается.
    const red = run([calib, { pose: PULLED_RIGHT, move: 140, hold: 500 }], 1);
    expect(red.yanks).toBe(1);
  });

  it('наклон в свою сторону — упор, выпрямился — передышка', () => {
    const r = run([calib, { pose: LEAN_LEFT, move: 300, hold: 800 }, { pose: GRIP, move: 300, hold: 600 }], -1);
    expect(r.braceOn).toBe(true);
    expect(r.outs.some((o) => o.brace === false)).toBe(true);
    expect(r.g.readout.bracing).toBe(false);
    // Наклон — не рывок: кисти считаются относительно плеч.
    expect(r.yanks).toBe(0);
  });

  it('лёгкое покачивание упор не включает', () => {
    const r = run([calib, { pose: LEAN_HALF_LEFT, move: 300, hold: 800 }, { pose: GRIP, move: 300, hold: 300 }], -1);
    expect(r.braceOn).toBe(false);
  });

  it('человек пропал из кадра — упор отпускается', () => {
    const g = new PullGestures(-1);
    const frames = simulate([calib, { pose: LEAN_LEFT, move: 300, hold: 500 }], CAM_DESK);
    let t = 0;
    for (const fr of frames) {
      g.update(computeFeatures(fr), fr.t);
      t = fr.t;
    }
    expect(g.readout.bracing).toBe(true);
    const out = g.update(null, t + 800);
    expect(out.brace).toBe(false);
  });

  it('реальная поза с фотографии (MediaPipe) без движения не даёт ложных срабатываний', () => {
    const pt = (a: number[]) => ({ x: a[0], y: a[1], z: a[2], visibility: a[3] });
    const g = new PullGestures(-1);
    let yanks = 0;
    let brace = false;
    for (let i = 0; i < 90; i++) {
      const t = i * 33;
      const o = g.update(computeFeatures(fromMediaPipe(fixture.image.map(pt), fixture.world.map(pt), fixture.aspect, t)), t);
      if (o.yank) yanks++;
      if (o.brace) brace = true;
    }
    expect(g.readout.calibrated).toBe(true);
    expect(yanks).toBe(0);
    expect(brace).toBe(false);
  });
});
