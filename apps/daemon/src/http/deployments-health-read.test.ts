/**
 * POST /deployments/health/read at the HANDLER seam: what the route projects out of durable
 * material it did not write, and what it refuses. Reachability from the COMPOSED production
 * listener is a different question and is pinned in `daemon-entry-deployments-health.test.ts` —
 * a test that builds its own server proves the handler works and says nothing about whether the
 * daemon serves it, which is the hole that forced task-eb2bb09d to exist after task-7ca9dca3.
 */
import { expect, it } from "vitest";

import type { EnvironmentDeployState } from "../deployment/deploy-ledger.js";
import {
  DEPLOY_ENGINE_STAMP, DEPLOY_RECEIPT_VERSION,
} from "../deployment/deploy-receipt-contracts.js";
import type { DeployReceiptV1, DeployRefusal } from "../deployment/deploy-receipt-contracts.js";
import { HEALTH_PROBE_VERSION } from "../monitoring/health-probe-contracts.js";
import type { HealthIncident, HealthProbe } from "../monitoring/health-probe-contracts.js";
import { deriveHealthState } from "../monitoring/health-probe-ring.js";
import {
  DEPLOYMENTS_HEALTH_READ_PATH, deploymentsHealthReadBodyOf, handleDeploymentsHealthReadRequest,
} from "./deployments-health-read.js";
import type { DeploymentsHealthSource } from "./deployments-health-read.js";
import { DEFAULT_PROBE_INTERVAL_MS } from "../monitoring/probe-interval-record.js";
import type { ProbeIntervalRefusal } from "../monitoring/probe-interval-record.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator, bytes } from "./http-test-fixtures.js";

const ENVIRONMENT = "production";
const SHA = "a".repeat(40);
const PREVIOUS_SHA = "b".repeat(40);

/**
 * THE ERROR LINE THE CARD EXISTS FOR. Deliberately long, punctuated and quoted: no summariser,
 * truncator or code-mapper produces this string by accident, so an equality assertion against it
 * cannot be satisfied by anything but the recorded bytes travelling through untouched.
 */
const ERROR_LINE = 'failed to solve: process "/bin/sh -c pnpm --filter @acme/api build" '
  + "did not complete successfully: exit code: 137 (OOMKilled, layer sha256:9f2c1b, 2.4GiB/2GiB)";

function probe(status: HealthProbe["status"], at: string, latencyMs = 12): HealthProbe {
  return Object.freeze({
    at, environment: ENVIRONMENT, latencyMs, sha: SHA, status, version: HEALTH_PROBE_VERSION,
  });
}

function receipt(overrides: Partial<DeployReceiptV1> = {}): DeployReceiptV1 {
  return Object.freeze({
    decidedAt: "2026-09-06T10:00:00.000Z",
    decisionId: "decision-1",
    environment: ENVIRONMENT,
    imageDigest: `sha256:${"c".repeat(64)}`,
    outcome: "DEPLOYED" as const,
    projectId: "proj-0001",
    receiptId: "d".repeat(64),
    refusal: null,
    releaseDecision: null,
    sha: SHA,
    url: "https://api.example.test",
    version: DEPLOY_RECEIPT_VERSION,
    ...overrides,
  });
}

function refusedReceipt(detail: string, decidedAt: string): DeployReceiptV1 {
  const refusal: DeployRefusal = Object.freeze({
    code: "DEPLOY_BUILD_FAILED" as const, detail, layer: DEPLOY_ENGINE_STAMP,
  });
  return receipt({ decidedAt, imageDigest: null, outcome: "REFUSED", refusal, url: null });
}

function deploys(receipts: readonly DeployReceiptV1[]): EnvironmentDeployState {
  const current = receipts[receipts.length - 1];
  if (current === undefined) throw new Error("fixture needs at least one receipt");
  return Object.freeze({ current, previous: receipts[receipts.length - 2] ?? null, receipts });
}

function incident(id: number, openedAt: string, closedAt: string | null): HealthIncident {
  return Object.freeze({ closedAt, environment: ENVIRONMENT, id, openedAt, openingProbes: [] });
}

