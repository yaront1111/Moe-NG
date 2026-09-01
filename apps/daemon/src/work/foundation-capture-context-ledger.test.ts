/**
 * The Foundation capture-context codec and its durable ledger.
 *
 * WHAT THIS RECORD IS FOR. A prepared Foundation workspace and the postlaunch
 * capture that seals its result are two different moments in two different
 * processes. Nothing durable connects them today: a reservation stores only the
 * request digest and the attempt identities, and a context record stores only
 * the rendered `inputManifestDigest`. So the physical facts the capture needs —
 * which worktree, which sealed inputs, which declared scope, what the tree
 * looked like before launch — survive only as process-local state, which is
 * exactly the "no process-global context map" the design forbids. This record is
 * the durable substitute, committed BEFORE physical launch and reached
 * afterwards through one immutable derived `captureRef`.
 *
 * THE SEALS ARE BOUND AND CROSS-CHECKED, NOT RECOMPUTED. `canonicalDigest` is
 * private to `@moe/runner` — it is NOT re-exported from that package's barrel
 * (measured at HEAD), and this repository has no `paths` mapping, no project
 * references, and a deep relative import fails TS6059. Reimplementing the hash
 * here would be a second formula that drifts from the first and would then be
 * the one this record trusts. So the codec fences that each nested manifest
 * CARRIES a well-formed seal and that the seals AGREE across fields, and it
 * never claims to have recomputed them. The producer's own seal check stays the
 * producer's.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInputManifest, observeScope } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import type {
  GitObserver,
  ScopeObservation,
  ScopePathObserver,
  WorkspaceInputEntry,
  WorkspaceInputManifest,
} from "@moe/runner";
import { describe, expect, it } from "vitest";

import {
  DAEMON_FOUNDATION_CAPTURE,
  FOUNDATION_CAPTURE_CONTEXT_CODES,
  FOUNDATION_CAPTURE_CONTEXT_KEYS,
  FOUNDATION_CAPTURE_CONTEXT_LIMITS,
  FOUNDATION_CAPTURE_CONTEXT_VERSION,
  decodeFoundationCaptureContext,
  deriveFoundationCaptureContextRecordDigest,
  encodeFoundationCaptureContext,
} from "./foundation-capture-context-contract.js";
import type {
  FoundationCaptureContextCode,
  FoundationCaptureContextRecord,
} from "./foundation-capture-context-contract.js";
import {
  DAEMON_FOUNDATION_CAPTURE_LEDGER,
  DAEMON_FOUNDATION_CAPTURE_READER,
  FOUNDATION_CAPTURE_CONTEXT_COMMAND_KIND,
  FOUNDATION_CAPTURE_CONTEXT_EVENT_TYPE,
  FOUNDATION_CAPTURE_CONTEXT_LEDGER_CODES,
  commitFoundationCaptureContext,
  deriveFoundationCaptureAggregateId,
  deriveFoundationCaptureCorrelationId,
  deriveFoundationCaptureDecisionKey,
  deriveFoundationCaptureEventId,
  deriveFoundationCaptureRef,
  deriveFoundationCaptureRequestBytes,
  readFoundationCaptureContext,
} from "./foundation-capture-context-ledger.js";
import type {
  FoundationCaptureContextReadResult,
  FoundationCaptureContextStore,
} from "./foundation-capture-context-ledger.js";

const PROJECT_ID = "proj-foundation-capture";
const SESSION_ID = "sess-foundation-capture-1";
const NODE_KEY = "node-code-1";
const ATTEMPT_AGGREGATE_ID = "foundation-attempt-aggregate-1";
const ATTEMPT_ID = "attempt-1";
const HEAD_COMMIT = "a".repeat(40);
const OBSERVED_AT = "2026-08-19T00:00:00Z";
const OBSERVER_VERSION = "moe-runner-scope-observer/1";
const WORKTREE_ROOT = join("fixture-parent", "proj-foundation-capture-attempt-1");
const DECLARED_PATHS = Object.freeze(["src/a.ts", "src/b.ts"]);

// --- fixtures ----------------------------------------------------------------

/**
 * A REAL sealed observation from `observeScope`, driven through its injected
 * ports. Hand-forging one would put a digest in the fixture that no production
 * code ever produced, and the cross-field arms below would then be comparing two
 * hand-written values — a tautology rather than a test.
 */
function observationFor(
  root: string = WORKTREE_ROOT,
  base: string = HEAD_COMMIT,
): ScopeObservation {
  const gitObserver: GitObserver = {
    headCommit: () => base,
    lsFilesIgnored: () => [],
    lsFilesTracked: () => [...DECLARED_PATHS],
    statusPorcelainV2: () => new TextEncoder().encode(`# branch.oid ${base}\0`),
    submodulePaths: () => [],
  };
  const pathObserver: ScopePathObserver = { exists: () => true, realpath: (path) => path };
  const result = observeScope({
    baseIdentity: base,
    declaredScopePaths: [...DECLARED_PATHS],
    gitObserver,
    observedAt: OBSERVED_AT,
    observerVersion: OBSERVER_VERSION,
    pathObserver,
    worktreeRoot: root,
  });
  if (!result.ok) throw new Error(`fixture observation refused: ${result.code}`);
  return result.observation;
}

/** A REAL sealed input manifest, for the same reason. */
function manifestFor(base: string = HEAD_COMMIT, count = 2): WorkspaceInputManifest {
  const entries: WorkspaceInputEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      byteLength: 8,
      path: `src/${index}.ts`,
      producer: { kind: "BASE" },
      sha256: index.toString(16).padStart(64, "0"),
    });
  }
  const built = buildInputManifest({ baseIdentity: base, entries });
  if (!built.ok) throw new Error(`fixture manifest refused: ${built.code}`);
  return built.manifest;
}

function assignmentFor(root: string = WORKTREE_ROOT): Record<string, unknown> {
  return {
    adopted: false,
    assignmentVersion: "moe-worktree-assignment/1",
    attemptId: ATTEMPT_ID,
    baseIdentity: HEAD_COMMIT,
    leaf: "proj-foundation-capture-attempt-1",
    projectId: PROJECT_ID,
    realSourceRepositoryRoot: join("fixture-source", "repo"),
    realWorktreeParent: "fixture-parent",
    realWorktreePath: root,
    worktreePath: root,
  };
}

function catalogAuthorityFor(): Record<string, unknown> {
  return {
    baseRevisionHash: HEAD_COMMIT,
    catalogDigest: "c".repeat(64),
    declaredPaths: [...DECLARED_PATHS],
    projectId: PROJECT_ID,
    repositoryRef: "repo-main",
    scopeRef: "scope-default",
    sourceRepositoryRoot: join("fixture-source", "repo"),
    worktreeParent: "fixture-parent",
  };
}

/**
 * A candidate WITHOUT its record digest; `stamp` derives it. The digest is never
 * hand-written: what the encoder returns IS the derivation, so a fixture that
 * carried its own digest would be asserting the test's arithmetic.
 */
