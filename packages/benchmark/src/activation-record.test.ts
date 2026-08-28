import { grantHumanAuthority } from "@moe/core";
import type { HumanAuthorityGate } from "@moe/core";
import { describe, expect, it } from "vitest";

import {
  GA_ACTIVATION_WORK_REF,
  GO_ACTIVATE_GATE_ID,
} from "./activation-binding.js";
import {
  GA_ACTIVATION_RECORD_LAYER,
  GA_ACTIVATION_RECORD_SCHEMA_VERSION,
  composeActivationRecord,
} from "./activation-record.js";
import { PINNED_SPEC_SHA256 } from "./claim-ladder-contract.js";
import type { ClaimGateVerdict } from "./claim-ladder-resolver.js";
import { GATE_FAMILIES } from "./gate-families.js";
import type { GateFamilyEvidence } from "./gate-family-resolver.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const GRANTED_AT = 1_756_000_000_000;

/** Every rung gate recorded UNKNOWN: the campaign shape the board actually holds today. */
const ALL_UNKNOWN: Readonly<Record<string, ClaimGateVerdict>> = Object.freeze({
  "G-L1": "UNKNOWN", "G-L2": "UNKNOWN", "G-L3": "UNKNOWN", "G-L4": "UNKNOWN",
  "G-L5": "UNKNOWN",
});

function validGate(): HumanAuthorityGate {
  const minted = grantHumanAuthority(
    { gateId: GO_ACTIVATE_GATE_ID, grant: null, workRef: GA_ACTIVATION_WORK_REF },
    { kind: "HUMAN", principalId: "operator-yaron" },
    GRANTED_AT,
  );
  if (!minted.ok) throw new Error(`fixture gate did not mint: ${minted.code}`);
  return minted.gate;
}

function validBinding(): Record<string, unknown> {
  return {
    authority: validGate(),
    decision: "GO_ACTIVATE",
    generations: {
      backupGenerationDigest: "a".repeat(64), distributionManifestSha256: "b".repeat(64),
      importGenerationSha256: "c".repeat(64), quiesceRecordSha256: "d".repeat(64),
    },
    sourceCommit: COMMIT,
  };
}

function input(patch: Record<string, unknown> = {}) {
  return {
    binding: null,
    campaignVerdicts: ALL_UNKNOWN,
    claimSentences: [] as readonly string[],
    familyEvidence: [] as readonly GateFamilyEvidence[],
    pinnedSpecSha256: PINNED_SPEC_SHA256,
    scopeNotEstablished: ["independent-review has no repository command"] as readonly string[],
    sourceCommit: COMMIT,
    ...patch,
  };
}

function composed(patch: Record<string, unknown> = {}) {
  const result = composeActivationRecord(input(patch));
  if (!result.ok) throw new Error(`expected a record, got ${result.code}`);
  return result.record;
}

function refusal(patch: Record<string, unknown>): Record<string, unknown> {
  const result = composeActivationRecord(input(patch));
  if (result.ok) throw new Error("expected a refusal, got a record");
  return { ...result };
}

