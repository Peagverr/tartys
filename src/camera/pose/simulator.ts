import { LANDMARK_COUNT, LM } from './landmarks';
import type { Landmark, PoseFrame, Vec3 } from './types';

/**
 * Симулятор скелета. Строит 33 точки BlazePose из «суставных» параметров.
 * Нужен для трёх вещей: автотестов правил, демо-режима без камеры
 * и пиктограмм-подсказок «как правильно».
 *
 * Система координат: метры, x вправо по экрану (зеркально), y вниз, z — от камеры (к камере — минус).
 */

/** Рука: направления плеча и предплечья. θ — угол в плоскости тела от «вниз» (90 = в сторону, 180 = вверх, отрицательный — поперёк тела); ψ — наклон вперёд к камере. */
export interface SimArm {
  ua: number;
  uf: number;
  fa: number;
  ff: number;
}

export interface SimPose {
  /** Сдвиг всего тела по x, м. */
  shift: number;
  /** Боковой наклон корпуса, градусы (плюс — вправо по экрану). */
  lean: number;
  /** Наклон корпуса вперёд, градусы. */
  pitch: number;
  /** Глубина приседа 0..1. */
  squat: number;
  /** Ширина стойки 0..1. */
  spread: number;
  /** Колени внутрь 0..1. */
  kneeIn: number;
  l: SimArm;
  r: SimArm;
}

const arm = (ua: number, fa: number, uf = 0, ff = 0): SimArm => ({ ua, uf, fa, ff });

export const NEUTRAL: SimPose = {
  shift: 0,
  lean: 0,
  pitch: 0,
  squat: 0,
  spread: 0,
  kneeIn: 0,
  l: arm(8, 6),
  r: arm(8, 6),
};

const P = (patch: Partial<SimPose>): SimPose => ({ ...NEUTRAL, ...patch });

/** Библиотека поз: правильные и с типичными ошибками. */
export const POSES = {
  neutral: NEUTRAL,
  // Қылыш
  swordUp: P({ l: arm(199, 199), r: arm(199, 199) }),
  swordUpApart: P({ l: arm(150, 150), r: arm(150, 150) }),
  swordUpLow: P({ l: arm(215, 215, 60, 60), r: arm(215, 215, 60, 60) }),
  swordOneHand: P({ l: arm(8, 6), r: arm(199, 199) }),
  swordMid: P({ l: arm(215, 215, 80, 80), r: arm(215, 215, 80, 80) }),
  swordDown: P({ l: arm(-12, -35, 30, 50), r: arm(-12, -35, 30, 50) }),
  // Садақ (лук в левой руке)
  bowL: P({ l: arm(90, 90), r: arm(80, -100) }),
  bowR: P({ r: arm(90, 90), l: arm(80, -100) }),
  bowLowArm: P({ l: arm(50, 50), r: arm(80, -100) }),
  bowBent: P({ l: arm(90, 150), r: arm(80, -100) }),
  bowNoDraw: P({ l: arm(90, 90), r: arm(8, 6) }),
  tPose: P({ l: arm(90, 90), r: arm(90, 90) }),
  // Қалқан
  shield: P({ l: arm(10, 195, 70, 10), r: arm(10, 195, 70, 10) }),
  shieldLow: P({ l: arm(10, 100, 40, 60), r: arm(10, 100, 40, 60) }),
  shieldWide: P({ l: arm(80, 170), r: arm(80, 170) }),
  // Уклон
  dodgeL: P({ shift: -0.12, lean: -18 }),
  dodgeR: P({ shift: 0.12, lean: 18 }),
  dodgeHalfL: P({ shift: -0.05, lean: -8 }),
  dodgeHalfR: P({ shift: 0.05, lean: 8 }),
  // Тренировка
  squatDeep: P({ squat: 1, spread: 0.3, l: arm(-20, -20, 70, 70), r: arm(-20, -20, 70, 70) }),
  squatShallow: P({ squat: 0.38, spread: 0.3, l: arm(-20, -20, 70, 70), r: arm(-20, -20, 70, 70) }),
  squatValgus: P({ squat: 0.95, spread: 0.3, kneeIn: 1, l: arm(-20, -20, 70, 70), r: arm(-20, -20, 70, 70) }),
  squatStand: P({ spread: 0.3 }),
  jackOpen: P({ spread: 1, l: arm(160, 170), r: arm(160, 170) }),
  jackHalf: P({ spread: 1, l: arm(85, 85), r: arm(85, 85) }),
  lateralUp: P({ l: arm(90, 90), r: arm(90, 90) }),
  lateralLow: P({ l: arm(40, 40), r: arm(40, 40) }),
  lateralUneven: P({ l: arm(60, 60), r: arm(92, 92) }),
  pressRack: P({ l: arm(80, 175), r: arm(80, 175) }),
  pressTop: P({ l: arm(172, 176), r: arm(172, 176) }),
  pressHalf: P({ l: arm(125, 170), r: arm(125, 170) }),
} satisfies Record<string, SimPose>;

