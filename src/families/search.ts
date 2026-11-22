// Search family (S-123): period and scope bound the store read; category, whole-merchant and
// substring text are matched in the core with the one folding routine, and the amount range on each
// row's shown figure, sign ignored, both bounds inclusive. Survivors newest first, capped at
// SEARCH_CAP, with the count of further matches. Options are checked before anything is read.

import { foldedEquals, foldedIncludes } from '../answers/text';
import { refuse } from '../core/primitives';
import type { Family } from '../core/question';
import { CATEGORIES, type Category } from '../local/classifier';
import { selectTransactions } from '../local/transactions';
import type { MoneyPart } from '../money/context';
import type { ConversionResult } from '../money/converter';
import { parseMinorUnits } from '../money/money';
import { convertRow, type TransactionRow } from './rows';

export const SEARCH_CAP = 50;

export interface SearchBody {
  readonly rows: readonly TransactionRow[]; // newest first, at most SEARCH_CAP
  readonly matched: number; // every transaction that passed all filters
  readonly moreMatched: number; // matched - rows.length
  readonly cap: number; // SEARCH_CAP
}

const OPTION_KEYS = ['text', 'merchant', 'category', 'minAmount', 'maxAmount'] as const;

export function resolveCategory(text: string): Category | null {
  const wanted = text.trim();
  return CATEGORIES.find((c) => foldedEquals(c, wanted)) ?? null;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));
const abs = (n: bigint): bigint => (n < 0n ? -n : n);

export function createSearchFamily(money: MoneyPart): Family<SearchBody> {
  return {
    name: 'transaction_search',
    period: 'optional',
    movesPoint: false,
    compute(ctx) {
      const options = ctx.options;
      for (const key of Object.keys(options)) {
        if (!(OPTION_KEYS as readonly string[]).includes(key)) {
          return refuse('bad_option', key, `The search question takes no option "${key}".`);
        }
      }

      const texts: { text?: string; merchant?: string; category?: string } = {};
      for (const key of ['text', 'merchant', 'category'] as const) {
        if (!(key in options)) continue;
        const value = options[key];
        if (typeof value !== 'string' || value.trim() === '') {
          return refuse('bad_option', key, `The ${key} filter must be non-blank text.`, asText(value));
        }
        texts[key] = value;
      }

      let category: Category | null = null;
      if (texts.category !== undefined) {
        category = resolveCategory(texts.category);
        if (category === null) {
          return refuse(
            'bad_option',
            'category',
            `The category "${texts.category}" is not on the category list.`,
            texts.category,
          );
        }
      }

      const bounds: { minAmount?: bigint; maxAmount?: bigint } = {};
      for (const key of ['minAmount', 'maxAmount'] as const) {
        if (!(key in options)) continue;
        const value = options[key];
        const parsed = typeof value === 'string' ? parseMinorUnits(value.trim(), ctx.displayCurrency) : null;
        if (parsed === null || !parsed.ok || parsed.money.minor < 0n) {
          return refuse(
            'bad_option',
            key,
            `The ${key} bound "${asText(value)}" is not an amount of zero or more in ${ctx.displayCurrency}.`,
            asText(value),
          );
        }
        bounds[key] = parsed.money.minor;
      }
      const { minAmount, maxAmount } = bounds;
      if (minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount) {
        const min = asText(options.minAmount);
        const max = asText(options.maxAmount);
        return refuse(
          'bad_option',
          'amountRange',
          `The amount range starts above its end: ${min} > ${max}.`,
          `${min}..${max}`,
        );
      }
      const ranged = minAmount !== undefined || maxAmount !== undefined;

      const m = money.moneyFor(ctx);
      const candidates = selectTransactions(ctx.snapshot.db, {
        holdings: ctx.scope.holdings,
        from: ctx.period?.from,
        until: ctx.period?.until,
        order: 'occurred',
      });

      const survivors: { row: TransactionRow; result: ConversionResult }[] = [];
      for (const t of candidates) {
        if (category !== null && t.category !== category) continue;
        if (texts.merchant !== undefined && !foldedEquals(t.merchant, texts.merchant)) continue;
        if (
          texts.text !== undefined &&
          !foldedIncludes(t.merchant, texts.text) &&
          !foldedIncludes(t.description, texts.text)
        ) {
          continue;
        }
        const converted = convertRow(ctx, m, t);
        if (ranged) {
          const shown = converted.row.shown;
          if (shown === null) continue;
          const size = abs(shown.minor);
          if (minAmount !== undefined && size < minAmount) continue;
          if (maxAmount !== undefined && size > maxAmount) continue;
        }
        survivors.push(converted);
      }

      // The store gives occurredAt ascending, ties by position ascending: reversed is newest first.
      survivors.reverse();
      const listed = survivors.slice(0, SEARCH_CAP);
      m.show(listed.map((s) => s.result));
      const rows = listed.map((s) => s.row);
      return {
        kind: 'body',
        body: { rows, matched: survivors.length, moreMatched: survivors.length - rows.length, cap: SEARCH_CAP },
      };
    },
  };
}
