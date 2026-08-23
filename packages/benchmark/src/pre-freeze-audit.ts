import {
  type PreFreezeAuditRefusal, type PreFreezeAuditVerdict, preFreezeAuditVerdict,
} from "./pre-freeze-audit-vocabulary.js";
import { type GateInventoryReport, auditGateInventory } from "./pre-freeze-gate-audit.js";
import { isPinnedDocument, readPinnedBenchmarkSpec, readPinnedRebuildDesign } from "./pre-freeze-pinned-documents.js";
import { type ReferenceAuditReport, auditReferences } from "./pre-freeze-reference-audit.js";
import type { PinnedSource } from "./pre-freeze-source-reader.js";
import { type ThresholdAuditReport, auditThresholds } from "./pre-freeze-threshold-audit.js";

/**
 * THE PRE-FREEZE AUDIT ENTRY POINT — spec Section 12.1, run end to end.
 *
 * "Before a campaign is frozen, an automated audit MUST PASS (a failing audit blocks
 * freeze; it is not a judgment call)." This composes the three halves that implement it:
 * the reference lint over both pinned documents, the rung/gate inventory with three-valued
 * handling, and the threshold, comparator and CI-tail checks.
 *
 * IT AUDITS. IT DOES NOT FREEZE. Nothing here creates or reads corpus bytes, admits a
 * freeze manifest, verifies a signature, names a custodian, executes a campaign, scores an
 * arm or decides a claim. A passing audit is a NECESSARY condition for a freeze and never
 * a sufficient one — the confirmatory freeze authority is still unassigned, and
 * `readConfirmatoryFreezeAuthority` refuses unconditionally regardless of what this says.
 *
 * REFUSALS ARE UNIONED, NOT COLLAPSED. Each half keeps its own code and its own source
 * location, so a blocked freeze tells its reader which of the six 12.1 items failed and at
 * which line — the difference between a gate someone can clear and a gate someone argues
 * with.
 */

export type PreFreezeAuditSources = {
  readonly benchmark: PinnedSource;
  readonly design: PinnedSource;
};

export type PreFreezeAuditReport = PreFreezeAuditVerdict & {
  readonly gateInventory: GateInventoryReport | null;
  readonly references: ReferenceAuditReport | null;
  readonly thresholds: ThresholdAuditReport | null;
};

/** The pure form: every input already hash-verified, no path and no filesystem. */
export const auditPreFreezeSources = (sources: PreFreezeAuditSources): PreFreezeAuditReport => {
  const references = auditReferences(sources);
  const gateInventory = auditGateInventory(sources.benchmark);
  const thresholds = auditThresholds(sources.benchmark);
  const parts = [references, gateInventory, thresholds];
  return Object.freeze({
    ...preFreezeAuditVerdict(
      parts.reduce((sum, part) => sum + part.generatedCases, 0),
      parts.flatMap((part) => [...part.refusals]),
    ),
    gateInventory, references, thresholds,
  });
};

/**
 * Reads both pinned documents and audits them. A document that cannot be read, or whose
 * bytes have moved off their pin, comes back as a refusal with zero generated cases — an
 * audit that could not run is never an audit that passed.
 */
export const runPreFreezeAudit = (): PreFreezeAuditReport => {
  const benchmark = readPinnedBenchmarkSpec();
  const design = readPinnedRebuildDesign();
  const unreadable: PreFreezeAuditRefusal[] = [
    ...(isPinnedDocument(benchmark) ? [] : [benchmark]),
    ...(isPinnedDocument(design) ? [] : [design]),
  ];
  if (!isPinnedDocument(benchmark) || !isPinnedDocument(design)) {
    return Object.freeze({
      ...preFreezeAuditVerdict(0, unreadable),
      gateInventory: null, references: null, thresholds: null,
    });
  }
  return auditPreFreezeSources({ benchmark: benchmark.source, design: design.source });
};