export type PoseName = keyof typeof POSES;

const SH_HALF = 0.19;
const UPPER = 0.3;
const FORE = 0.27;
const THIGH = 0.43;
const SHIN = 0.43;
const TORSO = 0.52;
const HIP_HALF = 0.1;

const rad = (d: number) => (d * Math.PI) / 180;

/** Направление руки в 3D: θ в плоскости тела (наружу — плюс), ψ — вперёд к камере. */
function armDir(side: 'l' | 'r', theta: number, psi: number): Vec3 {
  const out = side === 'l' ? -1 : 1;
  const c = Math.cos(rad(psi));
  return { x: out * c * Math.sin(rad(theta)), y: c * Math.cos(rad(theta)), z: -Math.sin(rad(psi)) };
}

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });

/** Строит 33 точки в «глобальных» метрах (пол — y = 0, вверх — минус). */
export function buildSkeleton(p: SimPose): Vec3[] {
  const pts: Vec3[] = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0 }));

  // Ноги: стопы стоят на полу, колени сгибаются вперёд (к камере), таз уходит назад и вниз.
  const flex = 100 * p.squat; // 180 - угол в колене
  const a = rad(0.45 * flex); // наклон голени
  const b = rad(0.55 * flex); // наклон бедра
  const hipY = -0.07 - SHIN * Math.cos(a) - THIGH * Math.cos(b);
  const hipZ = SHIN * Math.sin(a) * -1 + THIGH * Math.sin(b);
  const footHalf = HIP_HALF + 0.28 * p.spread;
  for (const s of ['l', 'r'] as const) {
    const sx = s === 'l' ? -1 : 1;
    const ankle = { x: p.shift + sx * footHalf, y: -0.07, z: 0 };
    const hip = { x: p.shift + sx * HIP_HALF, y: hipY, z: hipZ };
    const kneeX = ankle.x + (hip.x - ankle.x) * 0.5 - sx * 0.14 * p.kneeIn * p.squat;
    const knee = { x: kneeX, y: -0.07 - SHIN * Math.cos(a), z: -SHIN * Math.sin(a) };
    pts[s === 'l' ? LM.L_ANKLE : LM.R_ANKLE] = ankle;
    pts[s === 'l' ? LM.L_HIP : LM.R_HIP] = hip;
    pts[s === 'l' ? LM.L_KNEE : LM.R_KNEE] = knee;
    pts[s === 'l' ? LM.L_HEEL : LM.R_HEEL] = { x: ankle.x, y: -0.02, z: 0.05 };
    pts[s === 'l' ? LM.L_FOOT : LM.R_FOOT] = { x: ankle.x + sx * 0.03, y: -0.01, z: -0.14 };
  }

  // Корпус: от центра таза вверх, с боковым наклоном и наклоном вперёд.
  const hipMid = { x: p.shift, y: hipY, z: hipZ };
  const up: Vec3 = {
    x: Math.sin(rad(p.lean)) * Math.cos(rad(p.pitch)),
    y: -Math.cos(rad(p.lean)) * Math.cos(rad(p.pitch)),
    z: -Math.sin(rad(p.pitch)),
  };
  const side: Vec3 = { x: Math.cos(rad(p.lean)), y: Math.sin(rad(p.lean)), z: 0 };
  const shMid = add(hipMid, up, TORSO);
  for (const s of ['l', 'r'] as const) {
    const sx = s === 'l' ? -1 : 1;
    const sh = add(shMid, side, sx * SH_HALF);
    const ap = s === 'l' ? p.l : p.r;
    const el = add(sh, armDir(s, ap.ua, ap.uf), UPPER);
    const fd = armDir(s, ap.fa, ap.ff);
    const wr = add(el, fd, FORE);
    const ids = s === 'l'
      ? [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST, LM.L_PINKY, LM.L_INDEX, LM.L_THUMB]
      : [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST, LM.R_PINKY, LM.R_INDEX, LM.R_THUMB];
    pts[ids[0]] = sh;
    pts[ids[1]] = el;
    pts[ids[2]] = wr;
    pts[ids[3]] = add(add(wr, fd, 0.07), side, sx * 0.02);
    pts[ids[4]] = add(wr, fd, 0.08);
    pts[ids[5]] = add(add(wr, fd, 0.04), side, -sx * 0.03);
  }

  // Голова.
  const head = add(shMid, up, 0.25);
  const face = (dx: number, dy: number): Vec3 => add(add(add(head, side, dx), up, -dy), { x: 0, y: 0, z: -1 }, 0.09);
  pts[LM.NOSE] = face(0, 0);
  pts[1] = face(-0.02, -0.035);
  pts[LM.L_EYE] = face(-0.035, -0.035);
  pts[3] = face(-0.05, -0.035);
  pts[4] = face(0.02, -0.035);
  pts[LM.R_EYE] = face(0.035, -0.035);
  pts[6] = face(0.05, -0.035);
  pts[LM.L_EAR] = add(add(head, side, -0.075), up, 0.01);
  pts[LM.R_EAR] = add(add(head, side, 0.075), up, 0.01);
  pts[9] = face(-0.025, 0.04);
  pts[10] = face(0.025, 0.04);
  return pts;
}

