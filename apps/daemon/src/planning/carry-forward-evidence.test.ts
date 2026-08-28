import { CANONICAL_JSON_VERSION } from "@moe/contracts";
import type { GraphRevisionContent } from "@moe/scheduler";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as evidenceModule from "./carry-forward-evidence.js";
import {
  deriveSupersessionDispositions,
  diagnoseCarryUnavailability,
} from "./graph-supersede-dispositions.js";

type Authorities = GraphRevisionContent["nodeAuthority"]["authorities"];
type Outcome = ReturnType<typeof evidenceModule.assembleCarryForwardEvidence>;

const LAYER = "CARRY_EVIDENCE_ASSEMBLER";
const UNREADABLE = "CARRY_EVIDENCE_FACT_UNREADABLE";
const UNSUPPORTED = "CARRY_EVIDENCE_CANONICALIZER_UNSUPPORTED";
const NODE_KEY = "node-a";
const SOURCE_HASH = "a".repeat(64);
const TARGET_HASH = "b".repeat(64);
const OTHER_SOURCE_HASH = "c".repeat(64);
const MISSING_DURABLE_FACTS = [
  "dependenciesPresent",
  "environmentClosureUnchanged",
  "policySliceUnchanged",
  "predecessorResultUnchanged",
] as const;

function authorities(hash: string): Authorities {
  return Object.freeze([{ nodeAuthorityHash: hash, nodeKey: NODE_KEY }]);
}

function assemble(
  sourceHash = SOURCE_HASH,
  supportedVersions: readonly string[] = [CANONICAL_JSON_VERSION],
): Outcome {
  return evidenceModule.assembleCarryForwardEvidence(
    authorities(sourceHash), authorities(TARGET_HASH), NODE_KEY, supportedVersions,
  );
}

function refused(outcome: Outcome): Extract<Outcome, { readonly ok: false }> {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected carry evidence assembly to refuse");
  return outcome;
}

function expectUnreadable(outcome: Outcome) {
  const result = refused(outcome);
  expect({ code: result.code, layer: result.layer }).toEqual({
    code: UNREADABLE,
    layer: LAYER,
  });
  return result;
}

describe("assembleCarryForwardEvidence", () => {
  it("refuses the exact four facts without a durable source", () => {
    const result = expectUnreadable(assemble());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.missingFacts)).toBe(true);
    expect(Object.isFrozen(result.resolvedFacts)).toBe(true);
    expect([...result.missingFacts].sort()).toEqual([...MISSING_DURABLE_FACTS]);
    expect(result.missingFacts).toHaveLength(4);
  });

  it("reads all three reachable facts from server-owned inputs", () => {
    const result = expectUnreadable(assemble());
    const dispositions = deriveSupersessionDispositions(
      authorities(SOURCE_HASH), authorities(TARGET_HASH),
    );
    expect(dispositions).not.toBeNull();
    const disposition = dispositions?.[0];
    expect(disposition).toBeDefined();

    const reachable = [
      ["canonicalizerVersion", CANONICAL_JSON_VERSION],
      ["sourceHash", disposition?.predecessorAuthorityHash],
      ["targetHash", disposition?.successorAuthorityHash],
    ] as const;
    expect(reachable).toHaveLength(3);
    for (const [fact, expected] of reachable) {
      expect(result.resolvedFacts[fact]).toBe(expected);
    }
  });

  it("exports no caller evidence channel", () => {
    expectTypeOf<Parameters<typeof evidenceModule.assembleCarryForwardEvidence>>()
      .toEqualTypeOf<[
        predecessor: Authorities,
        successor: Authorities,
        nodeKey: string,
        supportedCanonicalizerVersions: readonly string[],
      ]>();
    expect(Object.keys(evidenceModule).sort()).toEqual(["assembleCarryForwardEvidence"]);
  });

  it("binds sourceHash to the selected predecessor revision", () => {
    const first = expectUnreadable(assemble(SOURCE_HASH));
    const second = expectUnreadable(assemble(OTHER_SOURCE_HASH));

    expect(first.resolvedFacts.sourceHash).toBe(SOURCE_HASH);
    expect(second.resolvedFacts.sourceHash).toBe(OTHER_SOURCE_HASH);
    expect(second.resolvedFacts.sourceHash).not.toBe(first.resolvedFacts.sourceHash);
  });

  it("refuses a stale server canonicalizer version distinctly", () => {
    const result = refused(assemble(SOURCE_HASH, ["moe-canonical-json/stale"]));

    expect({ code: result.code, layer: result.layer }).toEqual({
      code: UNSUPPORTED,
      layer: LAYER,
    });
    expect(result.missingFacts).toEqual(["canonicalizerVersion"]);
    expect(result.missingFacts).toHaveLength(1);
  });

  it("exposes the refusal roster through the graph diagnostic consumer", () => {
    const missingFacts = diagnoseCarryUnavailability(
      authorities(SOURCE_HASH), authorities(TARGET_HASH), NODE_KEY, [CANONICAL_JSON_VERSION],
    );

    expect([...missingFacts].sort()).toEqual([...MISSING_DURABLE_FACTS]);
    expect(missingFacts).toHaveLength(4);
  });
});
