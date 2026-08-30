import { describe, expect, it } from "vitest";

import {
  BUDGET_COMMITMENT_INVALID_RESPONSE_CODE, BUDGET_COMMITMENT_READ_PATH,
  BUDGET_COMMITMENT_TRANSPORT_FAILED_CODE, LIVE_BUDGET_COMMITMENT_LAYER,
  mapBudgetCommitmentAnswer, readBudgetCommitment,
} from "./live-budget-commitment.js";

/**
 * task-952564b3: the Control Room's reader for task-80b6bf7c's
 * `/budget/commitment/read`.
 *
 * Most arms drive the PURE mapper, because a transport-level test with a stubbed
 * `post` cannot distinguish "mapped the refusal correctly" from "the stub handed
 * the object back unchanged". The transport arms below exist only to prove the
 * three things the mapper cannot see: a throw, an unreadable body, and that the
 * status and body reach the mapper at all.
 */

const REF = "ab".repeat(32);

function response(status: number, body: unknown): Response {
  return {
    json: (): Promise<unknown> => Promise.resolve(body),
    status,
  } as unknown as Response;
}

describe("mapBudgetCommitmentAnswer", () => {
  it("maps an exact COMMITMENT frame at 200 to the ref", () => {
    expect(mapBudgetCommitmentAnswer(200, { outcome: "COMMITMENT", ref: REF }))
      .toStrictEqual({ ref: REF, status: "COMMITMENT" });
  });

  it("rejects a COMMITMENT frame carrying an EXTRA key rather than reading past it", () => {
    // The daemon route enforces an exact key set on the way IN; abandoning that
    // discipline on the way OUT would let a renamed or added field ride through
    // unvouched, which is precisely what exactDataRecord exists to stop.
    expect(mapBudgetCommitmentAnswer(200, { extra: 1, outcome: "COMMITMENT", ref: REF }))
      .toStrictEqual({
        code: BUDGET_COMMITMENT_INVALID_RESPONSE_CODE,
        layer: LIVE_BUDGET_COMMITMENT_LAYER,
        status: "ERROR",
      });
  });

  it("rejects a COMMITMENT frame whose ref is not a non-empty string", () => {
    expect(mapBudgetCommitmentAnswer(200, { outcome: "COMMITMENT", ref: "" }))
      .toStrictEqual({
        code: BUDGET_COMMITMENT_INVALID_RESPONSE_CODE,
        layer: LIVE_BUDGET_COMMITMENT_LAYER,
        status: "ERROR",
      });
  });

  /**
   * DoD 3's named minimum. DIVERGENCE from its two siblings below: this frame is
   * the RUN BINDING's own refusal, reachable only from a run that exists but is
   * not finalized — the prerequisite arm's run does not exist at all, and the
   * route-local arm never reaches the derivation. One input, one possible code.
   */
  it("carries the pre-finalization refusal at 200 with BOTH strings intact", () => {
    expect(mapBudgetCommitmentAnswer(200, {
      code: "APPROVAL_AUTHORITY_UNSEALED", layer: "APPROVAL_RUN_BINDING", outcome: "REFUSED",
    })).toStrictEqual({
      code: "APPROVAL_AUTHORITY_UNSEALED", layer: "APPROVAL_RUN_BINDING", status: "REFUSED",
    });
  });

  it("carries the missing-prerequisite refusal at 200 at the DAEMON_PREREQUISITE layer", () => {
    // DIVERGENCE: an absent run never reaches the run-binding check, so
    // APPROVAL_AUTHORITY_UNSEALED cannot be the answer for this input.
    expect(mapBudgetCommitmentAnswer(200, {
      code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE", outcome: "REFUSED",
    })).toStrictEqual({
      code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE", status: "REFUSED",
    });
  });

  it("carries a ROUTE-LOCAL refusal identically to an upstream one", () => {
    // DIVERGENCE: the capability gate runs BEFORE the port is asked, so no
    // durable state is read and neither sibling code is constructible here.
    expect(mapBudgetCommitmentAnswer(200, {
      code: "BUDGET_COMMITMENT_READ_CAPABILITY_DENIED", layer: "BUDGET_COMMITMENT_READ",
      outcome: "REFUSED",
    })).toStrictEqual({
      code: "BUDGET_COMMITMENT_READ_CAPABILITY_DENIED", layer: "BUDGET_COMMITMENT_READ",
      status: "REFUSED",
    });
  });

  /**
   * THE ORDERING ARM. A listener refusal arrives at a NON-200, so if the status
   * gate ran first it would be flattened into a generic invalid and the real code
   * would be lost. Mirrors live-planning-run.ts's refusal-before-status rule.
   */
  it.each([
    ["LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID", 400],
    ["LISTENER_BUDGET_COMMITMENT_UNAVAILABLE", 503],
  ])("keeps %s at HTTP %i instead of flattening it", (code, status) => {
    expect(mapBudgetCommitmentAnswer(status, { code, layer: "CONTROL_ROOM_LISTENER" }))
      .toStrictEqual({ code, layer: "CONTROL_ROOM_LISTENER", status: "REFUSED" });
  });

  it("maps a non-refusal non-200 to a visible ERROR, never to success", () => {
    expect(mapBudgetCommitmentAnswer(500, { outcome: "COMMITMENT", ref: REF }))
      .toStrictEqual({
        code: BUDGET_COMMITMENT_INVALID_RESPONSE_CODE,
        layer: LIVE_BUDGET_COMMITMENT_LAYER,
        status: "ERROR",
      });
  });

  it.each([
    ["null", null],
    ["an array", ["outcome", "COMMITMENT"]],
    ["a string", "COMMITMENT"],
    ["an empty object", {}],
  ])("maps %s to a visible ERROR", (_label, body) => {
    expect(mapBudgetCommitmentAnswer(200, body)).toStrictEqual({
      code: BUDGET_COMMITMENT_INVALID_RESPONSE_CODE,
      layer: LIVE_BUDGET_COMMITMENT_LAYER,
      status: "ERROR",
    });
  });
});

