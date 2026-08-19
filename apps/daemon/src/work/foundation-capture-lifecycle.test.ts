/**
 * The Foundation prepare-before-launch lifecycle, over REAL authorities.
 *
 * NOTHING UNDER TEST IS FAKED. The store is a file-backed `SqliteEventStore`,
 * the repositories are real temp Git repositories, and the worktree
 * materializer, capture filesystem and scope observers are the shipped Node
 * adapters. Where an invocation COUNT is asserted the production port is
 * WRAPPED — every call still reaches the real adapter and its answer is
 * returned untouched. A replacement would let this suite prove composition
 * against a port that cannot refuse.
 *
 * REAL GIT NEEDS SHA-256 OBJECTS HERE, and that is a measured constraint rather
 * than a preference: the durable observation validator demands a 64-hex
 * `baseRevisionHash`, while `deriveWorktreeTarget` admits 40- OR 64-hex. A
 * default sha1 repository yields a 40-hex head that the durable bind refuses,
 * so a fixture whose head must ALSO be bindable as the current observation can
 * only be created with `--object-format=sha256`.
 *
 * EVERY REFUSAL PINS CODE **AND** LAYER. Six authorities can refuse here
 * (catalog, resolution, worktree, hydrator, capture, ledger) and each keeps its
 * own vocabulary verbatim; asserting only the code would let a refusal migrate
 * between layers unnoticed, which is precisely what "preserve upstream refusal
 * code and layer" has to be tested for.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNodeFoundationCaptureFs, createNodeGitObserver, createNodeScopePaths,
  createNodeWorktreeMaterializer, hermeticGitEnvironment,
} from "@moe/runner";
import type {
  FoundationCaptureFsPort, FoundationCaptureStat, GitObserver, ScopePathObserver,
  WorktreeMaterializationRequest, WorktreeMaterializationResult, WorktreeMaterializer,
  WorktreeReleaseRequest, WorktreeReleaseResult,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import { PROJECT_ID, decisionCount, envelope, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { cleanupRestoreHarnesses, openHarnessStore } from "../recovery/restore-test-harness.js";
import { DAEMON_FOUNDATION_CAPTURE } from "./foundation-capture-context-contract.js";
import {
  deriveFoundationCaptureAggregateId, deriveFoundationCaptureRef, readFoundationCaptureContext,
} from "./foundation-capture-context-ledger.js";
import {
  FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
} from "./foundation-repository-scope-contracts.js";
import * as lifecycleSurface from "./foundation-capture-lifecycle.js";
import {
  FOUNDATION_CAPTURE_LIFECYCLE_CODES, createFoundationCaptureLifecycle,
  readFoundationCatalogConfig,
} from "./foundation-capture-lifecycle.js";
import type {
  FoundationCaptureLifecycle, FoundationCaptureLifecycleCode, PrepareCaptureInput,
  PrepareCaptureResult,
} from "./foundation-capture-lifecycle.js";

const CASE_TIMEOUT = { timeout: 30_000 } as const;

/** Read OUT of the declared vocabulary: a literal stays green when a member is
 *  renamed or dropped, which is the drift a closed code list exists to catch. */
function code(wanted: string): FoundationCaptureLifecycleCode {
  const found = FOUNDATION_CAPTURE_LIFECYCLE_CODES.find((entry) => entry === wanted);
  if (found === undefined) throw new Error(`${wanted} is not in the closed lifecycle vocabulary`);
  return found;
}

const scratchRoots: string[] = [];

afterEach(() => { cleanupRestoreHarnesses(); });
afterAll(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    // 20x250ms, matching the Windows suite's measured value: under full-fleet
    // parallelism a trailing git/scanner handle holds a scratch root well past
    // 5x100ms, and a failed removal leaks a temp directory on every run.
    if (root !== undefined) {
      rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
    }
  }
});

