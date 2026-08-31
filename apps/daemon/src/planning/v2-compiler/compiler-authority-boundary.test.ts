import { expect, it } from "vitest";

import { createV2Compiler } from "./compiler.js";
import { compilerResolutionMintInput } from "./compiler-resolution-test-fixtures.js";
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
    qualificationAuthority,
    readGraphAuthority: () => undefined,
    readNodeAdmissionAuthority: () => undefined,
    readNodeDefinition: () => undefined,
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
    clock: () => 1_500, qualificationAuthority,
    readGraphAuthority: () => undefined, readNodeAdmissionAuthority: () => undefined,
    readNodeDefinition: () => undefined,
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
    qualificationAuthority: world.qualificationAuthority,
    readGraphAuthority: () => undefined, readNodeAdmissionAuthority: () => undefined,
    readNodeDefinition: () => undefined }, {
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
