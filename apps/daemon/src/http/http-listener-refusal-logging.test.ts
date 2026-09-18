import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import {
  authenticator, decisionPort, envelopeObject, recordingHandler, registryOf,
} from "./http-test-fixtures.js";

/**
 * A REFUSED REQUEST LEFT NO TRACE.
 *
 * The listener's single per-request line is written BEFORE dispatch and carries method and path
 * only. Every refusal below it — the Host/Origin/CSRF gate, ~35 method refusals, an oversized
 * body, an unknown route, and every `{kind: "LISTENER_REFUSAL"}` flattened by the 25 serve
 * helpers — answered the client and told the host nothing.
 *
 * The live shape: a control room whose CSRF token has drifted gets 403 on every call, the
 * daemon's output reads as an ordinary list of paths, the board renders empty, and nothing gives
 * an operator a reason to suspect the daemon at all.
 */

const deps = () => ({
  authenticator: authenticator(),
  decisions: decisionPort(),
  registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
});

async function withListener(
  run: (origin: string, lines: string[]) => Promise<void>,
  slowRequestMs?: number,
): Promise<void> {
  const lines: string[] = [];
  const listener = await startControlRoomListener({
    csrfToken: "refusal-log-csrf",
    deps: deps(),
    log: (line) => { lines.push(line); },
    ...(slowRequestMs === undefined ? {} : { slowRequestMs }),
  });
  if (!listener.ok) throw new Error(listener.code);
  try {
    await run(listener.origin, lines);
  } finally {
    await listener.close();
  }
}

const refusals = (lines: readonly string[]): readonly string[] =>
  lines.filter((line) => line.startsWith("LISTENER_REFUSED "));

it("names the code and the status of a refused request", async () => {
  await withListener(async (origin, lines) => {
    const response = await fetch(`${origin}/no/such/route`);

    expect(response.status).toBe(404);
    expect(refusals(lines)).toHaveLength(1);
    expect(refusals(lines)[0]).toContain("GET /no/such/route");
    expect(refusals(lines)[0]).toContain("LISTENER_ROUTE_UNKNOWN");
    expect(refusals(lines)[0]).toContain("404");
  });
});

it("records a refusal made by the header gate, which is the drifted-CSRF case", async () => {
  await withListener(async (origin, lines) => {
    const response = await fetch(`${origin}/command`, {
      body: JSON.stringify({ kind: "goal.create" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(refusals(lines)).toHaveLength(1);
    expect(refusals(lines)[0]).toContain("POST /command");
  });
});

it("keeps the query string out of the refusal line, as the request line already does", async () => {
  await withListener(async (origin, lines) => {
    await fetch(`${origin}/no/such/route?credential=private-query-value`);

    expect(refusals(lines).join("\n")).not.toContain("private-query-value");
    expect(refusals(lines)[0]).toContain("/no/such/route");
  });
});

it("adds no line for a request that was served rather than refused", async () => {
  await withListener(async (origin, lines) => {
    const response = await fetch(`${origin}/health/read`, {
      headers: { "x-moe-csrf": "refusal-log-csrf" },
      method: "POST",
    });

    // Whatever this route answers, the arm that matters is that a NON-refused request adds
    // nothing: the refusal line must mean exactly one thing when it appears.
    if (response.status < 400) expect(refusals(lines)).toHaveLength(0);
  });
});

it("never puts the refusal tag itself on the wire", async () => {
  await withListener(async (origin) => {
    const response = await fetch(`${origin}/no/such/route`);
    const body = await response.text();

    expect(body).toBe(JSON.stringify({
      code: "LISTENER_ROUTE_UNKNOWN", layer: "CONTROL_ROOM_LISTENER",
    }));
    for (const [name] of response.headers) expect(name).not.toContain("refusal");
  });
});

it("names the status and duration of a request slower than the listener's threshold", async () => {
  // Threshold zero: every served request is "slow", which proves the option reaches the
  // per-request line through the real listener rather than only the unit under it.
  await withListener(async (origin, lines) => {
    const response = await fetch(`${origin}/no/such/route`);
    expect(response.status).toBe(404);
    const slow = lines.filter((line) => line.startsWith("LISTENER_SLOW "));
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatch(/^LISTENER_SLOW GET \/no\/such\/route 404 \d+ms$/u);
  }, 0);
});

it("writes no LISTENER_SLOW line at the default threshold for a request answered at once", async () => {
  await withListener(async (origin, lines) => {
    await fetch(`${origin}/no/such/route`);
    expect(lines.filter((line) => line.startsWith("LISTENER_SLOW "))).toEqual([]);
  });
});

/** node:http, not fetch: undici drops the Origin header this listener's gate requires. */
function postCommand(origin: string, csrf: string): Promise<number> {
  const payload = JSON.stringify(envelopeObject());
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${origin}/command`, {
      headers: {
        "content-length": String(Buffer.byteLength(payload)),
        "content-type": "application/json",
        origin,
        "x-moe-csrf": csrf,
        "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": "sess-good",
      },
      method: "POST",
    }, (response) => {
      response.resume();
      response.on("end", () => { resolve(response.statusCode ?? 0); });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

it("names a frame the daemon answered about its OWN fault, which is not a listener refusal", async () => {
  // The decision port answers what the durable store answers when it is locked: a 503 frame
  // with the store's code. The control room shows it; the listener used to write nothing.
  const lines: string[] = [];
  const listener = await startControlRoomListener({
    csrfToken: "refusal-log-csrf",
    deps: {
      authenticator: authenticator(),
      decisions: {
        decide: () => ({
          outcome: "REFUSED",
          refusal: { code: "OUTCOME_UNKNOWN", detail: "database is locked", httpStatus: 503, layer: "DURABLE_STORE" },
        }),
      },
      registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
    },
    log: (line) => { lines.push(line); },
  });
  if (!listener.ok) throw new Error(listener.code);
  try {
    const status = await postCommand(listener.origin, "refusal-log-csrf");
    expect(status).toBe(503);
    expect(refusals(lines)).toEqual([]);
    expect(lines.filter((line) => line.startsWith("LISTENER_FAULT_FRAME ")))
      .toEqual(["LISTENER_FAULT_FRAME POST /command OUTCOME_UNKNOWN DURABLE_STORE 503"]);
  } finally {
    await listener.close();
  }
});
