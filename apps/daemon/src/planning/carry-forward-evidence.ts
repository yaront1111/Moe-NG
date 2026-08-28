/**
 * Assembles carry evidence only from daemon-readable facts. The signature deliberately has no
 * request, payload, or evidence parameter: a caller must have no channel for supplying its own
 * carry authority. Unread durable facts remain absent rather than becoming invented booleans.
 */
import { CANONICAL_JSON_VERSION } from "@moe/contracts";
import type { CarryForwardInput } from "@moe/core";
import type { GraphRevisionContent } from "@moe/scheduler";

import { hashesByNodeKey } from "./graph-supersede-dispositions.js";

type Authorities = GraphRevisionContent["nodeAuthority"]["authorities"];
export type CarryForwardDurableFact =
  | "dependenciesPresent"
  | "environmentClosureUnchanged"
  | "policySliceUnchanged"
  | "predecessorResultUnchanged";

export type CarryForwardEvidenceFact = keyof CarryForwardInput;
export type CarryForwardEvidenceCode =
  | "CARRY_EVIDENCE_CANONICALIZER_UNSUPPORTED"
  | "CARRY_EVIDENCE_FACT_UNREADABLE";
export interface CarryForwardResolvedFacts {
  readonly canonicalizerVersion: string;
  readonly sourceHash: string | undefined;
  readonly targetHash: string | undefined;
}

export interface CarryForwardEvidenceAccepted {
  readonly evidence: CarryForwardInput;
  readonly ok: true;
}

export interface CarryForwardEvidenceRefused {
  readonly code: CarryForwardEvidenceCode;
  readonly layer: "CARRY_EVIDENCE_ASSEMBLER";
  readonly missingFacts: readonly CarryForwardEvidenceFact[];
  readonly ok: false;
  readonly resolvedFacts: CarryForwardResolvedFacts;
}

export type CarryForwardEvidenceOutcome =
  | CarryForwardEvidenceAccepted
  | CarryForwardEvidenceRefused;

export interface CarryForwardDurableFacts {
  readonly dependenciesPresent: boolean | undefined;
  readonly environmentClosureUnchanged: boolean | undefined;
  readonly policySliceUnchanged: boolean | undefined;
  readonly predecessorResultUnchanged: boolean | undefined;
}

type CompleteResolvedFacts = Pick<
  CarryForwardInput, "canonicalizerVersion" | "sourceHash" | "targetHash"
>;

const LAYER = "CARRY_EVIDENCE_ASSEMBLER" as const;
const DURABLE_FACT_KEYS = Object.freeze([
  "dependenciesPresent",
  "environmentClosureUnchanged",
  "policySliceUnchanged",
  "predecessorResultUnchanged",
] as const);

const UNREADABLE_DURABLE_FACTS = Object.freeze({
  /** Requires a durable dependency-presence record for this predecessor and successor. */
  dependenciesPresent: undefined,
  /** Requires a durable environment-closure digest for both revisions. */
  environmentClosureUnchanged: undefined,
  /** Requires per-node policy-slice hashes bound to the predecessor and successor. */
  policySliceUnchanged: undefined,
  /** Requires a durable predecessor verification result bound to this node. */
  predecessorResultUnchanged: undefined,
} satisfies CarryForwardDurableFacts);

/** Diagnostic-only classifier; it cannot assemble evidence or grant carry authority. */
export function missingCarryForwardFacts(
  facts: CarryForwardDurableFacts,
): readonly CarryForwardDurableFact[] {
  return Object.freeze(DURABLE_FACT_KEYS.filter((key) => typeof facts[key] !== "boolean"));
}

function completeEvidence(
  resolved: CompleteResolvedFacts, facts: CarryForwardDurableFacts,
): CarryForwardInput | null {
  const { dependenciesPresent, environmentClosureUnchanged,
    policySliceUnchanged, predecessorResultUnchanged } = facts;
  if (typeof dependenciesPresent !== "boolean"
    || typeof environmentClosureUnchanged !== "boolean"
    || typeof policySliceUnchanged !== "boolean"
    || typeof predecessorResultUnchanged !== "boolean") return null;
  return Object.freeze({
    ...resolved, dependenciesPresent, environmentClosureUnchanged,
    policySliceUnchanged, predecessorResultUnchanged,
  });
}

function refuse(
  code: CarryForwardEvidenceCode,
  missingFacts: readonly CarryForwardEvidenceFact[],
  resolvedFacts: CarryForwardResolvedFacts,
): CarryForwardEvidenceRefused {
  return Object.freeze({
    code, layer: LAYER, missingFacts: Object.freeze([...missingFacts]), ok: false,
    resolvedFacts: Object.freeze({ ...resolvedFacts }),
  });
}

export function assembleCarryForwardEvidence(
  predecessor: Authorities,
  successor: Authorities,
  nodeKey: string,
  supportedCanonicalizerVersions: readonly string[],
): CarryForwardEvidenceOutcome {
  const sourceHash = hashesByNodeKey(predecessor).get(nodeKey);
  const targetHash = hashesByNodeKey(successor).get(nodeKey);
  const resolvedFacts = Object.freeze({
    canonicalizerVersion: CANONICAL_JSON_VERSION, sourceHash, targetHash,
  });
  if (!supportedCanonicalizerVersions.includes(CANONICAL_JSON_VERSION)) {
    return refuse(
      "CARRY_EVIDENCE_CANONICALIZER_UNSUPPORTED", ["canonicalizerVersion"], resolvedFacts,
    );
  }
  const missing = [
    ...(sourceHash === undefined ? ["sourceHash" as const] : []),
    ...(targetHash === undefined ? ["targetHash" as const] : []),
    ...missingCarryForwardFacts(UNREADABLE_DURABLE_FACTS),
  ];
  if (missing.length > 0 || sourceHash === undefined || targetHash === undefined) {
    return refuse("CARRY_EVIDENCE_FACT_UNREADABLE", missing, resolvedFacts);
  }
  const evidence = completeEvidence(
    { canonicalizerVersion: CANONICAL_JSON_VERSION, sourceHash, targetHash },
    UNREADABLE_DURABLE_FACTS,
  );
  return evidence === null
    ? refuse("CARRY_EVIDENCE_FACT_UNREADABLE", missing, resolvedFacts)
    : Object.freeze({ evidence, ok: true });
}
