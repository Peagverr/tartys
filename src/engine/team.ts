// Командный ввод: много людей управляют одной стороной каната.
// Работает на сервере: собирает нажатия участников и превращает их в команды движка.
//
// Упор — если держит хотя бы половина команды.
// Рывок — первое нажатие открывает окно синхронности; когда окно закрылось
// (или дёрнули все), выходит один рывок. Дёрнули ≥70% — дружный рывок ×1,5,
// иначе сила пропорциональна доле дёрнувших. Силы тратятся как за обычный рывок,
// поэтому тянуть вразнобой невыгодно.

import type { Command, Fighter, Side } from './match';
import { RULES, ticks } from './rules';

export class TeamInput {
  private members = new Set<string>();
  private bracing = new Set<string>();
  private pressed = new Set<string>();
  private windowOpenedAt = -1;
  private braceSent = false;
  /** Доля команды, которая дёрнула в текущем окне (для индикатора на экране). */
  share = 0;

  constructor(readonly side: Side) {}

  get size(): number {
    return this.members.size;
  }

  /** Состав команды по id игроков, которые сейчас на связи. */
  setMembers(ids: Iterable<string>): void {
    this.members = new Set(ids);
    for (const id of [...this.bracing]) if (!this.members.has(id)) this.bracing.delete(id);
    for (const id of [...this.pressed]) if (!this.members.has(id)) this.pressed.delete(id);
  }

  brace(id: string, on: boolean): void {
    if (!this.members.has(id)) return;
    if (on) this.bracing.add(id);
    else this.bracing.delete(id);
  }

  /** Нажатие рывка. Повторные нажатия в том же окне не считаются. */
  yank(id: string, tick: number, fighter: Fighter): void {
    if (!this.members.has(id) || fighter.action !== 'none') return;
    if (this.windowOpenedAt < 0) this.windowOpenedAt = tick;
    this.pressed.add(id);
  }

  reset(): void {
    this.bracing.clear();
    this.pressed.clear();
    this.windowOpenedAt = -1;
    this.braceSent = false;
    this.share = 0;
  }

  /** Вызывать каждый тик до stepMatch. */
  update(tick: number): Command[] {
    const cmds: Command[] = [];
    const n = this.members.size;
    const braceOn = n > 0 && this.bracing.size > 0 && this.bracing.size * 2 >= n;
    if (braceOn !== this.braceSent) {
      this.braceSent = braceOn;
      cmds.push({ side: this.side, kind: 'brace', on: braceOn });
    }

    this.share = n > 0 ? this.pressed.size / n : 0;
    if (this.windowOpenedAt >= 0) {
      const expired = tick - this.windowOpenedAt >= ticks(RULES.syncWindowSec);
      if (expired || this.pressed.size >= n) {
        const share = this.share;
        const sync = n > 1 && share >= RULES.syncShare;
        const mult = n <= 1 ? 1 : sync ? RULES.syncMul : Math.max(RULES.minTeamMul, share);
        cmds.push({ side: this.side, kind: 'yank', mult, sync });
        this.pressed.clear();
        this.windowOpenedAt = -1;
      }
    }
    return cmds;
  }
}