/**
 * DELIBERATELY NOT 60000. Every arm that does not care about the interval still has to state one,
 * and stating the DEFAULT here would make a read that hard-codes `DEFAULT_PROBE_INTERVAL_MS`
 * agree with this fixture by accident. A value no default could produce keeps those arms honest.
 */
const FIXTURE_INTERVAL_MS = 15_000;

function source(overrides: Partial<DeploymentsHealthSource> = {}): DeploymentsHealthSource {
  return Object.freeze({
    deploys: deploys([receipt()]), incidents: [], probeIntervalMs: FIXTURE_INTERVAL_MS,
    probes: [], ...overrides,
  });
}

/** The port is injected, never opened here: the module holds no store (its own doc comment). */
function serve(
  value: DeploymentsHealthSource | null, body: unknown, capabilities: readonly string[] = ["goal.write"],
) {
  return handleDeploymentsHealthReadRequest({
    authenticator: authenticator(capabilities),
    deploymentsHealth: {
      read: () => value === null
        ? Object.freeze({ code: "PROBE_STORE_UNAVAILABLE" as const, layer: "DAEMON_INGRESS" as const, ok: false as const })
        : Object.freeze({ ok: true as const, value }),
    },
  }, { body: bytes(body), credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });
}

function viewOf(value: DeploymentsHealthSource): Record<string, unknown> {
  const result = serve(value, { environment: ENVIRONMENT });
  if (result.kind !== "REPLY") throw new Error(`expected a REPLY, got ${result.code}`);
  return result.body as unknown as Record<string, unknown>;
}

it("serves the path the consumers pin", () => {
  expect(DEPLOYMENTS_HEALTH_READ_PATH).toBe("/deployments/health/read");
});

/**
 * DoD 2, AND THE REASON THIS ROW EXISTS. The consuming incident card is there so an operator
 * under time pressure does not open the logs; a route that answers "unhealthy" makes it useless
 * while looking correct. EQUALITY against the seeded literal, not `toContain`, not "is non-empty":
 * a substring assertion passes for a truncation, and truncating docker's line is exactly the
 * failure mode that would send the operator to the logs anyway.
 */
it("carries the recorded error line VERBATIM, with its own code and layer", () => {
  const view = viewOf(source({
    deploys: deploys([receipt(), refusedReceipt(ERROR_LINE, "2026-09-06T11:00:00.000Z")]),
    probes: [probe("FAILURE", "2026-09-06T11:05:00.000Z")],
  }));

  expect(view["lastError"]).toEqual({
    at: "2026-09-06T11:00:00.000Z",
    code: "DEPLOY_BUILD_FAILED",
    layer: "DAEMON_DEPLOY_ENGINE",
    line: ERROR_LINE,
    source: "DEPLOY_RECEIPT",
  });
  // Stated twice on purpose: the object comparison above would still pass if a future edit made
  // BOTH the fixture and the answer a summary. This one is byte equality against the literal.
  expect((view["lastError"] as { readonly line: string }).line).toBe(ERROR_LINE);
  expect((view["lastError"] as { readonly line: string }).line).toHaveLength(ERROR_LINE.length);
});

/** The most recent recorded refusal wins: an older error line is not what an operator is fixing. */
it("carries the LAST error line when the ledger holds several", () => {
  const view = viewOf(source({
    deploys: deploys([
      refusedReceipt("an older failure nobody is looking at", "2026-09-01T10:00:00.000Z"),
      refusedReceipt(ERROR_LINE, "2026-09-06T11:00:00.000Z"),
    ]),
  }));
  expect((view["lastError"] as { readonly line: string }).line).toBe(ERROR_LINE);
});

it("reports no error line when nothing has been refused", () => {
  expect(viewOf(source())["lastError"]).toBeNull();
});

/**
 * DoD 4. An environment with a deploy receipt but NO health url carries the probe row's own
 * PROBE_URL_MISSING outcome, with its code AND its layer — and the STATE is asserted, not merely
 * the presence of a refusal member: a response reporting UP with a refusal hanging off it would
 * satisfy "a refusal is present" while telling an operator the opposite of the truth.
 */
