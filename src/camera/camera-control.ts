// Управление камерой: веб-камера → руки и жесты (MediaPipe Gesture Recognizer, прямо в браузере)
// → те же команды, что у клавиатуры. Модуль грузится динамически, только когда игрок выбрал камеру.
//
//  • Левый кулак — упор (держится, пока сжат).
//  • Правый кулак — рывок (одно сжатие — один рывок).
//  • Открытые ладони — передышка.

import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from '@mediapipe/tasks-vision';
import type { Command, Side } from '../engine/match';
import { CameraError } from './camera-source';
import { assignHands, FistGestures } from './fist-gestures';

export { CameraError };
export type LoadStage = 'camera' | 'model' | 'ready';

const BASE = import.meta.env.BASE_URL;
/** Официальная модель MediaPipe для распознавания жестов рук (около 8 МБ). */
const GESTURE_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task';

/** Связи 21 точки руки — для отрисовки. */
const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

async function openStream(): Promise<{ video: HTMLVideoElement; stream: MediaStream }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('Браузер не дает доступ к камере', 'Открой сайт по https:// в Chrome, Edge, Safari или Firefox - или играй с клавиатуры.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('Доступ к камере запрещен', 'Нажми на значок камеры в адресной строке, разреши доступ и обнови страницу. Или играй с клавиатуры и кнопок.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('Камера не найдена', 'Подключи веб-камеру или играй с клавиатуры и кнопок.');
    }
    if (name === 'NotReadableError') {
      throw new CameraError('Камера занята другой программой', 'Закрой Zoom, Teams или другую вкладку с камерой и попробуй снова.');
    }
    throw new CameraError('Не удалось включить камеру', String((e as Error)?.message ?? e));
  }
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.srcObject = stream;
  await video.play();
  await new Promise<void>((res) => {
    if (video.readyState >= 2) res();
    else video.onloadeddata = () => res();
  });
  return { video, stream };
}

async function createRecognizer(): Promise<GestureRecognizer> {
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
  const make = (delegate: 'GPU' | 'CPU') =>
    GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: GESTURE_MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  try {
    return await make('GPU');
  } catch {
    return make('CPU');
  }
}

export class CameraControl {
  readonly gestures = new FistGestures();
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private result: GestureRecognizerResult | null = null;
  private lastVideoTime = -1;
  private lastTs = 0;
  private sentBrace = false;
  private yankFlash = -1e9;
  private _enabled = false;
  triedYank = false;
  triedBrace = false;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly stream: MediaStream,
    private readonly recognizer: GestureRecognizer,
    private readonly emit: (cmd: Command) => void,
    private side: Side,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cam-canvas';
    this.canvas.width = 320;
    this.canvas.height = 180;
    this.ctx = this.canvas.getContext('2d')!;
  }

  static async open(side: Side, emit: (cmd: Command) => void, onStage: (s: LoadStage) => void): Promise<CameraControl> {
    onStage('camera');
    const { video, stream } = await openStream();
    onStage('model');
    try {
      const rec = await createRecognizer();
      onStage('ready');
      return new CameraControl(video, stream, rec, emit, side);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw new CameraError('Не удалось загрузить распознавание рук', `Проверь интернет и обнови страницу (${(e as Error)?.message ?? e}).`);
    }
  }

  /** Сторона нужна только для команд; жесты кулаками от стороны не зависят. */
  setSide(side: Side): void {
    this.side = side;
  }

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

  tick(now: number): void {
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const ts = Math.max(now, this.lastTs + 1);
      this.lastTs = ts;
      try {
        this.result = this.recognizer.recognizeForVideo(v, ts);
      } catch {
        this.result = null;
      }
      const raw = (this.result?.landmarks ?? []).map((lm, i) => {
        const g = this.result!.gestures[i]?.[0];
        const cx = lm.reduce((s, p) => s + p.x, 0) / lm.length;
        return {
          x: cx,
          label: this.result!.handedness[i]?.[0]?.categoryName ?? '',
          fist: g?.categoryName === 'Closed_Fist' && g.score > 0.45,
        };
      });
      const out = this.gestures.update(assignHands(raw), now);
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
    }
    this.draw(now);
  }

  label(now: number): [string, string] {
    const r = this.gestures.readout;
    if (!r.visible) return ['Не вижу рук - подними ладони к камере', 'bad'];
    if (now - this.yankFlash < 350) return ['РЫВОК!', 'hot'];
    if (r.bracing) return ['УПОР (левый кулак)', 'hot'];
    return ['ПЕРЕДЫШКА', ''];
  }

  private draw(now: number): void {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const v = this.video;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const ar = v.videoWidth / v.videoHeight || 16 / 9;
    const dw = Math.max(W, H * ar);
    const dh = dw / ar;
    const ox = (W - dw) / 2;
    const oy = (H - dh) / 2;
    // Видео зеркально — как в зеркале: левая рука слева.
    if (v.readyState >= 2) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.globalAlpha = 0.75;
      ctx.drawImage(v, ox, oy, dw, dh);
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const res = this.result;
    if (res) {
      res.landmarks.forEach((lm, i) => {
        const fist = res.gestures[i]?.[0]?.categoryName === 'Closed_Fist';
        const P = (k: number) => ({ x: W - (ox + lm[k].x * dw), y: oy + lm[k].y * dh });
        ctx.strokeStyle = fist ? '#ffd166' : 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        for (const [a, b] of HAND_BONES) {
          const pa = P(a);
          const pb = P(b);
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      });
    }
    // Подписи рук внизу.
    const r = this.gestures.readout;
    ctx.font = '700 12px Manrope, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    const tag = (x: number, text: string, on: boolean) => {
      ctx.fillStyle = on ? 'rgba(255,209,102,0.9)' : 'rgba(0,0,0,0.6)';
      const w = ctx.measureText(text).width + 12;
      ctx.fillRect(x, H - 22, w, 18);
      ctx.fillStyle = on ? '#1b1405' : '#fff';
      ctx.fillText(text, x + 6, H - 6);
    };
    tag(6, 'Левый: упор', r.bracing);
    ctx.textAlign = 'left';
    const rt = 'Правый: рывок';
    tag(W - ctx.measureText(rt).width - 18, rt, now - this.yankFlash < 350 || r.rightFist);
    if (now - this.yankFlash < 350) {
      ctx.fillStyle = 'rgba(255, 209, 102, 0.25)';
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  close(): void {
    this.enabled = false;
    this.stream.getTracks().forEach((t) => t.stop());
    this.recognizer.close();
  }
}
