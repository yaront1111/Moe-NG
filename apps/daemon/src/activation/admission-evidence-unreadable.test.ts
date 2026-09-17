import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { readHumanApprovalAuthority } from "./human-approval-authority-reader.js";
import type { HumanApprovalAuthorityStore } from "./human-approval-authority-reader.js";
import { readPolicyAdmission } from "./policy-admission-reader.js";

/**
 * A FAULT MUST NOT BE REPORTED AS ITS OPPOSITE.
 *
 * Both admission readers wrapped `store.readEvents` in a bare `} catch {` and answered with an
 * ABSENCE: the policy reader returned `[]`, whose tail refuses ADMISSION_GATE_POLICY_SOURCE_ABSENT
 * ("this project has never had a policy evaluated"), and the approval reader returned null, which
 * becomes ADMISSION_GATE_WITNESS_ABSENT ("no human approved this").
 *
 * Neither is an absence. SQLITE_BUSY after the busy timeout, a corrupt page, a poisoned handle
 * or a closed store all produced an affirmative claim about durable state that the daemon had
 * not read. The operator then re-installs the policy or re-approves through the UI, the write
 * succeeds, the refusal persists because the READ is what is failing, and nothing anywhere
 * names the store fault.
 *
 * Both still fail closed and still confer nothing. Only the NAME changes — which is the
 * distinction admission-gate-resolver.ts already demands of its other codes: "durably
 * distinguishable and must not collapse into one generic code."
 */

const STORE_FAULT = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

const POLICY_INPUT = {
  graphRevisionRef: "graph-revision-1",
  nodeKey: "dev-solo",
  policySliceHash: "slice-1",
  principalId: "operator-local",
  projectId: "project-1",
};

const APPROVAL_INPUT = {
  goalRef: "goal-1",
  graphRevisionRef: "graph-revision-1",
  nodeKey: "dev-solo",
  projectId: "project-1",
};

function throwingEventStore(): SqliteEventStore {
  return { readEvents: (): never => { throw STORE_FAULT; } } as unknown as SqliteEventStore;
}

function approvalStore(
  overrides: Partial<HumanApprovalAuthorityStore>,
): HumanApprovalAuthorityStore {
  return {
    getCommandDecision: () => null,
    getCommandReceipt: () => null,
    readEvents: () => [],
    ...overrides,
  };
}

describe("readPolicyAdmission", () => {
  it("refuses UNREADABLE, not SOURCE_ABSENT, when the event read throws", () => {
    const result = readPolicyAdmission({ ...POLICY_INPUT, store: throwingEventStore() });

    expect(result).toMatchObject({
      code: "ADMISSION_GATE_EVIDENCE_UNREADABLE",
      layer: "DAEMON_ADMISSION_GATE",
      ok: false,
    });
  });

  it("still refuses SOURCE_ABSENT when the store genuinely holds no policy", () => {
    const empty = { readEvents: () => [] } as unknown as SqliteEventStore;

    expect(readPolicyAdmission({ ...POLICY_INPUT, store: empty }))
      .toMatchObject({ code: "ADMISSION_GATE_POLICY_SOURCE_ABSENT", ok: false });
  });

  it("confers no authority when the evidence is unreadable", () => {
    const result = readPolicyAdmission({ ...POLICY_INPUT, store: throwingEventStore() });

    expect(result.ok).toBe(false);
    expect("gate" in result).toBe(false);
  });
});

describe("readHumanApprovalAuthority", () => {
  it("refuses UNREADABLE, not WITNESS_ABSENT, when the event read throws", () => {
    const store = approvalStore({ readEvents: (): never => { throw STORE_FAULT; } });

    expect(readHumanApprovalAuthority({ ...APPROVAL_INPUT, store }))
      .toMatchObject({ code: "ADMISSION_GATE_EVIDENCE_UNREADABLE", ok: false });
  });

  it("still refuses WITNESS_ABSENT when the goal genuinely carries no approval", () => {
    expect(readHumanApprovalAuthority({ ...APPROVAL_INPUT, store: approvalStore({}) }))
      .toMatchObject({ code: "ADMISSION_GATE_WITNESS_ABSENT", ok: false });
  });

  it("confers no approval when the evidence is unreadable", () => {
    const store = approvalStore({ readEvents: (): never => { throw STORE_FAULT; } });
    const result = readHumanApprovalAuthority({ ...APPROVAL_INPUT, store });

    expect(result.ok).toBe(false);
    expect("approval" in result).toBe(false);
  });
});
