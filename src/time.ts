import { BUSINESS } from './constants.js';

export interface LimaNow {
  date: string;
  hour: number;
  minute: number;
  weekday: string;
}

export function getLimaNow(date = new Date()): LimaNow {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

export function isBusinessDay(now: LimaNow): boolean {
  return now.weekday !== 'Sun';
}

export function isDropoffInPast(hour: number, now: LimaNow): boolean {
  return hour <= now.hour;
}

export function toMinutes(hour: number, minute = 0): number { return hour * 60 + minute; }
export function roundUpTo10(now: LimaNow): { hour: number; minute: number } {
  const rounded = Math.max(BUSINESS.openHour * 60, (Math.floor(toMinutes(now.hour, now.minute) / 10) + 1) * 10);
  return { hour: Math.floor(rounded / 60), minute: rounded % 60 };
}
export function timeLabel(hour: number, minute = 0): string {
  const suffix = hour >= 12 ? 'p. m.' : 'a. m.';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function phoneIsRequired(createdAt: LimaNow, pickupHour: number, pickupMinute = 0): boolean {
  return createdAt.hour >= BUSINESS.phoneRequiredFromHour || toMinutes(pickupHour, pickupMinute) >= BUSINESS.latePickupHour * 60;
}

export function dropoffHours(): number[] {
  return Array.from(
    { length: BUSINESS.lastDropoffHour - BUSINESS.openHour + 1 },
    (_, index) => BUSINESS.openHour + index,
  );
}

export function pickupHours(): number[] {
  return Array.from(
    { length: BUSINESS.closeHour - BUSINESS.openHour },
    (_, index) => BUSINESS.openHour + index + 1,
  );
}
