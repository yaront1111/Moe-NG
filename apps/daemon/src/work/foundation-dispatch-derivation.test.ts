/**
 * The server-side derivation of the two facts `foundation.dispatch` used to take from
 * its caller: the ACTIVE graph snapshot and the sealed workspace input manifest.
 *
 * NOTHING HERE IS SIMULATED. A real file-backed `SqliteEventStore`, the real bootstrap
 * command pipeline for project registration and repository binding, the real graph
 * revision reducer for the ACTIVE revision, and a real git repository on disk for the
 * manifest. A helper that reimplemented any of those would let the derivation pass
 * against facts production never produces.
 *
 * THE FIXTURE REPOSITORY IS SHA-256 ON PURPOSE, and it is the constraint that makes
 * these two authorities composable at all: the durable project observation validates
 * `baseRevisionHash` as 64 hex (`packages/core` project-validation `HASH_64`), while the
 * workspace manifest accepts 40 OR 64 (`baseIdentityRejection`). A default sha-1 `git
 * init` produces a 40-hex HEAD that the durable bind refuses, so the two layers can only
 * agree on a sha-256 repository.
 *
 * The reducer COMMAND INPUT below is restated rather than imported — `@moe/core`'s
 * revision fixtures are test-only and unreachable from its root — but every event, state
 * and lifecycle rule still comes from the production reducer.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reduceGraphRevision } from "@moe/core";
import type { GraphRevisionCommand, GraphRevisionEvent, GraphRevisionState } from "@moe/core";
import { encodeGraphContent } from "@moe/scheduler";
import type { GraphContent, GraphRevisionContent, GraphSnapshot } from "@moe/scheduler";
import { hermeticGitEnvironment } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  OBSERVATION, PROJECT_ID, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  ACTIVE_GRAPH_PROJECTION_LAYER, graphRevisionAggregateId,
} from "../planning/active-graph-projection.js";
import { putGraphBody } from "../planning/graph-body-record.js";
import { deriveFoundationDispatchFacts } from "./foundation-dispatch-derivation.js";
import { FOUNDATION_ATTEMPT_INPUT_KEYS } from "./foundation-attempt-contracts.js";
import { FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION } from "./foundation-repository-scope-contracts.js";

const ENCODER = new TextEncoder();
const SCOPE_PATHS = ["scope/alpha.txt", "scope/beta.txt"] as const;
const roots: string[] = [];

// --- the real repository on disk ---------------------------------------------

interface RepositoryFixture {
  readonly head: string;
  readonly root: string;
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8", env: hermeticGitEnvironment(process.env),
    shell: false, windowsHide: true,
  }).trim();
}

function repositoryFixture(): RepositoryFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-dispatch-derivation-")));
  roots.push(root);
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, SCOPE_PATHS[0]), Buffer.from("alpha\n", "utf8"));
  writeFileSync(join(root, SCOPE_PATHS[1]), Buffer.from("beta\n", "utf8"));
  // sha-256 objects: a 40-hex HEAD cannot be bound durably. See the header.
  runGit(root, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runGit(root, ["add", "--", ...SCOPE_PATHS]);
  runGit(root, [
    "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "dispatch derivation fixture",
  ]);
  return { head: runGit(root, ["rev-parse", "HEAD"]), root };
}

function expectedEntries(fixture: RepositoryFixture) {
  return SCOPE_PATHS.map((path) => {
    const bytes = readFileSync(join(fixture.root, path));
    return {
      byteLength: bytes.byteLength, path, producer: { kind: "BASE" as const },
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

// --- durable seeding, all through production seams ---------------------------

/** Registers the project and binds the repository at the fixture's REAL head. */
function seedProject(store: SqliteEventStore, fixture: RepositoryFixture): void {
  driveThrough(store, "project.bind_repository");
  const outcome = send(store, envelope("project.bind_repository", 1, {
    observation: { ...OBSERVATION, baseRevisionHash: fixture.head },
  }));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
}

