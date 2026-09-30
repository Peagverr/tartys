// Звуки синтезируются на лету через Web Audio — никаких файлов.

export class Sound {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  /** Вызывать из обработчика жеста пользователя — иначе браузер не даст играть звук. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  private ready(): AudioContext | null {
    return this.enabled && this.ctx && this.master ? this.ctx : null;
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, slideTo?: number, delay = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, from: number, to: number, vol = 0.3, q = 1): void {
    const ctx = this.ready();
    if (!ctx || !this.noiseBuf) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  countdown(): void {
    this.tone(440, 0.15, 'square', 0.15);
  }
  start(): void {
    this.tone(880, 0.35, 'square', 0.18);
    this.tone(1320, 0.3, 'triangle', 0.12, undefined, 0.05);
  }
  windup(): void {
    this.noise(0.18, 400, 1400, 0.08, 2);
  }
  landed(power: number): void {
    this.noise(0.25, 2400, 300, 0.25 + 0.2 * power, 0.8);
    this.tone(120, 0.2, 'sine', 0.35, 60);
  }
  blocked(): void {
    this.tone(220, 0.12, 'square', 0.18, 140);
    this.noise(0.12, 900, 500, 0.2, 4);
  }
  stun(): void {
    this.tone(600, 0.35, 'triangle', 0.12, 300);
  }
  clash(): void {
    this.tone(330, 0.2, 'sawtooth', 0.12, 280);
    this.tone(335, 0.2, 'sawtooth', 0.12, 250);
  }
  exhausted(): void {
    this.tone(300, 0.5, 'sine', 0.15, 150);
  }
  denied(): void {
    this.tone(160, 0.08, 'square', 0.08);
  }
  final(): void {
    this.tone(660, 0.12, 'square', 0.12);
    this.tone(660, 0.12, 'square', 0.12, undefined, 0.18);
  }
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.18, undefined, i * 0.11));
  }
  lose(): void {
    [392, 330, 262].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.15, undefined, i * 0.16));
  }
  click(): void {
    this.tone(700, 0.05, 'square', 0.06);
  }
}
