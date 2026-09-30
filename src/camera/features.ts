import { angle3, clamp, dist2, mid2, mid3, sub3, vecAngle2, vecAngle3 } from './geometry';
import { LM, SIDE_LM } from './pose/landmarks';
import type { Landmark, PoseFrame, Side, Vec2 } from './pose/types';

/**
 * Признаки тела — всё, из чего правила распознают движения и ошибки.
 * Расстояния на экране нормированы на ширину плеч (sw), поэтому правила
 * работают одинаково и когда человек близко к камере, и когда далеко.
 */
export interface ArmFeatures {
  shoulder: Vec2;
  elbow: Vec2;
  wrist: Vec2;
  /** Угол в локте, 180 = рука прямая. */
  elbowAngle: number;
  /** Отведение плеча: 0 = рука вдоль тела, 90 = в сторону горизонтально, 180 = вверх. */
  abduction: number;
  /** Высота кисти над линией плеч, в ширинах плеч (вверх — плюс). */
  wristUp: number;
  /** Насколько кисть вынесена наружу от своего плеча, в ширинах плеч. */
  wristOut: number;
  visible: boolean;
}

export interface LegFeatures {
  hip: Vec2;
  knee: Vec2;
  ankle: Vec2;
  /** Угол в колене, 180 = нога прямая. */
  kneeAngle: number;
  /** Длина бедра на экране (в тех же единицах, что и sw). */
  thigh: number;
  visible: boolean;
}

export interface Visibility {
  head: boolean;
  shoulders: boolean;
  arms: boolean;
  hips: boolean;
  legs: boolean;
  /** Видно всё, что нужно для игры (голова, плечи, руки). */
  upper: boolean;
  /** Видно всё тело целиком. */
  full: boolean;
}

export interface BodyFeatures {
  t: number;
  frame: PoseFrame;
  /** Ширина плеч в экранных единицах — «линейка» для всех расстояний. */
  sw: number;
  nose: Vec2;
  shMid: Vec2;
  hipMid: Vec2;
  /** Высота носа над линией плеч, в sw. */
  noseUp: number;
  arm: Record<Side, ArmFeatures>;
  leg: Record<Side, LegFeatures>;
  /** Наклон корпуса от вертикали, градусы (по 3D-точкам). */
  torsoLean: number;
  /** Расстояние между кистями, в sw. */
  wristGap: number;
  /** Расстояние между коленями и между щиколотками, в sw. */
  kneeGap: number;
  ankleGap: number;
  vis: Visibility;
}

const VIS_MIN = 0.5;

function seen(p: Landmark): boolean {
  return p.v >= VIS_MIN && p.x > -0.02 && p.x < 1.02 && p.y > -0.02 && p.y < 1.02;
}

/** Переводит нормированную точку в «изотропные» координаты (x растянут на соотношение сторон). */
function iso(p: Landmark, aspect: number): Vec2 {
  return { x: p.x * aspect, y: p.y };
}

export function computeFeatures(frame: PoseFrame): BodyFeatures | null {
  const { image: im, world: w, aspect } = frame;
  if (im.length < 33 || w.length < 33) return null;

  const P = (i: number) => iso(im[i], aspect);
  const lSh = P(LM.L_SHOULDER);
  const rSh = P(LM.R_SHOULDER);
  const shouldersSeen = seen(im[LM.L_SHOULDER]) && seen(im[LM.R_SHOULDER]);
  const sw = Math.max(dist2(lSh, rSh), 1e-3);
  const shMid = mid2(lSh, rSh);
  const hipMid = mid2(P(LM.L_HIP), P(LM.R_HIP));
  const nose = P(LM.NOSE);
  const hipsSeen = seen(im[LM.L_HIP]) && seen(im[LM.R_HIP]);

  const arm = {} as Record<Side, ArmFeatures>;
  const leg = {} as Record<Side, LegFeatures>;

  for (const s of ['l', 'r'] as const) {
    const ids = SIDE_LM[s];
    const sh = P(ids.shoulder);
    const el = P(ids.elbow);
    const wr = P(ids.wrist);
    // «Вниз по корпусу»: к бедру той же стороны, если его видно, иначе строго вниз.
    const down = hipsSeen ? { x: P(ids.hip).x - sh.x, y: P(ids.hip).y - sh.y } : { x: 0, y: 1 };
    const upperArm = { x: el.x - sh.x, y: el.y - sh.y };
    // В зеркальном виде левая рука пользователя — слева на экране, значит «наружу» для неё — влево.
    const outward = s === 'l' ? sh.x - wr.x : wr.x - sh.x;
    arm[s] = {
      shoulder: sh,
      elbow: el,
      wrist: wr,
      elbowAngle: angle3(w[ids.shoulder], w[ids.elbow], w[ids.wrist]),
      abduction: vecAngle2(upperArm, down),
      wristUp: (shMid.y - wr.y) / sw,
      wristOut: outward / sw,
      visible: seen(im[ids.elbow]) && seen(im[ids.wrist]),
    };

    const hip = P(ids.hip);
    const knee = P(ids.knee);
    const ankle = P(ids.ankle);
    leg[s] = {
      hip,
      knee,
      ankle,
      kneeAngle: angle3(w[ids.hip], w[ids.knee], w[ids.ankle]),
      thigh: dist2(hip, knee),
      visible: seen(im[ids.knee]) && seen(im[ids.ankle]),
    };
  }

  const wShMid = mid3(w[LM.L_SHOULDER], w[LM.R_SHOULDER]);
  const wHipMid = mid3(w[LM.L_HIP], w[LM.R_HIP]);
  const torsoLean = hipsSeen ? vecAngle3(sub3(wShMid, wHipMid), { x: 0, y: -1, z: 0 }) : 0;

  const vis: Visibility = {
    head: seen(im[LM.NOSE]),
    shoulders: shouldersSeen,
    arms: arm.l.visible && arm.r.visible,
    hips: hipsSeen,
    legs: leg.l.visible && leg.r.visible,
    upper: false,
    full: false,
  };
  vis.upper = vis.head && vis.shoulders && vis.arms;
  vis.full = vis.upper && vis.hips && vis.legs;

  return {
    t: frame.t,
    frame,
    sw,
    nose,
    shMid,
    hipMid,
    noseUp: (shMid.y - nose.y) / sw,
    arm,
    leg,
    torsoLean,
    wristGap: dist2(arm.l.wrist, arm.r.wrist) / sw,
    kneeGap: dist2(leg.l.knee, leg.r.knee) / sw,
    ankleGap: dist2(leg.l.ankle, leg.r.ankle) / sw,
    vis,
  };
}

/** Высота носа над плечами у среднего человека — запасное значение, если лицо не видно. */
export const TYPICAL_NOSE_UP = 0.75;

/** Высота «над головой»: кисть выше макушки с запасом. */
export function overheadLine(f: BodyFeatures): number {
  const n = f.vis.head ? f.noseUp : TYPICAL_NOSE_UP;
  return clamp(n, 0.4, 1.2) + 0.3;
}