function bodyFor(): Record<string, unknown> {
  const manifest = manifestFor();
  return {
    artifactDeclaration: "NONE",
    assignment: assignmentFor(),
    attemptAggregateId: ATTEMPT_AGGREGATE_ID,
    attemptId: ATTEMPT_ID,
    baselineDigest: manifest.sha256,
    catalogAuthority: catalogAuthorityFor(),
    inputManifest: manifest,
    nodeKey: NODE_KEY,
    observation: observationFor(),
    observedAt: OBSERVED_AT,
    projectId: PROJECT_ID,
    recordVersion: FOUNDATION_CAPTURE_CONTEXT_VERSION,
    requestDigest: "d".repeat(64),
    reservationDigest: "e".repeat(64),
    sessionId: SESSION_ID,
  };
}

function stamp(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, recordDigest: deriveFoundationCaptureContextRecordDigest(body) };
}

function candidate(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return stamp({ ...bodyFor(), ...overrides });
}

function admitted(): FoundationCaptureContextRecord {
  const encoded = encodeFoundationCaptureContext(candidate());
  if (!encoded.ok) throw new Error(`fixture record refused: ${encoded.code}`);
  return encoded.record;
}

/** Both fields on every refusal, so a case can never assert only "not ok". */
function refusalOf(input: unknown): { code: string; layer: string } {
  const result = encodeFoundationCaptureContext(input);
  if (result.ok) throw new Error("expected a refusal, the codec admitted the input");
  return { code: result.code, layer: result.layer };
}

// --- the record --------------------------------------------------------------