describe("readBudgetCommitment", () => {
  it("posts exactly {runId} to the route path and maps what comes back", async () => {
    const sent: string[] = [];
    const outcome = await readBudgetCommitment({}, "run-1", async (body) => {
      sent.push(body);
      return await Promise.resolve(response(200, { outcome: "COMMITMENT", ref: REF }));
    });
    expect(sent).toStrictEqual([JSON.stringify({ runId: "run-1" })]);
    expect(outcome).toStrictEqual({ ref: REF, status: "COMMITMENT" });
  });

  it("maps a THROWN send to the transport-failed code at this reader's layer", async () => {
    const outcome = await readBudgetCommitment({}, "run-1", () => {
      throw new Error("socket closed");
    });
    expect(outcome).toStrictEqual({
      code: BUDGET_COMMITMENT_TRANSPORT_FAILED_CODE,
      layer: LIVE_BUDGET_COMMITMENT_LAYER,
      status: "ERROR",
    });
  });

  it("maps a body that fails .json() to the invalid code", async () => {
    const outcome = await readBudgetCommitment({}, "run-1", async () => await Promise.resolve({
      json: (): Promise<unknown> => Promise.reject(new Error("not json")),
      status: 200,
    } as unknown as Response));
    expect(outcome).toStrictEqual({
      code: BUDGET_COMMITMENT_INVALID_RESPONSE_CODE,
      layer: LIVE_BUDGET_COMMITMENT_LAYER,
      status: "ERROR",
    });
  });

  it("carries the daemon's refusal through the transport unchanged", async () => {
    const outcome = await readBudgetCommitment({}, "run-1", async () => await Promise.resolve(
      response(200, {
        code: "APPROVAL_AUTHORITY_UNSEALED", layer: "APPROVAL_RUN_BINDING", outcome: "REFUSED",
      }),
    ));
    expect(outcome).toStrictEqual({
      code: "APPROVAL_AUTHORITY_UNSEALED", layer: "APPROVAL_RUN_BINDING", status: "REFUSED",
    });
  });

  it("names the parent route's path, spelled to match the landed daemon constant", () => {
    expect(BUDGET_COMMITMENT_READ_PATH).toBe("/budget/commitment/read");
  });
});
