/**
 * `/deployments/health/read`, REACHED THROUGH THE PRODUCTION LISTENER (DoD 3).
 *
 * The port is NOT hand-built here: it is the one `createStoreDependencies` — i.e.
 * `daemon-store-foundation-composition.ts` — constructs over a real store, so every arm below
 * traverses composition -> FACTORIES -> resolveOptionalDaemonPorts -> the daemon-entry spread ->
 * StartListenerOptions -> the JSON_ROUTES roster -> the method guard -> the dispatch branch, and
 * back out over a real socket. Removing ANY of those links breaks it.
 *
 * WHY THAT MATTERS HERE. task-7ca9dca3 served `/design/read` and task-eb2bb09d then had to exist
 * PURELY to mount it: a served route nothing mounts satisfies every existence grep while the
 * feature does not exist. A test that builds its own server and mounts the handler would have
 * passed for exactly that defect, so these arms refuse to build one.
 *
 * WHAT A FAILURE MEANS. 503 LISTENER_DEPLOYMENTS_HEALTH_UNAVAILABLE = no port reached the
 * listener. 404 = the path never entered JSON_ROUTES. 200 with
 * DEPLOYMENTS_HEALTH_READ_CAPABILITY_DENIED = the GOAL capability never reached the handler.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";

import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { isDependencyProvider, startDaemon } from "./daemon-entry.js";
import { recordDeployReceipt } from "./deployment/deploy-ledger.js";
import { DEPLOY_ENGINE_STAMP } from "./deployment/deploy-receipt-contracts.js";
import { HEALTH_PROBE_SIDECAR_SUFFIX, HEALTH_PROBE_VERSION } from "./monitoring/health-probe-contracts.js";
import type { HealthProbe } from "./monitoring/health-probe-contracts.js";
import { createHealthProbeRing } from "./monitoring/health-probe-ring.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http/http-test-fixtures.js";

const CSRF = "deployments-health-csrf";
const PATH = "/deployments/health/read";
const PROJECT = "proj-0001";
const ENVIRONMENT = "production";
const SHA = "a".repeat(40);
const ROLLBACK_SHA = "b".repeat(40);

/** Long, quoted and punctuated: nothing a summariser or a code-mapper mints by accident. */
const ERROR_LINE = 'failed to solve: process "/bin/sh -c pnpm --filter @acme/api build" '
  + "did not complete successfully: exit code: 137 (OOMKilled, layer sha256:9f2c1b, 2.4GiB/2GiB)";