describe("foundation capture context record", () => {
  it("binds exactly the sixteen fields the prepared attempt has to carry", () => {
    expect([...FOUNDATION_CAPTURE_CONTEXT_KEYS]).toEqual([
      "artifactDeclaration",
      "assignment",
      "attemptAggregateId",
      "attemptId",
      "baselineDigest",
      "catalogAuthority",
      "inputManifest",
      "nodeKey",
      "observation",
      "observedAt",
      "projectId",
      "recordDigest",
      "recordVersion",
      "requestDigest",
      "reservationDigest",
      "sessionId",
    ]);
  });

  it("admits a prepared attempt and deep-freezes every nested container", () => {
    const record = admitted();
    expect(record.recordVersion).toBe(FOUNDATION_CAPTURE_CONTEXT_VERSION);
    expect(record.artifactDeclaration).toBe("NONE");
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.inputManifest.entries)).toBe(true);
    expect(Object.isFrozen(record.observation.gitAttribution)).toBe(true);
    expect(Object.isFrozen(record.catalogAuthority.declaredPaths)).toBe(true);
    expect(() => {
      (record.inputManifest.entries as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("carries the sealed input manifest whole, not just its digest", () => {
    const record = admitted();
    const manifest = manifestFor();
    expect(record.inputManifest.entries).toHaveLength(manifest.entries.length);
    expect(record.inputManifest.entries[0]?.path).toBe("src/0.ts");
    expect(record.inputManifest.entries[0]?.producer).toEqual({ kind: "BASE" });
    expect(record.inputManifest.sha256).toBe(manifest.sha256);
    expect(record.observation.canonicalEntries.map((entry) => entry.path)).toEqual([
      ...DECLARED_PATHS,
    ]);
  });

  it("derives the record digest over every bound field, and only compares the caller's", () => {
    const body = bodyFor();
    const derived = deriveFoundationCaptureContextRecordDigest(body);
    expect(derived).toMatch(/^[0-9a-f]{64}$/u);
    expect(encodeFoundationCaptureContext({ ...body, recordDigest: derived }).ok).toBe(true);
    expect(refusalOf({ ...body, recordDigest: "f".repeat(64) })).toEqual({
      code: "FOUNDATION_CAPTURE_CONTEXT_RECORD_DIGEST_MISMATCH",
      layer: DAEMON_FOUNDATION_CAPTURE,
    });
  });

  /**
   * ONE FIELD MOVES PER CASE, and every one of the fifteen bound fields is
   * covered: a digest that misses a field is invisible while the field's value
   * happens to be constant, and this is the only test that would see it.
   */
  it("moves the record digest when any one bound field moves", () => {
    const body = bodyFor();
    const base = deriveFoundationCaptureContextRecordDigest(body);
    const perturbations: Readonly<Record<string, unknown>> = {
      artifactDeclaration: "SOME",
      assignment: assignmentFor(join("fixture-parent", "other")),
      attemptAggregateId: "foundation-attempt-aggregate-2",
      attemptId: "attempt-2",
      baselineDigest: "9".repeat(64),
      catalogAuthority: { ...catalogAuthorityFor(), catalogDigest: "0".repeat(64) },
      inputManifest: manifestFor(HEAD_COMMIT, 3),
      nodeKey: "node-code-2",
      observation: observationFor(join("fixture-parent", "other")),
      observedAt: "2026-08-19T00:00:01Z",
      projectId: "proj-other",
      recordVersion: "moe-foundation-capture-context/2",
      requestDigest: "1".repeat(64),
      reservationDigest: "2".repeat(64),
      sessionId: "sess-other",
    };
    const moved = Object.entries(perturbations);
    expect(moved).toHaveLength(15);
    expect([...FOUNDATION_CAPTURE_CONTEXT_KEYS].filter((key) => key !== "recordDigest")).toEqual(
      moved.map(([key]) => key),
    );
    for (const [key, value] of moved) {
      expect(deriveFoundationCaptureContextRecordDigest({ ...body, [key]: value })).not.toBe(base);
    }
  });

  it("is deterministic: the same preparation encodes to byte-identical bytes", () => {
    const first = encodeFoundationCaptureContext(candidate());
    const second = encodeFoundationCaptureContext(candidate());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect([...first.bytes]).toEqual([...second.bytes]);
  });
});

// --- admission ---------------------------------------------------------------

describe("foundation capture context admission", () => {
  it("publishes a closed vocabulary, hand-written here", () => {
    expect([...FOUNDATION_CAPTURE_CONTEXT_CODES]).toEqual([
      "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
      "FOUNDATION_CAPTURE_CONTEXT_VERSION_UNSUPPORTED",
      "FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED",
      "FOUNDATION_CAPTURE_CONTEXT_UNSEALED",
      "FOUNDATION_CAPTURE_CONTEXT_OBSERVATION_UNCLEAN",
      "FOUNDATION_CAPTURE_CONTEXT_ARTIFACT_DECLARATION_UNSUPPORTED",
      "FOUNDATION_CAPTURE_CONTEXT_FIELD_MISMATCH",
      "FOUNDATION_CAPTURE_CONTEXT_RECORD_DIGEST_MISMATCH",
      "FOUNDATION_CAPTURE_CONTEXT_NONCANONICAL",
    ]);
    expect(DAEMON_FOUNDATION_CAPTURE).toBe("DAEMON_FOUNDATION_CAPTURE");
  });

  /**
   * The generated sweep. Every case names its EXACT code and layer — "it
   * refused" would stay green the day one guard starts answering for another —
   * and the case count is asserted, because a sweep that generates nothing
   * passes while testing nothing.
   */
  it("refuses malformed, extra, missing, unsupported and over-limit input by exact code", () => {
    const body = bodyFor();
    const cases: readonly (readonly [string, unknown, FoundationCaptureContextCode])[] = [
      ["null", null, "FOUNDATION_CAPTURE_CONTEXT_MALFORMED"],
      ["an array", [], "FOUNDATION_CAPTURE_CONTEXT_MALFORMED"],
      ["a primitive", "record", "FOUNDATION_CAPTURE_CONTEXT_MALFORMED"],
      ["an extra key", { ...stamp(body), extra: 1 }, "FOUNDATION_CAPTURE_CONTEXT_MALFORMED"],
      ["a missing key", missingKey(stamp(body)), "FOUNDATION_CAPTURE_CONTEXT_MALFORMED"],
      ["a blank identity", candidate({ nodeKey: "" }), "FOUNDATION_CAPTURE_CONTEXT_MALFORMED"],
      [
        "a non-string identity",
        candidate({ sessionId: 7 }),
        "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
      ],
      [
        "an absent assignment",
        candidate({ assignment: null }),
        "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
      ],
      [
        "an assignment missing a key",
        candidate({ assignment: missingKey(assignmentFor()) }),
        "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
      ],
      [
        "a catalog authority with an extra key",
        candidate({ catalogAuthority: { ...catalogAuthorityFor(), extra: 1 } }),
        "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
      ],
      [
        "an unsupported record version",
        candidate({ recordVersion: "moe-foundation-capture-context/2" }),
        "FOUNDATION_CAPTURE_CONTEXT_VERSION_UNSUPPORTED",
      ],
      [
        "an unsupported input manifest version",
        candidate({ inputManifest: { ...manifestFor(), manifestVersion: "other/1" } }),
        "FOUNDATION_CAPTURE_CONTEXT_VERSION_UNSUPPORTED",
      ],
      [
        "an unsupported observation version",
        candidate({ observation: { ...observationFor(), observationVersion: "other/1" } }),
        "FOUNDATION_CAPTURE_CONTEXT_VERSION_UNSUPPORTED",
      ],
      [
        "an unsealed input manifest",
        candidate({ inputManifest: { ...manifestFor(), sha256: "" } }),
        "FOUNDATION_CAPTURE_CONTEXT_UNSEALED",
      ],
      [
        "an input manifest sealed with a non-digest",
        candidate({ inputManifest: { ...manifestFor(), sha256: "not-a-digest" } }),
        "FOUNDATION_CAPTURE_CONTEXT_UNSEALED",
      ],
      [
        "an unsealed observation",
        candidate({ observation: { ...observationFor(), sha256: "not-a-digest" } }),
        "FOUNDATION_CAPTURE_CONTEXT_UNSEALED",
      ],
      [
        "a baseline that is not a digest",
        candidate({ baselineDigest: "not-a-digest" }),
        "FOUNDATION_CAPTURE_CONTEXT_UNSEALED",
      ],
      [
        "too many declared paths",
        candidate({
          catalogAuthority: {
            ...catalogAuthorityFor(),
            declaredPaths: pathList(FOUNDATION_CAPTURE_CONTEXT_LIMITS.declaredPaths + 1),
          },
        }),
        "FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED",
      ],
      [
        "too many sealed input entries",
        candidate({ inputManifest: oversizedManifest() }),
        "FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED",
      ],
      [
        "too many observed entries",
        candidate({ observation: oversizedObservation() }),
        "FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED",
      ],
      [
        "an artifact declaration that is not NONE",
        candidate({ artifactDeclaration: "SOME" }),
        "FOUNDATION_CAPTURE_CONTEXT_ARTIFACT_DECLARATION_UNSUPPORTED",
      ],
      [
        "an artifact declaration carrying a caller list",
        candidate({ artifactDeclaration: [] }),
        "FOUNDATION_CAPTURE_CONTEXT_ARTIFACT_DECLARATION_UNSUPPORTED",
      ],
    ];
    expect(cases).toHaveLength(22);
    for (const [name, input, code] of cases) {
      expect({ name, ...refusalOf(input) }).toEqual({
        code,
        layer: DAEMON_FOUNDATION_CAPTURE,
        name,
      });
    }
  });

  /**
   * ACCESSORS ARE REFUSED, NOT INVOKED, AT EVERY DEPTH. A getter that answers
   * one value to the fence and another to the reader is the entire reason this
   * codec snapshots own data descriptors once, and the depth cases are what
   * prove the snapshot is not merely shallow.
   */
  it("refuses an accessor smuggled in at any depth", () => {
    const withAccessor = (host: Record<string, unknown>, key: string): Record<string, unknown> =>
      Object.defineProperty({ ...host }, key, { enumerable: true, get: () => "smuggled" });
    const cases: readonly (readonly [string, unknown])[] = [
      ["at the record root", withAccessor(candidate(), "nodeKey")],
      ["inside the assignment", candidate({ assignment: withAccessor(assignmentFor(), "leaf") })],
      [
        "inside the catalog authority",
        candidate({ catalogAuthority: withAccessor(catalogAuthorityFor(), "scopeRef") }),
      ],
      [
        "inside the sealed input manifest",
        candidate({ inputManifest: withAccessor({ ...manifestFor() }, "baseIdentity") }),
      ],
      [
        "inside the nested scope observation",
        candidate({
          observation: {
            ...observationFor(),
            gitAttribution: withAccessor({ ...observationFor().gitAttribution }, "headCommit"),
          },
        }),
      ],
    ];
    expect(cases).toHaveLength(5);
    for (const [name, input] of cases) {
      expect({ name, ...refusalOf(input) }).toEqual({
        code: "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
        layer: DAEMON_FOUNDATION_CAPTURE,
        name,
      });
    }
  });

  /**
   * THE PRELAUNCH TREE HAS TO BE CLEAN. A dirty prelaunch observation cannot be
   * a baseline: the postlaunch scan would attribute bytes that were already
   * there to the provider that never wrote them.
   */
  it("refuses a prelaunch observation that is not clean, one dirty class per case", () => {
    const observation = observationFor();
    const classes = [
      "dirtyPaths",
      "stagedPaths",
      "untrackedPaths",
      "unmergedPaths",
    ] as const;
    expect(classes).toHaveLength(4);
    for (const dirty of classes) {
      const unclean = candidate({
        observation: {
          ...observation,
          gitAttribution: { ...observation.gitAttribution, [dirty]: ["src/a.ts"] },
        },
      });
      expect({ dirty, ...refusalOf(unclean) }).toEqual({
        code: "FOUNDATION_CAPTURE_CONTEXT_OBSERVATION_UNCLEAN",
        dirty,
        layer: DAEMON_FOUNDATION_CAPTURE,
      });
    }
  });

  /**
   * CROSS-FIELD, ONE FIELD VARIED PER CASE. Each of these pairs two authorities
   * that produced their halves independently — the hydrator against the scanner,
   * the scanner against the materializer, the catalog against the record — so a
   * record whose halves describe different attempts is unrepresentable rather
   * than merely unlikely.
   */
  it("refuses a record whose bound halves disagree, by exact code", () => {
    const otherRoot = join("fixture-parent", "other-attempt");
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ["baseline digest against the sealed manifest seal", { baselineDigest: "3".repeat(64) }],
      [
        "observation base against the manifest base",
        { observation: observationFor(WORKTREE_ROOT, "b".repeat(40)) },
      ],
      ["assignment real root against the observed worktree", { assignment: assignmentFor(otherRoot) }],
      ["catalog authority project against the record project", { projectId: "proj-other" }],
      ["assignment attempt against the record attempt", { attemptId: "attempt-2" }],
    ];
    expect(cases).toHaveLength(5);
    for (const [name, overrides] of cases) {
      expect({ name, ...refusalOf(candidate(overrides)) }).toEqual({
        code: "FOUNDATION_CAPTURE_CONTEXT_FIELD_MISMATCH",
        layer: DAEMON_FOUNDATION_CAPTURE,
        name,
      });
    }
  });
});

// --- decode ------------------------------------------------------------------

describe("foundation capture context decode", () => {
  it("round-trips the encoded bytes back to an identical record", () => {
    const encoded = encodeFoundationCaptureContext(candidate());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeFoundationCaptureContext(encoded.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.record).toEqual(encoded.record);
    expect(Object.isFrozen(decoded.record.observation.gitAttribution)).toBe(true);
  });

  it("refuses bytes that parse to the record but are not the record's own encoding", () => {
    const encoded = encodeFoundationCaptureContext(candidate());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const text = new TextDecoder().decode(encoded.bytes);
    const reordered = new TextEncoder().encode(` ${text}`);
    expect(decodeFoundationCaptureContext(reordered)).toEqual({
      code: "FOUNDATION_CAPTURE_CONTEXT_NONCANONICAL",
      layer: DAEMON_FOUNDATION_CAPTURE,
      ok: false,
    });
  });

  it("refuses input that is not bytes at all", () => {
    for (const input of [null, "bytes", [1, 2, 3], new ArrayBuffer(4)]) {
      const decoded = decodeFoundationCaptureContext(input);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.layer).toBe(DAEMON_FOUNDATION_CAPTURE);
      expect(decoded.code).toBe("FOUNDATION_CAPTURE_CONTEXT_MALFORMED");
    }
  });
});

// --- helpers -----------------------------------------------------------------

function missingKey(host: Record<string, unknown>): Record<string, unknown> {
  const [first] = Object.keys(host);
  const copy = { ...host };
  if (first !== undefined) delete copy[first];
  return copy;
}

function pathList(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `src/generated-${index}.ts`);
}

