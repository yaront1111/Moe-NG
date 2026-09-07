/**
 * THE DEPLOYMENT-HEALTH READ CLIENT, at the decoder seam.
 *
 * The frames below are the shape `projectDeploymentsHealth` in
 * apps/daemon/src/http/deployments-health-read.ts actually serves - exact keys
 * `environment, incident, lastError, lastProbe, ok, probeRefusal, rollbackSha, state` - so a
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
  probeRefusal: null,
  rollbackSha: "b".repeat(40),
  state: "DOWN",
} as const;

const healthy = (): Record<string, unknown> => ({
  environment: "staging", incident: null, lastError: null,
  lastProbe: { at: "2026-09-07T09:04:00.000Z", latencyMs: 88, status: "SUCCESS" },
  latencySeries: { points: [{ at: "2026-09-07T09:04:00.000Z", latencyMs: 88 }], windowMinutes: 60 },
  ok: true, probeRefusal: null, rollbackSha: null, state: "UP",
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
