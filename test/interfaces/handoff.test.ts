// Front-end handoff (S-223): the shape in which a process's composition hands a question front end
// its local copy and core, and the exit codes both front ends return. The module declares shapes
// and codes only: isOpenRefusal tells an open refusal from an opened answering, and the four exit
// codes are fixed literals.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const handoffModule = () => import('../../src/interfaces/handoff');

describe('front-end handoff', () => {
  test('isOpenRefusal tells refusals from an opened answering by an own kind property', async () => {
    const { isOpenRefusal } = await handoffModule();

    const r1 = { kind: 'no_local_copy' as const, location: '/d/a.db' };
    const r2 = { kind: 'open_failed' as const, location: '/d/a.db', why: 'file is not a database' };
    const core = {
      serve: async () => {
        throw new Error('unused');
      },
    };
    const opened = { core, close() {} };
    // 'kind' only on the prototype, never an own property.
    const inherited = Object.assign(Object.create({ kind: 'no_local_copy' }), { core, close() {} });

    expect(isOpenRefusal(r1)).toBe(true);
    expect(isOpenRefusal(r2)).toBe(true);
    expect(isOpenRefusal(opened as never)).toBe(false);
    expect(isOpenRefusal(inherited as never)).toBe(false);
  });

  test('exit codes are the declared literals', async () => {
    const { EXIT_ANSWERED, EXIT_REFUSED, EXIT_USAGE, EXIT_WIRING } = await handoffModule();

    expect(EXIT_ANSWERED).toBe(0);
    expect(EXIT_REFUSED).toBe(1);
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_WIRING).toBe(70);
    expect(new Set([EXIT_ANSWERED, EXIT_REFUSED, EXIT_USAGE, EXIT_WIRING]).size).toBe(4);
  });
});
