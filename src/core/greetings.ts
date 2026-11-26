/**
 * Greeting days: the small skin (a headline, a colour, a motif) that the
 * greeting page wears on a birthday, at Christmas and so on. Everything is
 * computed from the calendar date and the configuration: nothing needs the
 * network, and the answer is the same every time it is asked.
 */
import { z } from 'zod';
import type { HubSceneSkin } from './hub-rules.js';

const MonthDaySchema = z
  .string()
  .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const BirthdaySchema = z
  .object({
    name: z.string().min(1).max(40),
    /** `MM-DD`, or `YYYY-MM-DD` to also show the age. */
    date: z.string().regex(/^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  })
  .strict();
const CustomDaySchema = z
  .object({
    title: z.string().min(1).max(60),
    date: MonthDaySchema,
  })
  .strict();

export const GreetingsConfigSchema = z
  .object({
    birthdays: z.array(BirthdaySchema).max(32).default([]),
    /** Days of your own ("Bröllopsdagen"), every year. */
    days: z.array(CustomDaySchema).max(32).default([]),
  })
  .strict()
  .default({ birthdays: [], days: [] });
export type GreetingsConfig = z.output<typeof GreetingsConfigSchema>;

type DateParts = { year: number; month: number; day: number; weekday: number };

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});
const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 0,
};

/** The Stockholm calendar date at `at`; `weekday` is 0 for Sunday. */
export function stockholmDate(at: number): DateParts {
  const parts: DateParts = { year: 0, month: 0, day: 0, weekday: 0 };
  for (const part of dateFormat.formatToParts(at)) {
    if (part.type === 'year') parts.year = Number(part.value);
    else if (part.type === 'month') parts.month = Number(part.value);
    else if (part.type === 'day') parts.day = Number(part.value);
    else if (part.type === 'weekday')
      parts.weekday = WEEKDAY_INDEX[part.value] ?? 0;
  }
  return parts;
}

/** Easter Sunday (the Gregorian computus, Meeus/Jones/Butcher). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const dayOfYear = (year: number, month: number, day: number) =>
  Math.round(Date.UTC(year, month - 1, day) / 86_400_000);

/**
 * Today's greeting day, or null. A birthday goes first, then a day of your own,
 * then the calendar's: Lucia (13 Dec), Christmas (24-26 Dec), New Year's Eve and
 * Day, Easter Eve and Easter Day, Midsummer Eve and Day (the Friday and Saturday
 * from 19 to 26 June) and All Saints' Day (the Saturday from 31 Oct to 6 Nov).
 */
export function greetingSkin(
  at: number,
  config: GreetingsConfig = { birthdays: [], days: [] },
): HubSceneSkin | null {
  const date = stockholmDate(at);
  const mmdd = `${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;

  for (const birthday of config.birthdays) {
    const parts = birthday.date.split('-');
    const monthDay = parts.slice(-2).join('-');
    if (monthDay !== mmdd) continue;
    const born = parts.length === 3 ? Number(parts[0]) : null;
    return {
      id: 'fodelsedag',
      name: birthday.name,
      ...(born !== null && date.year > born ? { age: date.year - born } : {}),
    };
  }
  for (const custom of config.days)
    if (custom.date === mmdd) return { id: 'egen', title: custom.title };

  if (mmdd === '12-13') return { id: 'lucia' };
  if (date.month === 12 && date.day >= 24 && date.day <= 26)
    return { id: 'jul' };
  if (mmdd === '12-31' || mmdd === '01-01') return { id: 'nyar' };

  const easter = easterSunday(date.year);
  const offset =
    dayOfYear(date.year, date.month, date.day) -
    dayOfYear(date.year, easter.month, easter.day);
  if (offset === 0 || offset === -1) return { id: 'pask' };

  // Midsummer Eve is the Friday from 19 to 25 June; Midsummer Day follows.
  if (date.month === 6) {
    const eve = date.weekday === 5 && date.day >= 19 && date.day <= 25;
    const day = date.weekday === 6 && date.day >= 20 && date.day <= 26;
    if (eve || day) return { id: 'midsommar' };
  }
  // All Saints' Day: the Saturday from 31 October to 6 November.
  if (
    date.weekday === 6 &&
    ((date.month === 10 && date.day === 31) ||
      (date.month === 11 && date.day <= 6))
  )
    return { id: 'allahelgon' };
  return null;
}
