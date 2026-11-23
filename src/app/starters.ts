// Composition lists (S-196): the product's one store installer list, its thirteen answer families
// built over the one money part in catalogue order, its envelope contributors in envelope order, and
// the one catalogue joining the analysis families' entries. Every constant is evaluated once, when
// this module is first loaded. Part of the composition root: no earlier slice imports this module,
// and it never imports from release/*.
//
// Product starters (S-206): the service, assistant, question and backfill starters, and the
// existing-only answering opener the two front ends are handed uncalled. The only module that calls
// composeAnswering, openStore, runService, runBackfillCommand and the two front-end entries.

import { createHealthFamily } from '../analysis/health';
import { createMonthlyReportFamily } from '../analysis/monthly-report';
import { createTrendsFamily } from '../analysis/trends';
import { createWeeklyReportFamily } from '../analysis/weekly-report';
import { createPatternsFamily } from '../analytics/patterns';
import { questionSettings, settingValue } from '../config/settings';
import { composeAnswering } from '../core/compose';
import type { EnvelopeContributor, Family } from '../core/question';
import { NoLocalCopyError, type SchemaInstaller, StoreLocationError, StoreSchemaError, openStore } from '../db';
import { runAssistantFrontEnd } from '../interfaces/assistant-entry';
import type { AnsweringOpener, OpenedAnswering, OpenRefusal } from '../interfaces/handoff';
import { runQuestionFrontEnd } from '../interfaces/question-entry';
import { runBackfillCommand } from '../sync/backfill';
import { type ServiceParams, runService } from '../sync/service';
import type { Timers } from '../sync/worker';
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
import type { CommandStarter, StartContext, Starters } from './main';
import { productFetch } from './network';
import { BALANCE_CONVENTIONS, BUILT_SOURCES, MONEY_PART, sourceListFaults } from './sources';

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

// Catalogue order. Every factory that takes the money part gets MONEY_PART, the one money part;
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

// A timer promise that rejects with the signal's reason when aborted.
const sleep: ServiceParams['sleep'] = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

// The wall-clock timers.
const timers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Before anything else: a faulty built list rejects, and the entry exits 1.
function checkBuiltSources(): void {
  const faults = sourceListFaults(BUILT_SOURCES);
  if (faults.length > 0) throw new Error(faults.join('\n'));
}

const locationOf = (ctx: StartContext): string | undefined => settingValue(ctx.record.shared.storage);

// Uncalled and existing-only: called by the front end at most once, after its own settings check.
// The open faults come back as the two refusals; anything else, CoreConfigError included, is thrown.
export function answeringOpener(location: string, record: StartContext['record']): AnsweringOpener {
  return (): OpenedAnswering | OpenRefusal => {
    let composed: ReturnType<typeof composeAnswering>;
    try {
      composed = composeAnswering({
        location,
        schemas: STORE_SCHEMAS,
        now: Date.now,
        settings: () => questionSettings(record),
        families: ANSWER_FAMILIES,
        contributors: ANSWER_CONTRIBUTORS,
        open: (l, s) => openStore(l, s, 'existing'),
      });
    } catch (e) {
      if (e instanceof NoLocalCopyError) return { kind: 'no_local_copy', location };
      // A lock not gained in the store's bounded wait surfaces as StoreSchemaError.
      if (e instanceof StoreLocationError || e instanceof StoreSchemaError) {
        return { kind: 'open_failed', location, why: e.message };
      }
      throw e;
    }
    const { store, core } = composed;
    let closed = false;
    return {
      core,
      close: () => {
        if (closed) return;
        closed = true;
        store.close();
      },
    };
  };
}

// Gated; ctx.sources the switched-on sources. The core composed here answers nothing in the
// service: composing it makes the store's installers and the families' registration the same as
// in every answering command.
const service: CommandStarter = async (ctx) => {
  checkBuiltSources();
  const location = locationOf(ctx) ?? '';
  const { store } = composeAnswering({
    location,
    schemas: STORE_SCHEMAS,
    now: Date.now,
    settings: () => questionSettings(ctx.record),
    families: ANSWER_FAMILIES,
    contributors: ANSWER_CONTRIBUTORS,
  });
  return runService({
    record: ctx.record,
    sources: ctx.sources,
    store,
    built: BUILT_SOURCES,
    now: Date.now,
    log: ctx.io.stderr,
    fetchImpl: productFetch,
    sleep,
    timers,
    onStopSignal: (h) => {
      process.on('SIGTERM', h);
      process.on('SIGINT', h);
    },
  });
};

// Ungated; the front end runs its own settings check before it calls the opener.
const assistant: CommandStarter = async (ctx) => {
  checkBuiltSources();
  const location = locationOf(ctx);
  return runAssistantFrontEnd({
    record: ctx.record,
    open: answeringOpener(location ?? '', ctx.record),
    families: ANSWER_FAMILIES,
    catalogue: ANSWER_CATALOGUE,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
};

// Ungated; ctx.args is the whole argv.
const question: CommandStarter = async (ctx) => {
  checkBuiltSources();
  const location = locationOf(ctx);
  return runQuestionFrontEnd({
    record: ctx.record,
    open: answeringOpener(location ?? '', ctx.record),
    families: ANSWER_FAMILIES,
    catalogue: ANSWER_CATALOGUE,
    argv: ctx.args,
    stdout: process.stdout,
    stderr: process.stderr,
  });
};

// Gated; ctx.sources is [the source id]. The interrupt signal aborts the run.
const backfill: CommandStarter = async (ctx) => {
  checkBuiltSources();
  const location = locationOf(ctx) ?? '';
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  return runBackfillCommand({
    record: ctx.record,
    sourceId: ctx.sources[0]!,
    args: ctx.args,
    built: BUILT_SOURCES,
    open: () => openStore(location, STORE_SCHEMAS, 'create'),
    now: Date.now,
    fetchImpl: productFetch,
    sleep,
    signal: controller.signal,
    out: (line) => ctx.io.stdout(line + '\n'),
    err: ctx.io.stderr,
  });
};

export const PRODUCT_STARTERS: Omit<Starters, 'releaseCheck'> = Object.freeze({ service, assistant, question, backfill });
