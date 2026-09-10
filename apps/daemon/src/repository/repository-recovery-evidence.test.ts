import { afterEach, describe, expect, it } from "vitest";
import { closeStores } from "../review/review-test-fixtures.js";
import { recoveryEvidenceFixture } from "./repository-recovery-test-fixtures.js";
import { readRecoveryLandingEvidence, readRecoveryNoEffectEvidence } from "./repository-recovery-evidence.js";

afterEach(closeStores);
describe("repository recovery evidence joins", () => {
  it("accepts a durable COMMITTED receipt only with its accepted exact verifier and original baseline", () => {
    const f = recoveryEvidenceFixture(); expect(f.landed().ok).toBe(true);
    expect(readRecoveryLandingEvidence(f.store, f.handle)).toMatchObject({ ok: true, evidence: { commit: f.commit, binding: f.binding, needsLandingReceipt: false,
      proof: { kind: "LANDING_RECEIPT" } } });
    expect(readRecoveryLandingEvidence(f.store, { ...f.handle, reservation: { ...f.handle.reservation, baselineId: "foreign-baseline" } })).toMatchObject({ ok: false });
  });
  it("can reconcile a completed exact commit whose landing receipt was never persisted", () => {
    const f = recoveryEvidenceFixture(); f.completed();
    const blocked = { ...f.handle, reservation: { ...f.handle.reservation, phase: "BLOCKED" as const } };
    expect(readRecoveryLandingEvidence(f.store, blocked)).toMatchObject({ ok: true, evidence: { commit: f.commit, needsLandingReceipt: true,
      proof: { kind: "LANDING_COMPLETION" } } });
    expect(readRecoveryLandingEvidence(f.store, { ...blocked, owner: { ...blocked.owner, ownershipToken: "f".repeat(64) } }))
      .toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN" });
  });
  it("holds ambiguous intent-only and historical BLOCKED owners even when a direct PID is absent", () => {
    const f = recoveryEvidenceFixture(); f.completed(false);
    const blocked = { ...f.handle, reservation: { ...f.handle.reservation, phase: "BLOCKED" as const, pid: null } };
    expect(readRecoveryLandingEvidence(f.store, blocked)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN" });
    expect(f.landed().ok).toBe(true);
    expect(readRecoveryLandingEvidence(f.store, blocked)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN" });
  });
  // DoD 4, first direction: the wedge this row exists for. No commit, no completion, no intent —
  // and therefore nothing to reconcile, so the reservation is offered a release.
  it("offers a release for a BLOCKED reservation whose refusal journaled no intent", () => {
    const f = recoveryEvidenceFixture();
    expect(f.landed({ commit: null, refusal: { code: "NOTHING_TO_COMMIT",
      detail: "no path in the workspace differs from the staffing baseline" } }).ok).toBe(true);
    const blocked = { ...f.handle, reservation: { ...f.handle.reservation, phase: "BLOCKED" as const } };
    expect(readRecoveryLandingEvidence(f.store, blocked)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN" });
    expect(readRecoveryNoEffectEvidence(f.store, blocked)).toMatchObject({ ok: true, evidence: {
      refusalCode: "NOTHING_TO_COMMIT", proof: { kind: "LANDING_REFUSED_NO_EFFECT" } } });
  });
  // DoD 4, second direction, without which the first is vacuous: an intent exists, so Git may have
  // run, and the reservation stays contained however the refusal was worded.
  it("still answers CONTAINMENT_UNKNOWN when the refusal followed a journaled intent", () => {
    const f = recoveryEvidenceFixture(); f.completed(false);
    expect(f.landed({ commit: null, refusal: { code: "GIT_COMMIT_FAILED", detail: "pre-commit hook refused" } }).ok).toBe(true);
    const blocked = { ...f.handle, reservation: { ...f.handle.reservation, phase: "BLOCKED" as const } };
    expect(readRecoveryNoEffectEvidence(f.store, blocked)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN" });
    expect(readRecoveryLandingEvidence(f.store, blocked)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN" });
  });
  it("never admits a committed landing through the no-effect release", () => {
    const f = recoveryEvidenceFixture(); expect(f.landed().ok).toBe(true);
    const blocked = { ...f.handle, reservation: { ...f.handle.reservation, phase: "BLOCKED" as const } };
    expect(readRecoveryNoEffectEvidence(f.store, blocked)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_CONFLICT" });
  });
  it("refuses legacy verifier history and contradictory landing refusals", () => {
    const old = recoveryEvidenceFixture({ legacy: true }); expect(old.landed().ok).toBe(true);
    expect(readRecoveryLandingEvidence(old.store, old.handle)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_MISSING" });
    const f = recoveryEvidenceFixture(); f.completed();
    expect(f.landed({ commit: null, refusal: { code: "REFUSED", detail: "recorded refusal" } }).ok).toBe(true);
    expect(readRecoveryLandingEvidence(f.store, f.handle)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_CONFLICT" });
  });
});
