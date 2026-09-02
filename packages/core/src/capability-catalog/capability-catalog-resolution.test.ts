import { expect, it } from "vitest";

import { createVerificationRecipe, hex } from
  "./capability-catalog-resolution-test-fixtures.js";
import {
  createWorld,
  type CapabilityCatalogWorldOptions,
} from "./capability-catalog-world-test-fixtures.js";

const resolutionPath = "./capability-catalog-resolution.js";
const malformed = {
  code: "CAPABILITY_CATALOG_MALFORMED",
  layer: "CAPABILITY_CATALOG_RESOLUTION",
  ok: false,
};
const mismatch = {
  code: "CAPABILITY_CATALOG_BINDING_MISMATCH",
  layer: "CAPABILITY_CATALOG_RESOLUTION",
  ok: false,
};

async function setup(options: CapabilityCatalogWorldOptions = {}) {
  const world = createWorld(options);
  const module = await import(resolutionPath) as any;
  const resolver = module.resolveCapabilityCatalogEntry as (...args: any[]) => any;
  return {
    ...world,
    resolve: (...args: unknown[]) => resolver(
      args.length > 0 ? args[0] : world.catalog,
      args.length > 1 ? args[1] : world.request,
      args.length > 2 ? args[2] : world.materials,
      args.length > 3 ? args[3] : world.authority,
    ),
  };
}

it("returns one immutable catalog-bound witness with exact per-entry materials", async () => {
  const world = await setup();
  const result = world.resolve();
  expect(result).toEqual({
    ok: true,
    witness: {
      atEpochMs: world.request.atEpochMs,
      builderBinding: {
        capability: world.catalog.entries[0],
        executionIsolationProfileRevision:
          world.builderExecutionIsolationProfileRevision,
        verificationRecipeRevisions: world.builderVerificationRecipeRevisions,
      },
      catalogId: world.catalog.catalogId,
      catalogRevisionDigest: world.catalog.revisionDigest,
      catalogRevisionId: world.catalog.revisionId,
      deliveryProfileQualification: world.materials.deliveryProfileQualification,
      deliveryProfileQualificationStatus: {
        qualificationDigest: world.materials.deliveryProfileQualification.qualificationDigest,
        qualificationId: world.materials.deliveryProfileQualification.qualificationId,
        status: "CURRENT",
        statusDigest: hex("a"),
        statusRef: `qualification-status:${world.materials.deliveryProfileQualification.qualificationId}`,
      },
      deliveryProfileRevision: world.materials.deliveryProfileRevision,
      requiredCriterionCategories: world.request.requiredCriterionCategories,
      verifierBindings: [{
        capability: world.catalog.entries[1],
        executionIsolationProfileRevision:
          world.verifierExecutionIsolationProfileRevision,
        verificationRecipeRevisions: world.verifierVerificationRecipeRevisions,
      }],
    },
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.witness)).toBe(true);
  expect(Object.isFrozen(result.witness.builderBinding)).toBe(true);
  expect(Object.isFrozen(result.witness.deliveryProfileQualificationStatus)).toBe(true);
  expect(Object.isFrozen(result.witness.verifierBindings)).toBe(true);
});

it("refuses an absent capability exactly and never selects another builder", async () => {
  const world = await setup();
  expect(world.resolve(world.catalog, {
    ...world.request, capabilityId: "capability-absent",
  })).toEqual({
    code: "CAPABILITY_CATALOG_ENTRY_ABSENT",
    layer: "CAPABILITY_CATALOG_RESOLUTION",
    ok: false,
  });
});

it.each([
  { requiredCriterionCategories: [] },
  { requiredCriterionCategories: ["SECURITY_PRIVACY", "FUNCTIONAL"] },
  { requiredCriterionCategories: ["FUNCTIONAL", "FUNCTIONAL"] },
  { requiredCriterionCategories: ["UNKNOWN"] },
  { atEpochMs: -0 },
  { atEpochMs: Number.MAX_SAFE_INTEGER + 1 },
  { extra: "no-default" },
])("rejects malformed requests and noncanonical category sets", async (patch) => {
  const world = await setup();
  expect(world.resolve(world.catalog, { ...world.request, ...patch })).toEqual(malformed);
});

it("requires builder and bound verifiers to cover every requested category", async () => {
  const builder = await setup({ builderPatch: { criterionCategories: ["FUNCTIONAL"] } });
  expect(builder.resolve()).toEqual(mismatch);
  const verifier = await setup({ verifierPatch: { criterionCategories: ["FUNCTIONAL"] } });
  expect(verifier.resolve()).toEqual(mismatch);
});

it("never resolves a verifier as the requested builder", async () => {
  const world = await setup();
  expect(world.resolve(world.catalog, {
    ...world.request, capabilityId: "capability-web-verify",
  })).toEqual(mismatch);
});

it("cross-checks exact catalog delivery and per-entry execution revisions", async () => {
  const delivery = await setup({ builderPatch: { deliveryProfileRevisionDigest: hex("9") } });
  expect(delivery.resolve()).toEqual(mismatch);
  const execution = await setup({
    verifierPatch: { executionIsolationProfileRevisionId: "execution-other-r1" },
  });
  expect(execution.resolve()).toEqual(mismatch);
});

