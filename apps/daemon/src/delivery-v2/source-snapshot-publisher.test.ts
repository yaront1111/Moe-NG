import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSourceSnapshot, encodeSourceSnapshot, type SourceSnapshotDraft,
} from "@moe/core";
import {
  RUNNER_SOURCE_SNAPSHOT_GIT_CODES,
  RUNNER_SOURCE_SNAPSHOT_GIT_LAYER,
  hermeticGitEnvironment,
  type SourceSnapshotGitObserved,
  type SourceSnapshotGitObserver,
  type SourceSnapshotGitRefusal,
} from "@moe/runner";
import { DurableStoreError, SqliteEventStore, identifyCorrelation } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_ID, envelope, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import {
  FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
} from "../work/foundation-repository-scope-contracts.js";
import { deriveDeliveryV2SourceSnapshotAggregateId } from
  "./source-snapshot-persistence.js";
import {
  DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_COMMAND_ID_DOMAIN,
  DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_CORRELATION_ID_DOMAIN,
  DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CODES,
  DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_PRINCIPAL_DOMAIN,
  DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER,
  createDeliveryV2SourceSnapshotPublisher,
  deriveDeliveryV2SourceSnapshotPublishCommandId,
  deriveDeliveryV2SourceSnapshotPublishCorrelationId,
  deriveDeliveryV2SourceSnapshotPublisherPrincipalId,
  type DeliveryV2SourceSnapshotPublisherConfig,
} from "./source-snapshot-publisher.js";
import { readDeliveryV2SourceSnapshot } from "./source-snapshot-reader.js";

const BASE = "a".repeat(64);
const SECOND_BASE = "f".repeat(64);
const TREE_A = "b".repeat(64);
const TREE_B = "c".repeat(64);
const REPOSITORY_REF = "repository:main";
const SCOPE_REF = "scope:root";
const DECIDED_AT = "2026-09-01T12:34:56.000Z";

const roots: string[] = [];
const stores = new Set<SqliteEventStore>();

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function track(store: SqliteEventStore): SqliteEventStore {
  stores.add(store);
  return store;
}

afterEach(() => {
  for (const store of stores) {
    try { store.close(); } catch { /* already closed by the test */ }
  }
  stores.clear();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, recursive: true });
  }
});

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: hermeticGitEnvironment(process.env),
    shell: false,
    windowsHide: true,
  }).trim();
}

interface GitFixture {
  readonly head: string;
  readonly root: string;
  readonly tree: string;
}

function sha256Repository(): GitFixture {
  const root = temporaryRoot("moe-source-publisher-repo-");
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, "scope", "source.txt"), "source snapshot\n", "utf8");
  runGit(root, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  runGit(root, ["add", "--", "scope/source.txt"]);
  runGit(root, [
    "-c", "user.name=Moe Source Snapshot",
    "-c", "user.email=source-snapshot@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "source snapshot base",
  ]);
  return Object.freeze({
    head: runGit(root, ["rev-parse", "HEAD"]),
    root,
    tree: runGit(root, ["rev-parse", "HEAD^{tree}"]),
  });
}

function register(store: SqliteEventStore): void {
  const result = send(store, envelope(
    "project.register", 0, { owner: "owner-source-publisher" }, "publisher-register",
  ));
  if (!result.ok) throw new Error(`register refused: ${result.code}`);
}

function bind(
  store: SqliteEventStore,
  baseRevisionHash: string,
  commandId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): void {
  const expectedVersion = versionOf(readDurableLedger(store, PROJECT_ID), PROJECT_ID);
  const result = send(store, envelope("project.bind_repository", expectedVersion, {
    observation: {
      baseRevisionHash,
      repositoryRef: REPOSITORY_REF,
      scopeRef: SCOPE_REF,
      truthClass: "DAEMON_VERIFIED",
      ...overrides,
    },
  }, commandId));
  if (!result.ok) throw new Error(`bind refused: ${result.code}`);
}

function boundStore(baseRevisionHash = BASE): SqliteEventStore {
  const store = track(SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID));
  register(store);
  bind(store, baseRevisionHash, "publisher-bind");
  return store;
}

