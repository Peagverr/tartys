import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import { fromMediaPipe } from './pose/mediapipe';
import type { PoseFrame } from './pose/types';

const BASE = import.meta.env.BASE_URL;

export const isMobile = (): boolean => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 600;

export type LoadStage = 'camera' | 'model' | 'ready';

/**
 * Создаёт модель MediaPipe Pose Landmarker. WASM и модель лежат в самом приложении,
 * поэтому ничего не грузится со сторонних CDN. Если нет WebGL — считаем на процессоре.
 */
export async function createPoseLandmarker(runningMode: 'VIDEO' | 'IMAGE'): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
  const model = `${BASE}models/pose_landmarker_${isMobile() ? 'lite' : 'full'}.task`;
  const make = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: model, delegate },
      runningMode,
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  try {
    return await make('GPU');
  } catch {
    return make('CPU');
  }
}

export class CameraError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/**
 * Веб-камера + MediaPipe Pose Landmarker. Всё считается прямо в браузере:
 * видео никуда не отправляется.
 */
export class CameraSource {
  readonly kind = 'camera' as const;
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private landmarker: PoseLandmarker | null = null;
  private lastVideoTime = -1;
  private last: PoseFrame | null = null;
  private lastTs = 0;
  /** Сколько кадров в секунду реально успевает модель. */
  fps = 0;
  private fpsCount = 0;
  private fpsSince = 0;

  private constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  get aspect(): number {
    return this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 16 / 9;
  }

  static async open(onStage: (s: LoadStage) => void): Promise<CameraSource> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('Браузер не даёт доступ к камере', 'Открой сайт по https:// в Chrome, Edge, Safari или Firefox - или играй с клавиатуры.');
    }
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    const src = new CameraSource(video);

    onStage('camera');
    const portrait = window.innerHeight > window.innerWidth;
    try {
      src.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: portrait ? 720 : 1280 },
          height: { ideal: portrait ? 1280 : 720 },
          frameRate: { ideal: 30 },
        },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new CameraError('Доступ к камере запрещён', 'Нажми на значок камеры в адресной строке, разреши доступ и обнови страницу. Или играй с клавиатуры и кнопок.');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new CameraError('Камера не найдена', 'Подключи веб-камеру или играй с клавиатуры и кнопок.');
      }
      if (name === 'NotReadableError') {
        throw new CameraError('Камера занята другой программой', 'Закрой Zoom, Teams или другую вкладку с камерой и попробуй снова.');
      }
      throw new CameraError('Не удалось включить камеру', String((e as Error)?.message ?? e));
    }
    video.srcObject = src.stream;
    await video.play();
    await new Promise<void>((res) => {
      if (video.readyState >= 2) res();
      else video.onloadeddata = () => res();
    });

    onStage('model');
    src.landmarker = await createPoseLandmarker('VIDEO');
    onStage('ready');
    return src;
  }

  read(t: number): PoseFrame | null {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2) return this.last;
    if (v.currentTime === this.lastVideoTime) return this.last;
    this.lastVideoTime = v.currentTime;
    // MediaPipe требует строго растущие метки времени.
    const ts = Math.max(t, this.lastTs + 1);
    this.lastTs = ts;
    let res: PoseLandmarkerResult;
    try {
      res = this.landmarker.detectForVideo(v, ts);
    } catch {
      return this.last;
    }
    this.countFps(t);
    const lm = res.landmarks[0];
    const wl = res.worldLandmarks[0];
    if (!lm || !wl) {
      this.last = null;
      return null;
    }
    this.last = fromMediaPipe(lm, wl, this.aspect, t);
    return this.last;
  }

  private probe: CanvasRenderingContext2D | null = null;

  /** Средняя яркость кадра 0..255 — чтобы подсказать «включи свет». */
  brightness(): number | null {
    const v = this.video;
    if (v.readyState < 2) return null;
    if (!this.probe) {
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 18;
      this.probe = c.getContext('2d', { willReadFrequently: true });
    }
    if (!this.probe) return null;
    this.probe.drawImage(v, 0, 0, 32, 18);
    const d = this.probe.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 4);
  }

  private countFps(t: number): void {
    this.fpsCount++;
    if (t - this.fpsSince > 1000) {
      this.fps = (this.fpsCount * 1000) / (t - this.fpsSince);
      this.fpsCount = 0;
      this.fpsSince = t;
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.landmarker?.close();
    this.landmarker = null;
  }
}
