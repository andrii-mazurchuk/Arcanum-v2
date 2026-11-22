// Report sections (S-165): the money part a report hands to its private section families, which
// resolves any section context, however often opened over, to the question's one money context;
// the section context opener with a period and options of its own; and the section period built
// from an analysis period. A section runs in the question's snapshot: opening reads and writes
// nothing.

import type { QuestionContext } from '../core/question';
import type { MoneyPart } from '../money/context';
import type { ResolvedPeriod } from './dates';
import type { AnalysisPeriod } from './periods';

export interface SectionMoney {
  readonly part: MoneyPart; // handed to the section families a report builds; never registered with the core
  open(
    ctx: QuestionContext,
    period: ResolvedPeriod | null,
    options: Readonly<Record<string, unknown>>,
  ): QuestionContext;
}

export function createSectionMoney(money: MoneyPart): SectionMoney {
  // Each opened section context -> the question context it was opened from, at any depth.
  const owners = new WeakMap<QuestionContext, QuestionContext>();
  const ownerOf = (c: QuestionContext): QuestionContext => owners.get(c) ?? c;

  const part: MoneyPart = Object.freeze({
    rateSource: money.rateSource,
    moneyFor: (c: QuestionContext) => money.moneyFor(ownerOf(c)),
    ratesUsedContributor: money.ratesUsedContributor,
  });

  return Object.freeze({
    part,
    open(
      ctx: QuestionContext,
      period: ResolvedPeriod | null,
      options: Readonly<Record<string, unknown>>,
    ): QuestionContext {
      const opened: QuestionContext = Object.freeze({
        snapshot: ctx.snapshot,
        now: ctx.now,
        settings: ctx.settings,
        calendar: ctx.calendar,
        displayCurrency: ctx.displayCurrency,
        position: ctx.position,
        register: ctx.register,
        scope: ctx.scope,
        period,
        asker: ctx.asker,
        options,
      });
      owners.set(opened, ownerOf(ctx));
      return opened;
    },
  });
}

// The report period's own instants, ending at the moment of asking for a period in progress.
export function sectionPeriod(ctx: QuestionContext, p: AnalysisPeriod): ResolvedPeriod {
  return {
    text: ctx.period?.text ?? p.label,
    firstDay: p.firstDay,
    lastDay: p.partial ? ctx.calendar.localDay(ctx.now) : p.lastDay,
    from: p.from,
    until: p.until,
  };
}
