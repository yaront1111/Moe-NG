import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { SqliteEventStore } from "@moe/store";

import {
  V2_READINESS_EVIDENCE_FILENAMES,
  V2_READINESS_EVIDENCE_KINDS,
  writeV2ReadinessManifest,
} from "./v2-readiness-manifest-writer.js";
import type { V2ReadinessEvidenceBytes, V2ReadinessEvidenceKind } from "./v2-readiness-manifest-writer.js";

/**
 * Release tooling: `node apps/daemon/src/cutover/v2-readiness-manifest-writer-main.ts
 *   --store-path=<store.sqlite> --project-id=<id> --store-root=<dir with live-quiesce-evidence.json>
 *   --source-commit=<40-hex> --evidence-root=<dir> [--source-root=<git checkout>]`
 *
 * Run AFTER `cutover.complete_quiesce` and BEFORE `cutover.activate`, against the
 * quiesced store, with the eight evidence files the release produced under
 * `--evidence-root` (names in V2_READINESS_EVIDENCE_FILENAMES). Prints one JSON
 * receipt on stdout and exits 0 only when the production reader answers the
 * written manifest back. When `--source-root` is given, the commit it names must
 * be that checkout's HEAD: the manifest may not claim a commit the release was
 * not built from.
 */

function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((entry) => entry.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function print(value: unknown, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
const storePath = flag(argv, "store-path");
const projectId = flag(argv, "project-id");
const storeRoot = flag(argv, "store-root");
const sourceCommit = flag(argv, "source-commit");
const evidenceRoot = flag(argv, "evidence-root");
const sourceRoot = flag(argv, "source-root");
if (storePath === null || projectId === null || storeRoot === null || sourceCommit === null
  || evidenceRoot === null) {
  print({
    code: "V2_READINESS_WRITER_USAGE", ok: false,
    usage: "--store-path= --project-id= --store-root= --source-commit= --evidence-root= [--source-root=]",
  }, 2);
}

if (sourceRoot !== null) {
  let head = "";
  try {
    head = execFileSync("git", ["-C", resolve(sourceRoot), "rev-parse", "HEAD^{commit}"],
      { encoding: "utf8" }).trim();
  } catch (error) {
    print({ code: "V2_READINESS_WRITER_SOURCE_ROOT_UNREADABLE", detail: String(error), ok: false }, 1);
  }
  if (head !== sourceCommit) {
    print({ code: "V2_READINESS_WRITER_SOURCE_COMMIT_MISMATCH", detail: { head, sourceCommit }, ok: false }, 1);
  }
}

const evidence: Partial<Record<V2ReadinessEvidenceKind, Uint8Array>> = {};
for (const kind of V2_READINESS_EVIDENCE_KINDS) {
  const path = join(resolve(evidenceRoot), V2_READINESS_EVIDENCE_FILENAMES[kind]);
  try {
    evidence[kind] = new Uint8Array(readFileSync(path));
  } catch {
    print({ code: "V2_READINESS_WRITER_EVIDENCE_UNREADABLE", detail: { kind, path }, ok: false }, 1);
  }
}

const store = SqliteEventStore.openForProject(resolve(storePath), projectId);
try {
  const result = writeV2ReadinessManifest({
    clock: () => new Date().toISOString(),
    generation: {
      config: { storeRoot: resolve(storeRoot) },
      readFileText: (path: string) => readFileSync(path, "utf8"),
      store,
    },
    store,
  }, {
    evidence: evidence as V2ReadinessEvidenceBytes,
    projectId,
    sourceCommit,
  });
  store.close();
  print(result, result.ok ? 0 : 1);
} catch (error) {
  store.close();
  print({ code: "V2_READINESS_WRITER_FAILED", detail: error instanceof Error ? error.message : String(error), ok: false }, 1);
}
