import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { webRequestFrom, writeWebResponse } from "./mcp-http-node-bridge.js";

/**
 * The bridge's DISCONNECT contract, driven with fakes on purpose: the behaviours under test —
 * reader cancellation on a dropped client, the drain wait under backpressure, the guard against
 * cancelling a normally finished stream — are all races against events the node pair emits, and
 * a real socket makes their timing incidental where an EventEmitter makes it exact. The host
 * suite proves the same teardown end to end over a real connection; this file proves each piece
 * of the mechanism in isolation, including the deadlock shapes a socket test can only hit by
 * luck.
 */

/** A fake IncomingMessage: bodiless GET, so `readBoundedNodeBody` resolves without events. */
function fakeMessage(method: string, url = "/"): IncomingMessage {
  return Object.assign(new EventEmitter(), {
    headers: { accept: "application/json, text/event-stream" },
    method,
    url,
  }) as unknown as IncomingMessage;
}

interface FakeTarget {
  readonly ended: () => boolean;
  readonly target: ServerResponse;
  readonly writes: Uint8Array[];
}

/**
 * A fake ServerResponse. `writeReturns` scripts the return value of successive `write` calls —
 * `false` is node saying "socket buffer full, wait for 'drain'" — and `destroyed` models a
 * client that was already gone before the pump began, for which 'close' has fired and will
 * never refire.
 */
function fakeTarget(writeReturns: readonly boolean[] = [], destroyed = false): FakeTarget {
  const emitter = new EventEmitter();
  const writes: Uint8Array[] = [];
  const pending = [...writeReturns];
  let ended = false;
  const target = Object.assign(emitter, {
    appendHeader: (): void => undefined,
    destroyed,
    end: (): void => { ended = true; },
    flushHeaders: (): void => undefined,
    statusCode: 0,
    write: (chunk: Uint8Array): boolean => {
      writes.push(chunk);
      return pending.shift() ?? true;
    },
  }) as unknown as ServerResponse;
  return { ended: (): boolean => ended, target, writes };
}

/** An SSE-shaped source: open until told otherwise, with `cancel()` observable as a flag. */
function sseSource(): {
  readonly body: ReadableStream<Uint8Array>;
  readonly cancelled: () => boolean;
  readonly close: () => void;
  readonly push: (text: string) => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel: (): void => { cancelled = true; },
    start: (c): void => { controller = c; },
  });
  return {
    body,
    cancelled: (): boolean => cancelled,
    close: (): void => controller?.close(),
    push: (text: string): void => controller?.enqueue(new TextEncoder().encode(text)),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Turns "the pump never returns" — the exact defect this file exists to catch — into a named
 * assertion failure instead of a suite-wide timeout with no attribution.
 */
function settlesWithin(label: string, pump: Promise<void>, ms = 1_000): Promise<string> {
  return Promise.race([
    pump.then(() => "settled"),
    delay(ms).then(() => `still pumping: ${label}`),
  ]);
}

describe("webRequestFrom — the disconnect lifeline", () => {
  it("threads the caller's abort signal into the Request verbatim", async () => {
    const lifeline = new AbortController();
    const request = await webRequestFrom(
      fakeMessage("GET"), "http://127.0.0.1:39999", lifeline.signal,
    );
    // Live until the caller says otherwise, and aborted the moment it does: a Request built
    // without the signal answers `false` to both reads and reports the drop to nobody.
    expect(request.signal.aborted).toBe(false);
    lifeline.abort();
    expect(request.signal.aborted).toBe(true);
  });
});

describe("writeWebResponse — pump teardown and backpressure", () => {
  it("cancels the response reader when the client drops mid-stream", async () => {
    const source = sseSource();
    const sink = fakeTarget();
    const pump = writeWebResponse(new Response(source.body, { status: 200 }), sink.target);
    source.push("event: message\ndata: 1\n\n");
    await delay(25);
    // The pump is live: one event written, then parked in read() with the stream still open.
    expect(sink.writes).toHaveLength(1);

    // The client vanishes. 'close' is the only notification node sends, and cancellation is
    // the only thing that unparks the pending read — the pre-fix pump looped here forever.
    sink.target.emit("close");
    expect(await settlesWithin("drop mid-stream", pump)).toBe("settled");
    expect(source.cancelled()).toBe(true);
    expect(sink.ended()).toBe(true);
  });

  it("treats a target that was already dead at the first byte as dropped", async () => {
    // 'close' fired before the pump existed and will never refire; only the `destroyed` check
    // at registration can notice. Without it this pump parks on a stream nobody will read.
    const source = sseSource();
    const sink = fakeTarget([], true);
    const pump = writeWebResponse(new Response(source.body, { status: 200 }), sink.target);
    expect(await settlesWithin("already-dead target", pump)).toBe("settled");
    expect(source.cancelled()).toBe(true);
  });

  it("does NOT cancel the source after a normal completion, even when close follows", async () => {
    const source = sseSource();
    const sink = fakeTarget();
    source.push("data: only\n\n");
    source.close();
    await writeWebResponse(new Response(source.body, { status: 200 }), sink.target);
    expect(sink.writes).toHaveLength(1);
    expect(sink.ended()).toBe(true);

    // node fires 'close' after every finished exchange too; a cancel here would tear down a
    // source that completed honestly. The guard is the `sourceDone` flag, and this pins it.
    sink.target.emit("close");
    await delay(10);
    expect(source.cancelled()).toBe(false);
  });

  it("waits for drain before pushing the next chunk into a backpressured socket", async () => {
    const source = sseSource();
    const sink = fakeTarget([false]);
    const pump = writeWebResponse(new Response(source.body, { status: 200 }), sink.target);
    source.push("one");
    source.push("two");
    source.close();
    await delay(25);
    // write() said false, so the second chunk must NOT have been pushed yet — ignoring the
    // signal buffers an unbounded backlog in process memory for a slow reader.
    expect(sink.writes).toHaveLength(1);

    sink.target.emit("drain");
    expect(await settlesWithin("drain resumes the pump", pump)).toBe("settled");
    expect(sink.writes).toHaveLength(2);
    expect(sink.ended()).toBe(true);
  });

  it("releases a pump stalled on backpressure when the client drops instead of deadlocking", async () => {
    const source = sseSource();
    const sink = fakeTarget([false]);
    const pump = writeWebResponse(new Response(source.body, { status: 200 }), sink.target);
    source.push("one");
    await delay(25);
    expect(sink.writes).toHaveLength(1);

    // No 'drain' is ever coming — a vanished client never empties its socket buffer. The
    // disconnect race is the only exit, and it must also cancel the abandoned source.
    sink.target.emit("close");
    expect(await settlesWithin("drop during drain wait", pump)).toBe("settled");
    expect(source.cancelled()).toBe(true);
  });
});
