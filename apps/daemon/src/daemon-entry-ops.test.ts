import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";

import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { readDesignRevision } from "./design/design-store.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { isDependencyProvider, startDaemon } from "./daemon-entry.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http/http-test-fixtures.js";

const CSRF = "ops-entry-csrf";

async function post(
  started: { readonly origin: string; readonly port: number }, path: string, body: unknown = {},
): Promise<{ readonly body: unknown; readonly status: number }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${started.port}`, origin: started.origin,
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": GOOD_CREDENTIAL,
      },
      host: "127.0.0.1", method: "POST", path, port: started.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

it("resolves and forwards the project-bound policy and health readers", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      health: () => ({
        boundProjectId: "proj-0001",
        readHealth: () => ({ code: "HEALTH_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" as const }),
      }),
      policy: () => ({
        boundProjectId: "proj-0001",
        readPolicy: () => ({ code: "POLICY_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" as const }),
      }),
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, "/policy/read")).toEqual({
      body: { code: "POLICY_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
    expect(await post(started, "/health/read")).toEqual({
      body: { code: "HEALTH_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
  } finally {
    await started.shutdown();
  }
});

it("refuses both routes as unavailable when the provider offers no readers", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, "/policy/read")).toMatchObject({ body: { code: "LISTENER_POLICY_UNAVAILABLE" }, status: 503 });
    expect(await post(started, "/health/read")).toMatchObject({ body: { code: "LISTENER_HEALTH_UNAVAILABLE" }, status: 503 });
  } finally {
    await started.shutdown();
  }
});

it("resolves and forwards the project-bound activity and sessions readers", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      activity: () => ({
        boundProjectId: "proj-0001",
        readActivity: () => ({ code: "ACTIVITY_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" as const }),
      }),
      goalSource: () => ({ read: () => ({ code: "GOAL_SOURCE_INVALID", layer: "TEST_READER", ok: false as const }) }),
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
      sessions: () => ({
        boundProjectId: "proj-0001",
        readSessions: () => ({ code: "SESSIONS_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" as const }),
      }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, "/activity/read")).toEqual({
      body: { code: "ACTIVITY_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
    expect(await post(started, "/sessions/read")).toEqual({
      body: { code: "SESSIONS_READ_UNREADABLE", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
    expect(await post(started, "/goals/source/read", { goalRef: "goal-1" })).toEqual({
      body: { code: "GOAL_SOURCE_INVALID", layer: "TEST_READER", outcome: "REFUSED" }, status: 200,
    });
  } finally {
    await started.shutdown();
  }
});

/**
 * THE DESIGN READ, FORWARDED BY A PRODUCTION BOOT. The port here is the real store reader --
 * `readDesignRevision` closed over a fresh store, the same closure the composition root ships --
 * so the answer this arm asserts is one the LEDGER minted, not one the test wrote. A fresh
 * store has appended no revision, so `DESIGN_REVISION_ABSENT` at layer `LEDGER` is the honest
 * answer and it travels VERBATIM at 200: `handleDesignReadRequest` forwards `port.read`'s object
 * without reshaping it.
 *
 * WHAT A FAILURE HERE MEANS. A 503 `LISTENER_DESIGN_UNAVAILABLE` is not a store answer at all --
 * it is the listener saying no port reached it, which is precisely the wiring this arm exists to
 * pin (composition factory -> shipped provider -> FACTORIES -> resolution -> daemon-entry spread).
 * A 200 `DESIGN_READ_CAPABILITY_DENIED` would mean the GOAL capability never reached the handler.
 */
it("resolves and forwards a store-backed design reader onto the listener", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-entry-design-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), "proj-0001");
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      designReads: () => ({ read: (input) => readDesignRevision(store, input) }),
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, "/design/read", { goalRef: "goal-1" })).toEqual({
      body: {
        code: "DESIGN_REVISION_ABSENT", layer: "LEDGER", ok: false,
        sourceCode: null, sourceLayer: null,
      },
      status: 200,
    });
  } finally {
    await started.shutdown();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

/**
 * The negative control for the arm above, and the behaviour rail 2 mandates: a daemon composed
 * with no design port REFUSES rather than inventing a design. The code is asserted WITH its
 * layer-bearing status -- 503 is the listener's own refusal, distinct from any 200 the store or
 * the capability fence could produce.
 */
it("refuses the design read as unavailable when the provider offers no design port", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, "/design/read", { goalRef: "goal-1" })).toMatchObject({
      body: { code: "LISTENER_DESIGN_UNAVAILABLE" }, status: 503,
    });
  } finally {
    await started.shutdown();
  }
});

/**
 * THE FACTORIES ROSTER, PINNED AT THE LAYER IT ACTUALLY GUARDS. `designReads` appearing in
 * `FACTORIES` does NOT decide whether the port is resolved -- `resolveOptionalDaemonPorts` reads
 * `provider.designReads` from its own explicit block either way. What the roster entry decides is
 * WHICH LAYER REFUSES a malformed MODULE-LOADED provider: listed, `isDependencyProvider` says no
 * at `daemon-main.ts:56` and the process refuses with `DAEMON_ENTRY_PROVIDER_INVALID` before boot;
 * unlisted, `optionalPortFactoriesAreValid`'s `FACTORIES.every` never inspects the key, the
 * provider is admitted, and the refusal degrades to `DAEMON_ENTRY_DEPENDENCIES_INVALID` from
 * inside `startDaemon`. Same "it failed", different layer -- which is precisely the distinction
 * this board requires a test to pin rather than infer.
 *
 * BOTH DIRECTIONS ARE ASSERTED ON PURPOSE. The `false` arm alone would be vacuous: any malformed
 * member of `base` would also produce `false`. The `true` arm holds `base` fixed and varies ONLY
 * the `designReads` value, so the rejection is attributable to that key and nothing else.
 */
it("rejects a module-loaded provider whose design factory is not callable", () => {
  const base = { provide: () => fixtureDependencies() };
  const port = { read: () => ({ code: "DESIGN_REVISION_ABSENT", layer: "LEDGER", ok: false }) };

  expect(isDependencyProvider({ ...base, designReads: () => port })).toBe(true);
  expect(isDependencyProvider({ ...base, designReads: port })).toBe(false);
});
