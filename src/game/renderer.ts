// Отрисовка сцены на canvas. Только читает состояние матча — ничего в нём не меняет.

import { holdForce, isGuarding, type Fighter, type GameEvent, type MatchState, type Side } from '../engine/match';
import { mulberry32 } from '../engine/bot';

export const TEAM_COLORS: [string, string] = ['#3d7bff', '#ff4b4b'];

interface ArenaLook {
  sky: [string, string, string, string];
  sun: string;
  mountains: [string, string];
  ground: [string, string];
  grass: string;
  yurt: string;
  cloud: string;
  stars?: boolean;
  snow?: boolean;
}

/** Арены — только оформление, на игру не влияют. */
export const ARENA_LOOKS: Record<string, ArenaLook> = {
  steppe: {
    sky: ['#141d38', '#46365e', '#d9785a', '#f2b36b'],
    sun: 'rgba(255, 214, 150, 0.9)',
    mountains: ['#3a3558', '#2a2a46'],
    ground: ['#b99152', '#6f5430'],
    grass: 'rgba(96, 84, 38, 0.55)',
    yurt: '#e9d9bd',
    cloud: 'rgba(255, 190, 150, 0.22)',
  },
  winter: {
    sky: ['#060a1a', '#122043', '#2b4a78', '#6a8cb6'],
    sun: 'rgba(235, 242, 255, 0.95)',
    mountains: ['#2a3d63', '#1b2a4a'],
    ground: ['#dfe8f3', '#94a9c4'],
    grass: 'rgba(120, 140, 170, 0.45)',
    yurt: '#f4f7fb',
    cloud: 'rgba(200, 220, 255, 0.14)',
    stars: true,
    snow: true,
  },
  city: {
    sky: ['#170d2e', '#48215e', '#c2477a', '#f59e6b'],
    sun: 'rgba(255, 200, 150, 0.85)',
    mountains: ['#3a3558', '#2a2a46'],
    ground: ['#8f8a99', '#4a4656'],
    grass: 'rgba(60, 55, 75, 0.5)',
    yurt: '#d8cfe6',
    cloud: 'rgba(255, 170, 200, 0.18)',
  },
};

/** Калпаки: верх и околыш. Косметика. */
export const SKIN_LOOKS: Record<string, [string, string]> = {
  classic: ['#f5efe2', '#1d1d24'],
  gold: ['#f2c14e', '#7a3f00'],
  night: ['#26263d', '#b58cff'],
  steppe: ['#b88a5a', '#3b2410'],
};

/** Затемнить цвет #rrggbb на долю f (0..1). */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * (1 - f));
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  born: number;
  life: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  color: string;
  r: number;
  /** Конфетти: прямоугольник, который вращается и медленно падает. */
  spin?: number;
  gravity?: number;
}

export interface View {
  state: MatchState;
  /** Положение каната на прошлом тике — для плавной интерполяции между тиками. */
  prevRope: number;
  alpha: number;
  /** Туториал: показать «!» над стороной, которая сейчас рванёт. */
  warn?: Side | null;
  /** Сколько батыров рисовать в каждой команде (по умолчанию по 3). */
  crew?: [number, number];
}

interface Layout {
  W: number;
  H: number;
  groundY: number;
  cx: number;
  L: number;
  gap: number;
  fig: number;
  /** Насколько камера едет за канатом (0 — стоит на месте). */
  cam: number;
  /** Расстояние между батырами одной команды. */
  spacing: number;
}

interface Pt {
  x: number;
  y: number;
}