it("never reports an unprobeable environment as UP", () => {
  const view = viewOf(source({ deploys: deploys([receipt({ url: null })]) }));

  expect(view["probeRefusal"]).toEqual({
    code: "PROBE_URL_MISSING", layer: "DAEMON_INGRESS", ok: false,
  });
  expect(view["state"]).toBe("DEGRADED");
  expect(view["state"]).not.toBe("UP");
});

/** A deployed environment that DOES name a url has nothing to refuse. */
it("reports no probe refusal when the environment names a health url", () => {
  const view = viewOf(source({ probes: [probe("SUCCESS", "2026-09-06T11:00:00.000Z")] }));
  expect(view["probeRefusal"]).toBeNull();
  expect(view["state"]).toBe("UP");
});

/**
 * DoD 1. THE RING IS CHOSEN SO THE DERIVATION AND A NAIVE RULE DISAGREE. Three failures then one
 * success: any "majority failed", "recent failures", or "latency threshold" rule reimplemented in
 * this route answers DOWN or DEGRADED. `deriveHealthState` answers UP, because the LAST
 * observation succeeded. A fixture where both rules agree cannot tell which one ran.
 *
 * The expectation is stated as a LITERAL and then cross-checked against the production function,
 * so neither a changed derivation nor a reimplemented one can go unnoticed.
 */
it("returns the existing derivation's answer, not a plausible one", () => {
  const probes = [
    probe("FAILURE", "2026-09-06T11:00:00.000Z", 9000),
    probe("FAILURE", "2026-09-06T11:01:00.000Z", 9000),
    probe("FAILURE", "2026-09-06T11:02:00.000Z", 9000),
    probe("SUCCESS", "2026-09-06T11:03:00.000Z", 4),
  ];
  expect(deriveHealthState(probes)).toBe("UP");
  expect(viewOf(source({ probes }))["state"]).toBe("UP");

  // The other direction: a success followed by two failures is DEGRADED, not the DOWN a
  // "two strikes" rule would mint. The threshold is three CONSECUTIVE failures and only that.
  const shaky = [
    probe("SUCCESS", "2026-09-06T12:00:00.000Z"),
    probe("FAILURE", "2026-09-06T12:01:00.000Z"),
    probe("FAILURE", "2026-09-06T12:02:00.000Z"),
  ];
  expect(deriveHealthState(shaky)).toBe("DEGRADED");
  expect(viewOf(source({ probes: shaky }))["state"]).toBe("DEGRADED");

  const down = [
    probe("FAILURE", "2026-09-06T13:00:00.000Z"),
    probe("FAILURE", "2026-09-06T13:01:00.000Z"),
    probe("FAILURE", "2026-09-06T13:02:00.000Z"),
  ];
  expect(deriveHealthState(down)).toBe("DOWN");
  expect(viewOf(source({ probes: down }))["state"]).toBe("DOWN");
});

/** No stored status field is introduced (rail 3): the view's `state` is the only one, and it is
 * recomputed from the probes handed in. Feeding the SAME deploys with different rings proves the
 * answer tracks the history rather than anything persisted beside it. */
it("derives the state from the ring rather than from a stored field", () => {
  const deployState = deploys([receipt()]);
  expect(viewOf({
    deploys: deployState, incidents: [], probeIntervalMs: FIXTURE_INTERVAL_MS,
    probes: [probe("SUCCESS", "2026-09-06T11:00:00.000Z")],
  })["state"]).toBe("UP");
  expect(viewOf({
    deploys: deployState,
    incidents: [],
    probeIntervalMs: FIXTURE_INTERVAL_MS,
    probes: [
      probe("FAILURE", "2026-09-06T11:00:00.000Z"), probe("FAILURE", "2026-09-06T11:01:00.000Z"),
      probe("FAILURE", "2026-09-06T11:02:00.000Z"),
    ],
  })["state"]).toBe("DOWN");
});

