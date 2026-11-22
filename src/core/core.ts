// Answering core (S-229): the one entry both front ends hand every question to. Admission by the
// in-memory gate and the store-held ask claim, the three-step frame inside one snapshot, rendering,
// the reply's write, receipt settlement and the token-checked release write that marks exactly the
// listed positions. Built once at start-up with the one Store; both front ends get the same core.

import type { Calendar, ResolvedPeriod } from '../analytics/dates';
import { openCalendar } from '../analytics/dates';
import type { Snapshot, Store } from '../db/index';
import type { DisplayCurrency, Instant, Position, Refusal } from './primitives';
import { DEFAULT_DISPLAY_CURRENCY, DISPLAY_CURRENCIES, isRefusal, refuse } from './primitives';
import type {
  Answer,
  Envelope,
  EnvelopeContributor,
  Family,
  Question,
  QuestionContext,
  Settings,
} from './question';
import type { ResolvedScope } from './register';
import { partitionByCapability, resolveScope, restrictToSources } from './register';

export const ASK_CLAIM_DEADLINE_MS = 60000; // fixed, no setting: how long a taken ask claim holds before another connection may take it
export const ASK_CLAIM_RETRY_MS = 25;       // fixed, no setting: pause between claim attempts while another unexpired claim is held
export type ReplyWriter = (rendered: string) => Promise<void>; // resolves when the channel has taken the whole reply, rejects or throws on failure
export interface ReplyChannel { write: ReplyWriter; closed: Promise<void> } // closed settles when the channel closes
export type Delivery = 'delivered' | 'failed';
export interface ServeResult { answer: Answer; delivery: Delivery; receipt: boolean; recorded: readonly Position[] | null } // recorded: the listed positions the release marked under this ask's token

export class PendingPointError extends Error {}
export class CoreConfigError extends Error {}
export interface CoreDeps {
  store: Store;
  now: () => Instant;
  settings: () => Settings;           // called exactly once per question, in step 1
  families: readonly Family[];
  contributors: readonly EnvelopeContributor[]; // run in this order
}
export function createCore(deps: CoreDeps): AnsweringCore {
  const families = new Map<string, Family>();
  for (const f of deps.families) {
    if (families.has(f.name)) throw new CoreConfigError(`Two question families share the name "${f.name}".`);
    families.set(f.name, f);
  }
  const keys = new Set<string>();
  for (const c of deps.contributors) {
    if (keys.has(c.key)) throw new CoreConfigError(`Two envelope contributors share the key "${c.key}".`);
    keys.add(c.key);
  }
  const { store, now } = deps;
  const gate = admissionGate();

  // Steps 1 to 3 and the envelope, inside one snapshot. Throws (PendingPointError included) leave it.
  const frame = (q: Question, receipt: boolean): { answer: Answer; pending: readonly Position[] | null } =>
    store.readSnapshot((snap) => {
      // 1.
      const at = now();
      const settings = deps.settings();
      const position = snap.position();
      const register = snap.register();
      const calendar = openCalendar(settings.timeZone);
      if (isRefusal(calendar)) return { answer: calendar, pending: null };

      // 2.
      const family = families.get(q.family);
      if (family === undefined) {
        return {
          answer: refuse('bad_option', 'family', `There is no question family named "${q.family}".`, q.family),
          pending: null,
        };
      }
      let displayCurrency: DisplayCurrency = DEFAULT_DISPLAY_CURRENCY;
      if (q.displayCurrency !== undefined) {
        const value = q.displayCurrency;
        if (!(DISPLAY_CURRENCIES as readonly string[]).includes(value)) {
          return {
            answer: refuse(
              'bad_display_currency',
              'displayCurrency',
              'Display currency "' + value + '" is not supported. Use one of: ' + DISPLAY_CURRENCIES.join(', ') + '.',
              value,
            ),
            pending: null,
          };
        }
        displayCurrency = value as DisplayCurrency;
      }
      const resolved = resolveScope(register, q.narrowing);
      if (isRefusal(resolved)) return { answer: resolved, pending: null };
      const period = resolvePeriod(q, family, calendar, at);
      if (isRefusal(period)) return { answer: period, pending: null };
      let scope: ResolvedScope = resolved;
      let notOffering: readonly string[] = [];
      let available = true;
      if (family.capability !== undefined) {
        const split = partitionByCapability(register, resolved, family.capability);
        notOffering = split.notOffering;
        if (split.offering.length === 0) available = false;
        else scope = restrictToSources(register, resolved, split.offering);
      }

      // 3.
      const ctx: QuestionContext = Object.freeze({
        snapshot: snap,
        now: at,
        settings,
        calendar,
        displayCurrency,
        position,
        register,
        scope,
        period,
        asker: q.asker,
        options: q.options,
      });
      let outcome: Envelope['outcome'];
      let pending: readonly Position[] | null = null;
      if (available) {
        const result = family.compute(ctx);
        if (isRefusal(result)) return { answer: result, pending: null };
        if (receipt) {
          checkPending(result.pending, position, snap);
          pending = result.pending as readonly Position[];
        }
        outcome = { kind: 'answered', body: result.body };
      } else {
        outcome = { kind: 'not_available', capability: family.capability!, sources: notOffering };
      }
      const statements: Record<string, unknown> = {};
      for (const c of deps.contributors) statements[c.key] = c.contribute(ctx);
      const answer: Envelope = {
        kind: 'envelope',
        asker: q.asker,
        family: family.name,
        asOf: { instant: at, localDateTime: calendar.localDateTime(at), position },
        timeZone: calendar.zone,
        displayCurrency,
        scope: { narrowing: scope.narrowing, sources: scope.sources, notOffering },
        period:
          ctx.period === null
            ? null
            : { text: ctx.period.text, firstDay: ctx.period.firstDay, lastDay: ctx.period.lastDay },
        statements,
        outcome,
      };
      return { answer, pending };
    });

  return {
    async serve(q, render, channel) {
      // 0.
      const family = families.get(q.family);
      if (family === undefined || !family.movesPoint || q.asker !== 'assistant') {
        const { answer } = frame(q, false);
        const delivery = await deliver(answer, render, channel);
        return { answer, delivery, receipt: false, recorded: null };
      }

      // 0a.
      const leave = await gate();
      let held = false;
      const token = crypto.randomUUID();
      try {
        // 0b.
        for (;;) {
          const t = now();
          if (store.write((tx) => tx.takeClaim(family.name, token, t, t + ASK_CLAIM_DEADLINE_MS))) break;
          await new Promise((r) => setTimeout(r, ASK_CLAIM_RETRY_MS));
        }
        held = true;

        // 1 to 3.
        const { answer, pending } = frame(q, true);

        // 4.
        let delivery = await deliver(answer, render, channel);

        // 5.
        let recorded: readonly Position[] | null = null;
        if (
          answer.kind === 'envelope' &&
          answer.outcome.kind === 'answered' &&
          delivery === 'delivered' &&
          pending !== null
        ) {
          try {
            const res = store.write((tx) => tx.releaseClaim(family.name, token, pending));
            held = false;
            recorded = res.released ? pending : null;
          } catch {
            delivery = 'failed';
          }
        }
        return { answer, delivery, receipt: true, recorded };
      } finally {
        // 6.
        if (held) {
          try {
            store.write((tx) => tx.releaseClaim(family.name, token, null));
          } catch {
            // the claim ends at its deadline
          }
        }
        leave();
      }
    },
  };
}
export interface AnsweringCore {
  serve(q: Question, render: (a: Answer) => string, channel: ReplyChannel): Promise<ServeResult>;
}

