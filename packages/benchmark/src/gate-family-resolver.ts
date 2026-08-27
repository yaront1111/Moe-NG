import { GATE_FAMILIES } from "./gate-families.js";
import type { GateFamilyId } from "./gate-families.js";

const LAYER = "BENCHMARK_GATE_FAMILY_RESOLVER";
const NONZERO_COUNT_LINE = /^\s*(?:Test Files|Tests)\s+([1-9]\d*)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?\s+\((\d+)\)\s*$/;

export type GateFamilyResolverLayer = typeof LAYER;
export type GateFamilyVerdict = "PASS" | "FAIL" | "UNKNOWN" | "NON_APPLICABLE";

export interface GateFamilyEvidence {
  readonly familyId: string;
  readonly exitCode: number | null;
  readonly countLine: string | null;
  readonly permitReason?: string;
}

export interface GateFamilyVerdictRow {
  readonly familyId: GateFamilyId;
  readonly ok: true;
  readonly permitReason: string | null;
  readonly verdict: GateFamilyVerdict;
}

export type GateFamilyRefusalCode =
  | "GATE_FAMILY_UNKNOWN"
  | "GATE_FAMILY_PERMIT_REASON_MISSING"
  | "GATE_FAMILY_EVIDENCE_DUPLICATE";

export interface GateFamilyRefusal {
  readonly code: GateFamilyRefusalCode;
  readonly familyId: string;
  readonly layer: GateFamilyResolverLayer;
  readonly ok: false;
}

export type GateFamilyResolution = GateFamilyRefusal | GateFamilyVerdictRow;

export interface GateFamilyVerdictTable {
  readonly ok: true;
  readonly verdicts: readonly GateFamilyVerdictRow[];
}

export type GateFamilyTableResolution = GateFamilyRefusal | GateFamilyVerdictTable;

function knownFamilyId(familyId: string): familyId is GateFamilyId {
  return GATE_FAMILIES.some(({ id }) => id === familyId);
}

function refusal(familyId: string, code: GateFamilyRefusalCode): GateFamilyRefusal {
  return Object.freeze({ code, familyId, layer: LAYER, ok: false });
}

function verdict(
  familyId: GateFamilyId,
  value: GateFamilyVerdict,
  permitReason: string | null = null,
): GateFamilyVerdictRow {
  return Object.freeze({ familyId, ok: true, permitReason, verdict: value });
}

function isNonzeroCountLine(countLine: string | null): boolean {
  if (countLine === null) return false;
  const match = NONZERO_COUNT_LINE.exec(countLine);
  if (match === null) return false;
  const passed = Number(match[1]);
  const skipped = Number(match[2] ?? 0);
  const total = Number(match[3]);
  return [passed, skipped, total].every(Number.isSafeInteger)
    && passed + skipped === total;
}

function hasPermitReason(evidence: GateFamilyEvidence): boolean {
  return Object.prototype.hasOwnProperty.call(evidence, "permitReason");
}

/**
 * Interprets only recorded evidence. An exit code is insufficient for PASS, and a
 * permit can classify only a family for which no execution evidence was recorded.
 */
export function resolveFamily(evidence: GateFamilyEvidence): GateFamilyResolution {
  if (!knownFamilyId(evidence.familyId)) {
    return refusal(evidence.familyId, "GATE_FAMILY_UNKNOWN");
  }

  if (evidence.exitCode !== null) {
    if (evidence.exitCode !== 0) return verdict(evidence.familyId, "FAIL");
    return verdict(
      evidence.familyId,
      isNonzeroCountLine(evidence.countLine) ? "PASS" : "UNKNOWN",
    );
  }

  if (evidence.countLine !== null) return verdict(evidence.familyId, "UNKNOWN");
  if (!hasPermitReason(evidence)) return verdict(evidence.familyId, "UNKNOWN");
  if (typeof evidence.permitReason !== "string" || evidence.permitReason.trim() === "") {
    return refusal(evidence.familyId, "GATE_FAMILY_PERMIT_REASON_MISSING");
  }
  return verdict(evidence.familyId, "NON_APPLICABLE", evidence.permitReason);
}

/** Resolves the complete frozen roster, filling every omitted family with UNKNOWN. */
export function resolveAll(
  evidence: readonly GateFamilyEvidence[],
): GateFamilyTableResolution {
  const resolved = new Map<GateFamilyId, GateFamilyVerdictRow>();
  for (const item of evidence) {
    const row = resolveFamily(item);
    if (!row.ok) return row;
    if (resolved.has(row.familyId)) {
      return refusal(row.familyId, "GATE_FAMILY_EVIDENCE_DUPLICATE");
    }
    resolved.set(row.familyId, row);
  }

  const verdicts = GATE_FAMILIES.map(({ id }) => resolved.get(id) ?? verdict(id, "UNKNOWN"));
  return Object.freeze({ ok: true, verdicts: Object.freeze(verdicts) });
}
