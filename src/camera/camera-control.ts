// Управление камерой: веб-камера → поза (MediaPipe, прямо в браузере) → жесты → те же
// команды, что у клавиатуры. Модуль грузится динамически, только когда игрок выбрал камеру.

import type { Command, Side } from '../engine/match';
import { CameraError, CameraSource, type LoadStage } from './camera-source';
import { computeFeatures } from './features';
import { BONES } from './pose/landmarks';
import { PoseSmoother } from './pose/smoother';
import type { PoseFrame } from './pose/types';
import { PULL, PullGestures } from './pull-gestures';

export { CameraError };
export type { LoadStage };

const dirOf = (side: Side): -1 | 1 => (side === 0 ? -1 : 1);

export class CameraControl {
  readonly gestures: PullGestures;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly smoother = new PoseSmoother();
  private frame: PoseFrame | null = null;
  private sentBrace = false;
  private yankFlash = -1e9;
  private _enabled = false;
  /** Счётчики для экрана подготовки: игрок попробовал оба жеста. */
  triedYank = false;
  triedBrace = false;

  private constructor(
    private readonly src: CameraSource,
    private readonly emit: (cmd: Command) => void,
    private side: Side,
  ) {
    this.gestures = new PullGestures(dirOf(side));
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cam-canvas';
    this.canvas.width = 320;
    this.canvas.height = 180;
    this.ctx = this.canvas.getContext('2d')!;
  }

  static async open(side: Side, emit: (cmd: Command) => void, onStage: (s: LoadStage) => void): Promise<CameraControl> {
    const src = await CameraSource.open(onStage);
    return new CameraControl(src, emit, side);
  }

  setSide(side: Side): void {
    if (side === this.side) return;
    this.side = side;
    this.gestures.dir = dirOf(side);
    this.gestures.recalibrate();
  }

  /** Отдавать ли команды в игру (только во время матча). */
  set enabled(on: boolean) {
    if (on === this._enabled) return;
    this._enabled = on;
    if (!on && this.sentBrace) {
      this.sentBrace = false;
      this.emit({ side: this.side, kind: 'brace', on: false });
    }
    if (on && this.gestures.readout.bracing) {
      this.sentBrace = true;
      this.emit({ side: this.side, kind: 'brace', on: true });
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Вызывать каждый кадр. */
  tick(now: number): void {
    const raw = this.src.read(now);
    if (raw && raw !== this.frame) {
      const f = this.smoother.apply(raw);
      this.frame = f;
      const out = this.gestures.update(computeFeatures(f), now);
      if (out.yank) {
        this.triedYank = true;
        this.yankFlash = now;
        if (this._enabled) this.emit({ side: this.side, kind: 'yank' });
      }
      if (out.brace !== null) {
        if (out.brace) this.triedBrace = true;
        if (this._enabled && out.brace !== this.sentBrace) {
          this.sentBrace = out.brace;
          this.emit({ side: this.side, kind: 'brace', on: out.brace });
        }
      }
    } else if (!raw) {
      const out = this.gestures.update(null, now);
      if (out.brace === false && this.sentBrace) {
        this.sentBrace = false;
        this.emit({ side: this.side, kind: 'brace', on: false });
      }
    }
    this.draw(now);
  }

  /** Текущая стойка для подписи. */
  label(now: number): [string, string] {
    const r = this.gestures.readout;
    if (!r.visible) return ['Не вижу тебя - встань в кадр', 'bad'];
    if (!r.calibrated) return [`Стой прямо - калибровка ${Math.round(r.calibProgress * 100)}%`, ''];
    if (now - this.yankFlash < 350) return ['РЫВОК!', 'hot'];
    if (r.bracing) return ['УПОР', 'hot'];
    return ['ПЕРЕДЫШКА', ''];
  }

  private draw(now: number): void {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const v = this.src.video;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // Видео зеркально — как в зеркале, левая рука слева.
    if (v.readyState >= 2) {
      const ar = v.videoWidth / v.videoHeight || 16 / 9;
      const dw = Math.max(W, H * ar);
      const dh = dw / ar;
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.globalAlpha = 0.75;
      ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // Своя сторона каната — стрелка по краю.
    const own = this.gestures.dir < 0 ? 0 : W;
    const g = ctx.createLinearGradient(own, 0, W / 2, 0);
    g.addColorStop(0, this.side === 0 ? 'rgba(61,123,255,0.45)' : 'rgba(255,75,75,0.45)');
    g.addColorStop(0.35, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Скелет (координаты кадра уже зеркальные).
    const f = this.frame;
    if (f && this.gestures.readout.visible) {
      const ar = f.aspect;
      const dw = Math.max(W, H * ar);
      const dh = dw / ar;
      const ox = (W - dw) / 2;
      const oy = (H - dh) / 2;
      const P = (i: number) => ({ x: ox + f.image[i].x * dw, y: oy + f.image[i].y * dh });
      const r = this.gestures.readout;
      ctx.strokeStyle = r.bracing ? '#ffd166' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (const [a, b] of BONES) {
        if (f.image[a].v < 0.5 || f.image[b].v < 0.5) continue;
        const pa = P(a);
        const pb = P(b);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
      if (now - this.yankFlash < 350) {
        ctx.fillStyle = 'rgba(255, 209, 102, 0.35)';
        ctx.fillRect(0, 0, W, H);
      }
    }
    // Шкала наклона: где включается упор.
    const r = this.gestures.readout;
    if (r.calibrated) {
      const bw = W - 24;
      const x0 = 12;
      const y0 = H - 12;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x0, y0 - 6, bw, 6);
      const k = Math.max(0, Math.min(1, r.lean / (PULL.braceOn * 2)));
      ctx.fillStyle = r.bracing ? '#ffd166' : '#4ade80';
      if (this.gestures.dir < 0) ctx.fillRect(x0 + bw / 2 - (bw / 2) * k, y0 - 6, (bw / 2) * k, 6);
      else ctx.fillRect(x0 + bw / 2, y0 - 6, (bw / 2) * k, 6);
      ctx.fillStyle = '#fff';
      const mark = (bw / 2) * 0.5 * this.gestures.dir;
      ctx.fillRect(x0 + bw / 2 + mark - 1, y0 - 9, 2, 12);
    }
    ctx.restore();
  }

  close(): void {
    this.enabled = false;
    this.src.stop();
  }
}