export interface SimCamera {
  /** Высота кадра в метрах сцены (чем меньше — тем «ближе» камера). */
  frameHeight: number;
  /** Какая высота (м, вверх — минус) попадает в центр кадра. */
  centerY: number;
  aspect: number;
}

/** Камера видит человека целиком (стоит в 2–3 м). */
export const CAM_FULL: SimCamera = { frameHeight: 2.2, centerY: -0.95, aspect: 16 / 9 };
/** Камера ноутбука, человек сидит за столом: видно голову, плечи, руки. */
export const CAM_DESK: SimCamera = { frameHeight: 1.4, centerY: -1.35, aspect: 16 / 9 };

/** Проецирует скелет в кадр и собирает PoseFrame, как будто его вернула модель. */
export function toFrame(global: Vec3[], cam: SimCamera, t: number, noise = 0, rand: () => number = Math.random): PoseFrame {
  const hipMid = { x: (global[LM.L_HIP].x + global[LM.R_HIP].x) / 2, y: (global[LM.L_HIP].y + global[LM.R_HIP].y) / 2, z: (global[LM.L_HIP].z + global[LM.R_HIP].z) / 2 };
  const jitter = () => (noise ? (rand() - 0.5) * 2 * noise : 0);
  const image: Landmark[] = global.map((p) => {
    const x = 0.5 + p.x / (cam.frameHeight * cam.aspect) + jitter();
    const y = 0.5 + (p.y - cam.centerY) / cam.frameHeight + jitter();
    const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    return { x, y, z: p.z, v: inside ? 0.98 : 0.05 };
  });
  const world = global.map((p) => ({ x: p.x - hipMid.x, y: p.y - hipMid.y, z: p.z - hipMid.z }));
  return { t, image, world, aspect: cam.aspect };
}

export function lerpPose(a: SimPose, b: SimPose, k: number): SimPose {
  const m = (x: number, y: number) => x + (y - x) * k;
  const ma = (x: SimArm, y: SimArm): SimArm => ({ ua: m(x.ua, y.ua), uf: m(x.uf, y.uf), fa: m(x.fa, y.fa), ff: m(x.ff, y.ff) });
  return {
    shift: m(a.shift, b.shift),
    lean: m(a.lean, b.lean),
    pitch: m(a.pitch, b.pitch),
    squat: m(a.squat, b.squat),
    spread: m(a.spread, b.spread),
    kneeIn: m(a.kneeIn, b.kneeIn),
    l: ma(a.l, b.l),
    r: ma(a.r, b.r),
  };
}

export interface SimStep {
  pose: PoseName | SimPose;
  /** Время перехода в эту позу, мс. */
  move: number;
  /** Сколько держать позу, мс. */
  hold: number;
}

const resolve = (p: PoseName | SimPose): SimPose => (typeof p === 'string' ? POSES[p] : p);
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

/** Проигрывает сценарий поз — как будто человек двигается перед камерой. */
export class SimPlayer {
  private steps: SimStep[] = [];
  private from: SimPose = NEUTRAL;
  private idx = 0;
  private stepStart = 0;
  private current: SimPose = NEUTRAL;

  constructor(steps: SimStep[] = [], start = 0) {
    this.load(steps, start);
  }

  load(steps: SimStep[], start: number): void {
    this.steps = steps;
    this.from = this.current;
    this.idx = 0;
    this.stepStart = start;
  }

  /** Добавить шаги в конец очереди. */
  push(...steps: SimStep[]): void {
    this.steps.push(...steps);
  }

  get idle(): boolean {
    return this.idx >= this.steps.length;
  }

  poseAt(t: number): SimPose {
    while (this.idx < this.steps.length) {
      const st = this.steps[this.idx];
      const el = t - this.stepStart;
      const target = resolve(st.pose);
      if (el < st.move) {
        this.current = lerpPose(this.from, target, ease(el / Math.max(st.move, 1)));
        return this.current;
      }
      if (el < st.move + st.hold) {
        this.current = target;
        return this.current;
      }
      this.from = target;
      this.current = target;
      this.stepStart += st.move + st.hold;
      this.idx++;
    }
    return this.current;
  }
}

/** Прогоняет сценарий и отдаёт кадры с заданной частотой — удобно для тестов. */
export function simulate(steps: SimStep[], cam: SimCamera = CAM_FULL, fps = 30): PoseFrame[] {
  const player = new SimPlayer(steps, 0);
  const total = steps.reduce((s, x) => s + x.move + x.hold, 0);
  const frames: PoseFrame[] = [];
  for (let t = 0; t <= total; t += 1000 / fps) frames.push(toFrame(buildSkeleton(player.poseAt(t)), cam, t));
  return frames;
}