it("serves the last probe with its timestamp and latency", () => {
  const view = viewOf(source({
    probes: [probe("SUCCESS", "2026-09-06T11:00:00.000Z", 7), probe("FAILURE", "2026-09-06T11:01:00.000Z", 331)],
  }));
  expect(view["lastProbe"]).toEqual({
    at: "2026-09-06T11:01:00.000Z", latencyMs: 331, status: "FAILURE",
  });
});

it("reports no last probe before an environment has been probed", () => {
  expect(viewOf(source())["lastProbe"]).toBeNull();
});

/**
 * THE SERVED KEY ROSTER, PINNED WHERE IT IS PRODUCED. Measured on 2026-09-07: every other arm in
 * this file and in `daemon-entry-deployments-health.test.ts` asserts ONE member off a
 * `Record<string, unknown>`, so nothing on the daemon side pinned the frame's key SET at all -
 * the exact-key discipline existed only in the control-room decoder. A key added here and
 * forgotten in that decoder reaches production as a refused frame, and a key REMOVED here breaks
 * a consumer no daemon arm would notice. Set-equality in BOTH directions, sorted so the literal
 * cannot pass by accident of insertion order.
 */
it("serves EXACTLY the key roster its consumers decode, in both directions", () => {
  expect(Object.keys(viewOf(source())).sort()).toEqual([
    "environment", "incident", "lastError", "lastProbe", "latencySeries", "ok",
    "probeIntervalMs", "probeRefusal", "rollbackSha", "state",
  ]);
  expect(Object.keys(viewOf(source())["latencySeries"] as object).sort())
    .toEqual(["points", "windowMinutes"]);
});

/**
 * DoD 1, AND THE ONLY ARM THAT CATCHES AN UNWINDOWED RING. The ring below spans NINETY MINUTES,
 * one probe a minute. A projection that returned the whole ring would satisfy any assertion about
 * the NEWEST point, so this asserts the returned COUNT and the OLDEST RETURNED INSTANT - the two
 * values that differ between a windowed series and a whole one. 61 points, not 60: the window is
 * inclusive of its far edge, so both endpoints of a closed hour are carried.
 */
it("drops probes older than the stated window rather than serving the whole ring", () => {
  const base = Date.parse("2026-09-06T10:00:00.000Z");
  const ring = Array.from({ length: 91 }, (_, index) =>
    probe("SUCCESS", new Date(base + (index * 60_000)).toISOString(), index));
  expect(ring).toHaveLength(91);
  const series = viewOf(source({ probes: ring }))["latencySeries"] as {
    readonly points: readonly { readonly at: string; readonly latencyMs: number }[];
    readonly windowMinutes: number;
  };
  expect(series.windowMinutes).toBe(60);
  expect(series.points).toHaveLength(61);
  expect(series.points[0]).toEqual({ at: "2026-09-06T10:30:00.000Z", latencyMs: 30 });
  expect(series.points.at(-1)).toEqual({ at: "2026-09-06T11:30:00.000Z", latencyMs: 90 });
  // Newest LAST, matching `lastProbe`, so the two members cannot disagree about which end is new.
  expect((viewOf(source({ probes: ring }))["lastProbe"] as { readonly at: string }).at)
    .toBe(series.points.at(-1)?.at);
});

/** The far edge is INCLUSIVE: a probe at exactly newest-minus-the-window is carried, not dropped. */
it("carries a probe sitting exactly on the window edge, and drops the one a millisecond older", () => {
  const series = viewOf(source({
    probes: [
      probe("SUCCESS", "2026-09-06T10:59:59.999Z", 1),
      probe("SUCCESS", "2026-09-06T11:00:00.000Z", 2),
      probe("SUCCESS", "2026-09-06T12:00:00.000Z", 3),
    ],
  }))["latencySeries"] as { readonly points: readonly { readonly latencyMs: number }[] };
  expect(series.points.map((point) => point.latencyMs)).toEqual([2, 3]);
});

