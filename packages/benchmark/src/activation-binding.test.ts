import { grantHumanAuthority } from "@moe/core";
import type { HumanAuthorityGate, HumanAuthorityGrant } from "@moe/core";
import { describe, expect, it } from "vitest";

import {
  ACTIVATION_GENERATION_KEYS,
  GA_ACTIVATION_BINDING_CODES,
  GA_ACTIVATION_BINDING_LAYER,
  GA_ACTIVATION_WORK_REF,
  GO_ACTIVATE_GATE_ID,
  admitActivationBinding,
} from "./activation-binding.js";

const GRANTED_AT = 1_756_000_000_000;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);

/**
 * The valid gate is MINTED THROUGH THE PUBLISHED MINTER, never hand-written: a literal grant
 * would be this suite's own idea of what core accepts, and would keep passing after core
 * tightened. Every hostile variant below is a ONE-FIELD edit of this gate.
 */
function validGate(): HumanAuthorityGate {
  const minted = grantHumanAuthority(
    { gateId: GO_ACTIVATE_GATE_ID, grant: null, workRef: GA_ACTIVATION_WORK_REF },
    { kind: "HUMAN", principalId: "operator-yaron" },
    GRANTED_AT,
  );
  if (!minted.ok) throw new Error(`fixture gate did not mint: ${minted.code}`);
  return minted.gate;
}

function grantOf(gate: HumanAuthorityGate): HumanAuthorityGrant {
  const grant = gate.grant;
  if (grant === null) throw new Error("fixture gate carries no grant");
  return grant;
}

function withGrant(gate: HumanAuthorityGate, patch: Partial<HumanAuthorityGrant>) {
  return { ...gate, grant: { ...grantOf(gate), ...patch } };
}

function validRecord(): Record<string, unknown> {
  return {
    authority: validGate(),
    decision: "GO_ACTIVATE",
    generations: {
      backupGenerationDigest: DIGEST, distributionManifestSha256: "b".repeat(64),
      importGenerationSha256: "c".repeat(64), quiesceRecordSha256: "d".repeat(64),
    },
    sourceCommit: COMMIT,
  };
}

const observed = new Set<string>();

function refusal(record: unknown): { code: string; layer: string } {
  const result = admitActivationBinding(record);
  if (result.ok) throw new Error("expected a refusal, got an admitted binding");
  observed.add(result.code);
  return { code: result.code, layer: result.layer };
}

