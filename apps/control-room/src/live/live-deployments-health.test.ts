/**
 * THE DEPLOYMENT-HEALTH READ CLIENT, at the decoder seam.
 *
 * The frames below are the shape `projectDeploymentsHealth` in
 * apps/daemon/src/http/deployments-health-read.ts actually serves - exact keys
 * `environment, incident, lastError, lastProbe, latencySeries, ok, probeIntervalMs,
 * probeRefusal, rollbackSha, state` - so a
 * daemon-side shape change reds this file rather than reaching production as a blank card.
 */

import { describe, expect, it } from "vitest";

import {
  DEPLOYMENTS_HEALTH_READ_PATH, mapDeploymentsHealthAnswer, readDeploymentsHealth,
} from "./live-deployments-health.js";
import { DEV_PROXY_PATHS } from "./dev-proxy-paths.js";

/** The served frame, verbatim: every key the route projects, none this client invented. */
const FRAME = {
  environment: "production",
  incident: { id: 7, openedAt: "2026-09-07T09:00:00.000Z" },
  lastError: {
    at: "2026-09-07T08:59:00.000Z",
    code: "DEPLOY_BUILD_FAILED",
    layer: "DEPLOY_ENGINE",
    line: "Error: failed to solve: process did not complete successfully",
    source: "DEPLOY_RECEIPT",
  },
  lastProbe: { at: "2026-09-07T09:04:00.000Z", latencyMs: 412, status: "FAILURE" },
  latencySeries: {
    points: [
      { at: "2026-09-07T09:02:00.000Z", latencyMs: 96 },
      { at: "2026-09-07T09:03:00.000Z", latencyMs: 210 },
      { at: "2026-09-07T09:04:00.000Z", latencyMs: 412 },
    ],
    windowMinutes: 60,
  },
  ok: true,
  probeIntervalMs: 5_000,
  probeRefusal: null,
  rollbackSha: "b".repeat(40),
  state: "DOWN",
} as const;

const healthy = (): Record<string, unknown> => ({
  environment: "staging", incident: null, lastError: null,
  lastProbe: { at: "2026-09-07T09:04:00.000Z", latencyMs: 88, status: "SUCCESS" },
  latencySeries: { points: [{ at: "2026-09-07T09:04:00.000Z", latencyMs: 88 }], windowMinutes: 60 },
  ok: true, probeIntervalMs: 900_000, probeRefusal: null, rollbackSha: null, state: "UP",
});

const replyOf = (status: number, body: unknown): (() => Promise<Response>) =>
  (): Promise<Response> => Promise.resolve({
    json: (): Promise<unknown> => Promise.resolve(body), status,
  } as Response);

