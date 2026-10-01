/** Ошибка включения камеры: что случилось и что сделать. */
export class CameraError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}