function catalogSourceFor(fixture: RepositoryFixture): () => unknown {
  return () => ({
    catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
    entries: [{
      declaredPaths: [...SCOPE_PATHS], projectId: PROJECT_ID,
      repositoryRef: OBSERVATION.repositoryRef, scopeRef: OBSERVATION.scopeRef,
      sourceRepositoryRoot: fixture.root, worktreeParent: fixture.root,
    }],
  });
}

// --- graph revision fixtures (command input only; the reducer owns the rules) --

function baseSnapshot(): GraphSnapshot {
  return {
    completionNodeKey: "dev-c",
    edges: [{ consumerNodeKey: "dev-c", edgeKey: "dev-e1", kind: "HARD", producerNodeKey: "dev-a" }],
    nodes: [{ executionBearing: true, nodeKey: "dev-a" }, { executionBearing: false, nodeKey: "dev-c" }],
  };
}

function encoded(author: string): GraphContent {
  const result = encodeGraphContent({
    author, completionNode: "dev-c", decompositionBudget: 24,
    parentRevision: "rev-000000000000", policyRevision: "pol-000000000001",
    repositoryBaseTree: "4".repeat(40), snapshot: baseSnapshot(),
  } as unknown as GraphRevisionContent);
  if (!result.ok) throw new Error(`fixture failed to encode: ${JSON.stringify(result.issues)}`);
  return result.value;
}

const seededHash = (seed: string): string => seed.repeat(64).slice(0, 64);

function bindingOf(graphHash: string) {
  return {
    budgetHash: seededHash("55"), expectedGoalVersion: 3, graphHash,
    policyHash: seededHash("66"), qualityHash: seededHash("33"),
  } as const;
}

type Step = (current: GraphRevisionState | undefined) => GraphRevisionCommand;
const versionOf = (current: GraphRevisionState | undefined): number =>
  current === undefined ? 0 : current.version;