/**
 * DEGENERATE RINGS STILL STATE THE WINDOW. An empty series with no window would leave a consumer
 * unable to say what span it failed to plot, and a NULL member would make "no probes yet"
 * indistinguishable from "the series could not be read" at the client's exact-key gate.
 */
it("serves an empty series - never null - for an empty ring, with the window still stated", () => {
  expect(viewOf(source())["latencySeries"]).toEqual({ points: [], windowMinutes: 60 });
});

it("serves a single-probe ring as a one-point series", () => {
  expect(viewOf(source({ probes: [probe("FAILURE", "2026-09-06T11:00:00.000Z", 404)] }))["latencySeries"])
    .toEqual({ points: [{ at: "2026-09-06T11:00:00.000Z", latencyMs: 404 }], windowMinutes: 60 });
});

/**
 * A ring whose every row predates the window CANNOT occur while the window is anchored on the
 * newest probe - the newest row is always its own anchor. This arm pins that: a ring older than
 * any wall clock still serves its final hour rather than an empty chart, which is what makes the
 * anchor choice observable rather than an implementation detail.
 */
it("anchors the window on the newest probe, not on a wall clock, so an old ring still plots", () => {
  const series = viewOf(source({
    probes: [
      probe("SUCCESS", "2019-01-01T00:00:00.000Z", 1),
      probe("SUCCESS", "2019-01-01T00:30:00.000Z", 2),
      probe("SUCCESS", "2019-01-01T02:00:00.000Z", 3),
    ],
  }))["latencySeries"] as { readonly points: readonly { readonly latencyMs: number }[] };
  expect(series.points.map((point) => point.latencyMs)).toEqual([3]);
});

/** No point may carry a per-point status: that is the material a client would re-derive from. */
it("carries only the instant and the latency per point, never a per-point status", () => {
  const series = viewOf(source({ probes: [probe("FAILURE", "2026-09-06T11:00:00.000Z", 9)] }))["latencySeries"] as {
    readonly points: readonly Record<string, unknown>[];
  };
  expect(series.points.map((point) => Object.keys(point).sort())).toEqual([["at", "latencyMs"]]);
});

/** DoD 6 for the incident: a healthy answer omits it rather than fabricating an empty object. */
it("reports the open incident with its opened-at, and null when none is open", () => {
  expect(viewOf(source({
    incidents: [incident(1, "2026-09-06T11:02:00.000Z", null)],
  }))["incident"]).toEqual({ id: 1, openedAt: "2026-09-06T11:02:00.000Z" });

  // A CLOSED incident is not an open one. Asserting only on the empty list would leave a route
  // that returns `incidents.at(-1)` green while it reported a resolved outage as current.
  expect(viewOf(source({
    incidents: [incident(1, "2026-09-06T11:02:00.000Z", "2026-09-06T11:30:00.000Z")],
  }))["incident"]).toBeNull();
  expect(viewOf(source({ incidents: [] }))["incident"]).toBeNull();

  // Closed then reopened: the OPEN one is the answer, not the last row.
  expect(viewOf(source({
    incidents: [
      incident(1, "2026-09-06T09:00:00.000Z", "2026-09-06T09:30:00.000Z"),
      incident(2, "2026-09-06T11:02:00.000Z", null),
    ],
  }))["incident"]).toEqual({ id: 2, openedAt: "2026-09-06T11:02:00.000Z" });
});

/** DoD 1's rollback target: the sha of the receipt the current deploy REPLACED, never its own. */
it("serves the previous receipt's sha as the rollback target", () => {
  const view = viewOf(source({
    deploys: deploys([receipt({ sha: PREVIOUS_SHA }), receipt({ decisionId: "decision-2" })]),
  }));
  expect(view["rollbackSha"]).toBe(PREVIOUS_SHA);
  expect(view["rollbackSha"]).not.toBe(SHA);
});

it("serves no rollback target on an environment's first deploy", () => {
  expect(viewOf(source())["rollbackSha"]).toBeNull();
});

/**
 * DoD 5, BOTH DIRECTIONS, WITH CODES THAT ARE TOLD APART. A single generic code for "unknown
 * key" and "missing key" makes the two indistinguishable to a client, which is why the decoder
 * returns a discriminated result rather than null.
 */
