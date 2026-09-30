// Клавиатура и сенсорные кнопки → команды движка.
// Автоповтор клавиш игнорируется: удержание кнопки рывка не даёт серию рывков.

import type { Command, Side } from '../engine/match';

type Act = 'yank' | 'brace';

const SOLO_KEYS: Record<string, Act> = {
  KeyW: 'yank',
  Space: 'yank',
  ArrowUp: 'yank',
  KeyS: 'brace',
  ShiftLeft: 'brace',
  ShiftRight: 'brace',
  ArrowDown: 'brace',
};

const DUO_KEYS: Record<string, [Side, Act]> = {
  KeyW: [0, 'yank'],
  KeyS: [0, 'brace'],
  ArrowUp: [1, 'yank'],
  ArrowDown: [1, 'brace'],
  Numpad8: [1, 'yank'],
  Numpad5: [1, 'brace'],
};

export class Input {
  /** Кто сейчас держит упор: коды клавиш и id касаний, по сторонам. */
  private holders: [Set<string>, Set<string>] = [new Set(), new Set()];
  private duo = false;
  private enabled = false;
  private cleanups: (() => void)[] = [];

  constructor(private readonly emit: (cmd: Command) => void) {}

  /** duo — двое на одном устройстве, иначе игрок один (левая сторона). */
  start(duo: boolean): void {
    this.duo = duo;
    this.enabled = true;
    this.releaseAll();
  }

  stop(): void {
    // Сначала отпускаем упор (команда уйдёт в очередь), потом отключаемся.
    this.releaseAll();
    this.enabled = false;
  }

  private map(code: string): [Side, Act] | null {
    if (this.duo) return DUO_KEYS[code] ?? null;
    const act = SOLO_KEYS[code];
    return act ? [0, act] : null;
  }

  private press(side: Side, act: Act, holder: string): void {
    if (!this.enabled) return;
    if (act === 'yank') {
      this.emit({ side, kind: 'yank' });
      return;
    }
    this.holders[side].add(holder);
    this.emit({ side, kind: 'brace', on: true });
  }

  private release(side: Side, act: Act, holder: string): void {
    if (act !== 'brace') return;
    const set = this.holders[side];
    if (!set.delete(holder)) return;
    if (set.size === 0 && this.enabled) this.emit({ side, kind: 'brace', on: false });
  }

  private releaseAll(): void {
    for (const side of [0, 1] as const) {
      if (this.holders[side].size > 0 && this.enabled) this.emit({ side, kind: 'brace', on: false });
      this.holders[side].clear();
    }
  }

  attachKeyboard(): void {
    const down = (e: KeyboardEvent) => {
      const m = this.map(e.code);
      if (!m || !this.enabled) return;
      e.preventDefault();
      if (e.repeat) return;
      this.press(m[0], m[1], e.code);
    };
    const up = (e: KeyboardEvent) => {
      const m = this.map(e.code);
      if (m) this.release(m[0], m[1], e.code);
    };
    const blur = () => this.releaseAll();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.cleanups.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });
  }

  /** Кнопки с data-act="yank|brace" внутри el управляют стороной side. */
  attachPad(el: HTMLElement, side: Side): void {
    const onDown = (e: PointerEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      e.preventDefault();
      const act = btn.dataset.act as Act;
      if (act === 'brace') btn.setPointerCapture(e.pointerId);
      btn.classList.add('down');
      this.press(side, act, `p${e.pointerId}`);
    };
    const onUp = (e: PointerEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      btn.classList.remove('down');
      this.release(side, btn.dataset.act as Act, `p${e.pointerId}`);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
