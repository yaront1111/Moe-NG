/**
 * Claude/Codex capability shadow matrix.
 *
 * The matrix compares the two SHIPPED provider surfaces and reports an exact
 * PASS, FAIL or UNKNOWN per capability and platform. It launches nothing: the
 * Codex side is the published observe/probe/render/reconcile API, the Claude
 * side is daemon Foundation CONSTRUCTION plus the durable reader, and EXECUTION
 * portability is UNKNOWN for BOTH providers by design — a valid dispatch writes
 * durable authority and prepares the real launcher, and no production Codex
 * execution call site exists at all.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as runnerRoot from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildShadowMatrix } from "./shadow-matrix-arms.js";
import {
  CAPABILITY_ROSTERS, PLATFORM_CASES, PROVENANCES, PROVIDERS, REASON_VOCABULARIES,
  UNKNOWN_REASONS, VERDICTS, canonicalMatrix, readSourceCommit, sealRow,
} from "./shadow-matrix-cases.js";
import type { ProviderId, ShadowRow } from "./shadow-matrix-cases.js";

const OWNED_SOURCES = ["provider-shadow-matrix.test.ts", "shadow-matrix-arms.ts",
  "shadow-matrix-cases.ts", "tsconfig.json"] as const;

interface StoreSnapshot {
  readonly decisions: number;
  readonly digest: string;
  readonly horizon: string;
  readonly mtimeMs: number;
}

let root = "";
let storePath = "";
let store: SqliteEventStore | null = null;
let closedStore: SqliteEventStore | null = null;
let rows: readonly ShadowRow[] = [];
let sourceCommit = "";
let baseline: StoreSnapshot | null = null;
const armSnapshots: StoreSnapshot[] = [];

/**
 * The main database file AND its write-ahead log: in WAL mode a durable write
 * lands in `-wal` first, so digesting only the main file could read as unchanged
 * while an event was in fact committed. `-shm` is excluded on purpose - it is
 * mutated by plain READS and would make the invariant flaky rather than strict.
 */
function storeBytesDigest(): string {
  const hash = createHash("sha256");
  for (const suffix of ["", "-wal"]) {
    const path = `${storePath}${suffix}`;
    hash.update(suffix).update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
  }
  return hash.digest("hex");
}

function snapshotStore(): StoreSnapshot {
  const open = store;
  if (open === null) throw new Error("scratch store is not open");
  const stat = statSync(storePath);
  return {
    decisions: open.readCommandDecisionsAfter(0n, 100).items.length,
    digest: storeBytesDigest(),
    horizon: open.readEventHorizon().toString(),
    mtimeMs: stat.mtimeMs,
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "moe-shadow-matrix-"));
  storePath = join(root, "shadow.sqlite");
  store = SqliteEventStore.openForProject(storePath, "moe-shadow-matrix");
  closedStore = SqliteEventStore.openForProject(join(root, "closed.sqlite"), "moe-shadow-matrix");
  closedStore.close();
  sourceCommit = readSourceCommit();
  baseline = snapshotStore();
  rows = (await buildShadowMatrix(sourceCommit, store, closedStore, () => {
    armSnapshots.push(snapshotStore());
  })).map(sealRow);
});

afterAll(() => {
  store?.close();
  store = null;
  closedStore = null;
  if (root !== "") rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });
});

const capabilityRows = (provider: ProviderId): readonly ShadowRow[] =>
  rows.filter((entry) => entry.provider === provider && entry.family === "CAPABILITY");
const surfaceRow = (provider: ProviderId, subject: string): ShadowRow => {
  const found = rows.find((entry) => entry.provider === provider && entry.subject === subject
    && entry.family === "SURFACE");
  if (found === undefined) throw new Error(`no surface row for ${provider}/${subject}`);
  return found;
};

describe("provider shadow matrix — coverage", () => {
  it("generates a positive row count bound to one source commit and one digest per row", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((entry) => entry.sourceCommit)).size).toBe(1);
    expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    for (const entry of rows) expect(entry.caseDigest).toBe(sealRow(entry).caseDigest);
  });

  it.each(PROVIDERS)("covers every capability %s publishes, on every platform", (provider) => {
    const roster = CAPABILITY_ROSTERS[provider];
    expect(roster.length).toBeGreaterThan(0);
    const covered = capabilityRows(provider);
    for (const platform of PLATFORM_CASES) {
      const onPlatform = covered.filter((entry) => entry.platform === platform.id);
      const missing = roster.filter((capability) =>
        !onPlatform.some((entry) => entry.subject === capability));
      expect(missing, `uncovered on ${platform.id}`).toStrictEqual([]);
      expect(onPlatform.length).toBe(roster.length);
    }
    expect(covered.length).toBe(roster.length * PLATFORM_CASES.length);
  });

  it("keeps the two published rosters distinct rather than assuming they agree", () => {
    expect(CAPABILITY_ROSTERS.codex).toContain("CWD_OBSERVATION");
    expect(CAPABILITY_ROSTERS.claude).not.toContain("CWD_OBSERVATION");
  });
});

