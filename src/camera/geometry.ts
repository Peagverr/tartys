import type { Vec2, Vec3 } from './pose/types';

export const RAD2DEG = 180 / Math.PI;

export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Линейно переводит v из [a..b] в [0..1] с обрезкой. Работает и когда a > b. */
export const norm = (v: number, a: number, b: number): number => clamp((v - a) / (b - a));

export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const mid2 = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const mid3 = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/** Угол ABC в вершине B (градусы, 0..180) по трём точкам в 3D. */
export function angle3(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const lu = Math.hypot(ux, uy, uz);
  const lv = Math.hypot(vx, vy, vz);
  if (lu < 1e-6 || lv < 1e-6) return 180;
  const cos = clamp((ux * vx + uy * vy + uz * vz) / (lu * lv), -1, 1);
  return Math.acos(cos) * RAD2DEG;
}

/** Угол между векторами u и v на плоскости (градусы, 0..180). */
export function vecAngle2(u: Vec2, v: Vec2): number {
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  if (lu < 1e-6 || lv < 1e-6) return 0;
  return Math.acos(clamp((u.x * v.x + u.y * v.y) / (lu * lv), -1, 1)) * RAD2DEG;
}

/** Угол между векторами в 3D (градусы, 0..180). */
export function vecAngle3(u: Vec3, v: Vec3): number {
  const lu = Math.hypot(u.x, u.y, u.z);
  const lv = Math.hypot(v.x, v.y, v.z);
  if (lu < 1e-6 || lv < 1e-6) return 0;
  return Math.acos(clamp((u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv), -1, 1)) * RAD2DEG;
}

export const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
