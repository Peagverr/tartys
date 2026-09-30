// Игровой цикл с фиксированным шагом: сколько бы ни было кадров в секунду,
// движок делает ровно 60 тиков за секунду реального времени.

import { sendCommand, stepMatch, type Command, type GameEvent, type MatchState } from '../engine/match';
import { DT } from '../engine/rules';

/** Кто отдаёт команды сам по себе: бот или сценарий обучения. */
export interface Driver {
  update(s: MatchState): Command[];
}

export class Runner {
  prevRope = 0;
  paused = false;
  private acc = 0;

  constructor(
    public state: MatchState,
    private readonly drivers: Driver[],
    private readonly onEvent: (e: GameEvent, s: MatchState) => void,
  ) {}

  /** Команда живого игрока: попадает в очередь и применится в начале следующего тика. */
  command(cmd: Command): void {
    if (!this.paused) sendCommand(this.state, cmd);
  }

  /** Продвинуть время на dt секунд; возвращает долю тика для интерполяции. */
  advance(dt: number): number {
    if (this.paused) return 1;
    // После долгой паузы вкладки не пытаемся «догнать» секунды одним махом.
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) {
      this.prevRope = this.state.rope;
      for (const d of this.drivers) for (const c of d.update(this.state)) sendCommand(this.state, c);
      stepMatch(this.state);
      for (const e of this.state.events) this.onEvent(e, this.state);
      this.acc -= DT;
    }
    return this.acc / DT;
  }
}
