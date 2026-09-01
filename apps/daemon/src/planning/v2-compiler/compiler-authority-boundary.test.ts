import { expect, it } from "vitest";

import { createV2Compiler } from "./compiler.js";
import { compilerResolutionMintInput } from "./compiler-resolution-test-fixtures.js";
import {
  TEST_PROJECT_ID, compilerPublishedSourceSnapshot,
} from "./compiler-scheduler-test-fixtures.js";
import { snapshotCompilerInput } from "./snapshot.js";

it("publishes a factory instead of caller-authorized mint and compile functions", async () => {
  const surface = await import("./compiler.js");
  const functions = Object.entries(surface)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
  expect(functions).toEqual(["createV2Compiler"]);
});

it("rejects proxies before invoking any proxy trap", () => {
  let traps = 0;
  const target = { contract: {}, graphId: "graph-v2", nodes: [] };
  const value = new Proxy(target, {
    getOwnPropertyDescriptor: (subject, key) => {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(subject, key);
    },
    getPrototypeOf: (subject) => {
      traps += 1;
      return Reflect.getPrototypeOf(subject);
    },
    ownKeys: (subject) => {
      traps += 1;
      return Reflect.ownKeys(subject);
    },
  });
  expect(snapshotCompilerInput(value)).toEqual({ ok: false });
  expect(traps).toBe(0);
});

it("closes the authoritative clock and qualification reader over token minting", () => {
  const world = compilerResolutionMintInput();
  let statusReads = 0;
  const qualificationAuthority = Object.freeze({
    ...world.qualificationAuthority,
    readDurableQualificationStatus: (binding: {
      qualificationDigest: string; qualificationId: string;
    }) => {
      statusReads += 1;
      return world.qualificationAuthority.readDurableQualificationStatus(binding);
    },
  });
  const compiler = createV2Compiler({
    clock: () => 1_500,
    projectId: TEST_PROJECT_ID,
    qualificationAuthority,
    readGraphAuthority: () => undefined,
    readNodeAdmissionAuthority: () => undefined,
    readNodePlanningAuthority: () => undefined,
    readPublishedSourceSnapshot: compilerPublishedSourceSnapshot,
  } as never);
  const minted = compiler.mintResolutionToken(
    world.catalog,
    {
      capabilityId: world.request.capabilityId,
      requiredCriterionCategories: world.request.requiredCriterionCategories,
    },
    world.materials,
  );
  expect(minted.ok).toBe(true);
  expect(statusReads).toBe(1);
});

it("descriptor-captures factory authority so later dependency mutation cannot downgrade it", () => {
  const world = compilerResolutionMintInput();
  const qualificationAuthority = { ...world.qualificationAuthority };
  const dependencies = {
    clock: () => 1_500, projectId: TEST_PROJECT_ID, qualificationAuthority,
    readGraphAuthority: () => undefined, readNodeAdmissionAuthority: () => undefined,
    readNodePlanningAuthority: () => undefined,
    readPublishedSourceSnapshot: compilerPublishedSourceSnapshot,
  };
  const compiler = createV2Compiler(dependencies);
  dependencies.clock = () => 2_000;
  qualificationAuthority.readDurableQualificationStatus = () => undefined;
  const minted = compiler.mintResolutionToken(world.catalog, {
    capabilityId: world.request.capabilityId,
    requiredCriterionCategories: world.request.requiredCriterionCategories,
  }, world.materials);
  expect(minted.ok).toBe(true);
});

it("rejects a proxied factory dependency record without invoking traps", () => {
  const world = compilerResolutionMintInput(); let traps = 0;
  const dependencies = new Proxy({ clock: () => 1_500,
    projectId: TEST_PROJECT_ID,
    qualificationAuthority: world.qualificationAuthority,
    readGraphAuthority: () => undefined, readNodeAdmissionAuthority: () => undefined,
    readNodePlanningAuthority: () => undefined,
    readPublishedSourceSnapshot: compilerPublishedSourceSnapshot }, {
    ownKeys: (target) => { traps += 1; return Reflect.ownKeys(target); },
  });
  const compiler = createV2Compiler(dependencies);
  const minted = compiler.mintResolutionToken(world.catalog, {
    capabilityId: world.request.capabilityId,
    requiredCriterionCategories: world.request.requiredCriterionCategories,
  }, world.materials);
  expect(minted).toEqual({ code: "V2_COMPILER_CAPABILITY_UNRESOLVED",
    layer: "V2_COMPILER_CAPABILITY_BINDING", ok: false });
  expect(traps).toBe(0);
});

it.each(["projectId", "readNodePlanningAuthority", "readPublishedSourceSnapshot"])(
  "rejects an accessor-backed %s dependency without invoking it",
  (key) => {
    const world = compilerResolutionMintInput(); let reads = 0;
    const dependencies: Record<string, unknown> = {
      clock: () => 1_500,
      projectId: TEST_PROJECT_ID,
      qualificationAuthority: world.qualificationAuthority,
      readGraphAuthority: () => undefined,
      readNodeAdmissionAuthority: () => undefined,
      readNodePlanningAuthority: () => undefined,
      readPublishedSourceSnapshot: compilerPublishedSourceSnapshot,
    };
    Object.defineProperty(dependencies, key, {
      enumerable: true,
      get: () => {
        reads += 1;
        if (key === "projectId") return TEST_PROJECT_ID;
        return key === "readPublishedSourceSnapshot"
          ? compilerPublishedSourceSnapshot : () => undefined;
      },
    });
    const compiler = createV2Compiler(dependencies as never);
    const minted = compiler.mintResolutionToken(world.catalog, {
      capabilityId: world.request.capabilityId,
      requiredCriterionCategories: world.request.requiredCriterionCategories,
    }, world.materials);
    expect(minted).toEqual({
      code: "V2_COMPILER_CAPABILITY_UNRESOLVED",
      layer: "V2_COMPILER_CAPABILITY_BINDING",
      ok: false,
    });
    expect(reads).toBe(0);
  },
);