describe("provider shadow matrix — verdict shape", () => {
  it("gives every row an exact verdict and a closed evidence provenance", () => {
    for (const entry of rows) {
      expect(VERDICTS).toContain(entry.verdict);
      expect(PROVENANCES).toContain(entry.provenance);
    }
  });

  it("makes every decided row quote a production vocabulary it belongs to", () => {
    const decided = rows.filter((entry) => entry.verdict !== "UNKNOWN");
    expect(decided.length).toBeGreaterThan(0);
    for (const entry of decided) {
      expect(entry.unknownBecause).toBeNull();
      expect(entry.reasonVocabulary).not.toBeNull();
      const vocabulary = REASON_VOCABULARIES[entry.reasonVocabulary ?? "CODEX_PROOF_METHODS"];
      expect(vocabulary, `${entry.provider}/${entry.subject}`).toContain(entry.reasonCode);
    }
  });

  it("leaves every UNKNOWN row without a production code and names why", () => {
    const unknown = rows.filter((entry) => entry.verdict === "UNKNOWN");
    expect(unknown.length).toBeGreaterThan(0);
    for (const entry of unknown) {
      expect(entry.reasonCode).toBeNull();
      expect(entry.refusedBy).toBeNull();
      expect(UNKNOWN_REASONS).toContain(entry.unknownBecause);
    }
  });

  it("serialises deterministically across two independent builds", async () => {
    const open = store;
    const closed = closedStore;
    if (open === null || closed === null) throw new Error("scratch stores are not available");
    const second = (await buildShadowMatrix(sourceCommit, open, closed)).map(sealRow);
    expect(canonicalMatrix(second)).toBe(canonicalMatrix(rows));
    expect(canonicalMatrix([...rows].reverse())).toBe(canonicalMatrix(rows));
  });
});

describe("provider shadow matrix — execution portability stays UNKNOWN", () => {
  it("reports no production Codex execution call site", () => {
    const codex = surfaceRow("codex", "execution-portability");
    expect(codex.verdict).toBe("UNKNOWN");
    expect(codex.unknownBecause).toBe("NO_PRODUCTION_EXECUTION_CALL_SITE");
    expect(codex.provenance).toBe("ABSENT_CALL_SITE");
    expect(Object.keys(runnerRoot)).not.toContain("launchCodex");
  });

  it("refuses to exercise the Claude launcher because dispatch writes authority", () => {
    const claude = surfaceRow("claude", "execution-portability");
    expect(claude.verdict).toBe("UNKNOWN");
    expect(claude.unknownBecause).toBe("DISPATCH_WRITES_AUTHORITY");
    expect(claude.provenance).toBe("NOT_EXERCISED");
    expect(Object.keys(runnerRoot)).toContain("launchClaude");
  });

  it("holds the withheld Claude surfaces UNKNOWN rather than reimplementing them", () => {
    for (const name of ["probeClaudeRuntime", "renderClaudeContext", "assessCapabilities",
      "recordClaudeStream"]) {
      expect(Object.keys(runnerRoot)).not.toContain(name);
    }
    expect(surfaceRow("claude", "capability-probe").unknownBecause)
      .toBe("PROVIDER_ASSESSOR_WITHHELD");
    expect(surfaceRow("claude", "context-render").unknownBecause)
      .toBe("PROVIDER_RENDERER_WITHHELD");
    expect(surfaceRow("claude", "run-reconciliation").unknownBecause)
      .toBe("PROVIDER_STREAM_RECORDER_WITHHELD");
    for (const entry of capabilityRows("claude")) {
      expect(entry.verdict).toBe("UNKNOWN");
      expect(entry.provenance).toBe("ABSENT_CALL_SITE");
    }
  });
});

describe("provider shadow matrix — accepted controls", () => {
  it("accepts a well-formed Codex probe and names the exact proof method", () => {
    const control = surfaceRow("codex", "probe-accepted-control");
    expect(control.verdict).toBe("PASS");
    expect(control.provenance).toBe("PROBE");
    expect(control.reasonCode).toBe("moe-codex-capability-profile/1");
    const version = capabilityRows("codex").filter((e) => e.subject === "VERSION_REPORT");
    expect(version.length).toBe(PLATFORM_CASES.length);
    for (const entry of version) {
      expect(entry.verdict).toBe("PASS");
      expect(entry.reasonCode).toBe("VERSION_RECORD");
    }
    const cwd = capabilityRows("codex").find((e) => e.subject === "CWD_OBSERVATION");
    expect(cwd?.reasonCode).toBe("CWD_OBSERVED");
  });

  it("credits a resume CLAIM to nothing, because a claim is not an observation", () => {
    for (const entry of capabilityRows("codex").filter((e) => e.subject === "RESUME")) {
      expect(entry.verdict).toBe("FAIL");
      expect(entry.reasonCode).toBe("NONE");
    }
  });

  it("constructs the daemon Foundation attempt service and calls it nothing more", () => {
    const control = surfaceRow("claude", "attempt-service-construction");
    expect(control.verdict).toBe("PASS");
    expect(control.provenance).toBe("CONSTRUCTION");
    expect(control.reasonCode).toBe("DAEMON_FOUNDATION_ATTEMPT");
    expect(control.refusedBy).toBeNull();
  });

  it("accepts a well-formed Claude runtime observation on every platform", () => {
    const controls = rows.filter((entry) => entry.subject === "observation-accepted-control");
    expect(controls.length).toBe(PLATFORM_CASES.length);
    for (const entry of controls) {
      expect(entry.verdict).toBe("PASS");
      expect(entry.provenance).toBe("OBSERVATION");
      expect(entry.reasonCode).toBe("moe-claude-runtime-observation/1");
    }
    const rendered = surfaceRow("codex", "render-accepted-control");
    expect(rendered.reasonCode).toBe("moe-codex-renderer-envelope/1");
    expect(surfaceRow("codex", "reconcile-accepted-control").reasonCode)
      .toBe("PROVEN_RESULT");
  });
});

