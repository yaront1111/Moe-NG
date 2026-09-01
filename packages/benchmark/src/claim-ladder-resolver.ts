import { CLAIM_LADDER } from "./claim-ladder-contract.js";
import type { ClaimLadderLayer, ReachedRung } from "./claim-ladder-contract.js";

const LAYER: ClaimLadderLayer = "BENCHMARK_CLAIM_LADDER";

export type ClaimGateVerdict = "FAIL" | "PASS" | "UNKNOWN";

export interface ClaimRungReached {
  readonly ok: true;
  readonly rung: ReachedRung;
}

export interface ClaimLadderGateRefusal {
  readonly code: "CLAIM_LADDER_GATE_UNKNOWN";
  readonly gateId: string;
  readonly layer: ClaimLadderLayer;
  readonly ok: false;
}

export type ClaimLadderResolution = ClaimLadderGateRefusal | ClaimRungReached;

function knownGateIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const rung of CLAIM_LADDER) {
    ids.add(rung.gateId);
    for (const subGateId of rung.subGateIds) ids.add(subGateId);
  }
  return ids;
}

function gateRefusal(gateId: string): ClaimLadderGateRefusal {
  return Object.freeze({
    code: "CLAIM_LADDER_GATE_UNKNOWN",
    gateId,
    layer: LAYER,
    ok: false,
  });
}

function rungPasses(
  verdicts: Readonly<Record<string, ClaimGateVerdict>>,
  gateIds: readonly string[],
): boolean {
  for (const gateId of gateIds) {
    if (verdicts[gateId] !== "PASS") return false;
  }
  return true;
}

/**
 * Resolves only evidence named by the pinned roster. Absence and UNKNOWN both stop
 * authority at the last all-PASS rung; neither is upgraded into PASS.
 */
export function resolveReachedRung(
  verdicts: Readonly<Record<string, ClaimGateVerdict>>,
): ClaimLadderResolution {
  const known = knownGateIds();
  for (const gateId of Object.keys(verdicts)) {
    if (!known.has(gateId)) return gateRefusal(gateId);
  }

  let reached: ReachedRung = "L0";
  for (const rung of CLAIM_LADDER) {
    if (!rungPasses(verdicts, [rung.gateId, ...rung.subGateIds])) break;
    reached = rung.rungId;
  }
  return Object.freeze({ ok: true, rung: reached });
}