function oversizedManifest(): Record<string, unknown> {
  const manifest = manifestFor();
  return {
    ...manifest,
    entries: Array.from(
      { length: FOUNDATION_CAPTURE_CONTEXT_LIMITS.inputEntries + 1 },
      (_unused, index) => ({
        byteLength: 1,
        path: `src/generated-${index}.ts`,
        producer: { kind: "BASE" },
        sha256: "4".repeat(64),
      }),
    ),
  };
}

function oversizedObservation(): Record<string, unknown> {
  const observation = observationFor();
  return {
    ...observation,
    canonicalEntries: Array.from(
      { length: FOUNDATION_CAPTURE_CONTEXT_LIMITS.observedEntries + 1 },
      (_unused, index) => ({
        attribution: "CLEAN",
        attributionReason: "generated",
        path: `src/generated-${index}.ts`,
      }),
    ),
  };
}

// --- durable harness ---------------------------------------------------------

const DECIDED_AT = "2026-08-19T00:00:00.000Z";

/**
 * WINDOWS HANDLE DISCIPLINE: every handle is closed in a `finally` before the
 * temp directory is removed. A handle held across the cleanup throws EPERM and
 * kills the vitest worker with no test output at all.
 */
function withDirectory<T>(name: string, run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-capture-ctx-${name}-`));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withStore<T>(databasePath: string, run: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

/** A store that answers ONLY the planted history, for the hostile roster. */
function plantedStore(events: readonly StoredEvent[]): FoundationCaptureContextStore {
  return {
    commitExpectedVersionDecision: () => {
      throw new Error("the hostile-history roster never commits");
    },
    readEvents: () => events,
  };
}

/** The genuine stored event a real commit produced; hostile cases perturb THIS. */
function realStoredEvent(directory: string): { event: StoredEvent; captureRef: string } {
  return withStore(join(directory, "real.sqlite"), (store) => {
    const committed = commitFoundationCaptureContext(store, {
      candidate: candidate(),
      decidedAt: DECIDED_AT,
    });
    if (!committed.ok) throw new Error(`fixture commit refused: ${committed.code}`);
    const [event] = store.readEvents(committed.aggregateId);
    if (event === undefined) throw new Error("fixture commit wrote no event");
    return { captureRef: committed.captureRef, event };
  });
}

function readerRefusal(result: FoundationCaptureContextReadResult): {
  code: string;
  codecCode: string | null;
  layer: string;
} {
  if (result.ok) throw new Error("expected a reader refusal, the read succeeded");
  return { code: result.code, codecCode: result.codecCode, layer: result.layer };
}

// --- identity ----------------------------------------------------------------

describe("foundation capture context identity", () => {
  it("derives six domain-separated identities, none sharing a namespace", () => {
    const record = admitted();
    const captureRef = deriveFoundationCaptureRef(record);
    const derived = [
      captureRef,
      deriveFoundationCaptureAggregateId(captureRef),
      deriveFoundationCaptureDecisionKey(record).commandId,
      deriveFoundationCaptureDecisionKey(record).principalId,
      deriveFoundationCaptureEventId(record),
      deriveFoundationCaptureCorrelationId(record.recordDigest),
    ];
    expect(derived).toHaveLength(6);
    expect(new Set(derived).size).toBe(6);
    expect(derived.map((value) => value.split("sha256:")[0])).toEqual([
      "moe-foundation-capture-context-ref/1:",
      "moe-foundation-capture-context/1:",
      "moe-foundation-capture-context-command/1:",
      "moe-foundation-capture-context-principal/1:",
      "moe-foundation-capture-context-event/1:",
      "moe-foundation-capture-context-correlation/1:",
    ]);
  });

  /**
   * THE COLLISION THIS FILE EXISTS TO PREVENT. The context-manifest family's
   * namespaces are pinned by hand-transcribed goldens in its own suite; reusing
   * one here would put two different records on one aggregate in one store.
   */
  it("shares no namespace with the golden-pinned context-manifest family", () => {
    const record = admitted();
    const captureRef = deriveFoundationCaptureRef(record);
    const derived = [
      captureRef,
      deriveFoundationCaptureAggregateId(captureRef),
      deriveFoundationCaptureDecisionKey(record).commandId,
      deriveFoundationCaptureEventId(record),
      deriveFoundationCaptureCorrelationId(record.recordDigest),
    ];
    for (const value of derived) {
      expect(value.startsWith("moe-foundation-context/1:")).toBe(false);
      expect(value.startsWith("moe-foundation-context-command/1:")).toBe(false);
      expect(value.startsWith("moe-foundation-context-event/1:")).toBe(false);
      expect(value.startsWith("moe-foundation-context-correlation/1:")).toBe(false);
    }
  });

  it("derives without a clock: identical input answers identical identities", () => {
    const record = admitted();
    expect(deriveFoundationCaptureRef(record)).toBe(deriveFoundationCaptureRef(record));
    expect(deriveFoundationCaptureEventId(record)).toBe(deriveFoundationCaptureEventId(record));
    expect([...deriveFoundationCaptureRequestBytes(record)]).toEqual([
      ...deriveFoundationCaptureRequestBytes(record),
    ]);
  });

  /**
   * The command id must NOT move with content and the request bytes MUST. That
   * asymmetry is what turns a changed field into a diagnosable conflict rather
   * than a silent second aggregate.
   */
  it("keeps the record digest out of the command preimage and inside the request", () => {
    const record = admitted();
    const drifted = { ...record, recordDigest: "7".repeat(64) };
    expect(deriveFoundationCaptureDecisionKey(drifted).commandId).toBe(
      deriveFoundationCaptureDecisionKey(record).commandId,
    );
    expect(deriveFoundationCaptureRef(drifted)).toBe(deriveFoundationCaptureRef(record));
    expect([...deriveFoundationCaptureRequestBytes(drifted)]).not.toEqual([
      ...deriveFoundationCaptureRequestBytes(record),
    ]);
  });

  it("frames its parts, so a shifted boundary cannot hash alike", () => {
    const record = admitted();
    const shifted = { ...record, attemptAggregateId: `${ATTEMPT_AGGREGATE_ID}x`, attemptId: "" };
    expect(deriveFoundationCaptureRef(shifted)).not.toBe(deriveFoundationCaptureRef(record));
  });
});

// --- the durable ledger ------------------------------------------------------

describe("foundation capture context ledger", () => {
  it("publishes its nine codes, hand-written here", () => {
    expect([...FOUNDATION_CAPTURE_CONTEXT_LEDGER_CODES]).toEqual([
      "FOUNDATION_CAPTURE_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT",
      "FOUNDATION_CAPTURE_CONTEXT_LEDGER_REPLAY_DIVERGED",
      "FOUNDATION_CAPTURE_CONTEXT_LEDGER_STORE_UNAVAILABLE",
      "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT",
      "FOUNDATION_CAPTURE_CONTEXT_READER_AMBIGUOUS",
      "FOUNDATION_CAPTURE_CONTEXT_READER_EVENT_TYPE_UNEXPECTED",
      "FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE",
      "FOUNDATION_CAPTURE_CONTEXT_READER_REF_MISMATCH",
      "FOUNDATION_CAPTURE_CONTEXT_READER_BINDING_MISMATCH",
    ]);
  });

  /** The accepted control: a real file-backed store, closed, REOPENED, read. */
  it("commits against a real store and answers the same bytes after a reopen", () => {
    withDirectory("roundtrip", (directory) => {
      const databasePath = join(directory, "capture.sqlite");
      const committed = withStore(databasePath, (store) =>
        commitFoundationCaptureContext(store, { candidate: candidate(), decidedAt: DECIDED_AT }));
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      expect(committed.disposition).toBe("COMMITTED");
      expect(committed.aggregateId).toBe(
        deriveFoundationCaptureAggregateId(committed.captureRef),
      );
      const read = withStore(databasePath, (store) =>
        readFoundationCaptureContext(store, committed.captureRef));
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect([...read.bytes]).toEqual([...committed.bytes]);
      expect(read.record).toEqual(committed.record);
      expect(read.captureRef).toBe(committed.captureRef);
    });
  });

  it("writes exactly one event, under this module's own type and schema version", () => {
    withDirectory("one-event", (directory) => {
      withStore(join(directory, "capture.sqlite"), (store) => {
        const committed = commitFoundationCaptureContext(store, {
          candidate: candidate(),
          decidedAt: DECIDED_AT,
        });
        expect(committed.ok).toBe(true);
        if (!committed.ok) return;
        const events = store.readEvents(committed.aggregateId);
        expect(events).toHaveLength(1);
        expect(events[0]?.eventType).toBe(FOUNDATION_CAPTURE_CONTEXT_EVENT_TYPE);
        expect(events[0]?.domainSchemaVersion).toBe(FOUNDATION_CAPTURE_CONTEXT_VERSION);
        expect(events[0]?.eventId).toBe(deriveFoundationCaptureEventId(committed.record));
        expect(events[0]?.aggregateSequence).toBe(1);
      });
    });
  });

  /**
   * A SECOND CALL THAT DOES NOT THROW IS ALSO WHAT A DOUBLE WRITE LOOKS LIKE, so
   * the row count is asserted, not just the disposition.
   */
  it("replays an identical re-seal from the durable event and appends nothing", () => {
    withDirectory("replay", (directory) => {
      withStore(join(directory, "capture.sqlite"), (store) => {
        const first = commitFoundationCaptureContext(store, {
          candidate: candidate(),
          decidedAt: DECIDED_AT,
        });
        const second = commitFoundationCaptureContext(store, {
          candidate: candidate(),
          decidedAt: DECIDED_AT,
        });
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(second.disposition).toBe("REPLAYED");
        expect([...second.bytes]).toEqual([...first.bytes]);
        expect(store.readEvents(first.aggregateId)).toHaveLength(1);
      });
    });
  });

  /**
   * A CHANGED FIELD UNDER THE SAME ATTEMPT IS A CONFLICT, AND THE FIRST BYTES
   * SURVIVE. Both conflict shapes are covered: a changed CONTENT field reuses the
   * command id under a different request (the store throws IDEMPOTENCY_CONFLICT),
   * while a changed COMMAND field is a new command against an aggregate already at
   * version 1 (the store RETURNS a no-effect decision).
   */
  it("refuses a conflicting re-seal by exact code and preserves the first bytes", () => {
    const conflicts: readonly (readonly [string, Record<string, unknown>, string])[] = [
      [
        "a changed content field",
        { observedAt: "2026-08-19T00:00:05Z" },
        "FOUNDATION_CAPTURE_CONTEXT_LEDGER_REPLAY_DIVERGED",
      ],
      [
        "a changed reservation digest",
        { reservationDigest: "8".repeat(64) },
        "FOUNDATION_CAPTURE_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT",
      ],
    ];
    expect(conflicts).toHaveLength(2);
    for (const [name, overrides, code] of conflicts) {
      withDirectory("conflict", (directory) => {
        withStore(join(directory, "capture.sqlite"), (store) => {
          const first = commitFoundationCaptureContext(store, {
            candidate: candidate(),
            decidedAt: DECIDED_AT,
          });
          expect(first.ok).toBe(true);
          if (!first.ok) return;
          const second = commitFoundationCaptureContext(store, {
            candidate: candidate(overrides),
            decidedAt: DECIDED_AT,
          });
          expect(second.ok).toBe(false);
          if (second.ok) return;
          expect({ code: second.code, layer: second.layer, name }).toEqual({
            code,
            layer: DAEMON_FOUNDATION_CAPTURE_LEDGER,
            name,
          });
          expect(store.readEvents(first.aggregateId)).toHaveLength(1);
          const read = readFoundationCaptureContext(store, first.captureRef);
          expect(read.ok).toBe(true);
          if (!read.ok) return;
          expect([...read.bytes]).toEqual([...first.bytes]);
        });
      });
    }
  });

  /**
   * THE REPLAY IS READ, NEVER ECHOED — and this is the ONLY test that can tell
   * the difference.
   *
   * WHY THE OBVIOUS TEST CANNOT. The store answers REPLAYED only when the request
   * identity matches, and the request preimage contains `recordDigest`, which
   * covers all fifteen bound fields. So on any genuine replay the caller's
   * candidate necessarily encodes to the same bytes as the durable record, and a
   * writer that simply echoed the candidate back would pass every byte comparison
   * in the suite. I drilled exactly that mutation and it SURVIVED GREEN against
   * the earlier tests.
   *
   * WHAT SEPARATES THEM IS A POISONED STORE. Reading the durable event re-runs
   * the codec's byte verification, so tampered history refuses; echoing the
   * caller returns clean bytes for a store whose record has been edited
   * underneath. The commit here goes through a REAL store — the REPLAYED
   * disposition is genuine, not hand-built — while the history it reads back is
   * hostile.
   */
  it("refuses a replay whose durable bytes were tampered with, instead of echoing", () => {
    withDirectory("poisoned-replay", (directory) => {
      withStore(join(directory, "capture.sqlite"), (store) => {
        const first = commitFoundationCaptureContext(store, {
          candidate: candidate(),
          decidedAt: DECIDED_AT,
        });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const forged = new TextEncoder().encode(
          new TextDecoder().decode(first.bytes)
            .replace('"reservationDigest":"e', '"reservationDigest":"f'),
        );
        expect([...forged]).not.toEqual([...first.bytes]);
        const poisoned: FoundationCaptureContextStore = {
          commitExpectedVersionDecision: (commit) => store.commitExpectedVersionDecision(commit),
          readEvents: (aggregateId) =>
            store.readEvents(aggregateId).map((event) => ({ ...event, payload: forged })),
        };
        const replayed = commitFoundationCaptureContext(poisoned, {
          candidate: candidate(),
          decidedAt: DECIDED_AT,
        });
        expect(replayed.ok).toBe(false);
        if (replayed.ok) return;
        expect({ code: replayed.code, layer: replayed.layer }).toEqual({
          code: "FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE",
          layer: DAEMON_FOUNDATION_CAPTURE_READER,
        });
      });
    });
  });

  /**
   * PARALLEL ISOLATION. Two attempts are written into ONE store and both read
   * back: a shared aggregate would have made the second overwrite or conflict
   * with the first, and reading only one of them would not have noticed.
   */
  it("keeps two attempts on disjoint aggregates with no bleed", () => {
    withDirectory("isolation", (directory) => {
      withStore(join(directory, "capture.sqlite"), (store) => {
        const other = { attemptId: "attempt-2", assignment: assignmentFor2() };
        const first = commitFoundationCaptureContext(store, {
          candidate: candidate(),
          decidedAt: DECIDED_AT,
        });
        const second = commitFoundationCaptureContext(store, {
          candidate: candidate(other),
          decidedAt: DECIDED_AT,
        });
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(second.aggregateId).not.toBe(first.aggregateId);
        expect(second.captureRef).not.toBe(first.captureRef);
        const readFirst = readFoundationCaptureContext(store, first.captureRef);
        const readSecond = readFoundationCaptureContext(store, second.captureRef);
        expect(readFirst.ok && readSecond.ok).toBe(true);
        if (!readFirst.ok || !readSecond.ok) return;
        expect(readFirst.record.attemptId).toBe(ATTEMPT_ID);
        expect(readSecond.record.attemptId).toBe("attempt-2");
        expect(store.readEvents(first.aggregateId)).toHaveLength(1);
        expect(store.readEvents(second.aggregateId)).toHaveLength(1);
      });
    });
  });

  it("is unreachable through another attempt's captureRef", () => {
    withDirectory("cross-ref", (directory) => {
      withStore(join(directory, "capture.sqlite"), (store) => {
        const committed = commitFoundationCaptureContext(store, {
          candidate: candidate(),
          decidedAt: DECIDED_AT,
        });
        expect(committed.ok).toBe(true);
        if (!committed.ok) return;
        const foreign = deriveFoundationCaptureRef({
          attemptAggregateId: ATTEMPT_AGGREGATE_ID,
          attemptId: "attempt-2",
          nodeKey: NODE_KEY,
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
        });
        expect(readerRefusal(readFoundationCaptureContext(store, foreign))).toEqual({
          code: "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT",
          codecCode: null,
          layer: DAEMON_FOUNDATION_CAPTURE_READER,
        });
      });
    });
  });

  /** The codec's diagnosis reaches the caller under the CODEC's layer. */
  it("passes a codec refusal through without restamping it as the ledger's", () => {
    withDirectory("codec-refusal", (directory) => {
      withStore(join(directory, "capture.sqlite"), (store) => {
        const result = commitFoundationCaptureContext(store, {
          candidate: candidate({ artifactDeclaration: "SOME" }),
          decidedAt: DECIDED_AT,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe("FOUNDATION_CAPTURE_CONTEXT_ARTIFACT_DECLARATION_UNSUPPORTED");
        expect(result.layer).toBe(DAEMON_FOUNDATION_CAPTURE);
      });
    });
  });

  /**
   * DETERMINISM ACROSS TWO SEPARATE STORES. Running the same preparation twice
   * inside one store proves only that the second call replayed; two independent
   * stores prove the derivation itself carries no state and no clock.
   */
  it("derives byte-identical bytes and the same captureRef in two separate stores", () => {
    const commits = ["first", "second"].map((name) =>
      withDirectory(`determinism-${name}`, (directory) =>
        withStore(join(directory, "capture.sqlite"), (store) => {
          const committed = commitFoundationCaptureContext(store, {
            candidate: candidate(),
            decidedAt: DECIDED_AT,
          });
          if (!committed.ok) throw new Error(`commit refused: ${committed.code}`);
          return {
            aggregateId: committed.aggregateId,
            bytes: [...committed.bytes],
            captureRef: committed.captureRef,
          };
        })));
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual(commits[1]);
  });

  /**
   * THE DECISION INSTANT IS NOT IN THE RECORD. `observedAt` is a BOUND INPUT and
   * `decidedAt` is the store's decision instant, so moving the wall clock must
   * change neither the sealed bytes nor the ref. If `decidedAt` ever leaked into
   * the preimage, the same preparation would seal differently on every retry and
   * the replay path would become unreachable.
   */
  it("seals identically under a different decidedAt", () => {
    const commits = [DECIDED_AT, "2026-08-19T23:59:59.000Z"].map((decidedAt) =>
      withDirectory("clock", (directory) =>
        withStore(join(directory, "capture.sqlite"), (store) => {
          const committed = commitFoundationCaptureContext(store, {
            candidate: candidate(),
            decidedAt,
          });
          if (!committed.ok) throw new Error(`commit refused: ${committed.code}`);
          return { bytes: [...committed.bytes], captureRef: committed.captureRef };
        })));
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual(commits[1]);
  });

  /**
   * NO MODULE-GLOBAL MAP CARRIES THE CONTEXT.
   *
   * THE ORDER HERE IS LOAD-BEARING AND WAS FOUND BY DRILLING. The obvious
   * version of this test — commit into one store, then read a FRESH store —
   * survives a real module-level cache, because the commit path returns
   * COMMITTED without reading and so never populates one. The read against the
   * WRITTEN store has to happen FIRST, so that any cache is warm before the
   * fresh-store read demands ABSENT. A cache added to the reader reddens this
   * test only in this order.
   */
  it("answers absent from a fresh store even after a warm successful read", () => {
    withDirectory("no-global", (directory) => {
      const committed = withStore(join(directory, "written.sqlite"), (store) =>
        commitFoundationCaptureContext(store, { candidate: candidate(), decidedAt: DECIDED_AT }));
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      const warm = withStore(join(directory, "written.sqlite"), (store) =>
        readFoundationCaptureContext(store, committed.captureRef));
      expect(warm.ok).toBe(true);
      const elsewhere = withStore(join(directory, "empty.sqlite"), (store) =>
        readerRefusal(readFoundationCaptureContext(store, committed.captureRef)));
      expect(elsewhere).toEqual({
        code: "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT",
        codecCode: null,
        layer: DAEMON_FOUNDATION_CAPTURE_READER,
      });
    });
  });

  it("names the command kind the store is asked to decide", () => {
    expect(FOUNDATION_CAPTURE_CONTEXT_COMMAND_KIND).toBe("foundation.capture-context.seal");
    expect(FOUNDATION_CAPTURE_CONTEXT_EVENT_TYPE).toBe("foundation.capture-context.sealed.v1");
  });
});

// --- hostile history ---------------------------------------------------------

describe("foundation capture context hostile history", () => {
  /**
   * EVERY CASE PERTURBS A GENUINE STORED EVENT, so the fixture is a real row the
   * store wrote rather than a hand-built shape that may not resemble one.
   */
  it("answers absent, ambiguous, wrong-type, unreadable and mis-bound apart", () => {
    withDirectory("hostile", (directory) => {
      const { captureRef, event } = realStoredEvent(directory);
      // One hex character inside a bound digest VALUE: the bytes stay valid JSON
      // and the field stays 64-hex, so every structural guard still passes and
      // only the record-digest binding can catch the edit.
      const forged = new TextDecoder().decode(event.payload)
        .replace('"reservationDigest":"e', '"reservationDigest":"f');
      const tampered = new TextEncoder().encode(forged);
      expect(tampered).not.toEqual(event.payload);
      const cases: readonly (readonly [string, readonly StoredEvent[], string, string, string | null])[] = [
        ["absent", [], captureRef, "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT", null],
        ["ambiguous", [event, event], captureRef,
          "FOUNDATION_CAPTURE_CONTEXT_READER_AMBIGUOUS", null],
        ["a foreign event type", [{ ...event, eventType: "foundation.other.v1" }], captureRef,
          "FOUNDATION_CAPTURE_CONTEXT_READER_EVENT_TYPE_UNEXPECTED", null],
        ["a truncated payload", [{ ...event, payload: event.payload.slice(0, 12) }], captureRef,
          "FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE",
          "FOUNDATION_CAPTURE_CONTEXT_MALFORMED"],
        ["a forged payload byte", [{ ...event, payload: tampered }], captureRef,
          "FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE",
          "FOUNDATION_CAPTURE_CONTEXT_RECORD_DIGEST_MISMATCH"],
        ["a foreign aggregate", [{ ...event, aggregateId: "foundation-elsewhere" }], captureRef,
          "FOUNDATION_CAPTURE_CONTEXT_READER_BINDING_MISMATCH", null],
        ["a reordered sequence", [{ ...event, aggregateSequence: 2 }], captureRef,
          "FOUNDATION_CAPTURE_CONTEXT_READER_BINDING_MISMATCH", null],
        ["a foreign schema version", [{ ...event, domainSchemaVersion: "moe-other/1" }], captureRef,
          "FOUNDATION_CAPTURE_CONTEXT_READER_BINDING_MISMATCH", null],
      ];
      expect(cases).toHaveLength(8);
      for (const [name, events, ref, code, codecCode] of cases) {
        const planted = plantedStore(
          events.map((planted) => ({
            ...planted,
            aggregateId: name === "a foreign aggregate"
              ? planted.aggregateId
              : deriveFoundationCaptureAggregateId(ref),
          })),
        );
        expect({ name, ...readerRefusal(readFoundationCaptureContext(planted, ref)) }).toEqual({
          code,
          codecCode,
          layer: DAEMON_FOUNDATION_CAPTURE_READER,
          name,
        });
      }
    });
  });

  /**
   * A RECORD THAT DECODES CLEANLY BUT DESCRIBES ANOTHER ATTEMPT. It is planted on
   * the aggregate the presented ref derives, so every earlier guard passes and
   * only the ref re-derivation can catch it.
   */
  it("refuses a decodable record whose own fields derive a different captureRef", () => {
    withDirectory("ref-mismatch", (directory) => {
      const { event } = realStoredEvent(directory);
      const foreignRef = deriveFoundationCaptureRef({
        attemptAggregateId: ATTEMPT_AGGREGATE_ID,
        attemptId: "attempt-7",
        nodeKey: NODE_KEY,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      });
      const planted = plantedStore([
        { ...event, aggregateId: deriveFoundationCaptureAggregateId(foreignRef) },
      ]);
      expect(readerRefusal(readFoundationCaptureContext(planted, foreignRef))).toEqual({
        code: "FOUNDATION_CAPTURE_CONTEXT_READER_REF_MISMATCH",
        codecCode: null,
        layer: DAEMON_FOUNDATION_CAPTURE_READER,
      });
    });
  });

  it("reports a throwing store as unreadable rather than absent", () => {
    const throwing: FoundationCaptureContextStore = {
      commitExpectedVersionDecision: () => {
        throw new Error("unreachable");
      },
      readEvents: () => {
        throw new Error("database is locked");
      },
    };
    expect(readerRefusal(readFoundationCaptureContext(throwing, "any-ref"))).toEqual({
      code: "FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE",
      codecCode: null,
      layer: DAEMON_FOUNDATION_CAPTURE_READER,
    });
  });
});

// --- adversarial -------------------------------------------------------------

/** A body whose manifest, baseline seal and observation are all rebuilt together,
 *  so the cross-field rules still hold at whatever size is being probed. */
function bodyAtSize(entryCount: number, pathCount: number): Record<string, unknown> {
  const manifest = manifestFor(HEAD_COMMIT, entryCount);
  const declared = pathList(pathCount);
  return {
    ...bodyFor(),
    baselineDigest: manifest.sha256,
    catalogAuthority: { ...catalogAuthorityFor(), declaredPaths: declared },
    inputManifest: manifest,
  };
}

describe("foundation capture context adversarial", () => {
  /**
   * EXACTLY AT THE BOUND IS ADMITTED, ONE PAST IT IS REFUSED. Only the pair
   * proves the comparison is `>` rather than `>=`: an off-by-one guard passes
   * every refusal case on its own and silently rejects a legal record.
   */
  it("admits a record sitting exactly on every published limit", () => {
    const limits = FOUNDATION_CAPTURE_CONTEXT_LIMITS;
    const encoded = encodeFoundationCaptureContext(
      stamp(bodyAtSize(limits.inputEntries, limits.declaredPaths)),
    );
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.record.inputManifest.entries).toHaveLength(limits.inputEntries);
    expect(encoded.record.catalogAuthority.declaredPaths).toHaveLength(limits.declaredPaths);
  });

  it("refuses one entry past the bound, and refuses it as over-limit", () => {
    const limits = FOUNDATION_CAPTURE_CONTEXT_LIMITS;
    expect(refusalOf(stamp(bodyAtSize(limits.inputEntries + 1, limits.declaredPaths)))).toEqual({
      code: "FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED",
      layer: DAEMON_FOUNDATION_CAPTURE,
    });
  });

  /**
   * FOUR THOUSAND NINETY-SIX ENTRIES. This is the case that forced the
   * pre-snapshot descriptor length read: the shared snapshot walker refuses any
   * array past its own generic ceiling, so without that read this record would
   * come back MALFORMED and an operator would never learn it was merely too big.
   */
  it("names a four-thousand-entry manifest over-limit, not merely malformed", () => {
    const oversized = {
      ...manifestFor(),
      entries: Array.from({ length: 4_096 }, (_unused, index) => ({
        byteLength: 1,
        path: `src/huge-${index}.ts`,
        producer: { kind: "BASE" },
        sha256: "5".repeat(64),
      })),
    };
    expect(refusalOf(candidate({ inputManifest: oversized }))).toEqual({
      code: "FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED",
      layer: DAEMON_FOUNDATION_CAPTURE,
    });
  });

  /** An accessor at the DEEPEST bound container, inside an observed entry. */
  it("refuses an accessor smuggled into an observed entry, three levels down", () => {
    const observation = observationFor();
    const [first] = observation.canonicalEntries;
    if (first === undefined) throw new Error("fixture observation has no entries");
    const smuggled = Object.defineProperty({ ...first }, "attribution", {
      enumerable: true,
      get: () => "CLEAN",
    });
    expect(refusalOf(candidate({
      observation: { ...observation, canonicalEntries: [smuggled, ...observation.canonicalEntries.slice(1)] },
    }))).toEqual({
      code: "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
      layer: DAEMON_FOUNDATION_CAPTURE,
    });
  });

  /**
   * EVERY MEMBER OF THE TEXT ROSTER, ONE AT A TIME.
   *
   * The production guard is a single `.every()` over a key list, so a case that
   * blanks only one field proves that ONE member is enforced and says nothing
   * about the other six: deleting any other member from the list would leave
   * such a suite green. The roster below is hand-written rather than imported —
   * an imported expected list moves with the mutant and goes vacuous.
   */
  it("refuses a blank value in each of the seven bound text fields", () => {
    const keys = [
      "attemptAggregateId",
      "attemptId",
      "nodeKey",
      "observedAt",
      "projectId",
      "recordDigest",
      "sessionId",
    ] as const;
    expect(keys).toHaveLength(7);
    for (const key of keys) {
      expect({ key, ...refusalOf({ ...candidate(), [key]: "" }) }).toEqual({
        code: "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
        key,
        layer: DAEMON_FOUNDATION_CAPTURE,
      });
    }
  });

  /** The same argument for the digest roster: each member proved on its own. */
  it("refuses a non-digest in each of the three bound digest fields", () => {
    const keys = ["baselineDigest", "requestDigest", "reservationDigest"] as const;
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect({ key, ...refusalOf(candidate({ [key]: "not-a-digest" })) }).toEqual({
        code: "FOUNDATION_CAPTURE_CONTEXT_UNSEALED",
        key,
        layer: DAEMON_FOUNDATION_CAPTURE,
      });
    }
  });

  /**
   * THE PROJECT AGREEMENT IS TWO CLAUSES, NOT ONE. Moving the record's own
   * projectId trips BOTH halves at once, so that case cannot tell whether the
   * assignment half is enforced. This one moves ONLY the assignment's copy.
   */
  it("refuses an assignment whose project disagrees, with the record left alone", () => {
    expect(refusalOf(candidate({
      assignment: { ...assignmentFor(), projectId: "proj-other" },
    }))).toEqual({
      code: "FOUNDATION_CAPTURE_CONTEXT_FIELD_MISMATCH",
      layer: DAEMON_FOUNDATION_CAPTURE,
    });
  });

  it("refuses an extra key on each of the two sealed upstream containers", () => {
    const containers: readonly (readonly [string, Record<string, unknown>])[] = [
      ["inputManifest", { ...manifestFor(), extra: 1 }],
      ["observation", { ...observationFor(), extra: 1 }],
    ];
    expect(containers).toHaveLength(2);
    for (const [key, value] of containers) {
      expect({ key, ...refusalOf(candidate({ [key]: value })) }).toEqual({
        code: "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
        key,
        layer: DAEMON_FOUNDATION_CAPTURE,
      });
    }
  });

  /** `adopted` is the one non-string assignment field; a string must not pass. */
  it("refuses an assignment whose adopted flag is not a boolean", () => {
    expect(refusalOf(candidate({
      assignment: { ...assignmentFor(), adopted: "false" },
    }))).toEqual({
      code: "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
      layer: DAEMON_FOUNDATION_CAPTURE,
    });
  });

  /**
   * INTERLEAVED, NOT MERELY SEQUENTIAL. Both attempts are sealed, then BOTH are
   * re-sealed, then both are read. A shared aggregate or a shared command id
   * would surface as the second re-seal conflicting or as a read crossing over,
   * neither of which a write-read-write-read order would notice.
   */
  it("holds isolation when two attempts are sealed and re-sealed interleaved", () => {
    withDirectory("interleaved", (directory) => {
      withStore(join(directory, "capture.sqlite"), (store) => {
        const other = { assignment: assignmentFor2(), attemptId: "attempt-2" };
        const seal = (overrides: Readonly<Record<string, unknown>> = {}) =>
          commitFoundationCaptureContext(store, {
            candidate: candidate(overrides),
            decidedAt: DECIDED_AT,
          });
        const firstA = seal();
        const firstB = seal(other);
        const againA = seal();
        const againB = seal(other);
        expect([firstA.ok, firstB.ok, againA.ok, againB.ok]).toEqual([true, true, true, true]);
        if (!firstA.ok || !firstB.ok || !againA.ok || !againB.ok) return;
        expect([firstA.disposition, firstB.disposition]).toEqual(["COMMITTED", "COMMITTED"]);
        expect([againA.disposition, againB.disposition]).toEqual(["REPLAYED", "REPLAYED"]);
        expect([...againA.bytes]).toEqual([...firstA.bytes]);
        expect([...againB.bytes]).toEqual([...firstB.bytes]);
        expect(againA.captureRef).not.toBe(againB.captureRef);
        expect(store.readEvents(firstA.aggregateId)).toHaveLength(1);
        expect(store.readEvents(firstB.aggregateId)).toHaveLength(1);
        expect(againA.record.attemptId).toBe(ATTEMPT_ID);
        expect(againB.record.attemptId).toBe("attempt-2");
      });
    });
  });
});

/** The second attempt's assignment; its own attemptId, so the record agrees. */
function assignmentFor2(): Record<string, unknown> {
  return { ...assignmentFor(), attemptId: "attempt-2" };
}
