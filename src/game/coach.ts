// Живой тренер: во время матча выбирает одну главную подсказку по состоянию каната
// и проговаривает её голосом. Только читает состояние — на правила не влияет.

import { dir, isFinalStretch, isGuarding, other, type MatchState, type Side } from '../engine/match';

interface Hint {
  id: string;
  text: string;
  /** Срочная — показывается сразу и перебивает текущую. */
  urgent?: boolean;
}

/** Голос через встроенный синтез речи; молчит, если в системе нет русского голоса. */
class Voice {
  private voice: SpeechSynthesisVoice | null = null;

  constructor() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const pick = () => {
      const ru = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ru'));
      this.voice = ru.find((v) => /google|natural|online|milena|svetlana|dariya/i.test(v.name)) ?? ru[0] ?? null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  }

  say(text: string, interrupt: boolean): void {
    if (!this.voice) return;
    const synth = window.speechSynthesis;
    if (synth.speaking) {
      if (!interrupt) return;
      synth.cancel();
    }
    const u = new SpeechSynthesisUtterance(text);
    u.voice = this.voice;
    u.lang = this.voice.lang;
    u.rate = 1.15;
    synth.speak(u);
  }

  stop(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) speechSynthesis.cancel();
  }
}

/** Выбрать подсказку для стороны me. null — сейчас подсказывать нечего. */
export function pickHint(s: MatchState, me: Side): Hint | null {
  if (s.phase !== 'live') return null;
  const m = s.fighters[me];
  const o = s.fighters[other(me)];
  const oGuard = isGuarding(o) && o.brace > 0.5;
  if ((o.action === 'stunned' || o.action === 'exhausted') && m.action === 'none' && m.stamina >= 15) {
    return { id: 'punish', text: o.action === 'stunned' ? 'Хват сбит - добивай! Рывок!' : 'Он выдохся - добивай! Рывок!', urgent: true };
  }
  if (m.action === 'recover' && !m.braceHeld && o.stamina >= 30 && o.action === 'none') {
    return { id: 'guard', text: 'Зажми упор - ответный рывок врежется в стену', urgent: true };
  }
  if (isGuarding(m) && m.stamina < 25) return { id: 'release', text: 'Отпусти упор, а то выдохнешься' };
  if (oGuard && m.action === 'none') return { id: 'wait', text: 'Он уперся - не рви, отдыхай, пусть тратит силы' };
  if (m.stamina < 30 && !m.braceHeld && m.action === 'none') return { id: 'rest', text: 'Мало сил - передышка, копи на рывок' };
  if (o.stamina < 30 && m.stamina >= 30 && o.action === 'none' && !oGuard) return { id: 'attack', text: 'У него нет сил на упор - рви!' };
  if (isFinalStretch(s) && s.rope * dir(me) < 0) return { id: 'final', text: 'Финал! Рывки сильнее - рискуй и отыгрывайся' };
  if (o.stamina >= 90 && o.action === 'none' && !oGuard && m.stamina >= 40) return { id: 'ready', text: 'У него полно сил - жди рывка, готовь упор' };
  return null;
}

export class LiveCoach {
  enabled = true;
  voiceOn = true;
  /** Пауза между подсказками, мс: на сложном боте тренер подсказывает реже. */
  gapMs = 1200;
  private readonly voice = new Voice();
  private shown: { hint: Hint; since: number } | null = null;
  private candidate: { id: string; since: number } | null = null;
  private lastHidden = -1e9;
  private spokenAt = new Map<string, number>();

  reset(): void {
    this.shown = null;
    this.candidate = null;
    this.voice.stop();
  }

  /** Текст подсказки на этот кадр или null. */
  update(s: MatchState, me: Side, now: number): string | null {
    if (!this.enabled) return null;
    const h = pickHint(s, me);
    if (this.shown) {
      const age = now - this.shown.since;
      const same = h?.id === this.shown.hint.id;
      // Держим подсказку хотя бы 1,6 с, чтобы успеть прочитать; срочная перебивает.
      if (same || (age < 1600 && !h?.urgent)) return this.shown.hint.text;
      this.shown = null;
      this.lastHidden = now;
    }
    if (!h) {
      this.candidate = null;
      return null;
    }
    if (!h.urgent) {
      if (this.candidate?.id !== h.id) this.candidate = { id: h.id, since: now };
      // Обычная подсказка — только если ситуация держится и после паузы.
      if (now - this.candidate.since < 300 || now - this.lastHidden < this.gapMs) return null;
    }
    this.shown = { hint: h, since: now };
    if (this.voiceOn && now - (this.spokenAt.get(h.id) ?? -1e9) > 5000) {
      this.spokenAt.set(h.id, now);
      this.voice.say(h.text.replace(/ - /g, ', '), !!h.urgent);
    }
    return h.text;
  }
}
