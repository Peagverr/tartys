import { OneEuro } from './oneEuro';
import { LANDMARK_COUNT } from './landmarks';
import type { PoseFrame } from './types';

/** Сглаживает все 33 точки кадра (экранные и мировые координаты). */
export class PoseSmoother {
  private img: OneEuro[][] = [];
  private wld: OneEuro[][] = [];

  constructor(minCutoff = 1.5, beta = 0.05) {
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      this.img.push([new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta)]);
      this.wld.push([new OneEuro(minCutoff, beta * 20), new OneEuro(minCutoff, beta * 20), new OneEuro(minCutoff, beta * 20)]);
    }
  }

  apply(f: PoseFrame): PoseFrame {
    const t = f.t;
    return {
      t,
      aspect: f.aspect,
      image: f.image.map((p, i) => ({
        x: this.img[i][0].filter(p.x, t),
        y: this.img[i][1].filter(p.y, t),
        z: p.z,
        v: p.v,
      })),
      world: f.world.map((p, i) => ({
        x: this.wld[i][0].filter(p.x, t),
        y: this.wld[i][1].filter(p.y, t),
        z: this.wld[i][2].filter(p.z, t),
      })),
    };
  }

  reset(): void {
    for (const a of this.img) for (const f of a) f.reset();
    for (const a of this.wld) for (const f of a) f.reset();
  }
}
