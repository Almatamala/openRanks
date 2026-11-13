/**
 * Fallo previsto con su código HTTP, para que la API no invente el estado.
 *
 * Los errores de cada módulo (`SettingsError`, `ScoreError`, `ImportError`) heredan de
 * aquí: cada ruta atrapa el suyo y lee `status` sin repetir el constructor. `new.target`
 * conserva el nombre del hijo en `error.name`, así que los logs siguen diciendo cuál fue.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}
