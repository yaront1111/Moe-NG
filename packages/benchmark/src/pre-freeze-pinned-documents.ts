import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type PreFreezeAuditRefusal, preFreezeAuditRefusal,
} from "./pre-freeze-audit-vocabulary.js";
import {
  PINNED_BENCHMARK_SPEC_SHA256, PINNED_REBUILD_DESIGN_SHA256, type PinnedSource,
  isPinnedSource, readPinnedSource,
} from "./pre-freeze-source-reader.js";

/**
 * THE THIN CALLER: the only place in this package that touches a filesystem path.
 *
 * The pre-freeze audit itself is pure — it takes bytes and a digest. That is deliberate,
 * and it leaves exactly one job here: turn "the pinned benchmark spec" into bytes. Keeping
 * that job in its own file is what lets every audit module stay testable without a host
 * layout. The source root is an explicit environment input: silently guessing a developer's
 * checkout would make the same audit read different evidence on different hosts.
 *
 * IT REFUSES; IT NEVER SKIPS. An unreadable document comes back as SPEC_UNPARSEABLE at
 * `PRE_FREEZE_AUDIT` and a document whose bytes have moved comes back as
 * SPEC_BYTES_UNPINNED. Neither is an absence a caller may treat as "nothing to check":
 * under epic rail 4 unverifiable evidence stays refused and never gains authority, and a
 * freeze gate that quietly passed when it could not read its input would be worse than no
 * gate at all.
 */

/** Required root of the pinned, read-only documents. No host-layout fallback exists. */
export const PINNED_DOCUMENT_ROOT_ENV = "MOE_PINNED_DOCUMENT_ROOT";

export const PINNED_BENCHMARK_SPEC_RELATIVE_PATH =
  "docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md";
export const PINNED_REBUILD_DESIGN_RELATIVE_PATH =
  "docs/plans/2026-08-05-moe-rebuild-design.md";

/** Verified bytes plus the parsed source, so a caller can re-hash without re-reading. */
export type PinnedDocument = {
  readonly bytes: Uint8Array;
  readonly path: string;
  readonly source: PinnedSource;
};

export const isPinnedDocument = (
  value: PinnedDocument | PreFreezeAuditRefusal,
): value is PinnedDocument => !("code" in value);

const pinnedDocumentRoot = (): string | null => {
  const configured = process.env[PINNED_DOCUMENT_ROOT_ENV]?.trim();
  return configured === undefined || configured.length === 0 ? null : configured;
};

const readPinnedDocument = (
  relativePath: string,
  expectedSha256: string,
): PinnedDocument | PreFreezeAuditRefusal => {
  const root = pinnedDocumentRoot();
  if (root === null) {
    return preFreezeAuditRefusal("SPEC_UNPARSEABLE", 0, PINNED_DOCUMENT_ROOT_ENV);
  }
  const path = join(root, ...relativePath.split("/"));
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return preFreezeAuditRefusal("SPEC_UNPARSEABLE", 0, path);
  }
  const source = readPinnedSource(bytes, expectedSha256);
  if (!isPinnedSource(source)) return source;
  return Object.freeze({ bytes, path, source });
};

export const readPinnedBenchmarkSpec = (): PinnedDocument | PreFreezeAuditRefusal =>
  readPinnedDocument(PINNED_BENCHMARK_SPEC_RELATIVE_PATH, PINNED_BENCHMARK_SPEC_SHA256);

export const readPinnedRebuildDesign = (): PinnedDocument | PreFreezeAuditRefusal =>
  readPinnedDocument(PINNED_REBUILD_DESIGN_RELATIVE_PATH, PINNED_REBUILD_DESIGN_SHA256);