function activePath(revisionId: string, graphHash: string, activationRef: string): readonly Step[] {
  return [
    () => ({
      commandId: `cmd-create-${revisionId}`, expectedVersion: 0, goalRef: "goal-1",
      graphContentHash: graphHash, kind: "graph_revision.create",
      planHash: seededHash("11"), revisionId,
    }) as GraphRevisionCommand,
    (current) => ({
      commandId: `cmd-submit-${revisionId}`, expectedVersion: versionOf(current),
      kind: "graph_revision.submit",
      witness: { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" },
    }) as GraphRevisionCommand,
    (current) => ({
      activation: {
        ...bindingOf(graphHash), activationRef, graphEpoch: 1, truthClass: "HUMAN_APPROVED",
      },
      approval: { ...bindingOf(graphHash), approvalRef: `approval-${revisionId}`, truthClass: "HUMAN_APPROVED" },
      commandId: `cmd-approve-${revisionId}`, expectedVersion: versionOf(current),
      kind: "graph.approve",
    }) as unknown as GraphRevisionCommand,
  ];
}

function seedActiveRevision(
  store: SqliteEventStore, revisionId: string, content: GraphContent, activationRef: string,
): void {
  let current: GraphRevisionState | undefined;
  const events: GraphRevisionEvent[] = [];
  for (const step of activePath(revisionId, content.graphContentHash, activationRef)) {
    const result = reduceGraphRevision(current, step(current));
    if (!result.ok) throw new Error(`fixture command rejected: ${result.error.code}`);
    current = result.state;
    events.push(...result.events);
  }
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  store.commit({
    aggregateId, commandBytes: ENCODER.encode(`seed-${revisionId}`),
    commandId: `seed-${revisionId}`, committedAt: "2026-08-19T00:00:00.000Z",
    events: events.map((event, index) => ({
      eventId: `seed-${revisionId}-${index}`, eventType: event.kind,
      payload: ENCODER.encode(JSON.stringify(event)),
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
  const stored = putGraphBody(store, PROJECT_ID, content);
  if (!stored.ok) throw new Error(`fixture body refused: ${stored.code}`);
}

// --- the call under test ------------------------------------------------------

function derive(store: SqliteEventStore, fixture: RepositoryFixture, projectId = PROJECT_ID) {
  return deriveFoundationDispatchFacts({
    catalogSource: catalogSourceFor(fixture), projectId, store,
  });
}

afterEach(() => {
  closeStores();
  for (const root of [...roots]) {
    rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    roots.splice(roots.indexOf(root), 1);
  }
});

describe("foundation dispatch derivation", () => {
  it("derives the ACTIVE graph snapshot from the durable revision, with its provenance", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    const content = encoded("human:architect-primary");
    seedActiveRevision(store, "graph-revision-1", content, "activation-1");

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error(derived.code);
    // `content.content` is the ENCODER's projection of the graph; `derived.graphSnapshot`
    // is the projection's read-back of the durable body. Independent operands.
    expect(derived.graphSnapshot).toEqual(content.content.snapshot);
    expect(derived.provenance).toMatchObject({
      graphContentHash: content.graphContentHash, graphEpoch: 1, revisionId: "graph-revision-1",
    });
  });

  it("passes an ABSENT graph refusal through with the projection's OWN layer", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("derivation accepted a project with no ACTIVE graph");
    expect([derived.code, derived.refusedBy])
      .toEqual(["ACTIVE_GRAPH_ABSENT", ACTIVE_GRAPH_PROJECTION_LAYER]);
  });

  it("passes SPLIT_BRAIN through rather than choosing between two ACTIVE revisions", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    seedActiveRevision(store, "graph-revision-1", encoded("human:architect-primary"), "activation-1");
    seedActiveRevision(store, "graph-revision-2", encoded("human:architect-successor"), "activation-2");

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("derivation chose between two ACTIVE revisions");
    expect([derived.code, derived.refusedBy])
      .toEqual(["ACTIVE_GRAPH_SPLIT_BRAIN", ACTIVE_GRAPH_PROJECTION_LAYER]);
  });

  it("seals the input manifest from the SERVER-observed head, in the codec's exact shape", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    seedActiveRevision(store, "graph-revision-1", encoded("human:architect-primary"), "activation-1");

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error(derived.code);
    // The head the SERVER read from the repository, not any value a caller could send.
    expect(derived.inputManifest.baseIdentity).toBe(fixture.head);
    expect(runGit(fixture.root, ["rev-parse", "HEAD"])).toBe(derived.inputManifest.baseIdentity);
    expect(derived.inputManifest.entries).toEqual(expectedEntries(fixture));
    // The sealed manifest carries manifestVersion and sha256 too; the attempt codec's
    // allow-list is exactly two keys, so the derivation must project rather than forward.
    expect(Object.keys(derived.inputManifest).sort())
      .toEqual([...FOUNDATION_ATTEMPT_INPUT_KEYS].sort());
  });

  it("passes a hydrator refusal through with the hydrator's own code and layer", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    seedActiveRevision(store, "graph-revision-1", encoded("human:architect-primary"), "activation-1");
    rmSync(fixture.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    roots.splice(roots.indexOf(fixture.root), 1);

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("derivation sealed a manifest over a missing worktree");
    expect(derived.code).toBe("FOUNDATION_INPUT_WORKTREE_MISSING");
    expect(derived.refusedBy).not.toBe(ACTIVE_GRAPH_PROJECTION_LAYER);
  });

  it("does not return one project's ACTIVE graph when deriving for another", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    seedActiveRevision(store, "graph-revision-1", encoded("human:architect-primary"), "activation-1");

    const derived = derive(store, fixture, "project-2");

    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("derivation crossed a project boundary");
    expect(derived.code).toBe("ACTIVE_GRAPH_ABSENT");
  });
});
