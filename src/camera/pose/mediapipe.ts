import type { PoseFrame } from './types';

interface MpPoint {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * Переводит ответ MediaPipe в наш PoseFrame и зеркалит его:
 * пользователь видит себя как в зеркале, и «левая рука» = левая на экране.
 */
export function fromMediaPipe(image: MpPoint[], world: MpPoint[], aspect: number, t: number): PoseFrame {
  return {
    t,
    aspect,
    image: image.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z, v: p.visibility ?? 1 })),
    world: world.map((p) => ({ x: -p.x, y: p.y, z: p.z })),
  };
}