async function post(
  started: { readonly origin: string; readonly port: number },
  path: string,
  body: unknown = {},
  method = "POST",
): Promise<{ readonly body: unknown; readonly status: number }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const call = httpRequest({
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${started.port}`, origin: started.origin,
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": GOOD_CREDENTIAL,
      },
      host: "127.0.0.1", method, path, port: started.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        status: response.statusCode ?? 0,
      }));
    });
    call.on("error", reject);
    call.end(payload);
  });
}

function probe(status: HealthProbe["status"], at: string, latencyMs = 11): HealthProbe {
  return Object.freeze({
    at, environment: ENVIRONMENT, latencyMs, sha: SHA, status, version: HEALTH_PROBE_VERSION,
  });
}

const RECEIPT_BASE = {
  environment: ENVIRONMENT, imageDigest: `sha256:${"c".repeat(64)}`, projectId: PROJECT,
  refusal: null, releaseDecision: null, url: "https://api.example.test",
} as const;

interface World {
  readonly composed: ReturnType<typeof createStoreDependencies>;
  readonly directory: string;
  readonly storePath: string;
}

/**
 * The composition installs genesis and REFUSES a store that already carries history
 * (RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT), so the store must be composed FIRST and seeded
 * after — which is also the real order of events: a daemon boots, then deploys happen.
 */
function world(name: string): World {
  const directory = mkdtempSync(join(tmpdir(), `moe-entry-${name}-`));
  const storePath = join(directory, "store.db");
  const composed = createStoreDependencies({
    credential: "deployments-health-credential", principalId: "operator-local",
    projectId: PROJECT, storePath,
  });
  return { composed, directory, storePath };
}

/**
 * Receipts written through the PRODUCTION writer, on a short-lived handle that is closed again
 * immediately. Nothing here hand-writes a receipt shape: `recordDeployReceipt` is the same
 * function the deploy engine calls, so what the route reads back is a ledger fact.
 */
function seed(open: World, inputs: readonly Parameters<typeof recordDeployReceipt>[1][]): void {
  const store = SqliteEventStore.openForProject(open.storePath, PROJECT);
  try {
    for (const input of inputs) expect(recordDeployReceipt(store, input).ok).toBe(true);
  } finally {
    store.close();
  }
}

/** ANYTHING THIS TEST STARTS, IT STOPS (epic rail 4): the listener, the store handle, the temp
 * tree and — because the ring is a SEPARATE sqlite sidecar — nothing else holds it open. */
function teardown(open: World): void {
  open.composed.close();
  rmSync(open.directory, { force: true, recursive: true });
}

async function boot(open: World, capabilities: readonly string[] = [CAPABILITIES.GOAL]) {
  // Read the port off the composition ONCE and refuse to proceed without it. `deploymentsHealth`
  // is optional on the provider type, so `composed.deploymentsHealth?.()` would silently hand the
  // entry `undefined` and every arm below would then assert the 503 it exists to rule out.
  const port = open.composed.deploymentsHealth?.();
  if (port === undefined) throw new Error("composition supplied no deployments-health port");
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      deploymentsHealth: () => port,
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator(capabilities) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  return started;
}

/**
 * THE ROW'S REASON FOR EXISTING, OVER A REAL SOCKET. A refused deploy records docker's own last
 * stderr line; three failing probes open an incident; the deploy before the current one is the
 * rollback target. Every value asserted below was written through the PRODUCTION writers
 * (`recordDeployReceipt`, `createHealthProbeRing().append`) into the SAME sidecar the composition
 * reads, so nothing here is a fixture the route was handed.
 */
it("serves environment state, the verbatim error line and the open incident from a production boot", async () => {
  // Three receipts in ledger order: the rollback target, the current deploy, then a REFUSED one
  // carrying the error line. `previous` is therefore the middle sha, not the oldest or the tip.
  const open = world("deployments-health");
  const ring = createHealthProbeRing(`${open.storePath}${HEALTH_PROBE_SIDECAR_SUFFIX}`, PROJECT);
  try {
    seed(open, [
      { ...RECEIPT_BASE, decidedAt: "2026-09-06T09:00:00.000Z", decisionId: "d-0", sha: ROLLBACK_SHA },
      { ...RECEIPT_BASE, decidedAt: "2026-09-06T10:00:00.000Z", decisionId: "d-1", sha: SHA },
      {
        ...RECEIPT_BASE, decidedAt: "2026-09-06T12:00:00.000Z", decisionId: "d-2", imageDigest: null,
        refusal: { code: "DEPLOY_BUILD_FAILED", detail: ERROR_LINE, layer: DEPLOY_ENGINE_STAMP },
        sha: SHA, url: null,
      },
    ]);
    const first = await boot(open);
    try {
      const answer = await post(first, PATH, { environment: ENVIRONMENT });
      expect(answer.status).toBe(200);
      const view = answer.body as Record<string, unknown>;
      expect(view["environment"]).toBe(ENVIRONMENT);
      // An environment with receipts and no probes yet is DEGRADED — never UP, and never an
      // invented DOWN. This is `deriveHealthState`'s answer for an empty history.
      expect(view["state"]).toBe("DEGRADED");
      expect(view["lastProbe"]).toBeNull();
      expect(view["incident"]).toBeNull();
      expect(view["ok"]).toBe(true);
    } finally {
      await first.shutdown();
    }

    // Now write real probe history through the production writer — into the SAME sidecar the
    // composition reads — and read it back over the socket.
    expect(ring.append(probe("FAILURE", "2026-09-06T11:00:00.000Z")).ok).toBe(true);
    expect(ring.append(probe("FAILURE", "2026-09-06T11:01:00.000Z")).ok).toBe(true);
    expect(ring.append(probe("FAILURE", "2026-09-06T11:02:00.000Z", 431)).ok).toBe(true);

    const started = await boot(open);
    try {
      const answer = await post(started, PATH, { environment: ENVIRONMENT });
      expect(answer.status).toBe(200);
      const view = answer.body as Record<string, unknown>;
      // Three consecutive failures is the probe row's DOWN threshold, derived not stored.
      expect(view["state"]).toBe("DOWN");
      expect(view["lastProbe"]).toEqual({
        at: "2026-09-06T11:02:00.000Z", latencyMs: 431, status: "FAILURE",
      });
      // THE POINT OF THE ROW: byte equality against the seeded line, off the wire. A route that
      // answered "unhealthy", a code, or a truncation makes the card it feeds useless.
      expect(view["lastError"]).toEqual({
        at: "2026-09-06T12:00:00.000Z", code: "DEPLOY_BUILD_FAILED",
        layer: "DAEMON_DEPLOY_ENGINE", line: ERROR_LINE, source: "DEPLOY_RECEIPT",
      });
      expect((view["lastError"] as { readonly line: string }).line).toBe(ERROR_LINE);
      // The one-open-incident lifecycle opened on the third failure; its opened-at is the probe's.
      expect(view["incident"]).toEqual({ id: 1, openedAt: "2026-09-06T11:02:00.000Z" });
      expect(view["rollbackSha"]).toBe(SHA);
      expect(view["rollbackSha"]).not.toBe(ROLLBACK_SHA);
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * DoD 4 over the socket: a DEPLOYED environment naming no health url carries the probe row's
 * PROBE_URL_MISSING with its code AND its layer, and the STATE is asserted rather than the mere
 * presence of a refusal member.
 */
it("never reports an unprobeable environment as UP through the composed listener", async () => {
  const open = world("deployments-health-unprobeable");
  try {
    seed(open, [
      { ...RECEIPT_BASE, decidedAt: "2026-09-06T09:00:00.000Z", decisionId: "d-0", sha: SHA, url: null },
    ]);
    const started = await boot(open);
    try {
      const view = (await post(started, PATH, { environment: ENVIRONMENT })).body as Record<string, unknown>;
      expect(view["probeRefusal"]).toEqual({
        code: "PROBE_URL_MISSING", layer: "DAEMON_INGRESS", ok: false,
      });
      expect(view["state"]).not.toBe("UP");
      expect(view["state"]).toBe("DEGRADED");
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * DoD 5 over the socket, BOTH DIRECTIONS AND DISTINGUISHABLE. The layer is the listener's own,
 * written by `refuseRequest`; the codes differ, so a client can tell which mistake it made. The
 * roster and the dispatch branch are separate edits and either alone leaves a hole, so reaching
 * these codes at all also pins both.
 */
it("refuses an unknown key and a missing key with different codes, each naming its layer", async () => {
  const open = world("deployments-health-keys");
  try {
    const started = await boot(open);
    try {
      expect(await post(started, PATH, { environment: ENVIRONMENT, projectId: PROJECT })).toEqual({
        body: { code: "LISTENER_DEPLOYMENTS_HEALTH_UNKNOWN_KEY", layer: "CONTROL_ROOM_LISTENER" },
        status: 400,
      });
      expect(await post(started, PATH, {})).toEqual({
        body: { code: "LISTENER_DEPLOYMENTS_HEALTH_MISSING_KEY", layer: "CONTROL_ROOM_LISTENER" },
        status: 400,
      });
      expect(await post(started, PATH, { environment: "" })).toEqual({
        body: { code: "LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER" },
        status: 400,
      });
      // The method guard, which is its own edit and would otherwise be unpinned.
      expect(await post(started, PATH, { environment: ENVIRONMENT }, "PUT")).toEqual({
        body: { code: "LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER" },
        status: 400,
      });
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * The negative control for every arm above: a daemon composed with NO health port refuses as
 * unavailable rather than inventing health. 503 is the listener's own refusal, distinct from any
 * 200 the store or the capability fence could produce — so the positive arms' 200 is attributable
 * to the port having ARRIVED, not merely to the request being well formed. An absent port
 * answering UP would report every environment healthy on a daemon that can see none of them.
 */
it("refuses as unavailable when the provider offers no deployments-health port", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.GOAL]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, PATH, { environment: ENVIRONMENT })).toMatchObject({
      body: { code: "LISTENER_DEPLOYMENTS_HEALTH_UNAVAILABLE" }, status: 503,
    });
  } finally {
    await started.shutdown();
  }
}, 60_000);

/** The capability fence, reached through the composed listener: 200 with the listener's layer,
 * distinct from the 503 above, so "it refused" cannot stand in for "the right layer refused". */
it("denies a principal without GOAL through the composed listener", async () => {
  const open = world("deployments-health-capability");
  try {
    const started = await boot(open, [CAPABILITIES.REVIEW]);
    try {
      expect(await post(started, PATH, { environment: ENVIRONMENT })).toEqual({
        body: {
          code: "DEPLOYMENTS_HEALTH_READ_CAPABILITY_DENIED", layer: "CONTROL_ROOM_LISTENER",
          outcome: "REFUSED",
        },
        status: 200,
      });
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * THE FACTORIES ROSTER, pinned at the layer it actually guards, exactly as `designReads` and
 * `environmentReads` are. Listed, `isDependencyProvider` refuses a malformed MODULE-LOADED
 * provider before boot with DAEMON_ENTRY_PROVIDER_INVALID; unlisted, `FACTORIES.every` never
 * inspects the key and the refusal degrades to DAEMON_ENTRY_DEPENDENCIES_INVALID from inside
 * `startDaemon`. Same "it failed", different layer.
 *
 * BOTH DIRECTIONS, with `base` held fixed so the rejection is attributable to this key alone: the
 * `false` arm on its own would be satisfied by any malformed member of `base`.
 */
it("rejects a module-loaded provider whose deployments-health factory is not callable", () => {
  const base = { provide: () => fixtureDependencies() };
  const port = {
    read: () => ({ code: "PROBE_STORE_UNAVAILABLE" as const, layer: "DAEMON_INGRESS" as const, ok: false as const }),
  };

  expect(isDependencyProvider({ ...base, deploymentsHealth: () => port })).toBe(true);
  expect(isDependencyProvider({ ...base, deploymentsHealth: port })).toBe(false);
});