// First come, first admitted; each entrant holds the gate until it calls the function it was given.
function admissionGate(): () => Promise<() => void> {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    let open!: () => void;
    const mine = new Promise<void>((r) => {
      open = r;
    });
    const before = tail;
    tail = before.then(() => mine);
    return before.then(() => open);
  };
}

function resolvePeriod(
  q: Question,
  family: Family,
  calendar: Calendar,
  at: Instant,
): ResolvedPeriod | null | Refusal {
  if (family.period === 'none') {
    if (q.period !== undefined) {
      return refuse(
        'bad_option',
        'period',
        `The question family "${family.name}" takes no period, but "${q.period}" was given.`,
        q.period,
      );
    }
    return null;
  }
  const text = q.period ?? family.defaultPeriod;
  if (text !== undefined) return calendar.resolvePeriod(text, at);
  if (family.period === 'required') {
    return refuse('bad_period', 'missing', `The question family "${family.name}" needs a period, and none was given.`);
  }
  return null;
}

// S-134's pending rule: whole numbers, strictly ascending, each in 1..position and not yet listed.
function checkPending(pending: unknown, position: Position, snap: Snapshot): void {
  if (!Array.isArray(pending)) throw new PendingPointError('A receipt-carrying answer gave no pending list.');
  let last = 0;
  for (const p of pending) {
    if (typeof p !== 'number' || !Number.isInteger(p) || p <= last || p > position || snap.isListed(p)) {
      throw new PendingPointError(`Pending position ${String(p)} breaks the pending rule.`);
    }
    last = p;
  }
}

// Step 4: render, then the write raced against the channel's closing.
async function deliver(answer: Answer, render: (a: Answer) => string, channel: ReplyChannel): Promise<Delivery> {
  try {
    const rendered = render(answer);
    const done = await Promise.race([
      channel.write(rendered).then(() => true),
      channel.closed.then(
        () => false,
        () => false,
      ),
    ]);
    return done ? 'delivered' : 'failed';
  } catch {
    return 'failed';
  }
}