it("refuses an unknown key and a missing key with DIFFERENT specific codes", () => {
  expect(deploymentsHealthReadBodyOf(bytes({ environment: ENVIRONMENT, verbose: true })))
    .toEqual({ code: "LISTENER_DEPLOYMENTS_HEALTH_UNKNOWN_KEY", ok: false });
  expect(deploymentsHealthReadBodyOf(bytes({}))).toEqual({
    code: "LISTENER_DEPLOYMENTS_HEALTH_MISSING_KEY", ok: false,
  });
  expect(deploymentsHealthReadBodyOf(bytes({ environment: ENVIRONMENT })))
    .toEqual({ environment: ENVIRONMENT, ok: true });
  // The distinctness is the point, asserted rather than inferred from the two literals above.
  expect("LISTENER_DEPLOYMENTS_HEALTH_UNKNOWN_KEY")
    .not.toBe("LISTENER_DEPLOYMENTS_HEALTH_MISSING_KEY");
});

/** `projectId` is the PRINCIPAL's, so naming it in the payload is an unknown key, not an override. */
it("treats projectId in the payload as an unknown key", () => {
  const result = serve(source(), { environment: ENVIRONMENT, projectId: "proj-0002" });
  expect(result).toEqual({
    code: "LISTENER_DEPLOYMENTS_HEALTH_UNKNOWN_KEY", kind: "LISTENER_REFUSAL",
  });
});

it("refuses a body that is not an object, and one whose environment is not a usable string", () => {
  expect(deploymentsHealthReadBodyOf(bytes([ENVIRONMENT]))).toEqual({
    code: "LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID", ok: false,
  });
  expect(deploymentsHealthReadBodyOf(bytes({ environment: "" }))).toEqual({
    code: "LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID", ok: false,
  });
  expect(deploymentsHealthReadBodyOf(bytes({ environment: 7 }))).toEqual({
    code: "LISTENER_DEPLOYMENTS_HEALTH_REQUEST_INVALID", ok: false,
  });
});

/**
 * The absent port REFUSES AS UNAVAILABLE. A daemon composed without this port answering a healthy
 * default would report every environment UP on a daemon that cannot see any of them — the most
 * dangerous output a health route has.
 */
