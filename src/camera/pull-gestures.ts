// Жесты «Тяни руками» для фронтальной веб-камеры.
//
// Кадр зеркальный: левая сторона экрана = левая сторона игрока. Своя сторона
// каната — dir = -1 (синие, тянут влево) или +1 (красные, вправо).
//
//  • Рывок — обе кисти резко уходят в свою сторону относительно плеч
//    (скорость, а не положение: медленное движение не считается).
//  • Упор — корпус наклонён или смещён в свою сторону от положения калибровки.
//  • Передышка — стоять прямо.
//
// Все расстояния — в ширинах плеч, поэтому неважно, близко человек к камере или далеко.

import type { BodyFeatures } from './features';

export const PULL = {
  /** Сколько кадров калибровки «стою прямо». */
  calibFrames: 20,
  /** Упор: смещение плеч в свою сторону (ширин плеч) — включить / выключить. */
  braceOn: 0.35,
  braceOff: 0.2,
  /** Рывок: каждая кисть сдвинулась в свою сторону минимум на столько… */
  yankEach: 0.5,
  /** …а середина кистей — на столько… */
  yankTotal: 0.75,
  /** …не дольше чем за это время, мс. */
  yankWindowMs: 260,
  /** Пауза после рывка, мс (движок всё равно не даст рвануть чаще). */
  yankCooldownMs: 450,
  /** Потерял человека в кадре дольше — отпускаем упор. */
  lostMs: 500,
};

export interface PullOutput {
  yank: boolean;
  /** true / false — упор включился / выключился на этом кадре; null — без изменений. */
  brace: boolean | null;
}

export interface PullReadout {
  calibrated: boolean;
  calibProgress: number;
  visible: boolean;
  lean: number;
  hands: number;
  bracing: boolean;
  lastYankAt: number;
}

interface Sample {
  t: number;
  l: number;
  r: number;
}

export class PullGestures {
  private calib: number[] = [];
  private base: number | null = null;
  private hist: Sample[] = [];
  private bracing = false;
  private lastYank = -1e9;
  private lastSeen = -1e9;
  private lean = 0;
  private hands = 0;
  private visible = false;

  constructor(public dir: -1 | 1) {}

  /** Начать калибровку заново (например, человек пересел). */
  recalibrate(): void {
    this.calib = [];
    this.base = null;
    this.hist = [];
  }

  get readout(): PullReadout {
    return {
      calibrated: this.base !== null,
      calibProgress: this.base !== null ? 1 : this.calib.length / PULL.calibFrames,
      visible: this.visible,
      lean: this.lean,
      hands: this.hands,
      bracing: this.bracing,
      lastYankAt: this.lastYank,
    };
  }

  update(f: BodyFeatures | null, t: number): PullOutput {
    const out: PullOutput = { yank: false, brace: null };
    const ok = !!f && f.vis.shoulders && f.vis.arms;
    this.visible = ok;
    if (!ok) {
      if (this.bracing && t - this.lastSeen > PULL.lostMs) {
        this.bracing = false;
        out.brace = false;
      }
      this.hist = [];
      return out;
    }
    this.lastSeen = t;
    const sw = f.sw;
    const x = f.shMid.x / sw;

    if (this.base === null) {
      this.calib.push(x);
      if (this.calib.length >= PULL.calibFrames) {
        const s = [...this.calib].sort((a, b) => a - b);
        this.base = s[Math.floor(s.length / 2)];
      }
      return out;
    }

    // Упор: насколько корпус ушёл в свою сторону от стойки «прямо».
    this.lean = (x - this.base) * this.dir;
    if (!this.bracing && this.lean > PULL.braceOn) {
      this.bracing = true;
      out.brace = true;
    } else if (this.bracing && this.lean < PULL.braceOff) {
      this.bracing = false;
      out.brace = false;
    }

    // Рывок: кисти относительно плеч, чтобы наклон корпуса рывком не считался.
    const l = ((f.arm.l.wrist.x - f.shMid.x) / sw) * this.dir;
    const r = ((f.arm.r.wrist.x - f.shMid.x) / sw) * this.dir;
    this.hands = (l + r) / 2;
    this.hist.push({ t, l, r });
    while (this.hist.length && t - this.hist[0].t > PULL.yankWindowMs) this.hist.shift();
    if (t - this.lastYank > PULL.yankCooldownMs) {
      for (const h of this.hist) {
        if (l - h.l >= PULL.yankEach && r - h.r >= PULL.yankEach && (l + r - h.l - h.r) / 2 >= PULL.yankTotal) {
          out.yank = true;
          this.lastYank = t;
          this.hist = [];
          break;
        }
      }
    }
    return out;
  }
}
