import { afterEach, describe, expect, it } from 'vitest';
import { BUSINESS } from '../src/constants.js';
import { ensureBusinessTimezone } from '../src/timezone.js';

describe('zona horaria del proceso', () => {
  afterEach(() => {
    process.env.TZ = BUSINESS.timezone;
  });

  it('usa explicitamente America/Lima', () => {
    process.env.TZ = 'UTC';

    ensureBusinessTimezone();

    expect(process.env.TZ).toBe('America/Lima');
    expect(process.env.TZ).toBe(BUSINESS.timezone);
  });
});