it("refuses as unavailable when no port reached the handler", () => {
  const result = handleDeploymentsHealthReadRequest(
    { authenticator: authenticator(["goal.write"]) },
    {
      body: bytes({ environment: ENVIRONMENT }), credential: GOOD_CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    },
  );
  expect(result).toEqual({ code: "LISTENER_DEPLOYMENTS_HEALTH_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
});

/** The capability fence answers at 200 with the LISTENER's layer, distinct from the 503 above. */
it("denies a principal without the GOAL capability, naming the layer that refused", () => {
  const result = serve(source(), { environment: ENVIRONMENT }, ["review.write"]);
  expect(result).toEqual({
    body: {
      code: "DEPLOYMENTS_HEALTH_READ_CAPABILITY_DENIED", layer: "CONTROL_ROOM_LISTENER",
      outcome: "REFUSED",
    },
    httpStatus: 200,
    kind: "REPLY",
  });
});

/** The store's refusal travels VERBATIM with the probe row's own code and layer, never reshaped
 * into a health verdict nobody measured. */
it("forwards the store's refusal with its own code and layer", () => {
  const result = serve(null, { environment: ENVIRONMENT });
  expect(result).toEqual({
    body: { code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false },
    httpStatus: 200,
    kind: "REPLY",
  });
});

/** An unauthenticated caller is refused before the port is consulted at all. */
it("refuses an unauthenticated caller without asking the port", () => {
  let asked = false;
  const result = handleDeploymentsHealthReadRequest({
    authenticator: authenticator(["goal.write"]),
    deploymentsHealth: {
      read: () => {
        asked = true;
        return Object.freeze({ ok: true as const, value: source() });
      },
    },
  }, {
    body: bytes({ environment: ENVIRONMENT }), credential: "sess-unknown",
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
  expect(result.kind).toBe("REPLY");
  expect(asked).toBe(false);
});


/**
 * THE INTERVAL SURVIVES THE PROJECTION UNTOUCHED. The value the PORT supplied is the value the
 * frame carries: not clamped, not defaulted, not re-derived. `FIXTURE_INTERVAL_MS` is not a value
 * any default could mint, so a handler that quietly substituted `DEFAULT_PROBE_INTERVAL_MS` for
 * what it was handed reds here rather than agreeing with its own fallback.
 */
it("carries the port's effective probe interval into the frame without re-resolving it", () => {
  const view = viewOf(source());
  expect(view["probeIntervalMs"]).toBe(FIXTURE_INTERVAL_MS);
  expect(view["probeIntervalMs"]).not.toBe(DEFAULT_PROBE_INTERVAL_MS);
});

/**
 * DoD 4 AT THIS SEAM: two environments carrying DIFFERENT intervals are projected separately.
 * A projection that resolved the interval ONCE and reused it - the shape a memoised or
 * module-scoped resolver would produce - passes every single-environment arm above and fails
 * only here. The end-to-end version, over a real socket and a real durable record, is in
 * `daemon-entry-deployments-health.test.ts`; this arm pins the projection itself.
 */
it("projects a different interval for each environment rather than one value for all", () => {
  const fast = viewOf(source({ probeIntervalMs: 5_000 }));
  const slow = viewOf(source({ probeIntervalMs: 900_000 }));
  expect(fast["probeIntervalMs"]).toBe(5_000);
  expect(slow["probeIntervalMs"]).toBe(900_000);
  expect(fast["probeIntervalMs"]).not.toBe(slow["probeIntervalMs"]);
});

/**
 * A SETTINGS FAULT IS NOT LAUNDERED INTO THE DEFAULT (DoD 1 and DoD 3's fail-closed clause).
 * The interval record refuses in its OWN vocabulary - `PROBE_INTERVAL_*` codes are deliberately
 * absent from `HealthProbeCode` - and the handler carries that refusal out verbatim rather than
 * serving 60000. Serving the default here would show an operator a rate nobody stored,
 * indistinguishable from one deliberately left unset.
 *
 * BOTH the code AND the layer are asserted, and the frame is asserted NOT to be a 200 view: an
 * arm that only checked "did not succeed" would pass if the handler answered the capability
 * refusal, the listener refusal, or the ring's own `PROBE_STORE_UNAVAILABLE` instead.
 */
it.each([
  "PROBE_INTERVAL_ENVIRONMENT_INVALID",
  "PROBE_INTERVAL_STORE_FAILED",
  "PROBE_INTERVAL_OUT_OF_RANGE",
] as const)("carries the interval record's %s out verbatim instead of serving the default", (code) => {
  const refusal: ProbeIntervalRefusal = Object.freeze({
    code, layer: "DAEMON_INGRESS" as const, ok: false as const,
  });
  const result = handleDeploymentsHealthReadRequest({
    authenticator: authenticator(["goal.write"]),
    deploymentsHealth: { read: () => refusal },
  }, {
    body: bytes({ environment: ENVIRONMENT }), credential: GOOD_CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
  if (result.kind !== "REPLY") throw new Error(`expected a REPLY, got ${result.code}`);
  expect(result.body).toEqual({ code, layer: "DAEMON_INGRESS", ok: false });
  // Not a view at all: no `probeIntervalMs`, and certainly not the default standing in for one.
  expect(result.body).not.toHaveProperty("probeIntervalMs");
  expect(result.body).not.toHaveProperty("ok", true);
});

/**
 * THE REFUSAL'S OWN NEGATIVE CONTROL. The three arms above would be satisfied by a handler that
 * refused EVERYTHING, so this pins that the very same request shape succeeds when the port
 * accepts - the refusal is attributable to the port's answer, not to the request.
 */
it("serves the frame for the same request shape when the interval record accepts", () => {
  expect(viewOf(source())["ok"]).toBe(true);
});
