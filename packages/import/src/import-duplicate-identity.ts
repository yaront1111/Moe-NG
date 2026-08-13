import { canonicalJson } from "./canonical-bytes.js";
import { canonicalPayload } from "./import-canonical.js";
import { AMBIGUITY_OUTCOME } from "./import-contract.js";
import type { ReconciliationFinding } from "./import-contract.js";
import type { ReconcileEntry } from "./import-reconcile.js";

/**
 * The derived-identity guard (see DERIVED_IDENTITY_AMBIGUITY_CLASSES in the contract).
 *
 * `deriveImportedId` digests (kind, legacyId, sourcePath) plus the manifest and version,
 * so every record sharing that tuple derives the SAME imported id. Byte-identical
 * duplicates collapse losslessly, but DIFFERENT payloads under one tuple would silently
 * last-writer-win — precisely the guess §21.6 forbids — so the collapse is reported here
 * instead. Split out of import-reconcile.ts only for the file-size rail; it is invoked
 * from `reconcileImport` and has no other caller.
 */

/** Payload equality is the module's own canonical text, never a structural guess. */
function canonicalOrNull(entry: ReconcileEntry): string | null {
  const canonical = canonicalPayload(entry.record);
  // An uncanonicalisable payload is already reported as CORRUPT_BYTES and carries no
  // event, so it cannot collide with anything and is not compared here.
  return typeof canonical === "string" ? canonical : null;
}

export function duplicateIdentityFindings(
  entries: readonly ReconcileEntry[],
): readonly ReconciliationFinding[] {
  const seen = new Map<string, string>();
  const reported = new Set<string>();
  const found: ReconciliationFinding[] = [];
  for (const entry of entries) {
    const canonical = canonicalOrNull(entry);
    if (canonical === null) continue;
    // A canonical RECORD key rather than a joined string — the same collision reasoning
    // as deriveImportedId: kind "a" + id "b:c" and kind "a:b" + id "c" must not share it.
    const key = canonicalJson({
      kind: entry.record.kind,
      legacyId: entry.record.legacyId,
      sourcePath: entry.record.sourcePath,
    });
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, canonical);
      continue;
    }
    // One finding per identity tuple: every conflicting duplicate collapses onto the same
    // imported id, so repeating the identical finding would add noise, not information.
    if (first === canonical || reported.has(key)) continue;
    reported.add(key);
    found.push(Object.freeze({
      ambiguityClass: "DUPLICATE_IDENTITY" as const,
      detail: `record ${entry.record.legacyId} appears more than once in `
        + `${entry.record.sourcePath} with conflicting payloads; all would import onto one id`,
      outcome: AMBIGUITY_OUTCOME,
      provenance: entry.provenance,
    }));
  }
  return found;
}
