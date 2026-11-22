// Observed stdio transport (S-224): the protocol's stdio transport over an observed standard
// output. Every tools/call is tracked from the moment its request arrives; its 'sent' settles from
// standard output's own write callback for the chunk carrying its response, and drain waits for
// every tracked call's response and serve to settle. Nothing here writes to standard output except
// what the delegate writes through the observed output, and nothing here closes the delegate.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Writable } from 'node:stream';

export type RequestId = string | number;

export interface ObservedStdio {
  transport: Transport;
  sentFor(id: RequestId, signal: AbortSignal): Promise<void>;
  track(id: RequestId, work: Promise<unknown>): void;
  closed: Promise<void>;
  inputEnded: Promise<void>;
  drain(): Promise<void>;
}

interface CallRecord {
  sent: Promise<void>;
  pending: boolean;
  resolve(): void;
  reject(reason: unknown): void;
  work: Promise<unknown>[];
}

const newRecord = (): CallRecord => {
  let resolveSent!: () => void;
  let rejectSent!: (reason: unknown) => void;
  const sent = new Promise<void>((resolve, reject) => {
    resolveSent = resolve;
    rejectSent = reject;
  });
  // The record's own copy never counts as unhandled; callers of sentFor still see the rejection.
  sent.catch(() => {});
  const record: CallRecord = {
    sent,
    pending: true,
    resolve() {
      if (!record.pending) return;
      record.pending = false;
      resolveSent();
    },
    reject(reason) {
      if (!record.pending) return;
      record.pending = false;
      rejectSent(reason);
    },
    work: [],
  };
  return record;
};

const settled = (p: Promise<unknown>): Promise<void> =>
  p.then(
    () => undefined,
    () => undefined,
  );

// Resolves once the record's sent has settled and every work promise tracked for it has settled,
// including work tracked while waiting.
const ended = async (record: CallRecord): Promise<void> => {
  await settled(record.sent);
  let seen = 0;
  while (seen < record.work.length) {
    const batch = record.work.slice(seen);
    seen = record.work.length;
    await Promise.all(batch.map(settled));
  }
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isToolCall = (m: JSONRPCMessage): m is JSONRPCMessage & { id: RequestId } =>
  isObject(m) && m.method === 'tools/call' && 'id' in m;

const responseId = (line: string): RequestId | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !('id' in parsed) || !('result' in parsed || 'error' in parsed)) {
    return undefined;
  }
  const id = parsed.id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
};

export function observeStdio(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): ObservedStdio {
  const records = new Map<RequestId, CallRecord>();
  const all: CallRecord[] = [];
  let isClosed = false;

  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    for (const record of all) record.reject(new Error('transport closed'));
    settleClosed();
  };

  let settleInputEnded!: () => void;
  const inputEnded = new Promise<void>((resolve) => {
    settleInputEnded = resolve;
  });
  stdin.once('end', () => settleInputEnded());
  stdin.once('close', () => settleInputEnded());

  const out = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const tied: CallRecord[] = [];
      for (const line of text.split('\n')) {
        if (line === '') continue;
        const id = responseId(line);
        if (id === undefined) continue;
        const record = records.get(id);
        if (record?.pending) tied.push(record);
      }
      stdout.write(chunk, (error?: Error | null) => {
        for (const record of tied) {
          if (error) record.reject(error);
          else record.resolve();
        }
        callback(error ?? null);
      });
    },
  });
  out.on('error', close);
  stdout.on('error', close);
  stdout.on('close', close);

  const delegate = new StdioServerTransport(stdin as never, out);

  const transport: Transport = {
    start: () => delegate.start(),
    close: () => delegate.close(),
    send: (message) => delegate.send(message),
  };

  delegate.onmessage = (message, extra) => {
    if (isToolCall(message)) {
      const record = newRecord();
      records.set(message.id, record);
      all.push(record);
      if (isClosed) record.reject(new Error('transport closed'));
    }
    transport.onmessage?.(message, extra);
  };
  delegate.onclose = () => {
    close();
    transport.onclose?.();
  };
  delegate.onerror = (error) => {
    transport.onerror?.(error);
  };

  const sentFor = (id: RequestId, signal: AbortSignal): Promise<void> => {
    const record = records.get(id);
    if (!record) return Promise.reject(new Error(`no tool call with id ${String(id)}`));
    if (record.pending) {
      if (signal.aborted) record.reject(signal.reason);
      else {
        const onAbort = () => record.reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        void settled(record.sent).then(() => signal.removeEventListener('abort', onAbort));
      }
    }
    return record.sent;
  };

  const track = (id: RequestId, work: Promise<unknown>): void => {
    records.get(id)?.work.push(work);
  };

  const drain = async (): Promise<void> => {
    let seen = 0;
    while (seen < all.length) {
      const batch = all.slice(seen);
      seen = all.length;
      await Promise.all(batch.map(ended));
    }
  };

  return { transport, sentFor, track, closed, inputEnded, drain };
}
