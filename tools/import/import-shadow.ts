import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

import {
  applyImport,
  buildSourceManifest,
  compareShadowProjections,
  decodeLegacySources,
  deriveProvenance,
  projectLegacyImport,
  refuseImport,
  reconcileImport,
} from "../../packages/import/src/index.js";
import type {
  ApplyImportResult,
  ImportEventRefused,
  ImportRefused,
  ImportStorePort,
  LegacySourceRecord,
  ReconcileEntry,
  SourceManifest,
} from "../../packages/import/src/index.js";
import { MAX_EVENTS_PER_COMMIT } from "../../packages/store/src/store-contracts.js";
import { parseOptions, readCurrent } from "./shadow-input.js";

/**
 * `import-shadow` — the read-only production consumer of @moe/import.
 *
 * It composes buildSourceManifest -> decodeLegacySources -> reconcileImport -> shadow
 * comparison over a COPIED snapshot of a legacy project and prints one JSON report.
 *
 * IT WRITES NOTHING. There is no write call in this file: no open-for-write, no rename,
 * no mkdir, no chmod, and nothing is written back to the snapshot. Read-only is asserted
 * on BYTES rather than promised here — every manifest-covered file's digest, size and
 * mtime are captured before the run and re-checked after it, so even an accidental
 * write-mode open that leaves content identical fails the run.
 *
 * IT ACTIVATES NOTHING. `applyImport` is composed only to derive claims and links through
 * production code rather than restating that derivation here, and the port it receives
 * DISCARDS everything: no database, no file, no socket, no handle of any kind. Per the
 * task rail the comparator never sees an authority-bearing store, and no command is
 * emitted anywhere in this file.
 *
 * The deep relative specifier is forced: pnpm-workspace.yaml globs only apps/*,
 * adapters/* and packages/*, so `tools/` is not a workspace package and a bare
 * `@moe/import` cannot resolve. `tools/packaging/distribution-build.ts` is the precedent,
 * and the root `typecheck:import` script names this file explicitly, which is why the
 * deep import does not trip TS6059.
 */

/** The legacy task fields this version understands; anything else reconciles as unknown. */
const KNOWN_FIELDS: readonly string[] = Object.freeze(["dependsOn", "held", "owner", "parent"]);

/** Only the fields the CLI reports, so two runs over identical bytes print identically. */
interface SourceFacts {
  readonly digest: string;
  readonly mtimeMs: number;
  readonly path: string;
  readonly size: number;
}

/**
 * Re-reads every manifest-covered file and records what the filesystem says about it.
 *
 * Digest AND mtime AND size, for EVERY entry rather than a sample: a write that restores
 * identical content still moves mtime, and a digest-only check would call that untouched.
 */