it("requires a digest-valid qualification resolved by durable authority", async () => {
  const world = await setup();
  expect(world.resolve(world.catalog, world.request, {
    ...world.materials,
    deliveryProfileQualification: {
      ...world.materials.deliveryProfileQualification,
      profileRevisionDigest: hex("9"),
    },
  })).toEqual(mismatch);
  expect(world.resolve(world.catalog, world.request, world.materials, undefined))
    .toEqual(mismatch);
  const calls = { approval: 0, builder: 0, provider: 0, receipt: 0, status: 0 };
  const authority = {
    readDurableQualificationStatus: (binding: {
      qualificationDigest: string; qualificationId: string;
    }) => {
      calls.status += 1;
      return {
        qualificationDigest: binding.qualificationDigest,
        qualificationId: binding.qualificationId,
        status: "CURRENT",
        statusDigest: hex("a"),
        statusRef: `qualification-status:${binding.qualificationId}`,
      };
    },
    verifyDurableOperatorApproval: () => { calls.approval += 1; return true; },
    verifyDurableBuilderIdentity: () => { calls.builder += 1; return true; },
    verifyDurableProviderProfile: () => { calls.provider += 1; return true; },
    verifyDurableVerifierReceipt: () => { calls.receipt += 1; return true; },
  };
  expect(world.resolve(world.catalog, world.request, world.materials, authority).ok).toBe(true);
  expect(calls).toEqual({ approval: 1, builder: 1, provider: 1, receipt: 9, status: 1 });
});

it("cross-checks execution-to-delivery and recipe source bindings", async () => {
  const execution = await setup({ executionPatch: { deliveryProfileRevisionDigest: hex("9") } });
  expect(execution.resolve()).toEqual(mismatch);
  for (const recipePatch of [
    { executionProfileRevisionDigest: hex("9") },
    { sourceSnapshotDigest: hex("9") },
  ]) {
    const recipe = await setup({ recipePatch });
    expect(recipe.resolve()).toEqual(mismatch);
  }
});

it("cross-checks required tool and OCI image digests per entry", async () => {
  for (const recipePatch of [
    { tool: { toolDigest: hex("9"), toolRef: "tool:node" } },
    { image: { imageDigest: `sha256:${hex("9")}`, imageRef: "image:node24" } },
  ]) {
    const recipe = await setup({ recipePatch });
    expect(recipe.resolve()).toEqual(mismatch);
  }
  const verifier = await setup({ verifierPatch: { requiredImageDigests: [] } });
  expect(verifier.resolve()).toEqual(mismatch);
});

it("enforces recipe network, resource, environment, and mount compatibility", async () => {
  const resources = await setup({ recipePatch: { resourceCaps: {
    cpuMilliCores: 3_000, memoryBytes: 1_073_741_824,
    outputBytes: 10_485_760, pids: 128, timeoutMs: 300_000,
  } } });
  expect(resources.resolve()).toEqual(mismatch);
  const output = await setup({ verifierRecipePatch: { expectedOutputs: [{
    mount: "OUTPUT", relativePath: "reports/unit.json", sha256: hex("7"),
  }] } });
  expect(output.resolve()).toEqual(mismatch);
});

it.each(["DOCKER_HOST", "GITHUB_TOKEN", "HOME", "SSH_AUTH_SOCK"])(
  "rejects execution-sensitive recipe environment name %s",
  async (environmentName) => {
    const world = await setup();
    const entries = world.materials.entryMaterials.map((entry) => entry.capabilityId
      !== "capability-web-build" ? entry : {
        ...entry,
        verificationRecipeRevisions: [{
          ...entry.verificationRecipeRevisions[0],
          environmentNameAllowlist: [environmentName],
        }],
      });
    expect(world.resolve(world.catalog, world.request, {
      ...world.materials, entryMaterials: entries,
    })).toEqual(mismatch);
  },
);

it("requires the supplied per-entry recipe and capability set exactly", async () => {
  const world = await setup();
  expect(world.resolve(world.catalog, world.request, {
    ...world.materials, entryMaterials: world.materials.entryMaterials.slice(0, 1),
  })).toEqual(mismatch);
  const builder = world.materials.entryMaterials[0]!;
  const extra = createVerificationRecipe(builder.executionIsolationProfileRevision, {
    recipeId: "verify-extra", revisionId: "verify-extra-r1",
  });
  expect(world.resolve(world.catalog, world.request, {
    ...world.materials,
    entryMaterials: [{ ...builder, verificationRecipeRevisions: [
      ...builder.verificationRecipeRevisions, extra,
    ] }, ...world.materials.entryMaterials.slice(1)],
  })).toEqual(mismatch);
});

it("does not default missing or unknown resolution materials", async () => {
  const world = await setup();
  expect(world.resolve(world.catalog, world.request, undefined)).toEqual(mismatch);
  expect(world.resolve(world.catalog, world.request, {
    ...world.materials, fallback: true,
  })).toEqual(mismatch);
});

it("uses the same hostile catalog and material snapshots it verified", async () => {
  const world = await setup();
  let catalogReads = 0; let materialReads = 0;
  const catalog = new Proxy({ ...world.catalog }, {
    getOwnPropertyDescriptor(target, key) {
      if (key !== "entries") return Reflect.getOwnPropertyDescriptor(target, key);
      catalogReads += 1;
      return { configurable: true, enumerable: true, value: world.catalog.entries, writable: true };
    },
  });
  const materials = new Proxy({ ...world.materials }, {
    getOwnPropertyDescriptor(target, key) {
      if (key !== "entryMaterials") return Reflect.getOwnPropertyDescriptor(target, key);
      materialReads += 1;
      return { configurable: true, enumerable: true,
        value: world.materials.entryMaterials, writable: true };
    },
  });
  expect(world.resolve(catalog, world.request, materials).ok).toBe(true);
  expect({ catalogReads, materialReads }).toEqual({ catalogReads: 1, materialReads: 1 });
});
