import { existsSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

import {
  buildSourceManifest, decodeLegacySources, refuseImport,
} from "../../packages/import/src/index.js";
import type { ImportEventRefused, ImportRefused } from "../../packages/import/src/index.js";
import { SqliteEventStore } from "../../packages/store/src/sqlite-event-store.js";
import { DurableStoreError, MAX_EVENTS_PER_COMMIT } from "../../packages/store/src/store-contracts.js";
import { DURABLE_COMMIT_LAYER, commitLegacyImport } from "./durable-import-store.js";
import type { DurableCommitRefused } from "./durable-import-store.js";

/**
 * `import-commit` — the durable producer of the legacy import.
 *
 * It composes buildSourceManifest -> decodeLegacySources -> applyImport over a COPIED
 * snapshot of a legacy project, commits the draft through `durable-import-store.ts` into
 * an operator-named `SqliteEventStore`, and prints one JSON report. It is the only
 * production path that writes a `legacy.<kind>.imported` row anywhere.
 *
 * Its sibling `import-shadow.ts` stays read-only by rail and is untouched by this file:
 * the comparator there still never sees an authority-bearing store, and nothing here
 * reads, imports or changes it.
 *
 * IT CREATES NO STORE. The named database must already exist; opening a missing path
 * would create it, and an import that invents its own empty ledger has written authority
 * nobody named. That check is the first thing this tool does after argv.
 *
 * The deep relative specifiers are the tools/ convention `import-shadow.ts` documents:
 * pnpm-workspace.yaml globs only apps/*, adapters/* and packages/*, and both this file and
 * `durable-import-store.ts` are named explicitly in the root `typecheck:import` script,
 * which is why the deep imports are typechecked and do not trip TS6059.
 */

export const USAGE =
  "usage: import-commit <copied-snapshot-root> --store <existing-store.db> --project <projectId>";

/** The legacy task fields this version understands; anything else reconciles as unknown. */
const KNOWN_FIELDS: readonly string[] = Object.freeze(["dependsOn", "held", "owner", "parent"]);

export interface Options {
  readonly project: string;
  readonly root: string;
  readonly store: string;
}

/** argv is untrusted: an operand it does not fully understand refuses rather than defaults. */
export function parseOptions(args: readonly string[]): ImportRefused | Options {
  const root = args[0];
  if (root === undefined || root.startsWith("--") || args.length !== 5) {
    return refuseImport("IMPORT_ROOT_INVALID", "INPUT", USAGE);
  }
  const flags = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") || flags.has(flag)) {
      return refuseImport("IMPORT_ROOT_INVALID", "INPUT", USAGE);
    }
    flags.set(flag, value);
  }
  const project = flags.get("--project");
  const store = flags.get("--store");
  if (project === undefined || store === undefined) {
    return refuseImport("IMPORT_ROOT_INVALID", "INPUT", USAGE);
  }
  return { project, root, store };
}

/** Every refusal shape this tool can answer with: each carries a code, a detail and a layer. */
function refusedText(refused: DurableCommitRefused | ImportEventRefused | ImportRefused): string {
  return `${JSON.stringify({
    code: refused.code,
    detail: refused.detail,
    layer: refused.layer,
    outcome: "REFUSED",
  })}\n`;
}

/**
 * Opens the operator-named store, or refuses with the store's own code.
 *
 * `openForProject` rather than `open`: a handle opened without a project asserts no
 * project scope, and the store then refuses every durable effect committed through it.
 */
function openStore(options: Options): DurableCommitRefused | ImportRefused | SqliteEventStore {
  try {
    return SqliteEventStore.openForProject(options.store, options.project);
  } catch (cause) {
    if (cause instanceof DurableStoreError) {
      return Object.freeze({
        code: cause.code,
        detail: cause.message,
        layer: DURABLE_COMMIT_LAYER,
        outcome: "REFUSED" as const,
      });
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImport("IMPORT_SOURCE_UNREADABLE", "INPUT", `${options.store}: ${detail}`);
  }
}

/** Composes the whole durable pass and returns the report text plus the process exit code. */
export function runImportCommit(
  args: readonly string[],
): { readonly code: number; readonly text: string } {
  const options = parseOptions(args);
  if ("outcome" in options) return { code: 2, text: refusedText(options) };
  if (!existsSync(options.store)) {
    return {
      code: 1,
      text: refusedText(refuseImport(
        "IMPORT_SOURCE_UNREADABLE", "INPUT",
        `no store at ${options.store}; import-commit never creates one`,
      )),
    };
  }
  const manifest = buildSourceManifest(options.root);
  if ("outcome" in manifest) return { code: 1, text: refusedText(manifest) };
  const store = openStore(options);
  if ("outcome" in store) return { code: 1, text: refusedText(store) };
  try {
    const decoded = decodeLegacySources({ manifest, root: options.root });
    const result = commitLegacyImport({
      declaredRecordCount: null,
      knownFields: KNOWN_FIELDS,
      manifest,
      // The store's own hard cap, and the bound `import-shadow.ts` binds to as well, so
      // the advisory run can never accept a snapshot this durable run refuses.
      maxEventsPerCommit: MAX_EVENTS_PER_COMMIT,
      records: decoded.records,
      store,
    });
    if (result.outcome === "REFUSED") return { code: 1, text: refusedText(result) };
    return {
      code: 0,
      text: `${JSON.stringify({
        aggregateId: `legacy-import:${manifest.digest}`,
        committedEvents: result.eventIds.length,
        counts: result.report.counts,
        currentVersion: result.currentVersion,
        decodeRefusals: decoded.refusals.map((item) => ({
          code: item.refusal.code, layer: item.refusal.layer, sourcePath: item.sourcePath,
        })),
        manifestDigest: manifest.digest,
        outcome: result.outcome,
      })}\n`,
    };
  } finally {
    store.close();
  }
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  const result = runImportCommit(argv.slice(2));
  if (result.code === 0) stdout.write(result.text);
  else stderr.write(result.text);
  exit(result.code);
}
