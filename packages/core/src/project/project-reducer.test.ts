import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  PROJECT_COMMAND_KINDS,
  reduceProject,
} from "./project-reducer.js";
import type {
  ProjectCommand,
  ProjectCommandKind,
  ProjectLifecycle,
  ProjectReducerResult,
  ProjectState,
} from "./project-contract.js";

const HASH = "ab".repeat(32);
const OTHER_HASH = "cd".repeat(32);

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key]);
  }
}

function state(lifecycle: ProjectLifecycle, version = 7): ProjectState {
  return freezeDeep({
    lifecycle,
    owner: "owner-1",
    projectId: "project-1",
    recoveryRequired: lifecycle === "QUIESCED",
    repositoryObservations: [],
    version,
  });
}

function command(kind: ProjectCommandKind, expectedVersion = 7): ProjectCommand {
  const base = { commandId: `cmd-${kind}`, expectedVersion };
  switch (kind) {
    case "project.register":
      return { ...base, kind, owner: "owner-1", projectId: "project-1" };
    case "project.bind_repository":
      return { ...base, kind, observation: {
        baseRevisionHash: HASH,
        repositoryRef: "repository-1",
        scopeRef: "scope-1",
        truthClass: "OBSERVED",
      } };
    case "project.activate":
      return { ...base, kind, witness: {
        artifactPathRef: "artifact-path-1",
        backupPathRef: "backup-path-1",
        credentialRef: "credential-1",
        distributionManifestHash: HASH,
        policyRevisionHash: OTHER_HASH,
        providerMinimumProfileRef: "profile-1",
        signingKeyRef: "signing-key-1",
        storeDriverRef: "sqlite-driver-1",
        truthClass: "DAEMON_VERIFIED",
      } };
    case "recovery.restore_quiesce":
      return { ...base, kind, witness: {
        backupGenerationHash: HASH,
        recoveryIncarnationRef: "incarnation-1",
        truthClass: "DAEMON_VERIFIED",
      } };
    case "recovery.complete":
      return { ...base, kind, witness: {
        coverageProofHash: HASH,
        inventoryReconciliationHash: OTHER_HASH,
        recoveryDecisionRef: "decision-1",
        recoveryIncarnationRef: "incarnation-1",
        truthClass: "HUMAN_APPROVED",
      } };
  }
}

function expectError(
  result: ProjectReducerResult,
  code: "EXPECTED_VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "ILLEGAL_TRANSITION",
  details: Readonly<Record<string, string | number>>,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.details).toEqual(details);
  expectDeepFrozen(result);
}

const ALLOWED = Object.freeze({
  BOOTSTRAPPING: new Set<ProjectCommandKind>([
    "project.bind_repository", "project.activate", "recovery.restore_quiesce",
  ]),
  READY: new Set<ProjectCommandKind>(["recovery.restore_quiesce"]),
  DEGRADED: new Set<ProjectCommandKind>(),
  QUIESCED: new Set<ProjectCommandKind>(["recovery.complete"]),
}) satisfies Readonly<Record<ProjectLifecycle, ReadonlySet<ProjectCommandKind>>>;

function expectedLifecycle(
  source: ProjectLifecycle,
  kind: ProjectCommandKind,
): ProjectLifecycle {
  if (kind === "project.activate" || kind === "recovery.complete") return "READY";
  if (kind === "recovery.restore_quiesce") return "QUIESCED";
  return source;
}

