import { describe, expect, it } from "vitest";
import { createProjectReviewDrainPort, decodeProjectReviewDrainFrame } from "./project-review-drain.js";

describe("trusted project review drain admission", () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])("refuses invalid controller identity %s before observer launch", async (controllerPid) => {
    expect(await createProjectReviewDrainPort().drain({ controllerPid, notStartedAfter: new Date().toISOString(), workspace: "C:\\project" }))
      .toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH" });
  });
  it("refuses a malformed seat boundary before observer launch", async () => {
    expect(await createProjectReviewDrainPort().drain({ controllerPid: 1, notStartedAfter: "not-a-time", workspace: "C:\\project" }))
      .toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH" });
  });
});

const input = { controllerPid: 44, notStartedAfter: "2026-09-14T09:00:00.000Z" };
const evidence = { controllerPid: 44, controllerStartedAt: "2026-09-14T08:00:00.000Z", brokerPid: 22,
  brokerStartedAt: "2026-09-14T07:59:58.000Z", cliPid: 11, daemonPid: 33, observedAt: "2026-09-14T10:00:00.000Z", jobEmpty: true };
describe("drain observer result contract", () => {
  it("accepts exact bound positive observations", () => {
    expect(decodeProjectReviewDrainFrame({ ok: true, evidence }, input)).toEqual({ ok: true, evidence });
  });
  it.each(["RUNTIME_REVIEW_DRAIN_ACCESS_DENIED", "RUNTIME_REVIEW_DRAIN_UNPROVEN", "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH"])("preserves stable refusal %s", (code) => {
    expect(decodeProjectReviewDrainFrame({ ok: false, code }, input)).toMatchObject({ ok: false, code });
  });
  it.each([null, {}, { ok: true, evidence: { ...evidence, jobEmpty: false } }, { ok: true, evidence: { ...evidence, controllerPid: 45 } },
    { ok: true, evidence: { ...evidence, controllerStartedAt: "2026-09-14T09:00:01.000Z" } },
    { ok: true, evidence: { ...evidence, daemonPid: 44 } }, { ok: true, evidence: { ...evidence, brokerStartedAt: evidence.observedAt } },
    { ok: true, evidence: { ...evidence, observedAt: "wrong" } }, { ok: true, evidence, fabricated: true },
    { ok: false, code: "UNTRUSTED", detail: "secret" }])("refuses incomplete or contradictory observer frame %#", (value) => {
    expect(decodeProjectReviewDrainFrame(value, input)).toBeNull();
  });
});
