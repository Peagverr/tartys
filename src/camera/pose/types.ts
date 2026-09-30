export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

/** Точка скелета в кадре: x, y нормированы в [0..1], v — уверенность модели, что точка видна. */
export interface Landmark extends Vec3 {
  v: number;
}

/**
 * Один кадр позы.
 *
 * Координаты `image` уже ЗЕРКАЛЬНЫЕ: левая часть экрана = левая сторона пользователя,
 * как в зеркале. Так подсказки «подними левую руку» совпадают с тем, что человек видит.
 */
export interface PoseFrame {
  /** Время кадра, мс. */
  t: number;
  /** 33 точки BlazePose в нормированных экранных координатах (зеркально). */
  image: Landmark[];
  /** 33 точки в метрах относительно центра таза (y вниз, x зеркально). */
  world: Vec3[];
  /** Ширина кадра / высота кадра — чтобы считать расстояния без искажений. */
  aspect: number;
}

export type Side = 'l' | 'r';

export const SIDES: readonly Side[] = ['l', 'r'];

export const other = (s: Side): Side => (s === 'l' ? 'r' : 'l');
