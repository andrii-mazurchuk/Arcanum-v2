// Rates family (S-130): per requested currency, the latest held record of that currency against the
// hryvnia from the rate source of record, shown exactly as held with its recorded moment drawn in
// the question's zone. Nothing is converted and nothing is shown, so the rates-used statement stays
// empty; scope narrowing does not change the lines.

import type { CurrencyCode, Instant, LocalDateTime, SourceId } from '../core/primitives';
import { refuse } from '../core/primitives';
import type { Family } from '../core/question';
import type { MoneyPart } from '../money/context';
import { currencyByCode } from '../money/currencies';
import { decimalToString } from '../money/exact';
import type { QuotedPair, RateFigures } from '../money/recorded-rates';

export const DEFAULT_RATE_CURRENCIES = ['USD', 'EUR', 'PLN', 'GBP'] as const;
export type QuotedFigures = { kind: 'buy_sell'; buy: string; sell: string } | { kind: 'cross'; rate: string }; // decimalToString of the record's figures
export interface QuotedRateLine {
  readonly currency: CurrencyCode;
  readonly quote: null | { pair: QuotedPair; figures: QuotedFigures; recordedAt: Instant; localDateTime: LocalDateTime }; // null: no record held
}
export interface RatesBody {
  readonly rateSource: SourceId | null;
  readonly lines: readonly QuotedRateLine[];
}

const HRYVNIA = 'UAH';

const asText = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));

const badCurrency = (value: unknown) =>
  refuse('bad_option', 'currencies', `The currency "${asText(value)}" cannot be shown against the hryvnia.`, asText(value));

const quoted = (f: RateFigures): QuotedFigures =>
  f.kind === 'buy_sell'
    ? { kind: 'buy_sell', buy: decimalToString(f.buy), sell: decimalToString(f.sell) }
    : { kind: 'cross', rate: decimalToString(f.rate) };

export function createRatesFamily(money: MoneyPart): Family<RatesBody> {
  return {
    name: 'exchange_rates',
    period: 'none',
    movesPoint: false,
    compute(ctx) {
      for (const key of Object.keys(ctx.options)) {
        if (key !== 'currencies') {
          return refuse('bad_option', key, `The rates question takes no option "${key}".`);
        }
      }
      let currencies: readonly CurrencyCode[] = DEFAULT_RATE_CURRENCIES;
      const option = ctx.options.currencies;
      if (option !== undefined) {
        if (!Array.isArray(option) || option.length === 0) return badCurrency(option);
        const picked: CurrencyCode[] = [];
        for (const c of option as unknown[]) {
          if (typeof c !== 'string' || c === HRYVNIA || currencyByCode(c) === undefined) return badCurrency(c);
          if (!picked.includes(c)) picked.push(c);
        }
        currencies = picked;
      }

      const rates = money.moneyFor(ctx).rates;
      const lines = currencies.map((currency): QuotedRateLine => {
        const pair = [
          { base: currency, quote: HRYVNIA },
          { base: HRYVNIA, quote: currency },
        ].find((p) => rates.hasAny(p));
        const dr = pair === undefined ? null : rates.latest(pair);
        if (pair === undefined || dr === null) return { currency, quote: null };
        const recordedAt = dr.record.heldFrom;
        return {
          currency,
          quote: {
            pair,
            figures: quoted(dr.record.figures),
            recordedAt,
            localDateTime: ctx.calendar.localDateTime(recordedAt),
          },
        };
      });
      return { kind: 'body', body: { rateSource: money.rateSource, lines } };
    },
  };
}