function scratch(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `moe-capture-lifecycle-${label}-`)));
  scratchRoots.push(root);
  return root;
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8", env: hermeticGitEnvironment(process.env),
    shell: false, windowsHide: true,
  }).trim();
}

interface RepositoryFixture {
  readonly head: string;
  readonly paths: readonly string[];
  readonly root: string;
  readonly worktreeParent: string;
}

/**
 * A sha256-object repository whose head is therefore 64 hex and bindable as a
 * durable observation. `core.autocrlf=false` is not decoration: a checkout that
 * rewrote line endings would make the materialized worktree's bytes differ from
 * the committed bytes, and the prelaunch proof would refuse a tree that is in
 * fact correct.
 */
function repositoryFixture(label: string): RepositoryFixture {
  const root = scratch(`repo-${label}`);
  const paths = ["scope/alpha.txt", "scope/beta.txt"] as const;
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, paths[0]), Buffer.from("alpha\n", "utf8"));
  writeFileSync(join(root, paths[1]), Buffer.from("beta\n", "utf8"));
  runGit(root, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  runGit(root, ["add", "--", ...paths]);
  runGit(root, [
    "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "foundation base",
  ]);
  return {
    head: runGit(root, ["rev-parse", "HEAD"]), paths, root,
    worktreeParent: scratch(`parent-${label}`),
  };
}

const REPOSITORY_REF = "repo-1";
const SCOPE_REF = "scope-1";
/** FILE paths, not the containing directory: the hydrator reads every declared
 *  path as a file and refuses a directory as UNREADABLE. */
const DECLARED_PATHS = ["scope/alpha.txt", "scope/beta.txt"] as const;

/** Registered then bound through the REAL bootstrap seam, never a planted row. */
function boundStore(label: string, fixture: RepositoryFixture): SqliteEventStore {
  const store = openHarnessStore(join(scratch(`store-${label}`), "project.db"));
  const registered = send(store, envelope("project.register", 0, { owner: "owner-1" }));
  if (!registered.ok) throw new Error(`fixture register refused: ${registered.code}`);
  const version = versionOf(readDurableLedger(store, PROJECT_ID), PROJECT_ID);
  const bound = send(store, envelope("project.bind_repository", version, {
    observation: {
      baseRevisionHash: fixture.head, repositoryRef: REPOSITORY_REF, scopeRef: SCOPE_REF,
      truthClass: "DAEMON_VERIFIED",
    },
  }, "cmd-bind-fixture"));
  if (!bound.ok) throw new Error(`fixture bind refused: ${bound.code}`);
  return store;
}

function catalogEntry(
  fixture: RepositoryFixture, overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    declaredPaths: [...DECLARED_PATHS], projectId: PROJECT_ID, repositoryRef: REPOSITORY_REF,
    scopeRef: SCOPE_REF, sourceRepositoryRoot: fixture.root, worktreeParent: fixture.worktreeParent,
    ...overrides,
  };
}

function catalogInput(entries: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION, entries };
}

interface Counters {
  hydrations: number;
  materializations: number;
  releases: number;
  scans: number;
}

/**
 * WRAPPERS, not fakes. Each delegates to the shipped adapter and returns its
 * answer untouched; only the call is counted. `listDirectory` is the scanner's
 * own entry into the tree, so counting it counts prelaunch scans without the
 * scanner knowing it is observed.
 */
function countingMaterializer(counters: Counters): WorktreeMaterializer {
  const real = createNodeWorktreeMaterializer(process.env);
  return Object.freeze({
    materialize: (request: WorktreeMaterializationRequest): WorktreeMaterializationResult => {
      counters.materializations += 1;
      return real.materialize(request);
    },
    release: (request: WorktreeReleaseRequest): WorktreeReleaseResult => {
      counters.releases += 1;
      return real.release(request);
    },
  });
}

function countingCaptureFs(counters: Counters): FoundationCaptureFsPort {
  const real = createNodeFoundationCaptureFs();
  return Object.freeze({
    ...real,
    lstatPath: (path: string): FoundationCaptureStat => {
      counters.scans += 1;
      return real.lstatPath(path);
    },
  });
}

