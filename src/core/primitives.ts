// Answer primitives (S-01): the names every other answer-frame entry takes from here and never
// redeclares, and the one refusal shape.

export type Instant = number; // whole milliseconds since 1970-01-01T00:00:00Z; zone-free, never a local time
export type LocalDate = string; // 'YYYY-MM-DD', a day drawn in the question's zone by the calendar
export type LocalDateTime = string; // 'YYYY-MM-DDTHH:mm:ss+HH:MM' (or '-HH:MM'): wall time in the question's zone with that zone's offset at that instant
export type Position = number; // storage position: whole number >= 1 for a stored transaction; 0 means 'before anything was stored'
export type SourceId = string; // matches /^[a-z][a-z0-9_]*$/, e.g. 'monobank'; never contains ':'
export type HoldingId = string; // a holding's narrowing name, built only by the register's narrowingName
export type CurrencyCode = string; // ISO 4217 alphabetic code, upper case

export const DISPLAY_CURRENCIES = ['PLN', 'UAH', 'USD', 'EUR'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];
export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = 'PLN';

export const ASKERS = ['assistant', 'command_line'] as const;
export type Asker = (typeof ASKERS)[number];

export const REFUSAL_REASONS = [
  'unknown_time_zone',
  'bad_period',
  'scope_not_found',
  'bad_display_currency',
  'bad_option',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface Refusal {
  kind: 'refused';
  reason: RefusalReason;
  subject: string; // what was wrong: a setting name, the narrowing text, a period part, an option name
  value?: string; // the offending value as given, when there is one
  message: string; // one sentence for the holder, naming subject and value
}

// The only constructor of a Refusal. A question family's own refusals use 'bad_option' with
// the option's name as subject.
export function refuse(
  reason: RefusalReason,
  subject: string,
  message: string,
  value?: string,
): Refusal {
  const refusal: Refusal =
    value === undefined
      ? { kind: 'refused', reason, subject, message }
      : { kind: 'refused', reason, subject, value, message };
  return Object.freeze(refusal);
}

export function isRefusal(x: unknown): x is Refusal {
  return typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'refused';
}
