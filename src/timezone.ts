import { BUSINESS } from './constants.js';

/**
 * Keeps native Date APIs and third-party libraries aligned with the
 * business timezone, even when the host machine uses another timezone.
 */
export function ensureBusinessTimezone(): void {
  const configuredTimezone = process.env.TZ;

  if (configuredTimezone && configuredTimezone !== BUSINESS.timezone) {
    console.warn(
      `[timezone] TZ="${configuredTimezone}" reemplazada por "${BUSINESS.timezone}" ` +
        'porque el negocio opera con la hora de Lima.',
    );
  }

  process.env.TZ = BUSINESS.timezone;
}

ensureBusinessTimezone();
