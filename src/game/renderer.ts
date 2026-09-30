// Отрисовка сцены на canvas. Только читает состояние матча — ничего в нём не меняет.

import { holdForce, isGuarding, type Fighter, type GameEvent, type MatchState, type Side } from '../engine/match';
import { mulberry32 } from '../engine/bot';

export const TEAM_COLORS: [string, string] = ['#3d7bff', '#ff4b4b'];

interface ArenaLook {
  sky: [string, string, string, string];
  sun: string;
  mountains: [string, string];
  ground: [string, string];
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
  },
  winter: {
    sky: ['#060a1a', '#122043', '#2b4a78', '#6a8cb6'],
    sun: 'rgba(235, 242, 255, 0.95)',
    mountains: ['#2a3d63', '#1b2a4a'],
    ground: ['#dfe8f3', '#94a9c4'],
    stars: true,
    snow: true,
  },
  city: {
    sky: ['#170d2e', '#48215e', '#c2477a', '#f59e6b'],
    sun: 'rgba(255, 200, 150, 0.85)',
    mountains: ['#3a3558', '#2a2a46'],
    ground: ['#8f8a99', '#4a4656'],
  },
};

/** Калпаки: верх и околыш. Косметика. */
export const SKIN_LOOKS: Record<string, [string, string]> = {
  classic: ['#f5efe2', '#1d1d24'],
  gold: ['#f2c14e', '#7a3f00'],
  night: ['#26263d', '#b58cff'],
  steppe: ['#b88a5a', '#3b2410'],
};

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
}