describe("task-09008b4c composeActivationRecord reports NOT_ACTIVATED honestly", () => {
  it("carries the binding refusal verbatim and never claims activation", () => {
    const record = composed();
    expect(record.schemaVersion).toBe(GA_ACTIVATION_RECORD_SCHEMA_VERSION);
    expect(record.activationRow).toBe(GA_ACTIVATION_WORK_REF);
    expect(record.reachedRung).toBe("L0");
    expect(record.activation).toEqual({
      refusal: { code: "ACTIVATION_BINDING_ABSENT", layer: "GA_ACTIVATION_BINDING" },
      status: "NOT_ACTIVATED",
    });
    expect(record.gateFamilies.map((row) => row.familyId)).toEqual(GATE_FAMILIES.map((f) => f.id));
    expect(record.gateFamilies).toHaveLength(10);
    expect(record.gateFamilies.every((row) => row.verdict === "UNKNOWN")).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("reports BINDING_ADMITTED_ACT_PENDING and CANNOT emit an ACTIVE status", () => {
    const record = composed({ binding: validBinding() });
    // The act belongs to the successor row's tooling. This composer has no vocabulary for it:
    // there is no "ACTIVE" status and no first-authoritative-command field to carry one.
    expect(Object.keys(record.activation).sort()).toEqual(["binding", "status"]);
    expect(record.activation.status).toBe("BINDING_ADMITTED_ACT_PENDING");
    expect(JSON.stringify(record)).not.toContain("\"ACTIVE\"");
  });
});

describe("task-09008b4c composeActivationRecord refuses closed", () => {
  it("refuses a claim the reached rung does not permit, naming the permit code", () => {
    expect(refusal({ claimSentences: ["Moe v2 is ready."] })).toEqual({
      code: "ACTIVATION_RECORD_CLAIM_REFUSED",
      layer: GA_ACTIVATION_RECORD_LAYER,
      ok: false,
      permitCode: "CLAIM_NOT_PERMITTED_AT_RUNG",
      sentence: "Moe v2 is ready.",
    });
  });

  it("refuses a permanently forbidden claim with its own permit code", () => {
    const sentence = "Rebuilt Moe is cheaper than legacy.";
    expect(refusal({ claimSentences: [sentence] })).toEqual({
      code: "ACTIVATION_RECORD_CLAIM_REFUSED",
      layer: GA_ACTIVATION_RECORD_LAYER,
      ok: false,
      permitCode: "CLAIM_PERMANENTLY_FORBIDDEN",
      sentence,
    });
  });

  it("refuses a source commit that is not 40 lowercase hex", () => {
    const expected = {
      code: "ACTIVATION_RECORD_SOURCE_COMMIT_INVALID", layer: GA_ACTIVATION_RECORD_LAYER,
      ok: false,
    };
    expect(refusal({ sourceCommit: COMMIT.slice(0, 39) })).toEqual(expected);
    expect(refusal({ sourceCommit: COMMIT.toUpperCase() })).toEqual(expected);
  });

  it("refuses a pinned spec digest that is not the transcribed one", () => {
    expect(refusal({ pinnedSpecSha256: "f".repeat(64) })).toEqual({
      code: "ACTIVATION_RECORD_SPEC_MISMATCH", layer: GA_ACTIVATION_RECORD_LAYER, ok: false,
    });
  });
});

describe("task-09008b4c composeActivationRecord derives, never copies", () => {
  it("passes a duplicate-family refusal through with the resolver's own code and layer", () => {
    const twice: readonly GateFamilyEvidence[] = [
      { countLine: null, exitCode: 0, familyId: "property" },
      { countLine: null, exitCode: 0, familyId: "property" },
    ];
    expect(refusal({ familyEvidence: twice })).toEqual({
      code: "GATE_FAMILY_EVIDENCE_DUPLICATE",
      familyId: "property",
      layer: "BENCHMARK_GATE_FAMILY_RESOLVER",
      ok: false,
    });
  });

  it("passes an unknown campaign gate through with the ladder's own code and layer", () => {
    expect(refusal({ campaignVerdicts: { "G-L9": "PASS" } })).toEqual({
      code: "CLAIM_LADDER_GATE_UNKNOWN",
      gateId: "G-L9",
      layer: "BENCHMARK_CLAIM_LADDER",
      ok: false,
    });
  });

  it("records exit 0 with no count line as UNKNOWN, because exit codes do not prove execution",
    () => {
      const evidence: readonly GateFamilyEvidence[] = [
        { countLine: null, exitCode: 0, familyId: "property" },
        { countLine: "Test Files  3 passed (3)", exitCode: 0, familyId: "fault" },
      ];
      const record = composed({ familyEvidence: evidence });
      const verdictOf = (id: string) =>
        record.gateFamilies.find((row) => row.familyId === id)?.verdict;
      expect(verdictOf("property")).toBe("UNKNOWN");
      expect(verdictOf("fault")).toBe("PASS");
      expect(verdictOf("independent-review")).toBe("UNKNOWN");
    });
});