it.each([
  ["missing key", (value: Record<string, unknown>) => { delete value["projectId"]; }],
  ["excess key", (value: Record<string, unknown>) => { value["extra"] = true; }],
])("rejects a dependency record with an exact-key %s", (_name, mutate) => {
  const world = compilerResolutionMintInput();
  const dependencies: Record<string, unknown> = {
    clock: () => 1_500,
    projectId: TEST_PROJECT_ID,
    qualificationAuthority: world.qualificationAuthority,
    readGraphAuthority: () => undefined,
    readNodeAdmissionAuthority: () => undefined,
    readNodePlanningAuthority: () => undefined,
    readPublishedSourceSnapshot: compilerPublishedSourceSnapshot,
  };
  mutate(dependencies);
  const compiler = createV2Compiler(dependencies as never);
  expect(compiler.mintResolutionToken(world.catalog, {
    capabilityId: world.request.capabilityId,
    requiredCriterionCategories: world.request.requiredCriterionCategories,
  }, world.materials)).toEqual({
    code: "V2_COMPILER_CAPABILITY_UNRESOLVED",
    layer: "V2_COMPILER_CAPABILITY_BINDING",
    ok: false,
  });
});

it("rejects proxied nested and revoked reader functions without applying them", () => {
  const world = compilerResolutionMintInput(); let applies = 0;
  const nested = new Proxy(() => true, {
    apply: () => {
      applies += 1;
      return true;
    },
  });
  const planningProxy = new Proxy(() => undefined, {
    apply: () => {
      applies += 1;
      return undefined;
    },
  });
  const revoked = Proxy.revocable(compilerPublishedSourceSnapshot, {
    apply: (target, thisArg, args: [never]) => {
      applies += 1;
      return Reflect.apply(target, thisArg, args);
    },
  });
  revoked.revoke();
  const revokedPlanning = Proxy.revocable(() => undefined, {
    apply: () => {
      applies += 1;
      return undefined;
    },
  });
  revokedPlanning.revoke();
  for (const dependencies of [
    {
      clock: () => 1_500,
      projectId: TEST_PROJECT_ID,
      qualificationAuthority: {
        ...world.qualificationAuthority,
        verifyDurableBuilderIdentity: nested,
      },
      readGraphAuthority: () => undefined,
      readNodeAdmissionAuthority: () => undefined,
      readNodePlanningAuthority: () => undefined,
      readPublishedSourceSnapshot: compilerPublishedSourceSnapshot,
    },
    {
      clock: () => 1_500,
      projectId: TEST_PROJECT_ID,
      qualificationAuthority: world.qualificationAuthority,
      readGraphAuthority: () => undefined,
      readNodeAdmissionAuthority: () => undefined,
      readNodePlanningAuthority: () => undefined,
      readPublishedSourceSnapshot: revoked.proxy,
    },
    {
      clock: () => 1_500,
      projectId: TEST_PROJECT_ID,
      qualificationAuthority: world.qualificationAuthority,
      readGraphAuthority: () => undefined,
      readNodeAdmissionAuthority: () => undefined,
      readNodePlanningAuthority: planningProxy,
      readPublishedSourceSnapshot: compilerPublishedSourceSnapshot,
    },
    {
      clock: () => 1_500,
      projectId: TEST_PROJECT_ID,
      qualificationAuthority: world.qualificationAuthority,
      readGraphAuthority: () => undefined,
      readNodeAdmissionAuthority: () => undefined,
      readNodePlanningAuthority: revokedPlanning.proxy,
      readPublishedSourceSnapshot: compilerPublishedSourceSnapshot,
    },
  ]) {
    const compiler = createV2Compiler(dependencies as never);
    expect(compiler.mintResolutionToken(world.catalog, {
      capabilityId: world.request.capabilityId,
      requiredCriterionCategories: world.request.requiredCriterionCategories,
    }, world.materials).ok).toBe(false);
  }
  expect(applies).toBe(0);
});

it.each(["", "project\0invalid", "e\u0301", "x".repeat(257)])(
  "rejects invalid server project syntax before any published-reader call",
  (projectId) => {
    const world = compilerResolutionMintInput(); let sourceReads = 0;
    const compiler = createV2Compiler({
      clock: () => 1_500,
      projectId,
      qualificationAuthority: world.qualificationAuthority,
      readGraphAuthority: () => undefined,
      readNodeAdmissionAuthority: () => undefined,
      readNodePlanningAuthority: () => undefined,
      readPublishedSourceSnapshot: (ref) => {
        sourceReads += 1;
        return compilerPublishedSourceSnapshot(ref);
      },
    });
    expect(compiler.mintResolutionToken(world.catalog, {
      capabilityId: world.request.capabilityId,
      requiredCriterionCategories: world.request.requiredCriterionCategories,
    }, world.materials).ok).toBe(false);
    expect(sourceReads).toBe(0);
  },
);