describe("project lifecycle transition matrix", () => {
  it("covers every state and command kind with the exact authorized outcome", () => {
    const visited = new Set<string>();
    for (const lifecycle of RUNTIME_LIFECYCLES.PROJECT) {
      for (const kind of PROJECT_COMMAND_KINDS) {
        visited.add(`${lifecycle}:${kind}`);
        const current = state(lifecycle);
        const result = reduceProject(current, command(kind));
        if (!ALLOWED[lifecycle].has(kind)) {
          expectError(result, "ILLEGAL_TRANSITION", {
            aggregateKind: "PROJECT", commandKind: kind, sourceState: lifecycle,
          });
          continue;
        }
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.state.lifecycle).toBe(expectedLifecycle(lifecycle, kind));
        expect(result.state.version).toBe(current.version + 1);
        expect(result.events.every((event) => event.commandId === command(kind).commandId)).toBe(true);
        expect(result.events.at(-1)?.version).toBe(result.state.version);
        expectDeepFrozen(result);
      }
    }
    const expected = RUNTIME_LIFECYCLES.PROJECT.flatMap((lifecycle) =>
      PROJECT_COMMAND_KINDS.map((kind) => `${lifecycle}:${kind}`));
    expect([...visited].sort()).toEqual([...expected].sort());
  });

  it("registers only a nonexistent project", () => {
    const result = reduceProject(undefined, command("project.register", 0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toMatchObject({
      lifecycle: "BOOTSTRAPPING", recoveryRequired: false, version: 1,
    });
    expect(result.events).toEqual([expect.objectContaining({
      commandId: "cmd-project.register", kind: "ProjectRegistered",
    })]);
    expectDeepFrozen(result);
  });

  it("keeps repository binding repeatable without changing lifecycle", () => {
    const first = reduceProject(state("BOOTSTRAPPING"), command("project.bind_repository"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = reduceProject(first.state, command("project.bind_repository", first.state.version));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.lifecycle).toBe("BOOTSTRAPPING");
    expect(second.state.repositoryObservations).toHaveLength(2);
    expectDeepFrozen(second.state.repositoryObservations);
  });
});

describe("project reducer rejection boundaries", () => {
  it("rejects stale versions without changing input state", () => {
    const current = state("BOOTSTRAPPING");
    const before = JSON.stringify(current);
    const result = reduceProject(current, command("project.activate", 6));
    expectError(result, "EXPECTED_VERSION_CONFLICT", {
      actualVersion: 7, expectedVersion: 6,
    });
    expect(JSON.stringify(current)).toBe(before);
  });

  it("rejects an empty command id as an idempotency conflict", () => {
    const candidate = { ...command("project.bind_repository"), commandId: "" };
    const result = reduceProject(state("BOOTSTRAPPING"), candidate);
    expectError(result, "IDEMPOTENCY_CONFLICT", {});
  });

  it.each(["UNKNOWN", "AGENT_REPORTED"] as const)(
    "rejects %s activation and restore witnesses",
    (truthClass) => {
      const activation = command("project.activate");
      const restore = command("recovery.restore_quiesce");
      if (activation.kind !== "project.activate"
        || restore.kind !== "recovery.restore_quiesce") {
        throw new Error("unreachable command mismatch");
      }
      const candidates: readonly ProjectCommand[] = [
        { ...activation, witness: { ...activation.witness, truthClass } },
        { ...restore, witness: { ...restore.witness, truthClass } },
      ];
      for (const candidate of candidates) {
        const result = reduceProject(state("BOOTSTRAPPING"), candidate);
        expectError(result, "ILLEGAL_TRANSITION", {
          aggregateKind: "PROJECT", commandKind: candidate.kind, sourceState: "BOOTSTRAPPING",
        });
      }
    },
  );

  it("requires HUMAN_APPROVED recovery completion and valid witness references", () => {
    const original = command("recovery.complete");
    if (original.kind !== "recovery.complete") throw new Error("unreachable command mismatch");
    const lowTruth = { ...original, witness: {
      ...original.witness, truthClass: "DAEMON_VERIFIED" as const,
    } };
    expectError(reduceProject(state("QUIESCED"), lowTruth), "ILLEGAL_TRANSITION", {
      aggregateKind: "PROJECT", commandKind: original.kind, sourceState: "QUIESCED",
    });
    const malformed = { ...original, witness: {
      ...original.witness, coverageProofHash: "not-a-hash",
    } };
    expectError(reduceProject(state("QUIESCED"), malformed), "ILLEGAL_TRANSITION", {
      aggregateKind: "PROJECT", commandKind: original.kind, sourceState: "QUIESCED",
    });
  });

  it.each([
    ["project.bind_repository", "observation", "BOOTSTRAPPING"],
    ["project.activate", "witness", "BOOTSTRAPPING"],
    ["recovery.restore_quiesce", "witness", "READY"],
    ["recovery.complete", "witness", "QUIESCED"],
  ] as const)("rejects a missing %s %s", (kind, field, lifecycle) => {
    const malformed = { ...command(kind), [field]: undefined } as unknown as ProjectCommand;
    const result = reduceProject(state(lifecycle), malformed);
    expectError(result, "ILLEGAL_TRANSITION", {
      aggregateKind: "PROJECT", commandKind: kind, sourceState: lifecycle,
    });
  });

  it("rejects extra witness fields", () => {
    const original = command("project.activate");
    if (original.kind !== "project.activate") throw new Error("unreachable command mismatch");
    const malformed = { ...original, witness: {
      ...original.witness, authorityGrant: "forbidden",
    } } as unknown as ProjectCommand;
    expectError(reduceProject(state("BOOTSTRAPPING"), malformed), "ILLEGAL_TRANSITION", {
      aggregateKind: "PROJECT", commandKind: original.kind, sourceState: "BOOTSTRAPPING",
    });
  });
});

function xorshift32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  };
}

function trace(seed: number): readonly unknown[] {
  const next = xorshift32(seed);
  const entries: unknown[] = [];
  let current: ProjectState | undefined;
  for (let index = 0; index < 80; index += 1) {
    const kind = PROJECT_COMMAND_KINDS[next() % PROJECT_COMMAND_KINDS.length];
    if (kind === undefined) throw new Error("project command vocabulary is empty");
    const actualVersion = current?.version ?? 0;
    const expectedVersion = next() % 4 === 0 ? actualVersion + 1 : actualVersion;
    const input = command(kind, expectedVersion);
    const before = current === undefined ? undefined : JSON.stringify(current);
    const result = reduceProject(current, input);
    expectDeepFrozen(result);
    if (result.ok) {
      current = result.state;
      expect(current.lifecycle).not.toBe("DEGRADED");
      entries.push([kind, current.lifecycle, current.version]);
    } else {
      expect(current === undefined ? undefined : JSON.stringify(current)).toBe(before);
      entries.push([kind, result.error.code]);
    }
  }
  return entries;
}

describe("project reducer properties", () => {
  it("is deterministic, deeply immutable, and never reaches DEGRADED", () => {
    for (const seed of [1, 7, 0x12345678, 0xdeadbeef]) {
      expect(trace(seed)).toEqual(trace(seed));
    }
  });
});
