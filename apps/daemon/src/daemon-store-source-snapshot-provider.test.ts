import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@moe/contracts";
import { createSourceSnapshot } from "@moe/core";
import { hermeticGitEnvironment } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { createStoreDependencies } from "./daemon-store-dependencies.js";
import {
  deriveDeliveryV2SourceSnapshotAggregateId,
} from "./delivery-v2/source-snapshot-persistence.js";
import {
  readDeliveryV2PublishedSourceSnapshot,
} from "./delivery-v2/source-snapshot-reader.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { bytes, envelopeObject } from "./http/http-test-fixtures.js";
import {
  FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
} from "./work/foundation-repository-scope-contracts.js";

const CREDENTIAL = "test-operator-credential";
const CLOCK = (): string => "2026-08-09T12:00:00.000Z";
const REPOSITORY_REF = "repository:store-deps-source";
const SCOPE_REF = "scope:store-deps-source";

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: hermeticGitEnvironment(process.env),
    shell: false,
    windowsHide: true,
  }).trim();
}

interface SourceRepositoryFixture {
  readonly catalogPath: string;
  readonly directory: string;
  readonly head: string;
  readonly projectId: string;
  readonly storePath: string;
  readonly tree: string;
}

function sourceRepositoryFixture(label: string): SourceRepositoryFixture {
  const projectId = `proj-store-deps-source-${label}`;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `moe-store-deps-source-${label}-`)));
  const repositoryRoot = join(directory, "repository");
  const worktreeParent = join(directory, "worktrees");
  mkdirSync(join(repositoryRoot, "scope"), { recursive: true });
  mkdirSync(worktreeParent);
  writeFileSync(join(repositoryRoot, "scope", "source.txt"), `source ${label}\n`, "utf8");
  runGit(repositoryRoot, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runGit(repositoryRoot, ["config", "core.autocrlf", "false"]);
  runGit(repositoryRoot, ["add", "--", "scope/source.txt"]);
  runGit(repositoryRoot, [
    "-c", "user.name=Moe Store Provider",
    "-c", "user.email=store-provider@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "store provider source",
  ]);
  const catalogPath = join(directory, "foundation-catalog.json");
  writeFileSync(catalogPath, JSON.stringify({
    catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
    entries: [{
      declaredPaths: ["scope/source.txt"],
      projectId,
      repositoryRef: REPOSITORY_REF,
      scopeRef: SCOPE_REF,
      sourceRepositoryRoot: realpathSync(repositoryRoot),
      worktreeParent: realpathSync(worktreeParent),
    }],
  }), "utf8");
  return Object.freeze({
    catalogPath,
    directory,
    head: runGit(repositoryRoot, ["rev-parse", "HEAD"]),
    projectId,
    storePath: join(directory, "store.db"),
    tree: runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"]),
  });
}

