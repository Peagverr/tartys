// Интерактивное обучение: учебный соперник справа ведёт себя по сценарию шага,
// а шаг засчитывается по реальным событиям движка — те же правила, что в бою.

import type { Command, GameEvent, MatchState, Side } from '../engine/match';
import { RULES, ticks } from '../engine/rules';
import type { Driver } from './runner';

export interface TutorialStep {
  title: string;
  text: string;
  goal: number;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: '1 · Рывок',
    text: 'Соперник отдыхает — рывок пройдёт полностью. Жми <kbd>W</kbd> / <kbd>Пробел</kbd> или кнопку <b>РЫВОК</b>. Каждый рывок стоит сил.',
    goal: 3,
  },
  {
    title: '2 · Упор',
    text: 'Над соперником «!» — он сейчас рванёт. Зажми <kbd>S</kbd> / <kbd>Shift</kbd> или <b>УПОР</b> <i>заранее</i> и держи. Рывок в упор отдаётся назад, а у соперника сбивается хват.',
    goal: 2,
  },
  {
    title: '3 · Передышка',
    text: 'Соперник встал в упор. Рвать в стену бесполезно. Отпусти всё — в передышке силы растут, а его упор их жжёт. Когда он <b>ВЫДОХНЕТСЯ</b> — рывок! Это добивание.',
    goal: 1,
  },
  {
    title: '4 · Рванул — упёрся',
    text: 'Этот соперник отвечает рывком на рывок. Рвани и <i>сразу</i> зажми упор — его ответ врежется в стену.',
    goal: 1,
  },
];

export class Tutorial implements Driver {
  step = 0;
  progress = 0;
  /** Короткая реакция на ошибку игрока. */
  note = '';
  warn: Side | null = null;
  done = false;
  private t = 0;
  private nextYank = 0;
  private noteUntil = 0;
  private counterAt = -1;
  private braceSent: boolean | null = null;

  constructor(private readonly onChange: () => void) {}

  private setBrace(on: boolean, cmds: Command[]): void {
    if (this.braceSent === on) return;
    this.braceSent = on;
    cmds.push({ side: 1, kind: 'brace', on });
  }

  private enter(step: number, s: MatchState): void {
    this.step = step;
    this.progress = 0;
    this.t = 0;
    this.counterAt = -1;
    this.nextYank = ticks(1.6);
    this.warn = null;
    s.rope = 0;
    s.ropeVel = 0;
    const dummy = s.fighters[1];
    dummy.stamina = step === 2 ? 45 : RULES.staminaMax;
    s.fighters[0].stamina = RULES.staminaMax;
    if (step >= TUTORIAL_STEPS.length) this.done = true;
    this.onChange();
  }

  update(s: MatchState): Command[] {
    const cmds: Command[] = [];
    if (this.done) return cmds;
    this.t++;
    if (this.noteUntil && this.t > this.noteUntil) {
      this.note = '';
      this.noteUntil = 0;
      this.onChange();
    }
    // Канат в обучении не уезжает за края.
    s.rope = Math.max(-70, Math.min(70, s.rope));
    const me = s.fighters[1];

    switch (this.step) {
      case 0:
        this.setBrace(false, cmds);
        break;
      case 1: {
        this.setBrace(false, cmds);
        const lead = ticks(0.9);
        this.warn = this.t >= this.nextYank - lead && this.t < this.nextYank + ticks(RULES.windupSec) ? 1 : null;
        if (this.t >= this.nextYank && me.action === 'none') {
          me.stamina = RULES.staminaMax;
          cmds.push({ side: 1, kind: 'yank' });
          this.nextYank = this.t + ticks(2.6);
        }
        break;
      }
      case 2:
        // Стоит в упоре, пока не выдохнется; отдышавшись — снова в упор.
        this.setBrace(true, cmds);
        break;
      case 3:
        this.setBrace(false, cmds);
        me.stamina = RULES.staminaMax;
        if (this.counterAt >= 0 && this.t >= this.counterAt) {
          cmds.push({ side: 1, kind: 'yank' });
          this.counterAt = -1;
        }
        break;
    }
    return cmds;
  }

  onEvent(e: GameEvent, s: MatchState): void {
    if (this.done) return;
    const say = (text: string) => {
      this.note = text;
      this.noteUntil = this.t + ticks(2.5);
      this.onChange();
    };
    const tick = () => {
      this.progress++;
      if (this.progress >= TUTORIAL_STEPS[this.step].goal) {
        this.enter(this.step + 1, s);
      } else this.onChange();
    };
    if (e.type !== 'yank') {
      if (this.step === 0 && e.type === 'nostamina') say('Силы кончились — подожди, в передышке они восстановятся.');
      return;
    }
    const mine = e.side === 0;
    switch (this.step) {
      case 0:
        if (mine && e.outcome !== 'blocked') tick();
        break;
      case 1:
        if (!mine && e.outcome === 'blocked') tick();
        else if (!mine) say('Поздно! Замах слишком быстрый, чтобы успеть глазами — упор ставят заранее, по «!».');
        break;
      case 2:
        if (mine && e.outcome === 'punish') tick();
        else if (mine && e.outcome === 'blocked') say('Видишь? В упор не рви — хват сбился. Жди, пока он выдохнется.');
        else if (mine) say('Рано! Дождись надписи «ВЫДОХСЯ».');
        break;
      case 3:
        if (mine) this.counterAt = this.t + ticks(0.2);
        else if (e.outcome === 'blocked') tick();
        else say('Не успел — упор нужно зажать сразу после своего рывка.');
        break;
    }
  }
}
