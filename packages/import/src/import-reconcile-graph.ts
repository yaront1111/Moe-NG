import { byCodeUnit } from "./canonical-bytes.js";
import type { LegacySourceRecord } from "./import-canonical.js";
import { AMBIGUITY_OUTCOME } from "./import-contract.js";
import type { AmbiguityClass, ImportProvenance, ReconciliationFinding } from "./import-contract.js";
// TYPE-ONLY, and deliberately so: `import type` is erased, so this leaves no runtime edge
// back to the module that calls graphFindings. `ReconcileEntry` describes the whole
// reconciliation input, not the graph, so it stays where the rest of that vocabulary lives.
import type { ReconcileEntry } from "./import-reconcile.js";

/**
 * The `dependsOn` graph walk (design §21.6: dangling refs and cycles).
 *
 * Extracted from import-reconcile.ts so the walk has room to be written without recursion.
 * It carries its own `finding` factory rather than importing one, matching what
 * import-skill-assets.ts and import-duplicate-identity.ts already do — a value import from
 * the caller would be a genuine runtime cycle.
 */
function finding(
  ambiguityClass: AmbiguityClass,
  provenance: ImportProvenance,
  detail: string,
): ReconciliationFinding {
  return Object.freeze({ ambiguityClass, detail, outcome: AMBIGUITY_OUTCOME, provenance });
}

function dependsOn(record: LegacySourceRecord): readonly string[] {
  const declared = record.payload["dependsOn"];
  if (!Array.isArray(declared)) return [];
  return declared.filter((value): value is string => typeof value === "string");
}

/**
 * One suspended node. `nextIndex` is what makes the explicit stack equivalent to the
 * recursion it replaces: a parent that descends into a child is left on the stack with its
 * index already advanced, so it RESUMES at its next ref when the child's whole subtree is
 * finished. A stack of plain node ids cannot express that, and would emit a parent's later
 * findings before its earlier child's.
 */
interface WalkFrame {
  readonly entry: ReconcileEntry | undefined;
  readonly legacyId: string;
  nextIndex: number;
  readonly refs: readonly string[];
}

/**
 * Depth-first cycle detection over a graph walked in sorted order, so output is stable.
 *
 * DEPTH-INDEPENDENT BY CONSTRUCTION. The traversal keeps its own heap-allocated stack
 * rather than one call frame per link, so a legacy project with an arbitrarily long
 * `dependsOn` chain is reconciled instead of surfacing as `RangeError: Maximum call stack
 * size exceeded`. There is no depth bound to exceed, so no legitimately deep import is
 * refused, and nothing here catches a RangeError — catching one would leave the walk's
 * partial state unknowable and turn a crash into a silently incomplete finding set.
 */
export function graphFindings(entries: readonly ReconcileEntry[]): readonly ReconciliationFinding[] {
  const byId = new Map<string, ReconcileEntry>();
  for (const entry of entries) {
    if (!byId.has(entry.record.legacyId)) byId.set(entry.record.legacyId, entry);
  }
  const found: ReconciliationFinding[] = [];
  const state = new Map<string, "DONE" | "OPEN">();
  const reported = new Set<string>();

  /** Marks OPEN on entry, exactly where the recursive form did. */
  const openFrame = (legacyId: string): WalkFrame => {
    state.set(legacyId, "OPEN");
    const entry = byId.get(legacyId);
    return {
      entry,
      legacyId,
      nextIndex: 0,
      refs: entry === undefined ? [] : [...dependsOn(entry.record)].sort(byCodeUnit),
    };
  };

  const walk = (rootId: string): void => {
    const stack: WalkFrame[] = [openFrame(rootId)];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) return;
      const { entry, legacyId } = frame;
      if (frame.nextIndex >= frame.refs.length) {
        // POST-ORDER. DONE means "subtree finished", and OPEN is the only thing separating
        // a back-edge (CYCLE, reported) from a cross-edge (already finished, skipped), so
        // marking it any earlier deletes cycle findings.
        state.set(legacyId, "DONE");
        stack.pop();
        continue;
      }
      const ref = frame.refs[frame.nextIndex];
      frame.nextIndex += 1;
      if (ref === undefined) continue;
      const target = byId.get(ref);
      if (target === undefined) {
        if (entry !== undefined && !reported.has(`${legacyId}->${ref}`)) {
          reported.add(`${legacyId}->${ref}`);
          found.push(finding(
            "DANGLING_REF",
            entry.provenance,
            `record ${legacyId} depends on ${ref}, which was not imported`,
          ));
        }
        continue;
      }
      const seen = state.get(ref);
      if (seen === "OPEN") {
        if (entry !== undefined && !reported.has(`cycle:${ref}`)) {
          reported.add(`cycle:${ref}`);
          found.push(finding(
            "CYCLE",
            entry.provenance,
            `record ${legacyId} closes a dependsOn cycle back to ${ref}`,
          ));
        }
        continue;
      }
      if (seen === undefined) stack.push(openFrame(ref));
    }
  };

  for (const legacyId of [...byId.keys()].sort(byCodeUnit)) {
    if (!state.has(legacyId)) walk(legacyId);
  }
  return found;
}
