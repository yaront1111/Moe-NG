import { describe, expect, it } from "vitest";

import { reduceProject } from "./project-reducer.js";
import type {
  ProjectActivateCommand,
  ProjectCommand,
  ProjectLifecycle,
  ProjectReducerResult,
  ProjectState,
} from "./project-contract.js";

const HASH = "ab".repeat(32);

function mutableState(lifecycle: ProjectLifecycle, version = 7): ProjectState {
  return {
    lifecycle,
    owner: "owner-1",
    projectId: "project-1",
    recoveryRequired: lifecycle === "QUIESCED",
    repositoryObservations: [{
      baseRevisionHash: HASH,
      repositoryRef: "repository-1",
      scopeRef: "scope-1",
      truthClass: "OBSERVED",
    }],
    version,
  };
}

function activation(expectedVersion = 7): ProjectActivateCommand {
  return {
    commandId: "cmd-activate",
    expectedVersion,
    kind: "project.activate",
    witness: {
      artifactPathRef: "artifact-1",
      backupPathRef: "backup-1",
      credentialRef: "credential-1",
      distributionManifestHash: HASH,
      policyRevisionHash: HASH,
      providerMinimumProfileRef: "profile-1",
      signingKeyRef: "key-1",
      storeDriverRef: "sqlite-1",
      truthClass: "DAEMON_VERIFIED",
    },
  };
}

function expectIllegal(
  result: ProjectReducerResult,
  commandKind: ProjectCommand["kind"],
  sourceState: ProjectLifecycle,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("ILLEGAL_TRANSITION");
  expect(result.error.details).toEqual({
    aggregateKind: "PROJECT", commandKind, sourceState,
  });
}

function expectUnknown(result: ProjectReducerResult): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("UNKNOWN_ERROR");
}

describe("project reducer state invariants", () => {
  it("does not freeze or otherwise mutate mutable caller state", () => {
    const input = mutableState("BOOTSTRAPPING");
    const before = JSON.stringify(input);
    const result = reduceProject(input, activation());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.repositoryObservations)).toBe(false);
    expect(Object.isFrozen(input.repositoryObservations[0])).toBe(false);
    if (!result.ok) return;
    expect(Object.isFrozen(result.state.repositoryObservations[0])).toBe(true);
  });

  it("sets and clears the recovery-required facet", () => {
    const ready = mutableState("READY");
    const quiesced = reduceProject(ready, {
      commandId: "cmd-restore", expectedVersion: 7, kind: "recovery.restore_quiesce",
      witness: { backupGenerationHash: HASH, recoveryIncarnationRef: "incarnation-1",
        truthClass: "DAEMON_VERIFIED" },
    });
    expect(quiesced.ok && quiesced.state.recoveryRequired).toBe(true);
    if (!quiesced.ok) return;
    const recovered = reduceProject(quiesced.state, {
      commandId: "cmd-recover", expectedVersion: 8, kind: "recovery.complete",
      witness: { coverageProofHash: HASH, inventoryReconciliationHash: HASH,
        recoveryDecisionRef: "decision-1", recoveryIncarnationRef: "incarnation-1",
        truthClass: "HUMAN_APPROVED" },
    });
    expect(recovered.ok && recovered.state.recoveryRequired).toBe(false);
  });

  it("rejects lifecycle-facet and numeric invariant violations", () => {
    const badFacet = { ...mutableState("QUIESCED"), recoveryRequired: false } as ProjectState;
    const recover = {
      commandId: "cmd-recover", expectedVersion: 7, kind: "recovery.complete",
      witness: { coverageProofHash: HASH, inventoryReconciliationHash: HASH,
        recoveryDecisionRef: "decision-1", recoveryIncarnationRef: "incarnation-1",
        truthClass: "HUMAN_APPROVED" },
    } as const satisfies ProjectCommand;
    expectUnknown(reduceProject(badFacet, recover));
    expectIllegal(reduceProject(mutableState("BOOTSTRAPPING"), activation(1.5)),
      "project.activate", "BOOTSTRAPPING");
    const max = mutableState("BOOTSTRAPPING", Number.MAX_SAFE_INTEGER);
    expectIllegal(reduceProject(max, activation(Number.MAX_SAFE_INTEGER)),
      "project.activate", "BOOTSTRAPPING");
  });

  it("rejects hidden witness fields and malformed runtime values without throwing", () => {
    const hidden = Symbol("authority");
    const extraWitness = { ...activation(), witness: {
      ...activation().witness, [hidden]: { grant: true },
    } } as ProjectCommand;
    expectIllegal(reduceProject(mutableState("BOOTSTRAPPING"), extraWitness),
      "project.activate", "BOOTSTRAPPING");
    const nonenumerable = { ...activation().witness };
    Object.defineProperty(nonenumerable, "truthClass", {
      enumerable: false, value: "DAEMON_VERIFIED",
    });
    expectIllegal(reduceProject(mutableState("BOOTSTRAPPING"), {
      ...activation(), witness: nonenumerable,
    }), "project.activate", "BOOTSTRAPPING");
    let reads = 0;
    const accessor = { ...activation() };
    Object.defineProperty(accessor, "kind", { enumerable: true,
      get: () => (++reads === 1 ? "project.activate" : "project.unknown") });
    expectUnknown(reduceProject(mutableState("BOOTSTRAPPING"),
      accessor as ProjectCommand));
    expectUnknown(reduceProject(null as unknown as ProjectState, activation()));
    const unknown = { ...activation(), kind: "project.unknown" } as unknown as ProjectCommand;
    expectUnknown(reduceProject(mutableState("BOOTSTRAPPING"), unknown));
  });
});