describe("task-09008b4c admitActivationBinding refuses closed", () => {
  it("refuses an absent record", () => {
    const expected = { code: "ACTIVATION_BINDING_ABSENT", layer: GA_ACTIVATION_BINDING_LAYER };
    expect(refusal(null)).toEqual(expected);
    expect(refusal(undefined)).toEqual(expected);
  });

  it("refuses a non-object, a missing key and an extra key with SHAPE_INVALID", () => {
    const expected = {
      code: "ACTIVATION_BINDING_SHAPE_INVALID", layer: GA_ACTIVATION_BINDING_LAYER,
    };
    expect(refusal("GO_ACTIVATE")).toEqual(expected);
    const missing = validRecord();
    delete missing["sourceCommit"];
    expect(refusal(missing)).toEqual(expected);
    // A `policy` key is the specific extra this shape exists to make unrepresentable: the
    // function takes ONE argument, so no caller can hand it a PROCEED_WITHOUT_HUMAN policy.
    expect(refusal({ ...validRecord(), policy: { kind: "PROCEED_WITHOUT_HUMAN", delayMs: 0 } }))
      .toEqual(expected);
  });

  it("refuses GO_QUIESCE with DECISION_MISMATCH, so GO_ACTIVATE is a distinct decision", () => {
    // DoD-2. The record is valid in every other respect and carries the real human grant.
    expect(refusal({ ...validRecord(), decision: "GO_QUIESCE" })).toEqual({
      code: "ACTIVATION_BINDING_DECISION_MISMATCH", layer: GA_ACTIVATION_BINDING_LAYER,
    });
  });

  it("refuses a gate bound to another gate or another row with WORK_MISMATCH", () => {
    const expected = { code: "ACTIVATION_BINDING_WORK_MISMATCH", layer: GA_ACTIVATION_BINDING_LAYER };
    const otherGate = { ...validGate(), gateId: "GO_QUIESCE" };
    expect(refusal({ ...validRecord(), authority: otherGate })).toEqual(expected);
    const otherRow = { ...validGate(), workRef: "task-ffffffffffffffffffffffffffffffff" };
    expect(refusal({ ...validRecord(), authority: otherRow })).toEqual(expected);
  });

  it("passes core's human-authority refusal through UNCHANGED, layer and code", () => {
    // The verdict is core's: this module calls decideApprovalAuthority and never re-decides.
    const gate = validGate();
    expect(refusal({ ...validRecord(), authority: { ...gate, grant: null } })).toEqual({
      code: "APPROVAL_HUMAN_AUTHORITY_REQUIRED", layer: "HUMAN_AUTHORITY_GATE",
    });
    expect(refusal({ ...validRecord(), authority: withGrant(gate, { principalKind: "AGENT" }) }))
      .toEqual({ code: "APPROVAL_PRINCIPAL_NOT_HUMAN", layer: "HUMAN_AUTHORITY_GATE" });
    expect(refusal({
      ...validRecord(),
      authority: withGrant(gate, { workRef: "task-b254847909ca4199a70a3a06173f1cd9" }),
    })).toEqual({ code: "APPROVAL_AUTHORITY_BINDING_MISMATCH", layer: "HUMAN_AUTHORITY_GATE" });
    expect(refusal({ ...validRecord(), authority: withGrant(gate, { grantedAtEpochMs: -1 }) }))
      .toEqual({ code: "APPROVAL_GRANT_MOMENT_INVALID", layer: "HUMAN_AUTHORITY_GATE" });
  });

  it("refuses every unbound generation shape with GENERATION_UNBOUND", () => {
    const expected = {
      code: "ACTIVATION_BINDING_GENERATION_UNBOUND", layer: GA_ACTIVATION_BINDING_LAYER,
    };
    for (const key of ACTIVATION_GENERATION_KEYS) {
      const record = validRecord();
      const generations = { ...record["generations"] as Record<string, string>, [key]: "" };
      expect(refusal({ ...record, generations })).toEqual(expected);
      expect(refusal({ ...record, generations: { ...generations, [key]: "not-hex" } }))
        .toEqual(expected);
      expect(refusal({ ...record, generations: { ...generations, [key]: DIGEST.toUpperCase() } }))
        .toEqual(expected);
    }
    expect(refusal({ ...validRecord(), sourceCommit: COMMIT.slice(0, 39) })).toEqual(expected);
    expect(refusal({ ...validRecord(), sourceCommit: COMMIT.toUpperCase() })).toEqual(expected);
  });

  it("refuses TODAY'S standing authorization: a real human grant over empty generations", () => {
    // This is the shape the board actually holds right now. It must never be admitted, because
    // a standing authorization names no quiesce, import, backup or distribution generation.
    const standing = {
      ...validRecord(),
      generations: Object.fromEntries(ACTIVATION_GENERATION_KEYS.map((key) => [key, ""])),
    };
    expect(refusal(standing)).toEqual({
      code: "ACTIVATION_BINDING_GENERATION_UNBOUND", layer: GA_ACTIVATION_BINDING_LAYER,
    });
  });
});

describe("task-09008b4c admitActivationBinding admits only the fully bound record", () => {
  it("admits the valid record and returns a frozen binding equal to its input", () => {
    const record = validRecord();
    const result = admitActivationBinding(record);
    if (!result.ok) throw new Error(`expected admission, got ${result.code}`);
    expect(result.binding).toEqual(record);
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.isFrozen(result.binding.generations)).toBe(true);
  });

  it("publishes exactly 5 codes and every one of them is reachable", () => {
    // Bidirectional: a code no arm produces is dead vocabulary, and an arm producing a code
    // outside the tuple means the roster is not the module's real answer set.
    expect(GA_ACTIVATION_BINDING_CODES).toHaveLength(5);
    const own = [...observed].filter((code) => code.startsWith("ACTIVATION_BINDING_"));
    expect(own.sort()).toEqual([...GA_ACTIVATION_BINDING_CODES].sort());
    expect([...GA_ACTIVATION_BINDING_CODES].filter((code) => !observed.has(code))).toEqual([]);
  });
});