function countingObservers(counters: Counters): (root: string) => {
  readonly gitObserver: GitObserver; readonly pathObserver: ScopePathObserver;
} {
  return (root: string) => {
    counters.hydrations += 1;
    return {
      gitObserver: createNodeGitObserver(root, hermeticGitEnvironment(process.env)),
      pathObserver: createNodeScopePaths(),
    };
  };
}

interface Harness {
  readonly counters: Counters;
  readonly lifecycle: FoundationCaptureLifecycle;
  readonly store: SqliteEventStore;
}

interface HarnessOptions {
  /** Supplied verbatim; an explicit `undefined` models ABSENT configuration. */
  readonly catalog?: unknown;
  readonly catalogThrows?: boolean;
}

function harness(label: string, fixture: RepositoryFixture, options: HarnessOptions = {}): Harness {
  const store = boundStore(label, fixture);
  const counters: Counters = { hydrations: 0, materializations: 0, releases: 0, scans: 0 };
  const catalog = "catalog" in options ? options.catalog : catalogInput([catalogEntry(fixture)]);
  const lifecycle = createFoundationCaptureLifecycle({
    captureFs: countingCaptureFs(counters),
    catalogSource: (): unknown => {
      if (options.catalogThrows === true) throw new Error("configuration unreadable");
      return catalog;
    },
    clock: () => "2026-08-19T00:00:00.000Z",
    materializer: countingMaterializer(counters),
    observers: countingObservers(counters),
    store,
  });
  return { counters, lifecycle, store };
}

const ATTEMPT_AGGREGATE_ID = "agg-lifecycle-1";
const ATTEMPT_ID = "attempt-1";
const NODE_KEY = "dev-done";
const SESSION_ID = "session-1";
const REQUEST_DIGEST = "d".repeat(64);
const RESERVATION_DIGEST = "e".repeat(64);

function prepareInput(
  fixture: RepositoryFixture, overrides: Partial<PrepareCaptureInput> = {},
): PrepareCaptureInput {
  return {
    attemptAggregateId: ATTEMPT_AGGREGATE_ID, attemptId: ATTEMPT_ID, nodeKey: NODE_KEY,
    projectId: PROJECT_ID, proposedBaseIdentity: fixture.head, proposedCwd: null,
    proposedEntries: [], requestDigest: REQUEST_DIGEST, reservationDigest: RESERVATION_DIGEST,
    sessionId: SESSION_ID, ...overrides,
  };
}

const slotOf = (input: PrepareCaptureInput): {
  readonly attemptAggregateId: string; readonly attemptId: string; readonly nodeKey: string;
  readonly projectId: string; readonly sessionId: string;
} => ({
  attemptAggregateId: input.attemptAggregateId, attemptId: input.attemptId,
  nodeKey: input.nodeKey, projectId: input.projectId, sessionId: input.sessionId,
});

const refusalOf = (result: PrepareCaptureResult): readonly string[] =>
  result.ok ? ["ACCEPTED", "ACCEPTED"] : [result.code, result.layer];

/** The durable event count on the capture slot's own derived aggregate. */
function captureEventCount(store: SqliteEventStore, input: PrepareCaptureInput): number {
  return store.readEvents(
    deriveFoundationCaptureAggregateId(deriveFoundationCaptureRef(slotOf(input)))).length;
}