function observeSources(root: string, manifest: SourceManifest): ImportRefused | SourceFacts[] {
  const facts: SourceFacts[] = [];
  for (const entry of manifest.entries) {
    const full = join(root, ...entry.path.split("/"));
    try {
      const stat = statSync(full);
      const bytes = readFileSync(full);
      facts.push({
        digest: createHash("sha256").update(bytes).digest("hex"),
        mtimeMs: stat.mtimeMs,
        path: entry.path,
        size: bytes.byteLength,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return refuseImport("IMPORT_SOURCE_UNREADABLE", "MANIFEST", `${entry.path}: ${detail}`);
    }
  }
  return facts;
}

/** Every difference between two observations, so the failure names the file it saw move. */
function driftBetween(before: readonly SourceFacts[], after: readonly SourceFacts[]): string[] {
  const drift: string[] = [];
  const seen = new Map(after.map((fact) => [fact.path, fact]));
  for (const fact of before) {
    const now = seen.get(fact.path);
    if (now === undefined) {
      drift.push(`${fact.path} disappeared during the run`);
      continue;
    }
    if (now.digest !== fact.digest) drift.push(`${fact.path} changed content`);
    if (now.mtimeMs !== fact.mtimeMs) drift.push(`${fact.path} changed mtime`);
    if (now.size !== fact.size) drift.push(`${fact.path} changed size`);
  }
  if (after.length !== before.length) drift.push("the covered file count changed during the run");
  return drift;
}

/** The port that proves nothing durable happens: it keeps no state and returns a version. */
const DISCARDING_STORE: ImportStorePort = Object.freeze({
  commit: () => ({ currentVersion: 0 }),
});

function entriesFor(
  manifest: SourceManifest,
  records: readonly LegacySourceRecord[],
): ImportRefused | ReconcileEntry[] {
  const entries: ReconcileEntry[] = [];
  for (const record of records) {
    const provenance = deriveProvenance(manifest, record);
    if ("outcome" in provenance) return provenance;
    entries.push({ provenance, record });
  }
  return entries;
}

/**
 * Derives claims and links through PRODUCTION `applyImport` rather than restating that
 * derivation here — a second copy of it in a tool is exactly how a shadow report starts
 * disagreeing with the importer it is supposed to shadow.
 *
 * The store discards, so this composes the derivation without anything durable happening.
 * `maxEventsPerCommit` is the store's own MAX_EVENTS_PER_COMMIT — the same bound
 * `import-commit.ts` passes to the durable run: any looser value here would let this tool
 * accept a snapshot the real importer would refuse, and the shadow must not be more
 * permissive than the thing it shadows. The constant is plain data out of
 * store-contracts.ts; no store, and no other store code, is imported with it.
 */
function applyShadowImport(
  manifest: SourceManifest,
  records: readonly LegacySourceRecord[],
): ApplyImportResult {
  return applyImport({
    declaredRecordCount: null,
    knownFields: KNOWN_FIELDS,
    manifest,
    maxEventsPerCommit: MAX_EVENTS_PER_COMMIT,
    records,
    store: DISCARDING_STORE,
  });
}

/** Either refusal shape: both carry a code, a detail and the layer that answered. */
function refusedReport(refused: ImportEventRefused | ImportRefused): string {
  return `${JSON.stringify({
    code: refused.code,
    detail: refused.detail,
    layer: refused.layer,
    outcome: "REFUSED",
  })}\n`;
}

/** Runs the whole read-only pass and returns the report text plus the process exit code. */
export function runImportShadow(args: readonly string[]): { readonly code: number; readonly text: string } {
  const options = parseOptions(args);
  if ("outcome" in options) return { code: 2, text: refusedReport(options) };
  const manifest = buildSourceManifest(options.root);
  if ("outcome" in manifest) return { code: 1, text: refusedReport(manifest) };
  const before = observeSources(options.root, manifest);
  if ("outcome" in before) return { code: 1, text: refusedReport(before) };
  const current = readCurrent(options.currentPath);
  if ("outcome" in current) return { code: 1, text: refusedReport(current) };

  const decoded = decodeLegacySources({ manifest, root: options.root });
  const entries = entriesFor(manifest, decoded.records);
  if ("outcome" in entries) return { code: 1, text: refusedReport(entries) };
  const reconciled = reconcileImport({
    declaredRecordCount: null,
    entries,
    knownFields: KNOWN_FIELDS,
    sourcePaths: manifest.entries.map((entry) => entry.path),
  });
  const imported = applyShadowImport(manifest, decoded.records);
  if ("outcome" in imported) return { code: 1, text: refusedReport(imported) };
  const comparison = compareShadowProjections(
    projectLegacyImport({ claims: imported.claims, links: imported.links }),
    current,
  );

  const after = observeSources(options.root, manifest);
  if ("outcome" in after) return { code: 1, text: refusedReport(after) };
  const drift = driftBetween(before, after);
  if (drift.length > 0) {
    return {
      code: 1,
      text: refusedReport(refuseImport("IMPORT_SOURCE_DIGEST_MISMATCH", "MANIFEST", drift.join("; "))),
    };
  }
  return {
    code: 0,
    text: `${JSON.stringify({
      counts: {
        decodeRefusals: decoded.refusals.length,
        mismatches: comparison.mismatches.length,
        reconciliations: reconciled.findings.length,
        records: decoded.records.length,
        shadowRefusals: comparison.refusals.length,
        sourceFiles: manifest.entries.length,
        verifiedFiles: after.length,
      },
      decodeRefusals: decoded.refusals.map((item) => ({
        code: item.refusal.code,
        layer: item.refusal.layer,
        sourcePath: item.sourcePath,
      })),
      manifestDigest: manifest.digest,
      mismatches: comparison.mismatches.map((item) => ({
        disposition: item.disposition,
        entityId: item.entityId,
        entityKind: item.entityKind,
        field: item.field,
        mismatchKind: item.mismatchKind,
      })),
      outcome: "COMPLETED",
      reconciliations: reconciled.findings.map((item) => ({
        ambiguityClass: item.ambiguityClass,
        sourcePath: item.provenance.sourcePath,
      })),
      shadowRefusals: comparison.refusals.map((item) => ({ code: item.code, layer: item.layer })),
      shadowVersion: comparison.version,
      sourceIntegrity: { files: after.length, verified: true },
    })}\n`,
  };
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  const result = runImportShadow(argv.slice(2));
  if (result.code === 0) stdout.write(result.text);
  else stderr.write(result.text);
  exit(result.code);
}
