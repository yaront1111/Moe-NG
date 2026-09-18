import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { tagRefusal } from "./http-refusal-tag.js";
import { SLOW_REQUEST_MS, logServedRequest } from "./http-listener-request-log.js";

/**
 * The per-request completion line, driven with a fake clock and a fake exchange: no socket,
 * no waiting. The listener's integration suite (`http-listener-refusal-logging.test.ts`) proves
 * the same lines come out of a real exchange; this one pins WHEN each line is written.
 */

function exchange(init: { readonly method?: string; readonly status?: number; readonly url?: string } = {}): {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
} {
  const request = { method: init.method ?? "GET", url: init.url ?? "/goals?cursor=3" } as IncomingMessage;
  const response = { headersSent: false, statusCode: init.status ?? 200 } as ServerResponse;
  return { request, response };
}

async function settled(): Promise<void> {
  // Two turns: the served promise resolves, then its `.then` handlers run.
  await Promise.resolve();
  await Promise.resolve();
}

function harness(init: {
  readonly elapsedMs?: number;
  readonly log?: (line: string) => void;
  readonly served?: Promise<unknown>;
  readonly status?: number;
  readonly url?: string;
} = {}): {
  readonly lines: string[];
  readonly response: ServerResponse;
  readonly run: () => Promise<void>;
  readonly thrown: { count: number };
} {
  const lines: string[] = [];
  const thrown = { count: 0 };
  const { request, response } = exchange({ ...(init.status === undefined ? {} : { status: init.status }), ...(init.url === undefined ? {} : { url: init.url }) });
  let calls = 0;
  const now = (): number => (calls++ === 0 ? 1_000 : 1_000 + (init.elapsedMs ?? 0));
  return {
    lines,
    response,
    run: async (): Promise<void> => {
      logServedRequest({
        log: init.log ?? ((line) => { lines.push(line); }),
        now,
        onThrown: () => { thrown.count += 1; },
        request,
        response,
        served: init.served ?? Promise.resolve(),
        slowRequestMs: SLOW_REQUEST_MS,
      });
      await settled();
    },
    thrown,
  };
}

describe("logServedRequest", () => {
  it("says nothing for a clean, fast request: the pre-dispatch line already named it", async () => {
    const h = harness({ elapsedMs: 40 });
    await h.run();
    expect(h.lines).toEqual([]);
    expect(h.thrown.count).toBe(0);
  });

  it("names the code and status of a refused request, with the query string dropped", async () => {
    const h = harness({ status: 403 });
    tagRefusal(h.response, "LISTENER_CSRF_MISMATCH");
    await h.run();
    expect(h.lines).toEqual(["LISTENER_REFUSED GET /goals LISTENER_CSRF_MISMATCH 403"]);
  });

  it("names the status and duration of a request slower than the threshold, refused or not", async () => {
    const slow = harness({ elapsedMs: SLOW_REQUEST_MS });
    await slow.run();
    expect(slow.lines).toEqual([`LISTENER_SLOW GET /goals 200 ${String(SLOW_REQUEST_MS)}ms`]);

    const both = harness({ elapsedMs: 3_500.4, status: 503 });
    tagRefusal(both.response, "LISTENER_STORE_UNAVAILABLE");
    await both.run();
    expect(both.lines).toEqual([
      "LISTENER_REFUSED GET /goals LISTENER_STORE_UNAVAILABLE 503",
      "LISTENER_SLOW GET /goals 503 3500ms",
    ]);
  });

  it("stays silent one millisecond under the threshold", async () => {
    const h = harness({ elapsedMs: SLOW_REQUEST_MS - 1 });
    await h.run();
    expect(h.lines).toEqual([]);
  });

  it("reports a handler that threw, host-side, and still answers through onThrown", async () => {
    const h = harness({
      served: Promise.reject(Object.assign(new Error("database is locked"), { name: "SqliteError" })),
      url: "/command?x=1",
    });
    await h.run();
    expect(h.lines).toEqual(["LISTENER_REQUEST_FAILED GET /command SqliteError: database is locked"]);
    expect(h.thrown.count).toBe(1);
  });

  it("answers through onThrown even when the log sink itself throws", async () => {
    const h = harness({
      log: () => { throw new Error("sink closed"); },
      served: Promise.reject(new Error("handler died")),
    });
    await h.run();
    expect(h.thrown.count).toBe(1);
  });

  it("never lets a throwing sink surface from a served request", async () => {
    const h = harness({ elapsedMs: SLOW_REQUEST_MS, log: () => { throw new Error("sink closed"); } });
    await expect(h.run()).resolves.toBeUndefined();
  });
});