describe("prepareCapture accepted control", CASE_TIMEOUT, () => {
  it("resolves, materializes, hydrates, proves and commits one durable context", async () => {
    const fixture = repositoryFixture("accepted");
    const { counters, lifecycle, store } = harness("accepted", fixture);
    const input = prepareInput(fixture);
    const decisionsBefore = decisionCount(store);
    expect(captureEventCount(store, input)).toBe(0);

    const prepared = await lifecycle.prepareCapture(input);
    if (!prepared.ok) throw new Error(`unexpected refusal ${prepared.code}@${prepared.layer}`);

    // The assignment is the materializer's own, detached at the exact durable base.
    expect(prepared.assignment.baseIdentity).toBe(fixture.head);
    expect(prepared.assignment.adopted).toBe(false);
    expect(prepared.assignment.realWorktreeParent).toBe(fixture.worktreeParent);
    expect(runGit(prepared.assignment.realWorktreePath, ["rev-parse", "HEAD"])).toBe(fixture.head);

    // Hydration read the REAL bytes of the materialized tree, not the source repo.
    expect(prepared.inputManifest.entries.map((entry) => entry.path)).toEqual([...fixture.paths]);
    expect(prepared.inputManifest.baseIdentity).toBe(fixture.head);
    expect(prepared.observation.worktreeIdentity).toBe(prepared.assignment.realWorktreePath);

    // The proof is the runner's own, sealed over the scanned tree.
    if (prepared.proof === null) throw new Error("an accepted preparation carries its proof");
    expect(prepared.proof.realRoot).toBe(prepared.assignment.realWorktreePath);
    expect(prepared.proof.scannedEntryCount).toBe(fixture.paths.length);

    // The durable context is readable BY THE DERIVED REF and equals what prepare answered.
    expect(prepared.captureRef).toBe(deriveFoundationCaptureRef(slotOf(input)));
    const read = readFoundationCaptureContext(store, prepared.captureRef);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toEqual(prepared.record);
    expect(read.record.baselineDigest).toBe(prepared.inputManifest.sha256);
    expect(read.record.catalogAuthority.declaredPaths).toEqual([...DECLARED_PATHS]);

    // RAW COUNTS, each moved by exactly the expected amount.
    expect(counters.materializations).toBe(1);
    expect(counters.hydrations).toBe(1);
    expect(counters.scans).toBeGreaterThan(0);
    expect(counters.releases).toBe(0);
    expect(captureEventCount(store, input)).toBe(1);
    expect(decisionCount(store) - decisionsBefore).toBe(1);
    expect(prepared.disposition).toBe("COMMITTED");
    expect(Object.isFrozen(prepared.assignment)).toBe(true);
  });
});