export interface View {
  state: MatchState;
  /** Положение каната на прошлом тике — для плавной интерполяции между тиками. */
  prevRope: number;
  alpha: number;
  /** Туториал: показать «!» над стороной, которая сейчас рванёт. */
  warn?: Side | null;
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
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private bottomInset = 0;
  private popups: Popup[] = [];
  private particles: Particle[] = [];
  private shake = 0;
  private lean: [number, number] = [0.3, 0.3];
  private startFlash = -10;
  private mountains: number[][] = [];
  private lastNow = 0;
  private lastLayout: Layout | null = null;
  private stars: [number, number, number][] = [];
  private buildings: [number, number, number][] = [];
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
    this.lean = [0.3, 0.3];
    this.startFlash = -10;
  }

  private layout(): Layout {
    const { W, H } = this;
    const groundY = Math.min(H - this.bottomInset - Math.max(24, H * 0.06), H * 0.82);
    const portrait = H > W;
    const fig = Math.max(52, Math.min(W * (portrait ? 0.15 : 0.17), (groundY - 110) * 0.85, 210));
    const L = W * (portrait ? 0.3 : 0.22);
    const gap = W * 0.08 + fig * 0.3;
    return { W, H, groundY, cx: W / 2, L, gap, fig, cam: portrait ? 0.5 : 0.25 };
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
        } else if (e.outcome === 'partial') {
          pop(handX(e.side), 'ЧАСТИЧНО', '#ffd166', 0.8);
          this.shake = Math.max(this.shake, 4);
        } else if (e.outcome === 'blocked') {
          pop(handX(d as Side), 'УПОР!', TEAM_COLORS[d], 1.1);
          pop(handX(e.side), 'ХВАТ СБИТ', '#ffffff', 0.75, 34);
          this.shake = Math.max(this.shake, 5);
          this.dust(handX(d as Side), lay.groundY, 14, now);
        } else if (e.outcome === 'punish') {
          pop(handX(e.side), 'ДОБИВАНИЕ!', '#ffd166', 1.15);
          this.shake = Math.max(this.shake, 12);
          this.dust(handX(d as Side), lay.groundY, 18, now);
        } else {
          pop(mx, 'СТОЛКНОВЕНИЕ', '#ffffff', 0.9);
          this.shake = Math.max(this.shake, 8);
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
        pop(lay.cx, 'ФИНАЛЬНЫЕ 15 СЕКУНД — РЫВКИ СИЛЬНЕЕ', '#ffd166', 0.7, -40);
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

  draw(v: View, now: number): void {
    const dt = Math.min(0.05, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    const lay = this.layout();
    this.lastLayout = lay;
    const { ctx } = this;
    const s = v.state;
    const rope = v.prevRope + (s.rope - v.prevRope) * v.alpha;

    ctx.save();
    if (this.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake * 0.6);
      this.shake *= Math.exp(-dt * 12);
    }
    const lim = Number.isFinite(s.opts.winLine) ? s.opts.winLine : 100;
    const cam = -(rope / lim) * lay.L * lay.cam;
    this.drawSky(lay);
    ctx.save();
    ctx.translate(cam, 0);
    this.drawGround(lay, s.opts.winLine);

    const mx = this.ropeX(lay, rope, s.opts.winLine);
    const hx: [number, number] = [mx - lay.gap, mx + lay.gap];

    for (const side of [0, 1] as const) {
      const target = this.targetLean(s, side, now);
      const f = s.fighters[side];
      const speed = f.action === 'recover' ? 30 : 12;
      this.lean[side] += (target - this.lean[side]) * (1 - Math.exp(-dt * speed));
    }

    const hands = ([0, 1] as const).map((side) => this.figureHands(lay, hx[side], side));
    this.drawRope(lay, s, hands[0], hands[1], mx, rope);
    for (const side of [0, 1] as const) this.drawFigure(lay, s, side, hx[side], now, v.warn === side);

    this.drawParticles(dt, now);
    this.drawPopups(now);
    ctx.restore();
    ctx.restore();
    this.drawCountdown(lay, s, now);
  }

  private targetLean(s: MatchState, side: Side, now: number): number {
    const f = s.fighters[side];
    if (s.phase === 'over' && s.result) {
      if (s.result.winner === side) return 0.15 + Math.sin(now * 8) * 0.05;
      if (s.result.winner !== null) return -0.45;
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

  private drawSky(lay: Layout): void {
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

  private drawGround(lay: Layout, winLine: number): void {
    const { ctx } = this;
    const { W, H, groundY, cx, L } = lay;
    const a = ARENA_LOOKS[this.arena] ?? ARENA_LOOKS.steppe;
    const ground = ctx.createLinearGradient(0, groundY, 0, H);
    ground.addColorStop(0, a.ground[0]);
    ground.addColorStop(1, a.ground[1]);
    ctx.fillStyle = ground;
    ctx.fillRect(-W, groundY, W * 3, H - groundY + 20);

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

  /** Геометрия фигуры: стопы, бёдра, плечи, голова, руки на канате. */
  private pose(lay: Layout, handX: number, side: Side) {
    const d = side === 0 ? -1 : 1;
    const a = this.lean[side];
    const k = lay.fig;
    const leg = k * 0.42;
    const torso = k * 0.38;
    const arm = k * 0.34;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    const footX = handX + d * arm - d * sin * (leg + torso);
    const foot = { x: footX, y: lay.groundY };
    const hip = { x: foot.x + d * sin * leg, y: foot.y - cos * leg };
    const shoulder = { x: hip.x + d * sin * torso, y: hip.y - cos * torso };
    const head = { x: shoulder.x + d * sin * k * 0.13, y: shoulder.y - cos * k * 0.13 };
    const hand = { x: handX, y: shoulder.y + k * 0.07 };
    return { d, a, k, foot, hip, shoulder, head, hand };
  }

  private figureHands(lay: Layout, handX: number, side: Side) {
    return this.pose(lay, handX, side).hand;
  }

  private drawRope(lay: Layout, s: MatchState, h0: { x: number; y: number }, h1: { x: number; y: number }, mx: number, rope: number): void {
    const { ctx } = this;
    const tension = holdForce(s.fighters[0]) + holdForce(s.fighters[1]);
    const sag = lay.fig * 0.16 * Math.max(0, 1 - tension / 1.1);
    const midY = (h0.y + h1.y) / 2 + sag;
    const ext = lay.fig * 0.5;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(h0.x - ext, h0.y + 6);
      ctx.lineTo(h0.x, h0.y);
      ctx.quadraticCurveTo((h0.x + h1.x) / 2, midY, h1.x, h1.y);
      ctx.lineTo(h1.x + ext, h1.y + 6);
    };
    const w = Math.max(5, lay.fig * 0.05);
    ctx.lineCap = 'round';
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
    const t = 0.5;
    const my = (1 - t) * (1 - t) * h0.y + 2 * (1 - t) * t * midY + t * t * h1.y;
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(mx - 7, my);
    ctx.lineTo(mx + 7, my);
    ctx.lineTo(mx + 3, my + 26);
    ctx.lineTo(mx, my + 20);
    ctx.lineTo(mx - 3, my + 26);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFigure(lay: Layout, s: MatchState, side: Side, handX: number, now: number, warn: boolean): void {
    const { ctx } = this;
    const f: Fighter = s.fighters[side];
    const p = this.pose(lay, handX, side);
    const { d, k, foot, hip, shoulder, head, hand } = p;
    const color = TEAM_COLORS[side];
    const guard = isGuarding(f) ? f.brace : 0;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Тень.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(foot.x + d * k * 0.15, lay.groundY + 3, k * 0.32, k * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();

    // Ноги: передняя и задняя, в упоре колени сильнее согнуты.
    const bend = k * (0.05 + 0.1 * guard);
    const legs = [
      { x: foot.x, y: foot.y },
      { x: foot.x + d * k * 0.2, y: foot.y },
    ];
    ctx.strokeStyle = '#2b2f3f';
    ctx.lineWidth = k * 0.09;
    for (const ft of legs) {
      const mxk = (ft.x + hip.x) / 2 - d * bend;
      const myk = (ft.y + hip.y) / 2;
      ctx.beginPath();
      ctx.moveTo(ft.x, ft.y);
      ctx.lineTo(mxk, myk);
      ctx.lineTo(hip.x, hip.y);
      ctx.stroke();
    }
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
    if (f.action === 'windup') {
      ctx.fillStyle = 'rgba(255, 230, 120, 0.35)';
      ctx.beginPath();
      ctx.arc(shoulder.x, shoulder.y, k * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }

    // Корпус.
    ctx.strokeStyle = color;
    ctx.lineWidth = k * 0.16;
    ctx.beginPath();
    ctx.moveTo(hip.x, hip.y);
    ctx.lineTo(shoulder.x, shoulder.y);
    ctx.stroke();
    // Пояс.
    ctx.strokeStyle = '#f2c14e';
    ctx.lineWidth = k * 0.04;
    ctx.beginPath();
    const bx = hip.x + (shoulder.x - hip.x) * 0.18;
    const by = hip.y + (shoulder.y - hip.y) * 0.18;
    ctx.moveTo(bx - k * 0.07, by);
    ctx.lineTo(bx + k * 0.07, by);
    ctx.stroke();

    // Руки.
    ctx.strokeStyle = color;
    ctx.lineWidth = k * 0.075;
    const slip = f.action === 'stunned' ? Math.sin(now * 30) * k * 0.04 : 0;
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(hand.x, hand.y + slip);
    ctx.stroke();
    ctx.fillStyle = '#e0a878';
    ctx.beginPath();
    ctx.arc(hand.x, hand.y + slip, k * 0.045, 0, Math.PI * 2);
    ctx.fill();

    // Голова и калпак.
    const hr = k * 0.1;
    const droop = f.action === 'exhausted' ? k * 0.04 : 0;
    const hy = head.y + droop;
    ctx.fillStyle = '#e0a878';
    ctx.beginPath();
    ctx.arc(head.x, hy, hr, 0, Math.PI * 2);
    ctx.fill();
    const [hat, brim] = SKIN_LOOKS[this.skins[side]] ?? SKIN_LOOKS.classic;
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
    if (f.action === 'stunned') {
      for (let i = 0; i < 3; i++) {
        const ang = now * 6 + (i * Math.PI * 2) / 3;
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(head.x + Math.cos(ang) * hr * 1.6, hy - hr * 2.4 + Math.sin(ang) * hr * 0.5, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (f.action === 'exhausted' && Math.random() < 0.15) {
      this.particles.push({ x: head.x, y: hy - hr, vx: (Math.random() - 0.5) * 40, vy: -30, born: now, life: 0.6, color: '#9fd3ff', r: 2.5 });
    }
    if (guard > 0.9 && Math.random() < 0.06) this.dust(foot.x, lay.groundY, 1, now);
    if (warn) {
      ctx.fillStyle = '#ffd166';
      ctx.font = `900 ${Math.round(k * 0.4)}px Unbounded, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('!', head.x, hy - hr * 2.6 + Math.sin(now * 14) * 3);
    }
  }

  private drawParticles(dt: number, now: number): void {
    const { ctx } = this;
    this.particles = this.particles.filter((p) => now - p.born < p.life);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 240 * dt;
      const a = 1 - (now - p.born) / p.life;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
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