function bindSourceRepository(
  built: ReturnType<typeof createStoreDependencies>,
  projectId: string,
  baseRevisionHash: string,
): void {
  const dispatch = (
    commandId: string,
    commandKind: "project.register" | "project.bind_repository",
    expectedVersion: number,
    payload: Readonly<Record<string, JsonValue>>,
  ) => handleCommandRequest(built.provide(), {
    body: bytes({
      ...envelopeObject({ commandId, commandKind, payload, targetAggregateId: projectId }),
      expectedVersion,
    }),
    credential: CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
  const registered = dispatch(
    `source-register-${projectId}`, "project.register", 0, { owner: "operator-local" },
  );
  if (!registered.ok) throw new Error(`source register refused: ${JSON.stringify(registered)}`);
  const bound = dispatch(
    `source-bind-${projectId}`, "project.bind_repository", 1, {
      observation: {
        baseRevisionHash,
        repositoryRef: REPOSITORY_REF,
        scopeRef: SCOPE_REF,
        truthClass: "DAEMON_VERIFIED",
      },
    },
  );
  if (!bound.ok) throw new Error(`source bind refused: ${JSON.stringify(bound)}`);
}

describe("SourceSnapshot publisher store dependency", () => {
  it("stays inert until explicit publication, then reopens and replays the bound Git tree", () => {
    const fixture = sourceRepositoryFixture("publish");
    let built: ReturnType<typeof createStoreDependencies> | null = null;
    try {
      const seeder = createStoreDependencies({
        clock: CLOCK,
        credential: CREDENTIAL,
        principalId: "operator-local",
        projectId: fixture.projectId,
        storePath: fixture.storePath,
        workspaceCatalogPath: fixture.catalogPath,
      });
      try {
        bindSourceRepository(seeder, fixture.projectId, fixture.head);
      } finally {
        seeder.close();
      }

      const expected = createSourceSnapshot({
        baseRevisionHash: fixture.head,
        projectId: fixture.projectId,
        repositoryBaseTree: fixture.tree,
        repositoryRef: REPOSITORY_REF,
        scopeRef: SCOPE_REF,
      });
      if (!expected.ok) throw new Error(`${expected.code}@${expected.layer}`);
      const aggregateId = deriveDeliveryV2SourceSnapshotAggregateId(
        fixture.projectId,
        expected.snapshot.sourceSnapshotDigest,
      );

      // The subject is composed only AFTER the durable repository authority is
      // publishable. An eager boot-time publish cannot hide behind an absent
      // binding refusal and still leave this aggregate empty.
      built = createStoreDependencies({
        clock: CLOCK,
        credential: CREDENTIAL,
        principalId: "operator-local",
        projectId: fixture.projectId,
        storePath: fixture.storePath,
        workspaceCatalogPath: fixture.catalogPath,
      });
      const before = SqliteEventStore.openForProject(fixture.storePath, fixture.projectId);
      try {
        expect(before.readAggregateEvents(aggregateId, 0, 2).items).toHaveLength(0);
        expect(before.readCommandDecisionsAfter(0n).items.filter(
          (decision) => decision.commandKind === "delivery_v2.source_snapshot.commit",
        )).toHaveLength(0);
      } finally {
        before.close();
      }

      const publisher = built.sourceSnapshotPublisher();
      expect(built.sourceSnapshotPublisher()).toBe(publisher);
      expect(publisher.publishCurrent.length).toBe(0);
      const first = publisher.publishCurrent();
      expect(first).toMatchObject({
        disposition: "DECIDED",
        ok: true,
        snapshot: {
          baseRevisionHash: fixture.head,
          projectId: fixture.projectId,
          repositoryBaseTree: fixture.tree,
          repositoryRef: REPOSITORY_REF,
          scopeRef: SCOPE_REF,
        },
      });
      if (!first.ok) throw new Error(`${first.code}@${first.layer}`);
      expect(publisher.publishCurrent()).toMatchObject({
        disposition: "REPLAYED",
        ok: true,
        ref: first.ref,
        snapshot: first.snapshot,
      });
      built.close();

      const reopened = SqliteEventStore.openForProject(fixture.storePath, fixture.projectId);
      try {
        expect(readDeliveryV2PublishedSourceSnapshot(reopened, first.ref)).toStrictEqual({
          ok: true,
          snapshot: first.snapshot,
        });
        expect(reopened.readAggregateEvents(aggregateId, 0, 2).items).toHaveLength(1);
        expect(reopened.readCommandDecisionsAfter(0n).items.filter(
          (decision) => decision.commandKind === "delivery_v2.source_snapshot.commit",
        )).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      try { built?.close(); } catch { /* already closed before reopen */ }
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });

  it.each([
    ["absent", false, "DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_ABSENT"],
    ["unreadable", true, "DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_UNREADABLE"],
  ] as const)("boots inertly and preserves the exact %s catalog refusal", (
    label,
    hasCatalogPath,
    code,
  ) => {
    const directory = mkdtempSync(join(tmpdir(), `moe-store-deps-source-${label}-`));
    const projectId = `proj-store-deps-source-${label}`;
    const workspaceCatalogPath = hasCatalogPath
      ? join(directory, "missing-catalog.json")
      : undefined;
    const built = createStoreDependencies({
      clock: CLOCK,
      credential: CREDENTIAL,
      principalId: "operator-local",
      projectId,
      storePath: join(directory, "store.db"),
      ...(workspaceCatalogPath === undefined ? {} : { workspaceCatalogPath }),
    });
    try {
      bindSourceRepository(built, projectId, "a".repeat(64));
      const publisher = built.sourceSnapshotPublisher();
      expect(built.sourceSnapshotPublisher()).toBe(publisher);
      expect(publisher.publishCurrent()).toStrictEqual({
        code,
        layer: "DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER",
        ok: false,
      });
    } finally {
      built.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("preserves the exact runner refusal when the catalog repository cannot be observed", () => {
    const directory = realpathSync(mkdtempSync(join(
      tmpdir(), "moe-store-deps-source-git-refusal-",
    )));
    const projectId = "proj-store-deps-source-git-refusal";
    const worktreeParent = join(directory, "worktrees");
    const catalogPath = join(directory, "foundation-catalog.json");
    mkdirSync(worktreeParent);
    writeFileSync(catalogPath, JSON.stringify({
      catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
      entries: [{
        declaredPaths: ["scope/source.txt"],
        projectId,
        repositoryRef: REPOSITORY_REF,
        scopeRef: SCOPE_REF,
        sourceRepositoryRoot: join(directory, "missing-repository"),
        worktreeParent: realpathSync(worktreeParent),
      }],
    }), "utf8");
    const built = createStoreDependencies({
      clock: CLOCK,
      credential: CREDENTIAL,
      principalId: "operator-local",
      projectId,
      storePath: join(directory, "store.db"),
      workspaceCatalogPath: catalogPath,
    });
    try {
      bindSourceRepository(built, projectId, "b".repeat(64));
      expect(built.sourceSnapshotPublisher().publishCurrent()).toStrictEqual({
        code: "RUNNER_SOURCE_SNAPSHOT_ROOT_UNRESOLVABLE",
        layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
        ok: false,
      });
    } finally {
      built.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("preserves the exact clock refusal after a successful real Git observation", () => {
    const fixture = sourceRepositoryFixture("clock-refusal");
    let unreadable = false;
    const built = createStoreDependencies({
      clock: () => {
        if (unreadable) throw new Error("clock unreadable by test");
        return CLOCK();
      },
      credential: CREDENTIAL,
      principalId: "operator-local",
      projectId: fixture.projectId,
      storePath: fixture.storePath,
      workspaceCatalogPath: fixture.catalogPath,
    });
    try {
      bindSourceRepository(built, fixture.projectId, fixture.head);
      unreadable = true;
      expect(built.sourceSnapshotPublisher().publishCurrent()).toStrictEqual({
        code: "DELIVERY_V2_SOURCE_SNAPSHOT_CLOCK_UNREADABLE",
        layer: "DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER",
        ok: false,
      });
    } finally {
      built.close();
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });
});