describe("catalog configuration refuses without touching the workspace", CASE_TIMEOUT, () => {
  it("refuses an ABSENT configuration with zero authority invocations", async () => {
    const fixture = repositoryFixture("absent");
    const { counters, lifecycle, store } = harness("absent", fixture, { catalog: undefined });
    const input = prepareInput(fixture);
    const decisionsBefore = decisionCount(store);

    const result = await lifecycle.prepareCapture(input);

    expect(refusalOf(result))
      .toEqual([code("FOUNDATION_CAPTURE_CATALOG_CONFIG_ABSENT"), DAEMON_FOUNDATION_CAPTURE]);
    expect([counters.materializations, counters.hydrations, counters.scans]).toEqual([0, 0, 0]);
    expect(readdirSync(fixture.worktreeParent)).toEqual([]);
    expect(captureEventCount(store, input)).toBe(0);
    expect(decisionCount(store)).toBe(decisionsBefore);
  });

  it("refuses an UNREADABLE configuration under its own code", async () => {
    const fixture = repositoryFixture("unreadable");
    const { counters, lifecycle } = harness("unreadable", fixture, { catalogThrows: true });

    expect(refusalOf(await lifecycle.prepareCapture(prepareInput(fixture))))
      .toEqual([code("FOUNDATION_CAPTURE_CATALOG_CONFIG_UNREADABLE"), DAEMON_FOUNDATION_CAPTURE]);
    expect(counters.materializations).toBe(0);
  });

  it("keeps the CATALOG CODEC's own refusal code and layer verbatim", async () => {
    const fixture = repositoryFixture("invalid");
    const { counters, lifecycle } = harness("invalid", fixture, {
      catalog: {
          catalogVersion: `${FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION}-unsupported`,
        entries: [catalogEntry(fixture)],
      },
    });

    expect(refusalOf(await lifecycle.prepareCapture(prepareInput(fixture)))).toEqual([
      "FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION_UNSUPPORTED",
      "DAEMON_REPOSITORY_SCOPE_CATALOG",
    ]);
    expect(counters.materializations).toBe(0);
  });

  it("refuses when the catalog names NO entry for the project", async () => {
    const fixture = repositoryFixture("entry-absent");
    const { lifecycle } = harness("entry-absent", fixture, {
      catalog: catalogInput([catalogEntry(fixture, { projectId: "project-other" })]),
    });

    expect(refusalOf(await lifecycle.prepareCapture(prepareInput(fixture))))
      .toEqual([code("FOUNDATION_CAPTURE_CATALOG_ENTRY_ABSENT"), DAEMON_FOUNDATION_CAPTURE]);
  });

  it("refuses an AMBIGUOUS project entry instead of taking the first", async () => {
    const fixture = repositoryFixture("ambiguous");
    const { lifecycle } = harness("ambiguous", fixture, {
      catalog: catalogInput([
        catalogEntry(fixture), catalogEntry(fixture, { scopeRef: "scope-2" }),
      ]),
    });

    expect(refusalOf(await lifecycle.prepareCapture(prepareInput(fixture))))
      .toEqual([code("FOUNDATION_CAPTURE_CATALOG_ENTRY_AMBIGUOUS"), DAEMON_FOUNDATION_CAPTURE]);
  });

  it("keeps RESOLUTION's own refusal when the proposed base is not the durable one", async () => {
    const fixture = repositoryFixture("base-mismatch");
    const { counters, lifecycle } = harness("base-mismatch", fixture);

    const result = await lifecycle.prepareCapture(
      prepareInput(fixture, { proposedBaseIdentity: "a".repeat(64) }));

    expect(refusalOf(result)).toEqual([
      "FOUNDATION_REPOSITORY_SCOPE_BASE_REVISION_MISMATCH", "DAEMON_REPOSITORY_SCOPE_RESOLUTION",
    ]);
    expect(counters.materializations).toBe(0);
  });
});

describe("a caller proposal can refuse but can never select", CASE_TIMEOUT, () => {
  it("refuses a cwd proposal that disagrees with the assigned root", async () => {
    const fixture = repositoryFixture("cwd");
    const { counters, lifecycle, store } = harness("cwd", fixture);
    const input = prepareInput(fixture, { proposedCwd: join(fixture.root, "elsewhere") });

    const result = await lifecycle.prepareCapture(input);

    expect(refusalOf(result))
      .toEqual([code("FOUNDATION_CAPTURE_WORKSPACE_MISMATCH"), DAEMON_FOUNDATION_CAPTURE]);
    // The tree is materialized before a proposal can be compared against it, so
    // the residue rule is the interesting half: nothing unowned is left behind.
    expect(counters.materializations).toBe(1);
    expect(readdirSync(fixture.worktreeParent)).toEqual([]);
    expect(captureEventCount(store, input)).toBe(0);
  });

  it("refuses an input entry that disagrees with the hydrated bytes", async () => {
    const fixture = repositoryFixture("entries");
    const { lifecycle, store } = harness("entries", fixture);
    const input = prepareInput(fixture, {
      proposedEntries: [{
        byteLength: 6, path: "scope/alpha.txt", producer: { kind: "BASE" }, sha256: "b".repeat(64),
      }],
    });

    expect(refusalOf(await lifecycle.prepareCapture(input)))
      .toEqual([code("FOUNDATION_CAPTURE_WORKSPACE_MISMATCH"), DAEMON_FOUNDATION_CAPTURE]);
    expect(readdirSync(fixture.worktreeParent)).toEqual([]);
    expect(captureEventCount(store, input)).toBe(0);
  });

  it("ACCEPTS proposals that agree with the hydrated authority", async () => {
    const fixture = repositoryFixture("agree");
    const { lifecycle } = harness("agree", fixture);
    const first = await lifecycle.prepareCapture(prepareInput(fixture));
    if (!first.ok) throw new Error(`unexpected refusal ${first.code}@${first.layer}`);

    // A SECOND slot, so the agreeing proposal is proven on a fresh preparation
    // rather than answered by the replay path.
    const second = await lifecycle.prepareCapture(prepareInput(fixture, {
      attemptId: "attempt-2",
      proposedEntries: first.inputManifest.entries.map((entry) => ({ ...entry })),
    }));
    if (!second.ok) throw new Error(`unexpected refusal ${second.code}@${second.layer}`);

    expect(second.inputManifest.sha256).toBe(first.inputManifest.sha256);
    expect(second.assignment.realWorktreePath).not.toBe(first.assignment.realWorktreePath);

    // A cwd proposal naming the assignment the lifecycle itself derived is admitted.
    const third = await lifecycle.prepareCapture(prepareInput(fixture, {
      attemptId: "attempt-3", proposedCwd: null,
    }));
    if (!third.ok) throw new Error(`unexpected refusal ${third.code}@${third.layer}`);
    const fourth = await lifecycle.prepareCapture(prepareInput(fixture, {
      attemptId: "attempt-3", proposedCwd: third.assignment.realWorktreePath,
    }));
    expect(fourth.ok).toBe(true);
  });
});