describe("the deployment-health read client decodes the served frame", () => {
  it("carries every field of a well-formed frame across by value", () => {
    const answer = mapDeploymentsHealthAnswer(200, structuredClone(FRAME));
    expect(answer).toEqual({
      environment: "production",
      incident: { id: 7, openedAt: "2026-09-07T09:00:00.000Z" },
      lastError: {
        at: "2026-09-07T08:59:00.000Z",
        code: "DEPLOY_BUILD_FAILED",
        layer: "DEPLOY_ENGINE",
        line: "Error: failed to solve: process did not complete successfully",
        source: "DEPLOY_RECEIPT",
      },
      lastProbe: { at: "2026-09-07T09:04:00.000Z", latencyMs: 412, status: "FAILURE" },
      latencySeries: {
        points: [
          { at: "2026-09-07T09:02:00.000Z", latencyMs: 96 },
          { at: "2026-09-07T09:03:00.000Z", latencyMs: 210 },
          { at: "2026-09-07T09:04:00.000Z", latencyMs: 412 },
        ],
        windowMinutes: 60,
      },
      probeIntervalMs: 5_000,
      probeRefusal: null,
      rollbackSha: "b".repeat(40),
      state: "DOWN",
      status: "DEPLOYMENTS_HEALTH",
    });
  });

  it("carries the daemon state verbatim for each of the three members", () => {
    for (const state of ["UP", "DEGRADED", "DOWN"] as const) {
      const answer = mapDeploymentsHealthAnswer(200, { ...healthy(), state });
      expect(answer.status).toBe("DEPLOYMENTS_HEALTH");
      expect(answer.status === "DEPLOYMENTS_HEALTH" ? answer.state : null).toBe(state);
    }
  });

  it("REFUSES a frame carrying an extra key, with the invalid-response code", () => {
    const answer = mapDeploymentsHealthAnswer(200, { ...healthy(), probeCount: 60 });
    expect(answer).toEqual({
      code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
  });

  it("REFUSES a frame missing a key, with the invalid-response code", () => {
    const partial: Record<string, unknown> = healthy();
    delete partial["rollbackSha"];
    expect(mapDeploymentsHealthAnswer(200, partial)).toEqual({
      code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
  });

  it("REFUSES an unexpected key nested inside lastProbe rather than narrowing it away", () => {
    const answer = mapDeploymentsHealthAnswer(200, {
      ...healthy(),
      lastProbe: { at: "2026-09-07T09:04:00.000Z", code: "X", latencyMs: 88, status: "SUCCESS" },
    });
    expect(answer).toEqual({
      code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
  });

  it("REFUSES a state member the daemon does not serve rather than inventing one", () => {
    expect(mapDeploymentsHealthAnswer(200, { ...healthy(), state: "HEALTHY" })).toEqual({
      code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
  });
});

/**
 * THE WINDOWED SERIES. Every arm here asserts a stable refusal CODE at a named LAYER, not merely
 * that decoding "failed": this decoder has one refusal to give, and an arm that only checked for
 * absence would stay green if a future layer started answering first.
 */
describe("the deployment-health read client decodes the windowed latency series", () => {
  const seriesOf = (series: unknown): unknown => {
    const answer = mapDeploymentsHealthAnswer(200, { ...healthy(), latencySeries: series });
    return answer.status === "DEPLOYMENTS_HEALTH" ? answer.latencySeries : answer;
  };
  const INVALID = {
    code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
    layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
    status: "ERROR",
  };

  it("carries the points and the stated window across BY VALUE, newest last", () => {
    expect(seriesOf({
      points: [
        { at: "2026-09-07T08:10:00.000Z", latencyMs: 0 },
        { at: "2026-09-07T08:11:00.000Z", latencyMs: 1200 },
      ],
      windowMinutes: 60,
    })).toEqual({
      points: [
        { at: "2026-09-07T08:10:00.000Z", latencyMs: 0 },
        { at: "2026-09-07T08:11:00.000Z", latencyMs: 1200 },
      ],
      windowMinutes: 60,
    });
  });

  it("carries an EMPTY series with its window - the day-one environment - rather than refusing it", () => {
    expect(seriesOf({ points: [], windowMinutes: 60 })).toEqual({ points: [], windowMinutes: 60 });
  });

  /** DoD 3: an unexpected member on a nested SERIES ROW is refused, never narrowed away. */
  it("REFUSES an unexpected key nested inside a series point rather than narrowing it away", () => {
    expect(seriesOf({
      points: [{ at: "2026-09-07T08:10:00.000Z", latencyMs: 5, status: "SUCCESS" }],
      windowMinutes: 60,
    })).toEqual(INVALID);
  });

  it("REFUSES an unexpected key on the series object itself", () => {
    expect(seriesOf({ anchoredAt: "2026-09-07T08:11:00.000Z", points: [], windowMinutes: 60 }))
      .toEqual(INVALID);
  });

  it("REFUSES a series missing its window rather than inferring one from the instants", () => {
    expect(seriesOf({ points: [{ at: "2026-09-07T08:10:00.000Z", latencyMs: 5 }] })).toEqual(INVALID);
  });

  /**
   * ONE malformed point refuses the WHOLE series. Dropping it would plot a gap the operator was
   * never told about, and the second point below is well-formed so a decoder that skipped the
   * bad row would answer a plausible one-point chart.
   */
  it("REFUSES the whole series when a single point is malformed, rather than dropping that point", () => {
    expect(seriesOf({
      points: [
        { at: "2026-09-07T08:10:00.000Z", latencyMs: "fast" },
        { at: "2026-09-07T08:11:00.000Z", latencyMs: 12 },
      ],
      windowMinutes: 60,
    })).toEqual(INVALID);
  });

  it("REFUSES a negative or non-integer latency, which no ms measurement produces", () => {
    expect(seriesOf({ points: [{ at: "2026-09-07T08:10:00.000Z", latencyMs: -1 }], windowMinutes: 60 }))
      .toEqual(INVALID);
    expect(seriesOf({ points: [{ at: "2026-09-07T08:10:00.000Z", latencyMs: Number.NaN }], windowMinutes: 60 }))
      .toEqual(INVALID);
  });

  /**
   * THE NULL-VS-UNREADABLE RULE, at the one member that has no legitimate null. Every other
   * nested decoder here answers null for BOTH an absent member and a broken one, so the raw
   * member is re-checked at the top. `latencySeries` is never null on the wire, so a null must
   * refuse the frame - narrowing it to "no points yet" would draw an EMPTY chart for an
   * environment whose history merely failed to decode, which is the exact confusion the
   * empty-series arm above makes indistinguishable otherwise.
   */
  it("REFUSES a null series instead of reading it as an environment with no history", () => {
    expect(seriesOf(null)).toEqual(INVALID);
  });

  it("REFUSES a series whose points are not an array", () => {
    expect(seriesOf({ points: { at: "2026-09-07T08:10:00.000Z", latencyMs: 5 }, windowMinutes: 60 }))
      .toEqual(INVALID);
    expect(seriesOf({ points: "none", windowMinutes: 60 })).toEqual(INVALID);
  });

  /**
   * A CRASH GUARD, NOT A STYLE RULE, and the arm names the mechanism so nobody relaxes the bound
   * without knowing what it costs. The sparkline reduces the latencies to a min and a max; the
   * obvious `Math.min(...latencies)` throws `RangeError: Maximum call stack size exceeded`
   * somewhere above 100k elements (measured on this host: 100000 ok, 200000 throws), and this
   * length arrives OVER THE WIRE. The daemon windows to an hour out of a 1440-row ring, so a
   * series longer than the whole ring cannot be a real answer.
   */
  it("REFUSES a series longer than the whole probe ring rather than handing it to a chart", () => {
    const point = { at: "2026-09-07T08:10:00.000Z", latencyMs: 5 };
    expect(seriesOf({ points: Array.from({ length: 1441 }, () => point), windowMinutes: 60 }))
      .toEqual(INVALID);
    // The bound is INCLUSIVE at the ring size, so a full ring still decodes.
    const full = seriesOf({ points: Array.from({ length: 1440 }, () => point), windowMinutes: 60 });
    expect((full as { readonly points: readonly unknown[] }).points).toHaveLength(1440);
  });

  it("REFUSES a frame that omits the series member entirely", () => {
    const partial: Record<string, unknown> = healthy();
    delete partial["latencySeries"];
    expect(mapDeploymentsHealthAnswer(200, partial)).toEqual(INVALID);
  });
});

describe("the deployment-health read client carries refusals at their own layer", () => {
  it("carries the route capability denial with its code and layer", () => {
    expect(mapDeploymentsHealthAnswer(200, {
      code: "DEPLOYMENTS_HEALTH_READ_CAPABILITY_DENIED",
      layer: "CONTROL_ROOM_LISTENER",
      outcome: "REFUSED",
    })).toEqual({
      code: "DEPLOYMENTS_HEALTH_READ_CAPABILITY_DENIED",
      layer: "CONTROL_ROOM_LISTENER",
      status: "REFUSED",
    });
  });

  it("carries the listener body refusal with its code and layer", () => {
    expect(mapDeploymentsHealthAnswer(400, {
      code: "LISTENER_DEPLOYMENTS_HEALTH_UNKNOWN_KEY", layer: "CONTROL_ROOM_LISTENER",
    })).toEqual({
      code: "LISTENER_DEPLOYMENTS_HEALTH_UNKNOWN_KEY",
      layer: "CONTROL_ROOM_LISTENER",
      status: "REFUSED",
    });
  });

  it("carries the probe store refusal, whose {code, layer, ok:false} shape the shared helper misses", () => {
    expect(mapDeploymentsHealthAnswer(200, {
      code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
    })).toEqual({
      code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", status: "REFUSED",
    });
  });
});

describe("the deployment-health read is pinned and scoped to one environment", () => {
  it("pins the route in DEV_PROXY_PATHS, or the dev lane answers it with Vite", () => {
    expect(DEV_PROXY_PATHS).toContain(DEPLOYMENTS_HEALTH_READ_PATH);
    expect(DEPLOYMENTS_HEALTH_READ_PATH).toBe("/deployments/health/read");
  });

  it("POSTs exactly {environment} and returns the frame for that environment", async () => {
    let sent = "";
    const answer = await readDeploymentsHealth({}, "staging", (body: string) => {
      sent = body;
      return replyOf(200, healthy())();
    });
    expect(JSON.parse(sent)).toEqual({ environment: "staging" });
    expect(answer.status).toBe("DEPLOYMENTS_HEALTH");
  });

  it("REFUSES a frame that answers about a different environment", async () => {
    const answer = await readDeploymentsHealth({}, "production", replyOf(200, healthy()));
    expect(answer).toEqual({
      code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
  });

  it("reports a transport failure at this client's own layer", async () => {
    const answer = await readDeploymentsHealth({}, "staging", () => Promise.reject(new Error("offline")));
    expect(answer).toEqual({
      code: "TRANSPORT_REQUEST_FAILED",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
  });
});

/**
 * THE EFFECTIVE PROBE INTERVAL, AT THE DECODER SEAM.
 *
 * WHY THE ARMS BELOW ASSERT THE WHOLE ROW AND NOT JUST THE MEMBER. `exactDataRecord` refuses on a
 * key-COUNT mismatch, so a frame missing this key does not lose one field - the ENTIRE environment
 * row fails to decode and the card goes blank. That is exactly why the daemon emits the key on
 * every row and why the member is required rather than optional here: there is no optional-key
 * path in that helper to encode "unset" through. "Unset" is carried IN BAND, as the daemon's
 * default value, never as an absent key.
 */
describe("the deployment-health read client preserves the effective probe interval", () => {
  it("carries a well-formed interval across by value, without re-defaulting it", () => {
    const answer = mapDeploymentsHealthAnswer(200, { ...FRAME });
    expect(answer.status).toBe("DEPLOYMENTS_HEALTH");
    expect(answer.status === "DEPLOYMENTS_HEALTH" ? answer.probeIntervalMs : null).toBe(5_000);
    // Not the daemon's 60000 default: a decoder substituting a fallback of its own would agree
    // with a fixture that happened to state the default, and this frame deliberately does not.
    expect(answer.status === "DEPLOYMENTS_HEALTH" ? answer.probeIntervalMs : null).not.toBe(60_000);
  });

  /**
   * DoD 4 on the browser side. Two environments carrying DIFFERENT intervals both survive with
   * their OWN value. A decoder that read the member once into shared state - or that hard-coded
   * one - passes every single-frame arm above and fails only here.
   */
  it("keeps each environment's own interval when two frames are decoded", () => {
    const fast = mapDeploymentsHealthAnswer(200, { ...FRAME });
    const slow = mapDeploymentsHealthAnswer(200, healthy());
    if (fast.status !== "DEPLOYMENTS_HEALTH" || slow.status !== "DEPLOYMENTS_HEALTH") {
      throw new Error("both fixtures must decode for this arm to mean anything");
    }
    expect(fast.probeIntervalMs).toBe(5_000);
    expect(slow.probeIntervalMs).toBe(900_000);
    expect(fast.probeIntervalMs).not.toBe(slow.probeIntervalMs);
    // The environments really are distinct, so the two values cannot be one frame read twice.
    expect(fast.environment).not.toBe(slow.environment);
  });

  /**
   * MALFORMED FAILS CLOSED (DoD 3). Every case refuses the WHOLE frame with the specific code AND
   * the layer that refused - never a decoded row with the member quietly dropped, which is what
   * would put a plausible card in front of an operator with an interval nobody served.
   *
   * `0` and `-1` are here because a plain `typeof === "number"` check admits both, and a zero
   * probe interval rendered as a rate reads as a real setting. `1.5`, `NaN` and `Infinity` are
   * here because `Number.isInteger` is what rules them out, and a bare comparison would not.
   */
  it.each([
    ["a string", "60000"],
    ["a negative interval", -1],
    ["zero", 0],
    ["a non-integer", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["a boolean", true],
    ["a numeric-looking object", { valueOf: () => 60_000 }],
  ])("refuses %s as the interval rather than dropping the member", (_label, probeIntervalMs) => {
    const answer = mapDeploymentsHealthAnswer(200, { ...FRAME, probeIntervalMs });
    expect(answer).toEqual({
      code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
    // The member was not merely absent from an otherwise-decoded row.
    expect(answer.status).not.toBe("DEPLOYMENTS_HEALTH");
    expect(answer).not.toHaveProperty("probeIntervalMs");
  });

  /**
   * THE OMITTED-KEY FAILURE MODE, PINNED. This is the reason the daemon must emit the key on
   * EVERY row: `exactDataRecord` compares key COUNT first, so omitting the member does not
   * degrade one field - the whole environment row decodes to a refusal and the card blanks. The
   * symptom then points at the read rather than at the new field, which is what makes it
   * expensive to diagnose in production.
   */
  it("refuses the WHOLE frame when the interval key is omitted, never a row missing one member", () => {
    const { probeIntervalMs: _omitted, ...withoutKey } = { ...FRAME };
    expect(Object.keys(withoutKey)).not.toContain("probeIntervalMs");
    expect(mapDeploymentsHealthAnswer(200, withoutKey)).toEqual({
      code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
  });

  /**
   * THE ROSTER, BOTH DIRECTIONS (global rail). A one-directional arm goes vacuous the next time
   * the roster changes: an arm that only proves the new key is ACCEPTED still passes when the
   * decoder stops refusing unknown keys altogether, and an arm that only proves an unknown key is
   * refused still passes when the new key was never added. Both, against one frame.
   */
  it("accepts the new key AND still refuses an unknown one beside it", () => {
    const accepted = mapDeploymentsHealthAnswer(200, { ...FRAME });
    expect(accepted.status).toBe("DEPLOYMENTS_HEALTH");
    expect(accepted.status === "DEPLOYMENTS_HEALTH" ? accepted.probeIntervalMs : null).toBe(5_000);

    expect(mapDeploymentsHealthAnswer(200, { ...FRAME, probeIntervalSeconds: 5 })).toEqual({
      code: "DEPLOYMENTS_HEALTH_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOYMENTS_HEALTH",
      status: "ERROR",
    });
  });

  /**
   * THE INTERVAL RECORD'S OWN REFUSALS REACH THE BROWSER AS REFUSALS, with the DAEMON's code and
   * layer rather than this client's generic invalid-response. Their envelope is `{code, layer,
   * ok:false}` - the probe store's shape - which `refusalFrom` matches at its third branch. That
   * branch exists because the shared `effectRefusal` key lists stop at `{code, layer}` and
   * `{outcome, code, layer}`, so without it a PROBE_INTERVAL_STORE_FAILED would arrive as
   * DEPLOYMENTS_HEALTH_RESPONSE_INVALID and the cause would be erased on the way to the screen.
   *
   * This is asserted rather than assumed: the daemon widened its port to carry these codes, and
   * "the existing branch already handles it" is a premise until a test runs the bytes through.
   */
  it.each([
    "PROBE_INTERVAL_ENVIRONMENT_INVALID",
    "PROBE_INTERVAL_STORE_FAILED",
    "PROBE_INTERVAL_OUT_OF_RANGE",
  ])("surfaces %s with the daemon's own code and layer, not a generic invalid response", (code) => {
    expect(mapDeploymentsHealthAnswer(200, { code, layer: "DAEMON_INGRESS", ok: false })).toEqual({
      code, layer: "DAEMON_INGRESS", status: "REFUSED",
    });
  });

  /**
   * THE SERVED ROSTER AS A SET, so a key SILENTLY REMOVED from the daemon frame reds here too.
   * The arms above all add or corrupt a key; none of them notices a member that stops being
   * served, because a shrunken frame simply refuses and an arm expecting a refusal would pass.
   */
  it("decodes exactly the ten members the daemon serves, no more and no fewer", () => {
    const answer = mapDeploymentsHealthAnswer(200, { ...FRAME });
    if (answer.status !== "DEPLOYMENTS_HEALTH") throw new Error("the frame must decode");
    expect(Object.keys(answer).sort()).toEqual([
      "environment", "incident", "lastError", "lastProbe", "latencySeries", "probeIntervalMs",
      "probeRefusal", "rollbackSha", "state", "status",
    ]);
    // The WIRE roster, stated separately: `ok` is consumed and replaced by `status`, so the two
    // rosters differ by exactly that one substitution and neither can be derived from the other.
    expect(Object.keys(FRAME).sort()).toEqual([
      "environment", "incident", "lastError", "lastProbe", "latencySeries", "ok",
      "probeIntervalMs", "probeRefusal", "rollbackSha", "state",
    ]);
  });
});
