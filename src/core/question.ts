// Question and answer (S-134): the one question type and the one answer type both front ends map
// to and from; the core entry is their only interpreter. The frame owns the envelope's shape;
// another slice adds a statement only by registering an EnvelopeContributor.

import type { Calendar, ResolvedPeriod } from '../analytics/dates';
import type { Snapshot } from '../db/index';
import type {
  Asker,
  DisplayCurrency,
  Instant,
  LocalDate,
  LocalDateTime,
  Position,
  Refusal,
  SourceId,
} from './primitives';
import type { Capability, Narrowing, RegisterView, ResolvedScope } from './register';

export interface Question {
  asker: Asker; // required; set by the front end that received the request, never from request content
  family: string; // a registered Family.name
  narrowing?: string; // a source id or a holding name, resolved by resolveScope
  period?: string; // period text, resolved by Calendar.resolvePeriod
  displayCurrency?: string; // one of DISPLAY_CURRENCIES; absent means DEFAULT_DISPLAY_CURRENCY
  options: Readonly<Record<string, unknown>>; // family-specific, read only by that family
}
export type QuestionDraft = Omit<Question, 'asker'>; // what a front-end mapping produces before stamping

// Read once per question, in step 1; a setting changed mid-question takes effect from the next.
export interface Settings {
  timeZone: string | undefined; // the time-zone setting as the calendar receives it
  sources: readonly SourceId[]; // the configured (enabled) sources, in configuration order; [] when none
}

export interface QuestionContext {
  readonly snapshot: Snapshot; // open, read-only; a family must not keep it past compute
  readonly now: Instant; // the only 'now' of the answer
  readonly settings: Settings; // the one Settings value read in step 1
  readonly calendar: Calendar;
  readonly displayCurrency: DisplayCurrency;
  readonly position: Position; // snapshot.position(), read once
  readonly register: RegisterView; // snapshot.register(), read once
  readonly scope: ResolvedScope; // already restricted to offering sources for a capability family
  readonly period: ResolvedPeriod | null; // null only for a 'none' family, or an 'optional' one with no default and no period text
  readonly asker: Asker;
  readonly options: Readonly<Record<string, unknown>>;
}

// `pending` is read only when the family movesPoint and the asker is 'assistant': then the
// positions it listed, strictly ascending, each in 1..ctx.position and none already marked.
export type FamilyOutcome<B> = { kind: 'body'; body: B; pending?: readonly Position[] } | Refusal;

export interface Family<B = unknown> {
  name: string;
  period: 'required' | 'optional' | 'none';
  defaultPeriod?: string; // period text used when the question names none
  capability?: Capability; // when set, the frame partitions scope before compute
  movesPoint: boolean;
  compute(ctx: QuestionContext): FamilyOutcome<B>; // synchronous; never awaits, never writes
}

export interface EnvelopeContributor {
  key: string; // unique among contributors; becomes the key in Envelope.statements
  contribute(ctx: QuestionContext): unknown; // synchronous, inside the same snapshot
}

export interface ScopeStatement {
  narrowing: Narrowing;
  sources: readonly SourceId[];
  notOffering: readonly SourceId[]; // empty unless the family declares a capability
}
export interface PeriodStatement {
  text: string;
  firstDay: LocalDate;
  lastDay: LocalDate;
}

export interface Envelope<B = unknown> {
  kind: 'envelope';
  asker: Asker;
  family: string;
  asOf: { instant: Instant; localDateTime: LocalDateTime; position: Position };
  timeZone: string;
  displayCurrency: DisplayCurrency;
  scope: ScopeStatement;
  period: PeriodStatement | null; // built from ctx.period, null exactly when it is
  statements: Readonly<Record<string, unknown>>; // one entry per registered contributor, by key
  outcome:
    | { kind: 'answered'; body: B }
    | { kind: 'not_available'; capability: Capability; sources: readonly SourceId[] };
}
export type Answer<B = unknown> = Envelope<B> | Refusal; // told apart by kind