function catalog(sourceRepositoryRoot: string): unknown {
  return {
    catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
    entries: [{
      declaredPaths: ["scope/source.txt"],
      projectId: PROJECT_ID,
      repositoryRef: REPOSITORY_REF,
      scopeRef: SCOPE_REF,
      sourceRepositoryRoot,
      worktreeParent: temporaryRoot("moe-source-publisher-worktrees-"),
    }],
  };
}

function observed(
  root: string,
  tree = TREE_A,
  baseRevisionHash = BASE,
): SourceSnapshotGitObserved {
  return Object.freeze({
    observation: Object.freeze({
      baseRevisionHash,
      realRepositoryRoot: root,
      repositoryBaseTree: tree,
    }),
    ok: true as const,
  });
}

function publisher(
  store: SqliteEventStore,
  sourceRepositoryRoot: string,
  overrides: Partial<DeliveryV2SourceSnapshotPublisherConfig> = {},
) {
  const rawCatalog = catalog(sourceRepositoryRoot);
  return createDeliveryV2SourceSnapshotPublisher({
    catalogSource: () => rawCatalog,
    clock: () => DECIDED_AT,
    projectId: PROJECT_ID,
    store,
    ...overrides,
  });
}

function draft(rootTree: string, baseRevisionHash = BASE): SourceSnapshotDraft {
  return Object.freeze({
    baseRevisionHash,
    projectId: PROJECT_ID,
    repositoryBaseTree: rootTree,
    repositoryRef: REPOSITORY_REF,
    scopeRef: SCOPE_REF,
  });
}

function snapshot(rootTree: string, baseRevisionHash = BASE) {
  const created = createSourceSnapshot(draft(rootTree, baseRevisionHash));
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.snapshot;
}

