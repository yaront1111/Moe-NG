import { afterEach, describe, expect, it } from "vitest";
import { closeStores } from "../review/review-test-fixtures.js";
import { recoveryEvidenceFixture } from "./repository-recovery-test-fixtures.js";
import { readRecoveryLandingEvidence } from "./repository-recovery-evidence.js";

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
  it("refuses legacy verifier history and contradictory landing refusals", () => {
    const old = recoveryEvidenceFixture({ legacy: true }); expect(old.landed().ok).toBe(true);
    expect(readRecoveryLandingEvidence(old.store, old.handle)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_MISSING" });
    const f = recoveryEvidenceFixture(); f.completed();
    expect(f.landed({ commit: null, refusal: { code: "REFUSED", detail: "recorded refusal" } }).ok).toBe(true);
    expect(readRecoveryLandingEvidence(f.store, f.handle)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_CONFLICT" });
  });
});