describe("replay is byte-identical and divergence is refused", CASE_TIMEOUT, () => {
  it("answers the DURABLE context with zero new materialize/hydrate/scan calls", async () => {
    const fixture = repositoryFixture("replay");
    const { counters, lifecycle, store } = harness("replay", fixture);
    const input = prepareInput(fixture);

    const first = await lifecycle.prepareCapture(input);
    if (!first.ok) throw new Error(`unexpected refusal ${first.code}@${first.layer}`);
    const after = {
      hydrations: counters.hydrations, materializations: counters.materializations,
      scans: counters.scans,
    };
    const decisionsBefore = decisionCount(store);

    const second = await lifecycle.prepareCapture(input);
    if (!second.ok) throw new Error(`unexpected refusal ${second.code}@${second.layer}`);

    expect(second.disposition).toBe("REPLAYED");
    expect(second.record).toEqual(first.record);
    expect(second.record.recordDigest).toBe(first.record.recordDigest);
    expect(second.captureRef).toBe(first.captureRef);
    expect([counters.materializations, counters.hydrations, counters.scans])
      .toEqual([after.materializations, after.hydrations, after.scans]);
    expect(captureEventCount(store, input)).toBe(1);
    expect(decisionCount(store)).toBe(decisionsBefore);
  });

  it("PRESERVES the first bytes and refuses a diverging re-preparation", async () => {
    const fixture = repositoryFixture("diverged");
    const { counters, lifecycle, store } = harness("diverged", fixture);
    const input = prepareInput(fixture);
    const first = await lifecycle.prepareCapture(input);
    if (!first.ok) throw new Error(`unexpected refusal ${first.code}@${first.layer}`);
    const materializationsAfterFirst = counters.materializations;

    const diverged = await lifecycle.prepareCapture(
      prepareInput(fixture, { requestDigest: "9".repeat(64) }));

    expect(refusalOf(diverged))
      .toEqual([code("FOUNDATION_CAPTURE_PREPARATION_DIVERGED"), DAEMON_FOUNDATION_CAPTURE]);
    const read = readFoundationCaptureContext(store, first.captureRef);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toEqual(first.record);
    expect(counters.materializations).toBe(materializationsAfterFirst);
    expect(captureEventCount(store, input)).toBe(1);
  });
});