function digest(domain: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of [domain, ...parts]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

const local = (code: string) => Object.freeze({
  code,
  layer: DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER,
  ok: false as const,
});

describe("delivery-v2 SourceSnapshot publisher identity", () => {
  it("derives namespaced bounded identities over the exact reviewed preimages", () => {
    const expectedPrincipal = `delivery-v2:source-snapshot-publisher:${digest(
      DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_PRINCIPAL_DOMAIN, PROJECT_ID,
    )}`;
    const expectedCommand = `delivery-v2:source-snapshot-publish-command:${digest(
      DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_COMMAND_ID_DOMAIN,
      PROJECT_ID, REPOSITORY_REF, SCOPE_REF, BASE,
    )}`;
    const material = snapshot(TREE_A);
    const expectedCorrelation = `delivery-v2:source-snapshot-publish-correlation:${digest(
      DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_CORRELATION_ID_DOMAIN,
      PROJECT_ID, material.sourceSnapshotDigest,
    )}`;

    expect(deriveDeliveryV2SourceSnapshotPublisherPrincipalId(PROJECT_ID))
      .toBe(expectedPrincipal);
    expect(deriveDeliveryV2SourceSnapshotPublishCommandId(
      PROJECT_ID, REPOSITORY_REF, SCOPE_REF, BASE,
    )).toBe(expectedCommand);
    expect(deriveDeliveryV2SourceSnapshotPublishCorrelationId(
      PROJECT_ID, material.sourceSnapshotDigest,
    )).toBe(expectedCorrelation);
    expect([expectedPrincipal, expectedCommand, expectedCorrelation].map(
      (value) => Buffer.byteLength(value, "utf8") <= 512,
    )).toStrictEqual([true, true, true]);
    expect([
      DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_PRINCIPAL_DOMAIN,
      DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_COMMAND_ID_DOMAIN,
      DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_CORRELATION_ID_DOMAIN,
    ]).toStrictEqual([
      "moe-delivery-v2-source-snapshot-publisher-principal/1",
      "moe-delivery-v2-source-snapshot-publish-command/1",
      "moe-delivery-v2-source-snapshot-publish-correlation/1",
    ]);
    expect([expectedPrincipal, expectedCommand, expectedCorrelation]).toStrictEqual([
      "delivery-v2:source-snapshot-publisher:"
        + "fd564208b9c0ad8ff9d156bc7979dc2c1978efc5a2284efbc1af3b47a1912b3f",
      "delivery-v2:source-snapshot-publish-command:"
        + "de71e244287530e1960d064d277e88e27678e4dc08b4165c80d64c34e65ce38f",
      "delivery-v2:source-snapshot-publish-correlation:"
        + "2d946f2e6ba74e7afa3dacc6f2522a10c125c75a8eba96acffc9aaa7cbeeba0c",
    ]);
  });

  it("keeps tree content out of the logical command while correlation follows content", () => {
    const command = deriveDeliveryV2SourceSnapshotPublishCommandId(
      PROJECT_ID, REPOSITORY_REF, SCOPE_REF, BASE,
    );
    const first = snapshot(TREE_A);
    const second = snapshot(TREE_B);
    expect(first.sourceSnapshotDigest).not.toBe(second.sourceSnapshotDigest);
    expect(deriveDeliveryV2SourceSnapshotPublishCommandId(
      PROJECT_ID, REPOSITORY_REF, SCOPE_REF, BASE,
    )).toBe(command);
    expect(deriveDeliveryV2SourceSnapshotPublishCorrelationId(
      PROJECT_ID, first.sourceSnapshotDigest,
    )).not.toBe(deriveDeliveryV2SourceSnapshotPublishCorrelationId(
      PROJECT_ID, second.sourceSnapshotDigest,
    ));
  });
});

describe("delivery-v2 SourceSnapshot publisher", () => {
  it("publishes real Git tree truth, reopens, reads, and replays without residue", () => {
    const repository = sha256Repository();
    const directory = temporaryRoot("moe-source-publisher-store-");
    const path = join(directory, "store.db");
    let store = track(SqliteEventStore.openForProject(path, PROJECT_ID));
    register(store);
    bind(store, repository.head, "publisher-file-bind");
    const rawCatalog = catalog(repository.root);
    let catalogReads = 0;
    const makePublisher = () => createDeliveryV2SourceSnapshotPublisher({
      catalogSource: () => { catalogReads += 1; return rawCatalog; },
      clock: () => DECIDED_AT,
      projectId: PROJECT_ID,
      store,
    });
    const port = makePublisher();
    expect(port.publishCurrent.length).toBe(0);
    const first = port.publishCurrent();
    const expected = snapshot(repository.tree, repository.head);
    const encoded = encodeSourceSnapshot(expected);
    if (!encoded.ok) throw new Error(`${encoded.code}@${encoded.layer}`);
    const principalId = deriveDeliveryV2SourceSnapshotPublisherPrincipalId(PROJECT_ID);
    const commandId = deriveDeliveryV2SourceSnapshotPublishCommandId(
      PROJECT_ID, REPOSITORY_REF, SCOPE_REF, repository.head,
    );
    const correlationId = deriveDeliveryV2SourceSnapshotPublishCorrelationId(
      PROJECT_ID, expected.sourceSnapshotDigest,
    );
    const aggregateId = deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, expected.sourceSnapshotDigest,
    );

    expect(first).toStrictEqual({
      bytes: encoded.bytes,
      disposition: "DECIDED",
      ok: true,
      ref: { projectId: PROJECT_ID, sourceSnapshotDigest: expected.sourceSnapshotDigest },
      snapshot: expected,
    });
    expect(catalogReads).toBe(1);
    const decision = store.getCommandDecision({ commandId, principalId, projectId: PROJECT_ID });
    expect(decision).toMatchObject({
      correlationSha256: identifyCorrelation(correlationId),
      decidedAt: DECIDED_AT,
    });
    expect(store.readAggregateEvents(aggregateId, 0, 2).items[0]).toMatchObject({
      aggregateSequence: 1,
      decisionTrace: { commandId, principalId, projectId: PROJECT_ID },
      payload: encoded.bytes,
    });
    const before = Object.freeze({
      decisions: store.readCommandDecisionsAfter(0n).items.length,
      events: store.readAggregateEvents(aggregateId, 0, 2).items.length,
      receipt: store.getCommandReceipt(commandId),
    });
    store.close();
    stores.delete(store);

    store = track(SqliteEventStore.openForProject(path, PROJECT_ID));
    expect(readDeliveryV2SourceSnapshot(store, {
      projectId: PROJECT_ID,
      sourceSnapshotDigest: expected.sourceSnapshotDigest,
    }, principalId)).toStrictEqual({ ok: true, snapshot: expected });
    expect(makePublisher().publishCurrent()).toMatchObject({
      disposition: "REPLAYED", ok: true, snapshot: expected,
    });
    expect({
      decisions: store.readCommandDecisionsAfter(0n).items.length,
      events: store.readAggregateEvents(aggregateId, 0, 2).items.length,
      receipt: store.getCommandReceipt(commandId),
    }).toStrictEqual(before);
  });

  it("accepts a catalog symlink after the runner proves its real repository ownership", () => {
    const repository = sha256Repository();
    const linkParent = temporaryRoot("moe-source-publisher-link-");
    const repositoryLink = join(linkParent, "repository-link");
    symlinkSync(repository.root, repositoryLink, "junction");
    const store = boundStore(repository.head);

    const result = publisher(store, repositoryLink).publishCurrent();
    expect(result).toMatchObject({
      disposition: "DECIDED",
      ok: true,
      snapshot: draft(repository.tree, repository.head),
    });
  });

  it("takes zero caller facts and selects only the durable current identity and catalog root", () => {
    const root = temporaryRoot("moe-source-publisher-authority-");
    const store = boundStore();
    const rootsSeen: string[] = [];
    const port = publisher(store, root, {
      observerFactory: (selectedRoot) => {
        rootsSeen.push(selectedRoot);
        return Object.freeze({ observe: () => observed(root) });
      },
    });
    const invokeWithHostileFacts = port.publishCurrent as unknown as (
      hostile: Record<string, unknown>,
    ) => ReturnType<typeof port.publishCurrent>;
    const result = invokeWithHostileFacts({
      baseRevisionHash: SECOND_BASE,
      principalId: "caller-principal",
      repositoryBaseTree: TREE_B,
      repositoryRef: "caller-repository",
      scopeRef: "caller-scope",
      sourceRepositoryRoot: temporaryRoot("moe-source-publisher-decoy-"),
    });
    expect(result).toMatchObject({ ok: true, snapshot: draft(TREE_A) });
    expect(rootsSeen).toStrictEqual([root]);
    if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
    expect(result.snapshot.projectId).toBe(PROJECT_ID);
  });

  it("passes through every runner Git refusal with its original object and layer", () => {
    const root = temporaryRoot("moe-source-publisher-runner-refusal-");
    const store = boundStore();
    const refusals = RUNNER_SOURCE_SNAPSHOT_GIT_CODES.map((code) => Object.freeze({
      code, layer: RUNNER_SOURCE_SNAPSHOT_GIT_LAYER, ok: false as const,
    } satisfies SourceSnapshotGitRefusal));
    expect(refusals).toHaveLength(8);
    const returned = refusals.map((refusal) => publisher(store, root, {
      observerFactory: () => Object.freeze({ observe: () => refusal }),
    }).publishCurrent());
    expect(returned.map((result, index) => result === refusals[index]))
      .toStrictEqual(refusals.map(() => true));
    expect(returned).toStrictEqual(refusals);
  });

  it("contains a mutable runner-refusal lookalike at the publisher boundary", () => {
    const root = temporaryRoot("moe-source-publisher-mutable-runner-refusal-");
    const mutable = {
      code: RUNNER_SOURCE_SNAPSHOT_GIT_CODES[0],
      layer: RUNNER_SOURCE_SNAPSHOT_GIT_LAYER,
      ok: false as const,
    } satisfies SourceSnapshotGitRefusal;

    expect(publisher(boundStore(), root, {
      observerFactory: () => Object.freeze({ observe: () => mutable }),
    }).publishCurrent()).toStrictEqual(local(
      "DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE",
    ));
    expect(Object.isFrozen(mutable)).toBe(false);
  });

  it("refuses a defensive accepted base substitution before persistence", () => {
    const root = temporaryRoot("moe-source-publisher-observation-binding-");
    const store = boundStore();
    const decisionCount = store.readCommandDecisionsAfter(0n).items.length;
    expect(publisher(store, root, {
      observerFactory: () => Object.freeze({
        observe: () => observed(root, TREE_A, SECOND_BASE),
      }),
    }).publishCurrent()).toStrictEqual(local(
      "DELIVERY_V2_SOURCE_SNAPSHOT_OBSERVATION_BASE_MISMATCH",
    ));
    expect(store.readCommandDecisionsAfter(0n).items).toHaveLength(decisionCount);
  });

  it("turns contradictory valid trees under one durable slot into a store idempotency conflict", () => {
    const root = temporaryRoot("moe-source-publisher-contradiction-");
    const store = boundStore();
    const trees = [TREE_A, TREE_B];
    const port = publisher(store, root, {
      observerFactory: () => Object.freeze({
        observe: () => observed(root, trees.shift() ?? TREE_B),
      }),
    });
    const first = port.publishCurrent();
    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
    if (!first.ok) throw new Error(`${first.code}@${first.layer}`);
    const before = Object.freeze({
      decisions: store.readCommandDecisionsAfter(0n).items.length,
      firstEvents: store.readEvents(deriveDeliveryV2SourceSnapshotAggregateId(
        PROJECT_ID, first.snapshot.sourceSnapshotDigest,
      )).length,
    });
    const secondSnapshot = snapshot(TREE_B);
    expect(port.publishCurrent()).toStrictEqual({
      code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE", ok: false,
    });
    expect({
      decisions: store.readCommandDecisionsAfter(0n).items.length,
      firstEvents: store.readEvents(deriveDeliveryV2SourceSnapshotAggregateId(
        PROJECT_ID, first.snapshot.sourceSnapshotDigest,
      )).length,
    }).toStrictEqual(before);
    expect(store.readEvents(deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, secondSnapshot.sourceSnapshotDigest,
    ))).toHaveLength(0);
  });

  it("re-resolves the original durable request after Git observation and refuses a move", () => {
    const root = temporaryRoot("moe-source-publisher-current-move-");
    const store = boundStore();
    const before = store.readCommandDecisionsAfter(0n).items.length;
    let moved = false;
    const result = publisher(store, root, {
      observerFactory: () => Object.freeze({
        observe: () => {
          if (!moved) {
            moved = true;
            bind(store, SECOND_BASE, "publisher-bind-moved");
          }
          return observed(root);
        },
      }),
    }).publishCurrent();
    expect(result).toStrictEqual({
      code: "FOUNDATION_REPOSITORY_SCOPE_BASE_REVISION_MISMATCH",
      layer: "DAEMON_REPOSITORY_SCOPE_RESOLUTION",
      ok: false,
    });
    expect(store.readCommandDecisionsAfter(0n).items).toHaveLength(before + 1);
    expect(store.readEvents(deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, snapshot(TREE_A).sourceSnapshotDigest,
    ))).toHaveLength(0);
  });

  it("rechecks the original durable request after clock effects immediately before append", () => {
    const root = temporaryRoot("moe-source-publisher-clock-move-");
    const store = boundStore();
    const before = store.readCommandDecisionsAfter(0n).items.length;
    let moved = false;
    const result = publisher(store, root, {
      clock: () => {
        if (!moved) {
          moved = true;
          bind(store, SECOND_BASE, "publisher-bind-clock-moved");
        }
        return DECIDED_AT;
      },
      observerFactory: () => Object.freeze({ observe: () => observed(root) }),
    }).publishCurrent();

    expect(result).toStrictEqual({
      code: "FOUNDATION_REPOSITORY_SCOPE_BASE_REVISION_MISMATCH",
      layer: "DAEMON_REPOSITORY_SCOPE_RESOLUTION",
      ok: false,
    });
    expect(store.readCommandDecisionsAfter(0n).items).toHaveLength(before + 1);
    expect(store.readEvents(deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, snapshot(TREE_A).sourceSnapshotDigest,
    ))).toHaveLength(0);
  });

  it("passes catalog and durable current-authority refusals through exactly", () => {
    const root = temporaryRoot("moe-source-publisher-upstream-");
    const absent = track(SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID));
    const malformedCatalog = createDeliveryV2SourceSnapshotPublisher({
      catalogSource: () => ({ catalogVersion: "wrong", entries: [] }),
      clock: () => DECIDED_AT,
      observerFactory: () => Object.freeze({ observe: () => observed(root) }),
      projectId: PROJECT_ID,
      store: boundStore(),
    });
    expect(publisher(absent, root, {
      observerFactory: () => Object.freeze({ observe: () => observed(root) }),
    }).publishCurrent()).toStrictEqual({
      code: "FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_ABSENT",
      layer: "DAEMON_REPOSITORY_SCOPE_RESOLUTION",
      ok: false,
    });
    expect(malformedCatalog.publishCurrent()).toStrictEqual({
      code: "FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION_UNSUPPORTED",
      layer: "DAEMON_REPOSITORY_SCOPE_CATALOG",
      ok: false,
    });
  });

  it("contains a hostile nested catalog array before observer or clock effects", () => {
    const root = temporaryRoot("moe-source-publisher-hostile-catalog-");
    let nestedReads = 0;
    let observerCalls = 0;
    let clockCalls = 0;
    const entries = new Proxy((catalog(root) as { entries: unknown[] }).entries, {
      get(): never {
        nestedReads += 1;
        throw new Error("nested catalog array was read");
      },
    });
    const result = createDeliveryV2SourceSnapshotPublisher({
      catalogSource: () => ({
        catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
        entries,
      }),
      clock: () => {
        clockCalls += 1;
        return DECIDED_AT;
      },
      observerFactory: () => {
        observerCalls += 1;
        return Object.freeze({ observe: () => observed(root) });
      },
      projectId: PROJECT_ID,
      store: boundStore(),
    }).publishCurrent();

    expect(result).toStrictEqual(Object.freeze({
      code: "FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR",
      layer: "DAEMON_REPOSITORY_SCOPE_CATALOG",
      ok: false,
    }));
    expect(Object.isFrozen(result)).toBe(true);
    expect({ clockCalls, nestedReads, observerCalls }).toStrictEqual({
      clockCalls: 0,
      nestedReads: 0,
      observerCalls: 0,
    });
  });

  it("passes malformed observed tree provenance through the core admission layer", () => {
    const root = temporaryRoot("moe-source-publisher-core-refusal-");
    expect(publisher(boundStore(), root, {
      observerFactory: () => Object.freeze({ observe: () => observed(root, "not-a-tree") }),
    }).publishCurrent()).toStrictEqual({
      code: "SOURCE_SNAPSHOT_MALFORMED",
      layer: "SOURCE_SNAPSHOT_ADMISSION",
      ok: false,
    });
  });

  it("passes a durable store error through the SourceSnapshot writer unchanged", () => {
    const root = temporaryRoot("moe-source-publisher-store-error-");
    const durable = boundStore();
    const store = Object.freeze({
      commitExpectedVersionDecisionLegs: () => {
        throw new DurableStoreError("STORE_BUSY", "busy by test");
      },
      getCommandDecision: durable.getCommandDecision.bind(durable),
      getCommandReceipt: durable.getCommandReceipt.bind(durable),
      readAggregateEvents: durable.readAggregateEvents.bind(durable),
      readCommandDecisionsAfter: durable.readCommandDecisionsAfter.bind(durable),
    }) as unknown as SqliteEventStore;
    expect(publisher(store, root, {
      observerFactory: () => Object.freeze({ observe: () => observed(root) }),
    }).publishCurrent()).toStrictEqual({
      code: "STORE_BUSY", layer: "DURABLE_STORE", ok: false,
    });
  });
});

