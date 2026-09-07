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
  ok: true,
  probeRefusal: null,
  rollbackSha: "b".repeat(40),
  state: "DOWN",
} as const;

const healthy = (): Record<string, unknown> => ({
  environment: "staging", incident: null, lastError: null,
  lastProbe: { at: "2026-09-07T09:04:00.000Z", latencyMs: 88, status: "SUCCESS" },
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