describe("parallel preparations cannot cross", CASE_TIMEOUT, () => {
  it("keeps immutable captureRefs and distinct worktrees per attempt", async () => {
    const fixture = repositoryFixture("parallel");
    const { lifecycle, store } = harness("parallel", fixture);
    const left = prepareInput(fixture, { attemptId: "attempt-left" });
    const right = prepareInput(fixture, { attemptId: "attempt-right" });

    const [first, second] = await Promise.all([
      lifecycle.prepareCapture(left), lifecycle.prepareCapture(right),
    ]);
    if (first === undefined || second === undefined) throw new Error("a preparation is missing");
    if (!first.ok || !second.ok) throw new Error("a parallel preparation refused");

    expect(first.captureRef).not.toBe(second.captureRef);
    expect(first.captureRef).toBe(deriveFoundationCaptureRef(slotOf(left)));
    expect(second.captureRef).toBe(deriveFoundationCaptureRef(slotOf(right)));
    expect(first.assignment.realWorktreePath).not.toBe(second.assignment.realWorktreePath);
    // Cross-assert: neither durable context carries the other's identities.
    expect(first.record.attemptId).toBe("attempt-left");
    expect(second.record.attemptId).toBe("attempt-right");
    expect(first.record.assignment.realWorktreePath).toBe(first.assignment.realWorktreePath);
    expect(second.record.assignment.realWorktreePath).toBe(second.assignment.realWorktreePath);
    expect(readFoundationCaptureContext(store, first.captureRef).ok).toBe(true);
    expect(readFoundationCaptureContext(store, second.captureRef).ok).toBe(true);
  });
});

