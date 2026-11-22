// Observed stdio transport (S-224): the assistant connection's stdio transport over an observed
// standard output. Every tools/call is tracked from the moment its request arrives; its 'sent'
// settles from standard output's own write callback (rejecting on a failed write, cancellation or
// close), and drain waits for every tracked call's response and serve to settle.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';

const transportModule = () => import('../../src/mcp/stdio');

type Settled = 'pending' | 'settled';

// Resolves 'settled' if p settles (either way) within ms, else 'pending'.
const within = (p: Promise<unknown>, ms: number): Promise<Settled> =>
  Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    Bun.sleep(ms).then(() => 'pending' as const),
  ]);

// Resolves 'resolved' if p resolves within ms, 'rejected' if it rejects, else 'pending'.
const resolvesWithin = (
  p: Promise<unknown>,
  ms: number,
): Promise<'pending' | 'resolved' | 'rejected'> =>
  Promise.race([
    p.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    Bun.sleep(ms).then(() => 'pending' as const),
  ]);

const waitUntil = async (cond: () => boolean, ms = 1000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(1);
  }
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

const toolCall = (id: number) => request(id, 'tools/call', { name: 'balance', arguments: {} });

// A fresh observed stdio over a PassThrough stdin and a capturing stdout (unless one is given),
// with onmessage recording every relayed message; the transport is started.
const open = async (stdout?: Writable) => {
  const { observeStdio } = await transportModule();
  const stdin = new PassThrough();
  const capture = { out: '' };
  const target =
    stdout ??
    new Writable({
      write(c, _e, cb) {
        capture.out += c;
        cb();
      },
    });
  const io = observeStdio(stdin, target);
  const received: unknown[] = [];
  io.transport.onmessage = (m) => {
    received.push(m);
  };
  await io.transport.start();
  return { io, stdin, stdout: target, capture, received };
};

describe('interfaces/assistant-transport', () => {
  test('drain waits for send and tracked work', async () => {
    const { observeStdio } = await transportModule();
    const stdin = new PassThrough();
    let out = '';
    const stdout = new Writable({
      write(c, _e, cb) {
        out += c;
        cb();
      },
    });
    const io = observeStdio(stdin, stdout);
    const received: unknown[] = [];
    let drained = false;
    // drain is called inside the relay, before any handler work.
    io.transport.onmessage = (m) => {
      received.push(m);
      io.drain().then(() => {
        drained = true;
      });
    };
    await io.transport.start();

    stdin.write(toolCall(7));
    await waitUntil(() => received.length === 1);
    const work = deferred();
    io.track(7, work.promise);
    stdin.end();
    await io.inputEnded;

    // The record exists from arrival: drain is still pending at end of input.
    await Bun.sleep(10);
    expect(drained).toBe(false);

    await io.transport.send({ jsonrpc: '2.0', id: 7, result: { content: [] } });
    expect(out).toContain('"id":7');
    await io.sentFor(7, new AbortController().signal);
    // Sent, but the tracked work is still pending.
    await Bun.sleep(10);
    expect(drained).toBe(false);

    work.resolve();
    expect(await resolvesWithin(io.drain(), 1000)).toBe('resolved');
    await waitUntil(() => drained);
    expect(drained).toBe(true);
  });

  test('only tool calls are tracked', async () => {
    // No message at all: drain resolves at once.
    const none = await open();
    expect(await resolvesWithin(none.io.drain(), 50)).toBe('resolved');

    // A tools/list request creates no record, though no response is ever sent for it.
    const list = await open();
    list.stdin.write(request(1, 'tools/list', {}));
    await waitUntil(() => list.received.length === 1);
    list.stdin.end();
    await list.io.inputEnded;
    expect(await resolvesWithin(list.io.drain(), 50)).toBe('resolved');

    // Contrast: a tools/call with no response keeps drain pending.
    const call = await open();
    call.stdin.write(toolCall(2));
    await waitUntil(() => call.received.length === 1);
    call.stdin.end();
    await call.io.inputEnded;
    expect(await within(call.io.drain(), 50)).toBe('pending');
  });

  test('abort rejects sent', async () => {
    const { io, stdin, received } = await open();
    stdin.write(toolCall(3));
    await waitUntil(() => received.length === 1);

    const ac = new AbortController();
    const p = io.sentFor(3, ac.signal);
    io.track(3, Promise.resolve());

    const reason = new Error('cancelled');
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);

    // The cancelled call counts as ended, with no response ever sent for id 3.
    stdin.end();
    await io.inputEnded;
    expect(await resolvesWithin(io.drain(), 100)).toBe('resolved');
  });

  test('failed write rejects sent', async () => {
    // highWaterMark 1: the first write reports backpressure, so the delegate's send waits for a
    // 'drain' that never comes after the error.
    const stdout = new Writable({
      highWaterMark: 1,
      write(_c, _e, cb) {
        cb(new Error('EPIPE'));
      },
    });
    stdout.on('error', () => {});
    const { io, stdin, received } = await open(stdout);
    stdin.write(toolCall(4));
    await waitUntil(() => received.length === 1);

    const p = io.sentFor(4, new AbortController().signal);
    let outcome: unknown = 'pending';
    p.then(
      () => {
        outcome = 'resolved';
      },
      (e) => {
        outcome = e;
      },
    );
    io.transport.send({ jsonrpc: '2.0', id: 4, result: { content: [] } }).catch(() => {});

    // The reason may be the write error or 'transport closed'; either way, never a resolve.
    await waitUntil(() => outcome !== 'pending', 1000);
    expect(outcome).not.toBe('resolved');
    expect(outcome).toBeInstanceOf(Error);
    await expect(p).rejects.toBeInstanceOf(Error);
  });

  test('close rejects every pending sent', async () => {
    const { io, stdin, stdout, received } = await open();
    stdin.write(toolCall(5));
    stdin.write(toolCall(6));
    await waitUntil(() => received.length === 2);

    const signal = new AbortController().signal;
    const p5 = io.sentFor(5, signal);
    const p6 = io.sentFor(6, signal);
    p5.catch(() => {});
    p6.catch(() => {});

    stdout.destroy();

    expect(await within(io.closed, 1000)).toBe('settled');
    await expect(p5).rejects.toThrow('transport closed');
    await expect(p6).rejects.toThrow('transport closed');
  });
});
