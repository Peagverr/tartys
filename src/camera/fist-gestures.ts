// Жесты кулаками для игры сидя за столом.
//  • Левый кулак сжат — упор (держится, пока сжат); разжал — упор снят.
//  • Правый кулак сжал — один рывок. Следующий — только после того, как разжал.
//  • Открытые ладони — передышка.
// Кадр считается устойчивым через пару кадров подряд, чтобы дрожание распознавания не срабатывало.

export interface HandObs {
  /** Рука игрока (не экранная сторона). */
  hand: 'l' | 'r';
  fist: boolean;
}

export const FIST = {
  onFrames: 2,
  offFrames: 3,
  yankCooldownMs: 250,
};

export interface FistOutput {
  yank: boolean;
  brace: boolean | null;
}

export class FistGestures {
  private lOn = 0;
  private lOff = 0;
  private rOn = 0;
  private rOff = 0;
  private rFist = false;
  private bracing = false;
  private lastYank = -1e9;
  private seen = false;
  visible = false;
  leftFist = false;

  get readout() {
    return { calibrated: this.seen, bracing: this.bracing, visible: this.visible, rightFist: this.rFist };
  }

  /** Для совместимости с экраном подготовки: калибровка жестам кулаками не нужна. */
  recalibrate(): void {}

  update(hands: HandObs[] | null, t: number): FistOutput {
    const out: FistOutput = { yank: false, brace: null };
    const list = hands ?? [];
    this.visible = list.length > 0;
    if (this.visible) this.seen = true;
    const l = list.find((h) => h.hand === 'l');
    const r = list.find((h) => h.hand === 'r');

    // Левый — упор.
    if (l?.fist) {
      this.lOn++;
      this.lOff = 0;
    } else {
      this.lOff++;
      this.lOn = 0;
    }
    this.leftFist = this.lOn >= FIST.onFrames;
    if (!this.bracing && this.lOn >= FIST.onFrames) {
      this.bracing = true;
      out.brace = true;
    } else if (this.bracing && this.lOff >= FIST.offFrames) {
      this.bracing = false;
      out.brace = false;
    }

    // Правый — рывок по сжатию.
    if (r?.fist) {
      this.rOn++;
      this.rOff = 0;
    } else {
      this.rOff++;
      this.rOn = 0;
    }
    if (!this.rFist && this.rOn >= FIST.onFrames) {
      this.rFist = true;
      if (t - this.lastYank >= FIST.yankCooldownMs) {
        out.yank = true;
        this.lastYank = t;
      }
    } else if (this.rFist && this.rOff >= FIST.offFrames) {
      this.rFist = false;
    }
    return out;
  }
}

/**
 * Какая рука чья. Камера не зеркальная, а MediaPipe подписывает руки так, будто кадр зеркальный,
 * поэтому надёжнее смотреть на положение: у двух рук левая рука игрока — правее в сыром кадре.
 */
export function assignHands(raw: { x: number; label: string; fist: boolean }[]): HandObs[] {
  if (raw.length >= 2) {
    const [a, b] = [...raw].sort((p, q) => q.x - p.x);
    return [
      { hand: 'l', fist: a.fist },
      { hand: 'r', fist: b.fist },
    ];
  }
  return raw.map((h) => ({ hand: h.label === 'Right' ? 'l' : 'r', fist: h.fist }));
}