describe("release stays fenced on the proven identity", CASE_TIMEOUT, () => {
  it("releases the proven assignment and refuses a forged one, vocabulary verbatim", async () => {
    const fixture = repositoryFixture("release");
    const { counters, lifecycle } = harness("release", fixture);
    const prepared = await lifecycle.prepareCapture(prepareInput(fixture));
    if (!prepared.ok) throw new Error(`unexpected refusal ${prepared.code}@${prepared.layer}`);

    const forged = lifecycle.releaseWorktree({
      assignment: { ...prepared.assignment, leaf: "not-the-derived-leaf" },
      callerIntent: "ATTEMPT_TERMINAL",
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect([forged.code, forged.layer])
      .toEqual(["RUNNER_WORKSPACE_WORKTREE_RELEASE_FENCE_MISMATCH", "WORKTREE_NODE"]);

    const nonTerminal = lifecycle.releaseWorktree({
      assignment: prepared.assignment, callerIntent: "ATTEMPT_ACTIVE",
    });
    expect(nonTerminal.ok).toBe(false);
    if (nonTerminal.ok) return;
    expect(nonTerminal.code).toBe("RUNNER_WORKSPACE_WORKTREE_RELEASE_NOT_TERMINAL");

    const released = lifecycle.releaseWorktree({
      assignment: prepared.assignment, callerIntent: "ATTEMPT_TERMINAL",
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.disposition).toBe("RELEASED");
    expect(readdirSync(fixture.worktreeParent)).toEqual([]);
    expect(counters.releases).toBe(3);
  });

  it("QUARANTINES a tree whose bytes it cannot prove are its own", async () => {
    const fixture = repositoryFixture("quarantine");
    const { lifecycle } = harness("quarantine", fixture);
    const prepared = await lifecycle.prepareCapture(prepareInput(fixture));
    if (!prepared.ok) throw new Error(`unexpected refusal ${prepared.code}@${prepared.layer}`);
    // Detach the tree from its repository WITHOUT deleting the path: git no
    // longer owns it, so release must keep the bytes rather than remove them.
    runGit(fixture.root, ["worktree", "remove", "--force", prepared.assignment.realWorktreePath]);
    mkdirSync(prepared.assignment.realWorktreePath);
    writeFileSync(join(prepared.assignment.realWorktreePath, "stray.txt"), "stray\n");

    const result = lifecycle.releaseWorktree({
      assignment: prepared.assignment, callerIntent: "ATTEMPT_TERMINAL",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disposition).toBe("QUARANTINED");
    expect(readdirSync(prepared.assignment.realWorktreePath)).toEqual(["stray.txt"]);
  });
});

/**
 * The hostile roster. Its LENGTH is asserted before it is swept, because a
 * generator that produced zero cases would otherwise pass this whole describe
 * without testing anything.
 */
const HOSTILE_SLOTS: readonly (readonly [string, Partial<PrepareCaptureInput>])[] = [
  ["empty attemptId", { attemptId: "" }],
  ["empty nodeKey", { nodeKey: "" }],
  ["empty sessionId", { sessionId: "" }],
  ["empty attemptAggregateId", { attemptAggregateId: "" }],
  ["non-digest requestDigest", { requestDigest: "not-a-digest" }],
  ["short reservationDigest", { reservationDigest: "0".repeat(63) }],
  ["non-string base", { proposedBaseIdentity: 42 as unknown as string }],
  ["non-array entries", { proposedEntries: 7 as unknown as readonly unknown[] }],
];

describe("hostile preparation inputs refuse before any authority runs", CASE_TIMEOUT, () => {
  it("sweeps a NONZERO generated roster", () => {
    expect(HOSTILE_SLOTS.length).toBe(8);
  });

  it.each(HOSTILE_SLOTS)("%s refuses as a malformed slot", async (_label, overrides) => {
    const fixture = repositoryFixture("hostile");
    const { counters, lifecycle } = harness("hostile", fixture);

    expect(refusalOf(await lifecycle.prepareCapture(prepareInput(fixture, overrides))))
      .toEqual([code("FOUNDATION_CAPTURE_SLOT_MALFORMED"), DAEMON_FOUNDATION_CAPTURE]);
    expect([counters.materializations, counters.hydrations, counters.scans]).toEqual([0, 0, 0]);
  });
});

describe("the lifecycle module's published surface", () => {
  it("publishes no security-roster layer constant of its own", () => {
    expect(Object.keys(lifecycleSurface).filter((name) => /_(LAYER|LAYERS|BOUNDARIES)$/u.test(name)))
      .toEqual([]);
  });

  it("declares a closed code vocabulary that names the mismatch", () => {
    expect([...FOUNDATION_CAPTURE_LIFECYCLE_CODES])
      .toContain("FOUNDATION_CAPTURE_WORKSPACE_MISMATCH");
    expect(Object.isFrozen(FOUNDATION_CAPTURE_LIFECYCLE_CODES)).toBe(true);
  });

  it("reads an ABSENT catalog path as a lazily refusing source, never a boot fault", () => {
    expect(readFoundationCatalogConfig({})()).toBeUndefined();
    expect(readFoundationCatalogConfig({ MOE_FOUNDATION_WORKSPACE_CATALOG: "" })()).toBeUndefined();
  });

  it("reads a REAL catalog file through the configured path", () => {
    const fixture = repositoryFixture("config");
    const path = join(scratch("config-file"), "catalog.json");
    writeFileSync(path, JSON.stringify(catalogInput([catalogEntry(fixture)])), "utf8");

    const source = readFoundationCatalogConfig({ MOE_FOUNDATION_WORKSPACE_CATALOG: path });

    expect(source()).toEqual(catalogInput([catalogEntry(fixture)]));
  });

  it("REFUSES an oversized catalog without reading it into memory", () => {
    const path = join(scratch("config-huge"), "catalog.json");
    // One byte past the ceiling is the only interesting size: a much larger file
    // would also pass a check that measured AFTER reading.
    writeFileSync(path, Buffer.alloc(1_048_577, 0x20));

    const source = readFoundationCatalogConfig({ MOE_FOUNDATION_WORKSPACE_CATALOG: path });

    expect(() => source()).toThrow("catalog exceeds its byte ceiling");
  });

  it("THROWS from the source when the configured path cannot be read", () => {
    const source = readFoundationCatalogConfig({
      MOE_FOUNDATION_WORKSPACE_CATALOG: join(scratch("config-missing"), "absent.json"),
    });

    expect(() => source()).toThrow();
  });
});
