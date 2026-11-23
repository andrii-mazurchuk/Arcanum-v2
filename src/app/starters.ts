// Composition lists (S-196): the product's one store installer list, its thirteen answer families
// built over the one money part in catalogue order, its envelope contributors in envelope order, and
// the one catalogue joining the analysis families' entries. Every constant is evaluated once, when
// this module is first loaded. Part of the composition root: no earlier slice imports this module,
// and it never imports from release/*.

import { createHealthFamily } from '../analysis/health';
import { createMonthlyReportFamily } from '../analysis/monthly-report';
import { createTrendsFamily } from '../analysis/trends';
import { createWeeklyReportFamily } from '../analysis/weekly-report';
import { createPatternsFamily } from '../analytics/patterns';
import type { EnvelopeContributor, Family } from '../core/question';
import type { SchemaInstaller } from '../db';
import { createBalanceFamily } from '../families/balance';
import { createBreakdownFamily } from '../families/breakdown';
import { createForeignSpendingFamily } from '../families/foreign';
import { holdingsFamily } from '../families/holdings';
import { createJarsFamily } from '../families/jars';
import { createNewFamily } from '../families/new';
import { createRatesFamily } from '../families/rates';
import { createSearchFamily } from '../families/search';
import {
  CATALOGUE_ENTRIES,
  type Catalogue,
  type CatalogueEntry,
  DISPLAY_CURRENCY_OPTION,
  NARROWING_OPTION,
  type OptionSpec,
  PERIOD_OPTION,
  buildCatalogue,
} from '../interfaces/catalogue';
import { coveredRangesContributor } from '../local/covered-ranges';
import { ensureCoverageSchema } from '../local/covered';
import { ensureTransactionSchema } from '../local/transactions';
import { ensureQuarantineSchema } from '../money/quarantine';
import { ensureRateSchema } from '../money/recorded-rates';
import { ensureBalanceSchema } from '../sync/balances';
import { ensureFirstFillSchema } from '../sync/progress';
import { ensureRateLedgerSchema } from '../sync/rate-gate';
import { BALANCE_CONVENTIONS, MONEY_PART } from './sources';

// The only installer list in the product; every starter passes this one. The store declares no
// installer beside what openStore runs itself, so the table owners' installers are the whole list.
export const STORE_SCHEMAS: readonly SchemaInstaller[] = Object.freeze([
  ensureRateSchema,
  ensureQuarantineSchema,
  ensureCoverageSchema,
  ensureTransactionSchema,
  ensureBalanceSchema,
  ensureRateLedgerSchema,
  ensureFirstFillSchema,
]);

// Catalogue order. Every factory that takes the money part gets MONEY_PART, the process's one part;
// the balance family and both reports share the one BALANCE_CONVENTIONS map.
export const ANSWER_FAMILIES: readonly Family[] = Object.freeze([
  createBalanceFamily(MONEY_PART, BALANCE_CONVENTIONS),
  createJarsFamily(MONEY_PART),
  createSearchFamily(MONEY_PART),
  createBreakdownFamily(MONEY_PART),
  createRatesFamily(MONEY_PART),
  createForeignSpendingFamily(MONEY_PART),
  holdingsFamily,
  createNewFamily(MONEY_PART),
  createTrendsFamily(MONEY_PART),
  createPatternsFamily(MONEY_PART),
  createWeeklyReportFamily(MONEY_PART, BALANCE_CONVENTIONS),
  createMonthlyReportFamily(MONEY_PART, BALANCE_CONVENTIONS),
  createHealthFamily(MONEY_PART),
] as Family[]);

// Envelope order.
export const ANSWER_CONTRIBUTORS: readonly EnvelopeContributor[] = Object.freeze([
  coveredRangesContributor,
  MONEY_PART.ratesUsedContributor,
]);

function analysisEntry(
  family: string,
  command: string,
  title: string,
  description: string,
  options: readonly OptionSpec[],
): CatalogueEntry {
  return Object.freeze({ family, tool: family, command, title, description, options: Object.freeze([...options]) });
}

// Shared options first, by identity. A family whose period is 'none' (trends, health) is offered no
// period option.
export const ANALYSIS_CATALOGUE_ENTRIES: readonly CatalogueEntry[] = Object.freeze([
  analysisEntry('trends', 'trends', 'Spending trends', 'How spending, income and savings moved month by month.', [
    NARROWING_OPTION,
    DISPLAY_CURRENCY_OPTION,
    Object.freeze({
      key: 'months',
      type: Object.freeze({ kind: 'number' as const }),
      required: false,
      target: 'options' as const,
      description:
        "how many complete months to compare, a whole number from 1 to 24; the family's default when omitted",
    }),
  ]),
  analysisEntry(
    'behaviour_patterns',
    'patterns',
    'Behaviour patterns',
    'When spending happens, by hour and weekday, and the habits it shows.',
    [NARROWING_OPTION, PERIOD_OPTION, DISPLAY_CURRENCY_OPTION],
  ),
  analysisEntry(
    'weekly_report',
    'weekly',
    'Weekly report',
    "One week's spending, comparisons, unusual categories, jars and balances.",
    [NARROWING_OPTION, PERIOD_OPTION, DISPLAY_CURRENCY_OPTION],
  ),
  analysisEntry(
    'monthly_report',
    'monthly',
    'Monthly report',
    "One month's spending, savings, patterns, health signals, jars and balances.",
    [NARROWING_OPTION, PERIOD_OPTION, DISPLAY_CURRENCY_OPTION],
  ),
  analysisEntry(
    'health_signals',
    'health',
    'Financial health',
    'Health signals and score for the last complete month.',
    [NARROWING_OPTION, DISPLAY_CURRENCY_OPTION],
  ),
]);

// A duplicate entry is buildCatalogue's CatalogueError here, at module load.
export const ANSWER_CATALOGUE: Catalogue = buildCatalogue(CATALOGUE_ENTRIES, ANALYSIS_CATALOGUE_ENTRIES);