describe("provider shadow matrix — hostile arms pin their exact production code", () => {
  it.each([
    ["codex", "probe-unsupported-platform", "CODEX_OBSERVATION_PLATFORM_INVALID", "PROBE"],
    ["codex", "observation-hostile-version", "CODEX_OBSERVATION_VERSION_INVALID", "OBSERVATION"],
    ["codex", "probe-unverifiable-observation", "NONE", "PROBE"],
    ["codex", "probe-missing-runtime", "UNSUPPORTED", "PROBE"],
    ["codex", "probe-surface-disagreement", "NONE", "PROBE"],
    ["codex", "render-context-bound-absent", "CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN", "RENDER"],
    ["codex", "render-authority-bearing-snapshot",
      "CODEX_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY", "RENDER"],
    ["claude", "observation-unsupported-platform", "CLAUDE_OBSERVATION_PLATFORM_INVALID",
      "OBSERVATION"],
    ["claude", "observation-hostile-version", "CLAUDE_OBSERVATION_VERSION_INVALID", "OBSERVATION"],
    ["claude", "observation-missing-runtime", "UNKNOWN", "OBSERVATION"],
  ] as const)("%s/%s refuses with %s", (provider, subject, code, provenance) => {
    const entry = surfaceRow(provider, subject);
    expect(entry.verdict).toBe("FAIL");
    expect(entry.reasonCode).toBe(code);
    expect(entry.provenance).toBe(provenance);
  });

  it.each([
    ["dispatch-request-malformed", "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", "REQUEST_REFUSAL"],
    ["durable-read-record-absent", "FOUNDATION_ATTEMPT_RECORD_ABSENT", "DURABLE_READ"],
    ["durable-read-identity-malformed", "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", "DURABLE_READ"],
    ["durable-read-store-unreadable", "FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS", "DURABLE_READ"],
  ] as const)("claude/%s refuses with %s at the daemon layer", (subject, code, provenance) => {
    const entry = surfaceRow("claude", subject);
    expect(entry.verdict).toBe("FAIL");
    expect(entry.reasonCode).toBe(code);
    expect(entry.refusedBy).toBe("DAEMON_FOUNDATION_ATTEMPT");
    expect(entry.provenance).toBe(provenance);
  });

  it("cannot produce an accepted durable read, and says so instead of forging one", () => {
    const control = surfaceRow("claude", "durable-read-accepted-control");
    expect(control.verdict).toBe("UNKNOWN");
    expect(control.unknownBecause).toBe("NO_PUBLISHED_RECORD_CODEC");
    expect(control.provenance).toBe("DURABLE_READ");
    for (const name of ["encodeFoundationPayload", "deriveDispatchAggregateId"]) {
      expect(Object.keys(runnerRoot)).not.toContain(name);
    }
  });
});

describe("provider shadow matrix — the matrix writes nothing and launches nothing", () => {
  it("leaves event count, decision count and store bytes unchanged after every arm", () => {
    expect(armSnapshots.length).toBeGreaterThan(0);
    const start = baseline;
    if (start === null) throw new Error("no baseline snapshot");
    for (const [index, taken] of armSnapshots.entries()) {
      expect(taken.horizon, `arm ${index}`).toBe(start.horizon);
      expect(taken.decisions, `arm ${index}`).toBe(start.decisions);
      expect(taken.digest, `arm ${index}`).toBe(start.digest);
      expect(taken.mtimeMs, `arm ${index}`).toBe(start.mtimeMs);
    }
    expect(snapshotStore()).toStrictEqual(start);
  });

  it("spawns no child process, because it imports nothing that could", () => {
    for (const name of OWNED_SOURCES) {
      const source = readFileSync(join(import.meta.dirname, name), "utf8");
      expect(source, name).not.toMatch(/from\s+"(?:node:)?child_process"/u);
      expect(source, name).not.toMatch(/require\(\s*"(?:node:)?child_process"/u);
    }
  });
});
