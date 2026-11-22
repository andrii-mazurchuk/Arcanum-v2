// Converter (S-85): one per answer. The route is chosen by whether the direct pair is held at all,
// each leg's record is the rate of some held day with substitution marked, the arithmetic is exact
// fractions with one half-away-from-zero rounding per line, and every result carries provenance.
// It offers no operation that converts or rounds a sum.

import type { Calendar } from '../analytics/dates';
import type { CurrencyCode, DisplayCurrency, Instant, LocalDate } from '../core/primitives';
import { exponentOf } from './currencies';
import type { ExactDecimal, Fraction } from './exact';
import { decimalToFraction, fraction, midpoint, mulF, reciprocal, roundHalfAwayFromZero } from './exact';
import type { Money } from './money';
import { money } from './money';
import type { DayRate, RateView } from './rate-view';
import type { QuotedPair, RecordedRate } from './recorded-rates';

export type When = { kind: 'day'; day: LocalDate } | { kind: 'latest' }; // a transaction's day (calendar.localDay of its instant); 'latest' for balances, credit limits, jar balances, net-position terms

export interface ProvenanceLeg {
  readonly applied: { readonly from: CurrencyCode; readonly to: CurrencyCode }; // direction applied
  readonly quoted: QuotedPair; // the pair as recorded
  readonly quotedValue: ExactDecimal; // record value as quoted (midpoint or cross)
  readonly appliedValue: Fraction; // quotedValue, or its exact reciprocal when applied quote -> base
  readonly recordDate: LocalDate; // day of the record used, in the answer's calendar
  readonly heldFrom: Instant; // that record's heldFrom
  readonly substituted: boolean; // true when used in place of the wanted day's missing rate
}

export type ConversionResult =
  | { kind: 'same'; original: Money; line: Money } // currency = display: no rate, line = original
  | { kind: 'converted'; original: Money; line: Money; legs: readonly ProvenanceLeg[] } // 1 leg direct, 2 legs built
  | { kind: 'unconverted'; original: Money; pair: { readonly from: CurrencyCode; readonly to: DisplayCurrency } };

export interface Converter {
  readonly display: DisplayCurrency;
  convert(amount: Money, when: When): ConversionResult;
}

const HUB: CurrencyCode = 'UAH';

// One leg of a route: the quoted pair as held and whether it is applied from quote to base.
interface RouteLeg {
  readonly quoted: QuotedPair;
  readonly reversed: boolean;
}

// Midpoint with trailing fractional zeros removed while its scale exceeds both figures' scales;
// a cross rate as written.
function quotedValueOf(record: RecordedRate): ExactDecimal {
  const f = record.figures;
  if (f.kind === 'cross') return f.rate;
  const floor = Math.max(f.buy.scale, f.sell.scale);
  let { digits, scale } = midpoint(f.buy, f.sell);
  while (scale > floor && digits % 10n === 0n) {
    digits /= 10n;
    scale -= 1;
  }
  return { digits, scale };
}

export function createConverter(view: RateView, calendar: Calendar, display: DisplayCurrency): Converter {
  const routes = new Map<string, readonly RouteLeg[] | null>();
  const records = new Map<string, { dayRate: DayRate; substituted: boolean }>();

  // The first of [from-in-to, to-in-from] with any record held, as a leg applied from -> to.
  const heldLeg = (from: CurrencyCode, to: CurrencyCode): RouteLeg | null => {
    const forward: QuotedPair = { base: from, quote: to };
    if (view.hasAny(forward)) return { quoted: forward, reversed: false };
    const backward: QuotedPair = { base: to, quote: from };
    if (view.hasAny(backward)) return { quoted: backward, reversed: true };
    return null;
  };

  const routeOf = (from: CurrencyCode): readonly RouteLeg[] | null => {
    const memo = routes.get(from);
    if (memo !== undefined) return memo;
    let route: readonly RouteLeg[] | null = null;
    const direct = heldLeg(from, display);
    if (direct !== null) {
      route = [direct];
    } else if (from !== HUB && display !== HUB) {
      const first = heldLeg(from, HUB);
      const second = first === null ? null : heldLeg(HUB, display);
      if (first !== null && second !== null) route = [first, second];
    }
    routes.set(from, route);
    return route;
  };

  const recordOf = (pair: QuotedPair, when: When): { dayRate: DayRate; substituted: boolean } => {
    const key = `${pair.base}/${pair.quote}|${when.kind === 'day' ? when.day : 'latest'}`;
    const memo = records.get(key);
    if (memo !== undefined) return memo;
    let chosen: { dayRate: DayRate; substituted: boolean } | null = null;
    if (when.kind === 'latest') {
      const latest = view.latest(pair);
      if (latest !== null) chosen = { dayRate: latest, substituted: false };
    } else {
      const ofDay = view.rateOfDay(pair, when.day);
      if (ofDay !== null) {
        chosen = { dayRate: ofDay, substituted: false };
      } else {
        const before = view.latestBefore(pair, calendar.startOfDay(when.day));
        if (before !== null) {
          chosen = { dayRate: before, substituted: true };
        } else {
          const earliest = view.earliest(pair);
          const firstDay = earliest === null ? null : view.rateOfDay(pair, earliest.day);
          if (firstDay !== null) chosen = { dayRate: firstDay, substituted: true };
        }
      }
    }
    if (chosen === null) throw new Error(`converter: no record of held pair ${pair.base}/${pair.quote}`);
    records.set(key, chosen);
    return chosen;
  };

  const provenance = (leg: RouteLeg, when: When): ProvenanceLeg => {
    const { dayRate, substituted } = recordOf(leg.quoted, when);
    const quotedValue = quotedValueOf(dayRate.record);
    const asFraction = decimalToFraction(quotedValue);
    const { base, quote } = leg.quoted;
    return {
      applied: leg.reversed ? { from: quote, to: base } : { from: base, to: quote },
      quoted: { base, quote },
      quotedValue,
      appliedValue: leg.reversed ? reciprocal(asFraction) : asFraction,
      recordDate: dayRate.day,
      heldFrom: dayRate.record.heldFrom,
      substituted,
    };
  };

  return {
    display,
    convert(amount, when) {
      const from = amount.currency;
      if (from === display) return { kind: 'same', original: amount, line: amount };
      const route = routeOf(from);
      if (route === null) return { kind: 'unconverted', original: amount, pair: { from, to: display } };
      const legs = route.map((leg) => provenance(leg, when));
      const shift = exponentOf(display) - exponentOf(from);
      let value =
        shift >= 0 ? fraction(amount.minor * 10n ** BigInt(shift), 1n) : fraction(amount.minor, 10n ** BigInt(-shift));
      for (const leg of legs) value = mulF(value, leg.appliedValue);
      return { kind: 'converted', original: amount, line: money(roundHalfAwayFromZero(value), display), legs };
    },
  };
}