describe("delivery-v2 SourceSnapshot publisher composition fences", () => {
  it("declares the exact narrow publisher-owned refusal roster", () => {
    expect(DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER)
      .toBe("DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER");
    expect(DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CODES).toStrictEqual([
      "DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CONFIG_INVALID",
      "DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_ABSENT",
      "DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_UNREADABLE",
      "DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE",
      "DELIVERY_V2_SOURCE_SNAPSHOT_OBSERVATION_BASE_MISMATCH",
      "DELIVERY_V2_SOURCE_SNAPSHOT_CLOCK_UNREADABLE",
    ]);
  });

  it("does not invoke or accept proxy and accessor composition dependencies", () => {
    const root = temporaryRoot("moe-source-publisher-hostile-config-");
    const store = boundStore();
    const safe = {
      catalogSource: () => catalog(root),
      clock: () => DECIDED_AT,
      observerFactory: () => Object.freeze({ observe: () => observed(root) }),
      projectId: PROJECT_ID,
      store,
    };
    let reads = 0;
    const proxy = new Proxy(safe, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const accessor = { ...safe } as Record<string, unknown>;
    Object.defineProperty(accessor, "clock", {
      enumerable: true,
      get() { reads += 1; return () => DECIDED_AT; },
    });
    const revoked = Proxy.revocable(safe, {});
    revoked.revoke();
    const nestedProxies: DeliveryV2SourceSnapshotPublisherConfig[] = [
      { ...safe, catalogSource: new Proxy(safe.catalogSource, {}) },
      { ...safe, clock: new Proxy(safe.clock, {}) },
      { ...safe, observerFactory: new Proxy(safe.observerFactory, {}) },
      { ...safe, store: new Proxy(store, {}) },
    ];
    expect([
      createDeliveryV2SourceSnapshotPublisher(proxy).publishCurrent(),
      createDeliveryV2SourceSnapshotPublisher(
        accessor as unknown as DeliveryV2SourceSnapshotPublisherConfig,
      ).publishCurrent(),
      createDeliveryV2SourceSnapshotPublisher(revoked.proxy).publishCurrent(),
      ...nestedProxies.map((config) =>
        createDeliveryV2SourceSnapshotPublisher(config).publishCurrent()),
    ]).toStrictEqual([
      ...Array.from({ length: 7 }, () =>
        local("DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CONFIG_INVALID")),
    ]);
    expect(reads).toBe(0);
  });

  it("distinguishes absent and unreadable lazy catalog configuration", () => {
    const root = temporaryRoot("moe-source-publisher-catalog-config-");
    const store = boundStore();
    expect([
      publisher(store, root, { catalogSource: () => undefined }).publishCurrent(),
      publisher(store, root, { catalogSource: () => { throw new Error("unreadable"); } })
        .publishCurrent(),
    ]).toStrictEqual([
      local("DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_ABSENT"),
      local("DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_UNREADABLE"),
    ]);
  });

  it("contains thrown observer and clock effects without restamping upstream refusals", () => {
    const root = temporaryRoot("moe-source-publisher-thrown-effects-");
    const store = boundStore();
    expect([
      publisher(store, root, {
        observerFactory: () => { throw new Error("observer construction"); },
      }).publishCurrent(),
      publisher(store, root, {
        observerFactory: () => Object.freeze({ observe: () => { throw new Error("observe"); } }),
      }).publishCurrent(),
      publisher(store, root, {
        clock: () => { throw new Error("clock"); },
        observerFactory: () => Object.freeze({ observe: () => observed(root) }),
      }).publishCurrent(),
    ]).toStrictEqual([
      local("DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE"),
      local("DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE"),
      local("DELIVERY_V2_SOURCE_SNAPSHOT_CLOCK_UNREADABLE"),
    ]);
  });

  it("contains proxy and accessor accepted-result wrappers without invoking them", () => {
    const root = temporaryRoot("moe-source-publisher-hostile-observer-");
    const hostile = new Proxy(observed(root), {
      get() { throw new Error("hostile observer result"); },
    });
    let reads = 0;
    const accessor = { ok: true } as Record<string, unknown>;
    Object.defineProperty(accessor, "observation", {
      enumerable: true,
      get() { reads += 1; return observed(root).observation; },
    });
    const revoked = Proxy.revocable(observed(root), {});
    revoked.revoke();
    expect([
      publisher(boundStore(), root, {
        observerFactory: () => Object.freeze({ observe: () => hostile }),
      }).publishCurrent(),
      publisher(boundStore(), root, {
        observerFactory: () => Object.freeze({
          observe: () => accessor as unknown as ReturnType<SourceSnapshotGitObserver["observe"]>,
        }),
      }).publishCurrent(),
      publisher(boundStore(), root, {
        observerFactory: () => Object.freeze({ observe: () => revoked.proxy }),
      }).publishCurrent(),
    ]).toStrictEqual([
      local("DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE"),
      local("DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE"),
      local("DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE"),
    ]);
    expect(reads).toBe(0);
  });

  it("lets the writer own an invalid returned timestamp", () => {
    const root = temporaryRoot("moe-source-publisher-invalid-clock-");
    expect(publisher(boundStore(), root, {
      clock: () => "not-a-timestamp",
      observerFactory: () => Object.freeze({ observe: () => observed(root) }),
    }).publishCurrent()).toStrictEqual({
      code: "DELIVERY_V2_INPUT_INVALID",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });
  });
});