const MAX_CREW = 6;

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private bottomInset = 0;
  private popups: Popup[] = [];
  private particles: Particle[] = [];
  private shake = 0;
  /** Наклон каждого батыра: задние повторяют переднего с запаздыванием. */
  private leans: [number[], number[]] = [new Array(MAX_CREW).fill(0.3), new Array(MAX_CREW).fill(0.3)];
  private startFlash = -10;
  private mountains: number[][] = [];
  private lastNow = 0;
  private lastLayout: Layout | null = null;
  private stars: [number, number, number][] = [];
  private buildings: [number, number, number][] = [];
  private clouds: [number, number, number, number][] = [];
  private yurts: [number, number][] = [];
  private tufts: [number, number, number][] = [];
  private waveAt = -10;
  private waveAmp = 0;
  private lastRope = 0;
  private overAt = -10;
  arena = 'steppe';
  skins: [string, string] = ['classic', 'classic'];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const rand = mulberry32(7);
    for (let layer = 0; layer < 2; layer++) {
      const pts: number[] = [];
      for (let i = 0; i <= 24; i++) pts.push(0.35 + rand() * 0.65 * (layer ? 0.7 : 1));
      this.mountains.push(pts);
    }
    for (let i = 0; i < 70; i++) this.stars.push([rand(), rand(), rand() < 0.2 ? 2 : 1]);
    for (let x = 0; x < 1; ) {
      const w = 0.03 + rand() * 0.05;
      this.buildings.push([x, w, 0.25 + rand() * 0.7]);
      x += w + rand() * 0.01;
    }
    // Облака: x, высота, размер, скорость.
    for (let i = 0; i < 6; i++) this.clouds.push([rand(), 0.08 + rand() * 0.35, 0.6 + rand() * 0.8, 0.004 + rand() * 0.008]);
    this.yurts = [
      [-0.62, 1],
      [-0.48, 0.7],
      [0.55, 0.85],
      [0.7, 0.6],
    ];
    for (let i = 0; i < 90; i++) this.tufts.push([rand() * 3 - 1, rand(), 0.6 + rand() * 0.8]);
  }

  resize(bottomInset: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.W = rect.width;
    this.H = rect.height;
    this.bottomInset = bottomInset;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  reset(): void {
    this.popups = [];
    this.particles = [];
    this.shake = 0;
    for (const l of this.leans) l.fill(0.3);
    this.startFlash = -10;
    this.waveAt = -10;
    this.overAt = -10;
  }

  private layout(crew = 3): Layout {
    const { W, H } = this;
    const groundY = Math.min(H - this.bottomInset - Math.max(24, H * 0.06), H * 0.82);
    const portrait = H > W;
    // Больше людей в команде — фигуры чуть мельче, чтобы все поместились.
    const crowdScale = crew > 3 ? 0.78 : crew > 1 ? 0.88 : 1;
    const fig = Math.max(46, Math.min(W * (portrait ? 0.15 : 0.17), (groundY - 110) * 0.85, 210) * crowdScale);
    const L = W * (portrait ? 0.3 : 0.22);
    const gap = W * 0.08 + fig * 0.3;
    return { W, H, groundY, cx: W / 2, L, gap, fig, cam: portrait ? 0.5 : 0.25, spacing: fig * 0.58 };
  }

  private ropeX(lay: Layout, rope: number, winLine: number): number {
    const lim = Number.isFinite(winLine) ? winLine : 100;
    return lay.cx + (rope / lim) * lay.L;
  }

  /** Эффекты по событиям движка. */
  onEvent(e: GameEvent, s: MatchState, now: number): void {
    const lay = this.lastLayout ?? this.layout();
    const mx = this.ropeX(lay, s.rope, s.opts.winLine);
    const handX = (side: Side) => mx + (side === 0 ? -lay.gap : lay.gap);
    const top = lay.groundY - lay.fig * 1.25;
    const pop = (x: number, text: string, color: string, size = 1, dy = 0) => {
      // Свежая надпись рядом — ставим новую выше, чтобы не слипались.
      let y = top + dy;
      while (this.popups.some((p) => now - p.born < 0.6 && Math.abs(p.x - x) < 120 && Math.abs(p.y - y) < 30)) y -= 36;
      this.popups.push({ x, y, text, color, size, born: now, life: 1.1 });
    };
    const wave = (strength: number) => {
      this.waveAt = now;
      this.waveAmp = Math.min(lay.fig * 0.14, lay.fig * 0.05 * strength);
    };

    switch (e.type) {
      case 'start':
        this.startFlash = now;
        break;
      case 'yank': {
        const d = e.side === 0 ? 1 : 0;
        if (e.sync && e.outcome !== 'blocked') pop(handX(e.side), 'ДРУЖНО ×1,5!', '#ffd166', 1.2, -36);
        if (e.outcome === 'landed') {
          pop(handX(e.side), 'РЫВОК!', TEAM_COLORS[e.side], 1);
          this.shake = Math.max(this.shake, 6 + e.distance * 0.4);
          this.dust(handX(d as Side), lay.groundY, 10, now);
          wave(e.distance / 10);
        } else if (e.outcome === 'partial') {
          pop(handX(e.side), 'ЧАСТИЧНО', '#ffd166', 0.8);
          this.shake = Math.max(this.shake, 4);
          wave(0.8);
        } else if (e.outcome === 'blocked') {
          pop(handX(d as Side), 'УПОР!', TEAM_COLORS[d], 1.1);
          pop(handX(e.side), 'ХВАТ СБИТ', '#ffffff', 0.75, 34);
          this.shake = Math.max(this.shake, 5);
          this.dust(handX(d as Side), lay.groundY, 14, now);
          wave(1.6);
        } else if (e.outcome === 'punish') {
          pop(handX(e.side), 'ДОБИВАНИЕ!', '#ffd166', 1.15);
          this.shake = Math.max(this.shake, 12);
          this.dust(handX(d as Side), lay.groundY, 18, now);
          wave(2.4);
        } else {
          pop(mx, 'СТОЛКНОВЕНИЕ', '#ffffff', 0.9);
          this.shake = Math.max(this.shake, 8);
          wave(2);
        }
        break;
      }
      case 'exhausted':
        pop(handX(e.side), 'ВЫДОХСЯ', '#c0c8d8', 0.9);
        break;
      case 'nostamina':
        pop(handX(e.side), 'нет сил', '#c0c8d8', 0.6, 10);
        break;
      case 'final':
        pop(lay.cx, 'ФИНАЛЬНЫЕ 15 СЕКУНД - РЫВКИ СИЛЬНЕЕ', '#ffd166', 0.7, -40);
        break;
      case 'over':
        this.overAt = now;
        if (e.winner !== null) this.confetti(lay, e.winner, now);
        this.shake = Math.max(this.shake, 10);
        break;
      default:
        break;
    }
  }

  private dust(x: number, y: number, n: number, now: number): void {
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * 40,
        y: y - 2,
        vx: (Math.random() - 0.5) * 120,
        vy: -Math.random() * 90 - 20,
        born: now,
        life: 0.5 + Math.random() * 0.4,
        color: 'rgba(222, 196, 140, 0.8)',
        r: 2 + Math.random() * 3,
      });
    }
  }

  private confetti(lay: Layout, winner: Side, now: number): void {
    const colors = [TEAM_COLORS[winner], '#ffd166', '#ffffff', shade(TEAM_COLORS[winner], 0.3)];
    for (let i = 0; i < 140; i++) {
      this.particles.push({
        x: Math.random() * lay.W,
        y: -20 - Math.random() * lay.H * 0.4,
        vx: (Math.random() - 0.5) * 60,
        vy: 60 + Math.random() * 90,
        born: now,
        life: 2.6 + Math.random() * 1.4,
        color: colors[i % colors.length],
        r: 3 + Math.random() * 4,
        spin: (Math.random() - 0.5) * 12,
        gravity: 20,
      });
    }
  }

  draw(v: View, now: number): void {
    const dt = Math.min(0.05, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    const crew: [number, number] = (v.crew ?? [3, 3]).map((n) => Math.max(1, Math.min(MAX_CREW, Math.round(n)))) as [number, number];
    const lay = this.layout(Math.max(crew[0], crew[1]));
    this.lastLayout = lay;
    const { ctx } = this;
    const s = v.state;
    const rope = v.prevRope + (s.rope - v.prevRope) * v.alpha;
    const ropeSpeed = dt > 0 ? (rope - this.lastRope) / dt : 0;
    this.lastRope = rope;

    ctx.save();
    if (this.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake * 0.6);
      this.shake *= Math.exp(-dt * 12);
    }
    const lim = Number.isFinite(s.opts.winLine) ? s.opts.winLine : 100;
    const cam = -(rope / lim) * lay.L * lay.cam;
    this.drawSky(lay, now);
    ctx.save();
    ctx.translate(cam, 0);
    const mx = this.ropeX(lay, rope, s.opts.winLine);
    // Финал: камера плавно приближается к ленте.
    const since = now - this.overAt;
    if (s.phase === 'over' && since >= 0 && since < 60) {
      const z = 1 + 0.12 * (1 - Math.exp(-since * 3));
      const fy = lay.groundY - lay.fig * 0.5;
      ctx.translate(mx, fy);
      ctx.scale(z, z);
      ctx.translate(-mx, -fy);
    }
    this.drawGround(lay, s.opts.winLine);

    // Наклоны: передний батыр следует за стойкой, остальные — за соседом впереди.
    for (const side of [0, 1] as const) {
      const f = s.fighters[side];
      const ls = this.leans[side];
      const speed = f.action === 'recover' ? 30 : 12;
      ls[0] += (this.targetLean(s, side, now, 0) - ls[0]) * (1 - Math.exp(-dt * speed));
      for (let i = 1; i < MAX_CREW; i++) {
        const t = s.phase === 'over' ? this.targetLean(s, side, now, i) : ls[i - 1];
        ls[i] += (t - ls[i]) * (1 - Math.exp(-dt * 8));
      }
    }

    const handsX = (side: Side) => {
      const d = side === 0 ? -1 : 1;
      const front = mx + d * lay.gap;
      return Array.from({ length: crew[side] }, (_, i) => front + d * i * lay.spacing);
    };
    const hx: [number[], number[]] = [handsX(0), handsX(1)];
    const hands: [Pt[], Pt[]] = [
      hx[0].map((x, i) => this.pose(lay, x, 0, this.leans[0][i], this.hop(s, 0, i, now)).hand),
      hx[1].map((x, i) => this.pose(lay, x, 1, this.leans[1][i], this.hop(s, 1, i, now)).hand),
    ];
    this.drawRope(lay, s, hands, mx, rope, now);
    // Сначала задние батыры, потом передние — передние поверх.
    for (const side of [0, 1] as const) {
      for (let i = crew[side] - 1; i >= 0; i--) {
        this.drawFigure(lay, s, side, hx[side][i], now, i, v.warn === side && i === 0);
      }
    }
    // Пыль из-под ног тех, кого тащат.
    if (Math.abs(ropeSpeed) > 18 && s.phase === 'live') {
      const dragged: Side = ropeSpeed > 0 ? 0 : 1;
      if (Math.random() < Math.min(1, Math.abs(ropeSpeed) / 60)) {
        const i = Math.floor(Math.random() * crew[dragged]);
        const p = this.pose(lay, hx[dragged][i], dragged, this.leans[dragged][i], 0);
        this.dust(p.foot.x, lay.groundY, 1, now);
      }
    }

    this.drawParticles(dt, now, false);
    this.drawPopups(now);
    ctx.restore();
    ctx.restore();
    this.drawTension(lay, s, rope / lim, now);
    this.drawParticles(dt, now, true);
    this.drawCountdown(lay, s, now);
  }

  /** Прыжок победителей после финала. */
  private hop(s: MatchState, side: Side, i: number, now: number): number {
    if (s.phase !== 'over' || s.result?.winner !== side) return 0;
    return Math.abs(Math.sin(now * 7 + i * 0.9)) * 0.1;
  }

  private targetLean(s: MatchState, side: Side, now: number, i: number): number {
    const f = s.fighters[side];
    if (s.phase === 'over' && s.result) {
      if (s.result.winner === side) return 0.1 + Math.sin(now * 8 + i) * 0.05;
      // Проигравших тянет вперёд: передний падает, остальные спотыкаются.
      if (s.result.winner !== null) return i === 0 ? -0.95 : -0.55;
    }
    const breathe = Math.sin(now * 2.2 + side) * 0.03;
    switch (f.action) {
      case 'windup':
        return -0.08;
      case 'recover':
        return 0.8;
      case 'stunned':
        return -0.3 + Math.sin(now * 18) * 0.08;
      case 'exhausted':
        return 0.05;
      default:
        return 0.28 + (isGuarding(f) ? 0.42 * f.brace : 0) + breathe;
    }
  }

  private drawSky(lay: Layout, now: number): void {
    const { ctx } = this;
    const { W, H, groundY } = lay;
    const a = ARENA_LOOKS[this.arena] ?? ARENA_LOOKS.steppe;
    const sky = ctx.createLinearGradient(0, 0, 0, groundY);
    a.sky.forEach((c, i) => sky.addColorStop([0, 0.55, 0.85, 1][i], c));
    ctx.fillStyle = sky;
    ctx.fillRect(-20, -20, W + 40, groundY + 20);

    if (a.stars) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      for (const [x, y, r] of this.stars) ctx.fillRect(x * W, y * groundY * 0.7, r, r);
    }
    ctx.fillStyle = a.sun;
    ctx.beginPath();
    ctx.arc(W * 0.72, a.stars ? groundY * 0.25 : groundY - 30, Math.min(W, H) * 0.06, 0, Math.PI * 2);
    ctx.fill();

    // Облака медленно плывут.
    ctx.fillStyle = a.cloud;
    for (const [x0, y, size, speed] of this.clouds) {
      const x = (((x0 + now * speed) % 1.3) - 0.15) * W;
      const r = Math.min(W, H) * 0.05 * size;
      const cy = y * groundY;
      ctx.beginPath();
      ctx.ellipse(x, cy, r * 2.2, r * 0.55, 0, 0, Math.PI * 2);
      ctx.ellipse(x + r * 0.8, cy - r * 0.3, r * 1.2, r * 0.5, 0, 0, Math.PI * 2);
      ctx.ellipse(x - r * 0.9, cy - r * 0.15, r, r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.arena === 'city') {
      this.drawSkyline(lay);
      return;
    }
    this.mountains.forEach((pts, layer) => {
      const h = (groundY - 60) * (layer ? 0.28 : 0.4);
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(-20, groundY);
        pts.forEach((p, i) => ctx.lineTo((i / (pts.length - 1)) * (W + 40) - 20, groundY - h * p));
        ctx.lineTo(W + 20, groundY);
        ctx.closePath();
      };
      ctx.fillStyle = a.mountains[layer];
      path();
      ctx.fill();
      if (a.snow && layer === 0) {
        // Снежные шапки: верхняя часть гор светлее.
        ctx.save();
        path();
        ctx.clip();
        ctx.fillStyle = 'rgba(235, 242, 255, 0.85)';
        ctx.fillRect(-20, 0, W + 40, groundY - h * 0.72);
        ctx.restore();
      }
    });
  }

  /** Арена «Астана»: силуэт города и Байтерек. */
  private drawSkyline(lay: Layout): void {
    const { ctx } = this;
    const { W, groundY } = lay;
    ctx.fillStyle = '#2b1740';
    for (const [x, w, h] of this.buildings) ctx.fillRect(x * W, groundY - h * groundY * 0.45, w * W, h * groundY * 0.45 + 1);
    // Окна.
    ctx.fillStyle = 'rgba(255, 210, 140, 0.35)';
    for (const [x, w, h] of this.buildings) {
      const top = groundY - h * groundY * 0.45;
      for (let yy = top + 8; yy < groundY - 6; yy += 12) {
        for (let xx = x * W + 4; xx < (x + w) * W - 4; xx += 9) if (((xx * 7 + yy * 3) | 0) % 5 === 0) ctx.fillRect(xx, yy, 3, 4);
      }
    }
    const bx = W * 0.3;
    const bh = groundY * 0.55;
    ctx.fillStyle = '#1f1030';
    ctx.beginPath();
    ctx.moveTo(bx - 14, groundY);
    ctx.lineTo(bx - 4, groundY - bh * 0.85);
    ctx.lineTo(bx + 4, groundY - bh * 0.85);
    ctx.lineTo(bx + 14, groundY);
    ctx.fill();
    const g = ctx.createRadialGradient(bx - 6, groundY - bh - 6, 2, bx, groundY - bh, 22);
    g.addColorStop(0, '#fff3c4');
    g.addColorStop(1, '#f2a93b');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, groundY - bh, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawYurt(x: number, groundY: number, size: number, color: string): void {
    const { ctx } = this;
    const w = size;
    const h = size * 0.45;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, groundY);
    ctx.lineTo(x - w / 2, groundY - h);
    ctx.quadraticCurveTo(x, groundY - h - size * 0.55, x + w / 2, groundY - h);
    ctx.lineTo(x + w / 2, groundY);
    ctx.closePath();
    ctx.fill();
    // Узор-пояс и дверь.
    ctx.fillStyle = 'rgba(160, 50, 40, 0.75)';
    ctx.fillRect(x - w / 2, groundY - h * 0.75, w, h * 0.12);
    ctx.fillStyle = 'rgba(90, 40, 20, 0.85)';
    ctx.fillRect(x - w * 0.09, groundY - h * 0.62, w * 0.18, h * 0.62);
  }

  private drawGround(lay: Layout, winLine: number): void {
    const { ctx } = this;
    const { W, H, groundY, cx, L } = lay;
    const a = ARENA_LOOKS[this.arena] ?? ARENA_LOOKS.steppe;
    const ground = ctx.createLinearGradient(0, groundY, 0, H);
    ground.addColorStop(0, a.ground[0]);
    ground.addColorStop(1, a.ground[1]);
    ctx.fillStyle = ground;
    ctx.fillRect(-W, groundY, W * 3, H - groundY + 20);

    // Юрты на горизонте (в городе их нет).
    if (this.arena !== 'city') {
      for (const [x, s] of this.yurts) this.drawYurt(cx + x * W, groundY + 1, lay.fig * 0.55 * s, a.yurt);
    }
    // Трава.
    ctx.strokeStyle = a.grass;
    ctx.lineWidth = 1.5;
    for (const [x, y, s] of this.tufts) {
      const px = x * W;
      const py = groundY + 6 + y * (H - groundY - 10);
      const h = 4 + 6 * s * (0.5 + y);
      ctx.beginPath();
      ctx.moveTo(px - 3, py);
      ctx.lineTo(px - 5, py - h);
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - h * 1.2);
      ctx.moveTo(px + 3, py);
      ctx.lineTo(px + 5, py - h);
      ctx.stroke();
    }

    if (Number.isFinite(winLine)) {
      // Зоны за линиями победы.
      ctx.fillStyle = 'rgba(61, 123, 255, 0.18)';
      ctx.fillRect(-W, groundY, cx - L + W, H - groundY + 20);
      ctx.fillStyle = 'rgba(255, 75, 75, 0.18)';
      ctx.fillRect(cx + L, groundY, W * 2, H - groundY + 20);
      for (const side of [0, 1] as const) {
        const x = cx + (side === 0 ? -L : L);
        ctx.strokeStyle = TEAM_COLORS[side];
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x, groundY - 2);
        ctx.lineTo(x, H);
        ctx.stroke();
        // Флажок.
        ctx.strokeStyle = '#e8dcc4';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, groundY);
        ctx.lineTo(x, groundY - 46);
        ctx.stroke();
        ctx.fillStyle = TEAM_COLORS[side];
        ctx.beginPath();
        const fd = side === 0 ? -1 : 1;
        ctx.moveTo(x, groundY - 46);
        ctx.lineTo(x + fd * 22, groundY - 39);
        ctx.lineTo(x, groundY - 32);
        ctx.fill();
      }
    }
    // Центральная отметка.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, groundY);
    ctx.lineTo(cx, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Геометрия фигуры: стопы, колени, бёдра, плечи, голова, руки на канате. */
  private pose(lay: Layout, handX: number, side: Side, lean: number, hop: number) {
    const d = side === 0 ? -1 : 1;
    const a = lean;
    const k = lay.fig;
    const leg = k * 0.42;
    const torso = k * 0.38;
    const arm = k * 0.34;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    const lift = hop * k;
    const footX = handX + d * arm - d * sin * (leg + torso);
    const foot = { x: footX, y: lay.groundY - lift };
    const hip = { x: foot.x + d * sin * leg, y: foot.y - cos * leg };
    const shoulder = { x: hip.x + d * sin * torso, y: hip.y - cos * torso };
    const head = { x: shoulder.x + d * sin * k * 0.13, y: shoulder.y - cos * k * 0.13 };
    const hand = { x: handX, y: shoulder.y + k * 0.07 };
    return { d, a, k, foot, hip, shoulder, head, hand };
  }

  private drawRope(lay: Layout, s: MatchState, hands: [Pt[], Pt[]], mx: number, rope: number, now: number): void {
    const { ctx } = this;
    const h0 = hands[0][0];
    const h1 = hands[1][0];
    const tension = holdForce(s.fighters[0]) + holdForce(s.fighters[1]);
    const sag = lay.fig * 0.16 * Math.max(0, 1 - tension / 1.1);
    const midY = (h0.y + h1.y) / 2 + sag;
    const ext = lay.fig * 0.5;

    // Середина каната — кривая с волной после рывка.
    const since = now - this.waveAt;
    const amp = since < 1.2 ? this.waveAmp * Math.exp(-since * 4) : 0;
    const mid: Pt[] = [];
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const x = (1 - u) * (1 - u) * h0.x + 2 * (1 - u) * u * ((h0.x + h1.x) / 2) + u * u * h1.x;
      const y = (1 - u) * (1 - u) * h0.y + 2 * (1 - u) * u * midY + u * u * h1.y;
      mid.push({ x, y: y + amp * Math.sin(u * Math.PI * 3 - since * 22) * Math.sin(u * Math.PI) });
    }
    const left = [...hands[0]].reverse();
    const lastL = left[0];
    const lastR = hands[1][hands[1].length - 1];
    const pts: Pt[] = [
      { x: lastL.x - ext, y: lastL.y + 8 },
      ...left.slice(0, -1),
      ...mid,
      ...hands[1].slice(1),
      { x: lastR.x + ext, y: lastR.y + 8 },
    ];
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    };
    const w = Math.max(5, lay.fig * 0.05);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#6b4a22';
    ctx.lineWidth = w + 3;
    path();
    ctx.stroke();
    ctx.strokeStyle = '#c99a5b';
    ctx.lineWidth = w;
    path();
    ctx.stroke();
    // Витки каната ползут вместе с ним — движение видно даже на месте.
    ctx.strokeStyle = 'rgba(90, 60, 25, 0.8)';
    ctx.lineWidth = w * 0.45;
    ctx.setLineDash([w * 0.7, w * 1.1]);
    ctx.lineDashOffset = -rope * 3;
    path();
    ctx.stroke();
    ctx.setLineDash([]);

    // Красная лента — отметка каната.
    const my = mid[N / 2].y;
    const flutter = Math.sin(now * 9) * 2;
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(mx - 7, my);
    ctx.lineTo(mx + 7, my);
    ctx.lineTo(mx + 3 + flutter, my + 26);
    ctx.lineTo(mx + flutter * 0.5, my + 20);
    ctx.lineTo(mx - 3 + flutter, my + 26);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFigure(lay: Layout, s: MatchState, side: Side, handX: number, now: number, idx: number, warn: boolean): void {
    const { ctx } = this;
    const f: Fighter = s.fighters[side];
    const p = this.pose(lay, handX, side, this.leans[side][idx], this.hop(s, side, idx, now));
    const { d, k, foot, hip, shoulder, head, hand } = p;
    // Передний батыр — ярче, задние чуть темнее: видно, кто «ты».
    const base = TEAM_COLORS[side];
    const color = idx === 0 ? base : shade(base, 0.12 + idx * 0.05);
    const dark = shade(base, 0.45);
    const guard = isGuarding(f) ? f.brace : 0;
    const skin = '#e0a878';

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Тень.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(foot.x + d * k * 0.12, lay.groundY + 3, k * 0.3, k * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();

    // Ноги: передняя и задняя, в упоре колени сильнее согнуты; сапоги.
    const bend = k * (0.05 + 0.1 * guard);
    const legs = [
      { x: foot.x, y: foot.y },
      { x: foot.x + d * k * 0.2, y: foot.y },
    ];
    legs.forEach((ft, li) => {
      const kx = (ft.x + hip.x) / 2 - d * bend;
      const ky = (ft.y + hip.y) / 2;
      ctx.strokeStyle = li ? '#23263a' : '#2e3350';
      ctx.lineWidth = k * 0.09;
      ctx.beginPath();
      ctx.moveTo(hip.x, hip.y);
      ctx.lineTo(kx, ky);
      ctx.lineTo(ft.x, ft.y - k * 0.03);
      ctx.stroke();
      ctx.fillStyle = '#3a2416';
      ctx.beginPath();
      ctx.ellipse(ft.x - d * k * 0.025, ft.y - k * 0.025, k * 0.065, k * 0.035, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    // Упор: пятки врезаны в землю.
    if (guard > 0.5) {
      ctx.strokeStyle = 'rgba(80, 55, 25, 0.8)';
      ctx.lineWidth = 2;
      for (const ft of legs) {
        ctx.beginPath();
        ctx.moveTo(ft.x - d * 4, ft.y + 1);
        ctx.lineTo(ft.x - d * 16, ft.y + 4);
        ctx.stroke();
      }
    }

    // Замах — вспышка, чтобы соперник мог прочитать рывок.
    if (f.action === 'windup' && idx === 0) {
      ctx.fillStyle = 'rgba(255, 230, 120, 0.35)';
      ctx.beginPath();
      ctx.arc(shoulder.x, shoulder.y, k * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }

    // Дальняя рука (за корпусом).
    const slip = f.action === 'stunned' ? Math.sin(now * 30 + idx) * k * 0.04 : 0;
    const armTo = (from: Pt, to: Pt, width: number, col: string) => {
      const ex = (from.x + to.x) / 2;
      const ey = Math.max(from.y, to.y) + k * 0.06;
      ctx.strokeStyle = col;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(ex, ey);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    };
    const backHand = { x: hand.x + d * k * 0.07, y: hand.y + slip };
    armTo({ x: shoulder.x, y: shoulder.y + k * 0.02 }, backHand, k * 0.07, dark);

    // Корпус: чапан-трапеция.
    const ux = shoulder.x - hip.x;
    const uy = shoulder.y - hip.y;
    const len = Math.hypot(ux, uy) || 1;
    const nx = -uy / len;
    const ny = ux / len;
    const wHip = k * 0.13;
    const wSh = k * 0.1;
    const skirt = { x: hip.x - ux * 0.25, y: hip.y - uy * 0.25 };
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(skirt.x + nx * wHip * 1.15, skirt.y + ny * wHip * 1.15);
    ctx.lineTo(shoulder.x + nx * wSh, shoulder.y + ny * wSh);
    ctx.lineTo(shoulder.x - nx * wSh, shoulder.y - ny * wSh);
    ctx.lineTo(skirt.x - nx * wHip * 1.15, skirt.y - ny * wHip * 1.15);
    ctx.closePath();
    ctx.fill();
    // Орнамент по краю чапана.
    ctx.strokeStyle = 'rgba(255, 220, 140, 0.8)';
    ctx.lineWidth = Math.max(1.5, k * 0.018);
    ctx.beginPath();
    ctx.moveTo(skirt.x + nx * wHip * 1.15, skirt.y + ny * wHip * 1.15);
    ctx.lineTo(skirt.x - nx * wHip * 1.15, skirt.y - ny * wHip * 1.15);
    ctx.stroke();
    // Пояс.
    ctx.strokeStyle = '#f2c14e';
    ctx.lineWidth = k * 0.035;
    const bx = hip.x + ux * 0.18;
    const by = hip.y + uy * 0.18;
    ctx.beginPath();
    ctx.moveTo(bx + nx * wHip, by + ny * wHip);
    ctx.lineTo(bx - nx * wHip, by - ny * wHip);
    ctx.stroke();

    // Ближняя рука и кулаки на канате.
    armTo({ x: shoulder.x, y: shoulder.y }, { x: hand.x, y: hand.y + slip }, k * 0.075, color);
    ctx.fillStyle = skin;
    for (const h of [backHand, { x: hand.x, y: hand.y + slip }]) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, k * 0.042, 0, Math.PI * 2);
      ctx.fill();
    }

    // Голова, лицо и калпак.
    const hr = k * 0.1;
    const droop = f.action === 'exhausted' ? k * 0.05 : 0;
    const hy = head.y + droop;
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(head.x, hy, hr, 0, Math.PI * 2);
    ctx.fill();
    // Глаз и рот смотрят к центру каната.
    const fx = head.x - d * hr * 0.45;
    ctx.fillStyle = '#2a1a12';
    ctx.beginPath();
    ctx.arc(fx, hy - hr * 0.15, Math.max(1.2, hr * 0.12), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6b2e1e';
    ctx.lineWidth = Math.max(1.2, hr * 0.12);
    ctx.beginPath();
    if (guard > 0.5 || f.action === 'windup' || f.action === 'recover') {
      // Стиснутые зубы.
      ctx.moveTo(fx - d * hr * 0.05, hy + hr * 0.4);
      ctx.lineTo(fx + d * hr * 0.3, hy + hr * 0.4);
    } else if (f.action === 'exhausted' || f.action === 'stunned') {
      ctx.arc(fx + d * hr * 0.1, hy + hr * 0.45, hr * 0.14, 0, Math.PI * 2);
    } else {
      ctx.arc(fx + d * hr * 0.1, hy + hr * 0.25, hr * 0.22, 0.2 * Math.PI, 0.8 * Math.PI);
    }
    ctx.stroke();
    const [hat, brim] = idx === 0 ? (SKIN_LOOKS[this.skins[side]] ?? SKIN_LOOKS.classic) : SKIN_LOOKS.classic;
    ctx.fillStyle = hat;
    ctx.beginPath();
    ctx.moveTo(head.x - hr * 1.05, hy - hr * 0.35);
    ctx.lineTo(head.x - hr * 0.35, hy - hr * 2.1);
    ctx.lineTo(head.x + hr * 0.35, hy - hr * 2.1);
    ctx.lineTo(head.x + hr * 1.05, hy - hr * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = brim;
    ctx.fillRect(head.x - hr * 1.15, hy - hr * 0.55, hr * 2.3, hr * 0.32);

    // Состояния.
    if (f.action === 'stunned' && idx === 0) {
      for (let i = 0; i < 3; i++) {
        const ang = now * 6 + (i * Math.PI * 2) / 3;
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(head.x + Math.cos(ang) * hr * 1.6, hy - hr * 2.4 + Math.sin(ang) * hr * 0.5, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (f.action === 'exhausted' && Math.random() < 0.1) {
      this.particles.push({ x: head.x, y: hy - hr, vx: (Math.random() - 0.5) * 40, vy: -30, born: now, life: 0.6, color: '#9fd3ff', r: 2.5 });
    }
    if (guard > 0.9 && Math.random() < 0.04) this.dust(foot.x, lay.groundY, 1, now);
    if (warn) {
      ctx.fillStyle = '#ffd166';
      ctx.font = `900 ${Math.round(k * 0.4)}px Unbounded, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('!', head.x, hy - hr * 2.6 + Math.sin(now * 14) * 3);
    }
  }

  /** Пульсация по краю экрана: ленту почти перетянули, или идут финальные секунды. */
  private drawTension(lay: Layout, s: MatchState, p: number, now: number): void {
    if (s.phase !== 'live') return;
    const { ctx } = this;
    const { W, H } = lay;
    const edge = (side: Side, strength: number) => {
      const x0 = side === 0 ? 0 : W;
      const g = ctx.createLinearGradient(x0, 0, side === 0 ? W * 0.18 : W * 0.82, 0);
      const c = side === 0 ? '61, 123, 255' : '255, 75, 75';
      g.addColorStop(0, `rgba(${c}, ${0.35 * strength})`);
      g.addColorStop(1, `rgba(${c}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(side === 0 ? 0 : W * 0.82, 0, W * 0.18, H);
    };
    const pulse = 0.6 + 0.4 * Math.sin(now * 9);
    // Лента у линии синих — светится синий край: ещё немного, и синие победят.
    if (p < -0.7) edge(0, ((-p - 0.7) / 0.3) * pulse);
    if (p > 0.7) edge(1, ((p - 0.7) / 0.3) * pulse);
    if (Number.isFinite(s.timeLeftTicks) && s.finalAnnounced) {
      const beat = Math.max(0, Math.sin(now * 6)) ** 4 * 0.25;
      ctx.fillStyle = `rgba(255, 209, 102, ${beat * 0.25})`;
      ctx.fillRect(0, 0, W, 5);
      ctx.fillRect(0, H - 5, W, 5);
    }
  }

  private drawParticles(dt: number, now: number, confettiLayer: boolean): void {
    const { ctx } = this;
    if (!confettiLayer) this.particles = this.particles.filter((p) => now - p.born < p.life);
    for (const p of this.particles) {
      if (!!p.spin !== confettiLayer) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += (p.gravity ?? 240) * dt;
      const a = 1 - (now - p.born) / p.life;
      ctx.globalAlpha = Math.max(0, Math.min(1, a * (p.spin ? 2 : 1)));
      ctx.fillStyle = p.color;
      if (p.spin) {
        const ang = (now - p.born) * p.spin;
        ctx.save();
        ctx.translate(p.x + Math.sin(now * 3 + p.r) * 8, p.y);
        ctx.rotate(ang);
        ctx.fillRect(-p.r, -p.r * 0.45, p.r * 2, p.r * 0.9 * Math.abs(Math.cos(ang * 1.7)) + 1);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawPopups(now: number): void {
    const { ctx } = this;
    this.popups = this.popups.filter((p) => now - p.born < p.life);
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      const t = (now - p.born) / p.life;
      const scale = t < 0.12 ? 0.6 + (t / 0.12) * 0.5 : 1.1 - Math.min(0.1, (t - 0.12) * 0.3);
      const size = Math.round(Math.max(14, Math.min(this.W * 0.035, 34)) * p.size * scale);
      ctx.globalAlpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      ctx.font = `800 ${size}px Unbounded, system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(10, 12, 25, 0.8)';
      const y = p.y - t * 30;
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, y);
    }
    ctx.globalAlpha = 1;
  }

  private drawCountdown(lay: Layout, s: MatchState, now: number): void {
    const { ctx } = this;
    let text = '';
    let frac = 0;
    if (s.phase === 'countdown') {
      const secs = s.countdownTicks / 60;
      text = String(Math.ceil(secs));
      frac = 1 - (secs % 1 || 1);
    } else if (now - this.startFlash < 0.8) {
      text = 'ТАРТ!';
      frac = (now - this.startFlash) / 0.8;
    }
    if (!text) return;
    const size = Math.min(lay.W * 0.18, lay.H * 0.22) * (1.25 - frac * 0.35);
    ctx.globalAlpha = 1 - frac * 0.6;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(size)}px Unbounded, system-ui, sans-serif`;
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(10, 12, 25, 0.85)';
    const y = lay.groundY * 0.45;
    ctx.strokeText(text, lay.cx, y);
    ctx.fillStyle = text === 'ТАРТ!' ? '#ffd166' : '#ffffff';
    ctx.fillText(text, lay.cx, y);
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }
}
