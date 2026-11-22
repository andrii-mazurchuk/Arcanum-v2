// Money context (S-86): one per question object, built from the question's snapshot, calendar and
// display currency over the rate source of record chosen once from the product's built source list,
// never from the question's settings. It collects the results an answer shows and supplies the
// 'ratesUsed' envelope contributor, which closes it. It holds no source, network or fetch handle.

import type { SourceId } from '../core/primitives';
import type { EnvelopeContributor, QuestionContext } from '../core/question';
import type { ConversionResult, Converter } from './converter';
import { createConverter } from './converter';
import type { BuiltSource, RateView } from './rate-view';
import { chooseRateSource, openRateView } from './rate-view';
import type { RateUsedItem } from './rates-used';
import { assembleRatesUsed } from './rates-used';

export interface MoneyContext {
  readonly converter: Converter;
  readonly rates: RateView;
  readonly rateSource: SourceId | null;
  show(results: Iterable<ConversionResult>): void; // declare results that contribute to a rendered figure
  ratesUsed(): RateUsedItem[]; // assembleRatesUsed over everything shown so far
}

export interface MoneyPart {
  readonly rateSource: SourceId | null; // the rate source of record, chosen once at creation
  moneyFor(ctx: QuestionContext): MoneyContext;
  readonly ratesUsedContributor: EnvelopeContributor; // key 'ratesUsed'
}

// show called after the question's contributors ran.
export class MoneyContextClosedError extends Error {
  constructor(message = 'money context closed: show called after the ratesUsed contributor ran') {
    super(message);
    this.name = 'MoneyContextClosedError';
  }
}

interface OpenContext extends MoneyContext {
  close(): void;
}

function openContext(ctx: QuestionContext, rateSource: SourceId | null): OpenContext {
  const rates = openRateView(ctx.snapshot, ctx.calendar, rateSource);
  const converter = createConverter(rates, ctx.calendar, ctx.displayCurrency);
  const shown: ConversionResult[] = [];
  let closed = false;
  return {
    converter,
    rates,
    rateSource,
    show(results) {
      if (closed) throw new MoneyContextClosedError();
      for (const r of results) shown.push(r);
    },
    ratesUsed: () => assembleRatesUsed(shown),
    close() {
      closed = true;
    },
  };
}

export function createMoneyPart(built: readonly BuiltSource[]): MoneyPart {
  const frozen: readonly BuiltSource[] = Object.freeze(
    built.map((s) => Object.freeze({ id: s.id, capabilities: Object.freeze([...s.capabilities]) })),
  );
  const rateSource = chooseRateSource(frozen);
  const contexts = new WeakMap<QuestionContext, OpenContext>();

  const contextFor = (ctx: QuestionContext): OpenContext => {
    let m = contexts.get(ctx);
    if (m === undefined) {
      m = openContext(ctx, rateSource);
      contexts.set(ctx, m);
    }
    return m;
  };

  return {
    rateSource,
    moneyFor: (ctx) => contextFor(ctx),
    ratesUsedContributor: {
      key: 'ratesUsed',
      contribute(ctx) {
        const m = contextFor(ctx);
        const items = m.ratesUsed();
        m.close();
        return items;
      },
    },
  };
}
