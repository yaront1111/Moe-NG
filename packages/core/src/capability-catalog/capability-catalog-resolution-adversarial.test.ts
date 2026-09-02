import { expect, it } from "vitest";

import { createCapabilityCatalogRevision } from "./capability-catalog-codec.js";
import { resolveCapabilityCatalogEntry } from "./capability-catalog-resolution.js";
import {
  createVerificationRecipe,
  durableQualificationAuthority,
  hex,
} from "./capability-catalog-resolution-test-fixtures.js";
import {
  catalogDraft,
  createWorld,
} from "./capability-catalog-world-test-fixtures.js";

const mismatch = Object.freeze({
  code: "CAPABILITY_CATALOG_BINDING_MISMATCH",
  layer: "CAPABILITY_CATALOG_RESOLUTION",
  ok: false,
});

it("refuses a verifier backed by a credential-bearing BUILD_AGENT profile", () => {
  const world = createWorld({
    verifierExecutionPatch: {
      credentialBroker: {
        brokerRef: "broker:provider-session",
        maximumCredentialTtlMs: 60_000,
      },
      mounts: [
        { access: "READ_ONLY", kind: "SOURCE_SNAPSHOT", maxBytes: 10_485_760 },
        { access: "READ_WRITE", kind: "RUN_SCRATCH", maxBytes: 10_485_760 },
        { access: "READ_WRITE", kind: "OUTPUT", maxBytes: 10_485_760 },
        { access: "READ_WRITE", kind: "EVIDENCE", maxBytes: 10_485_760 },
      ],
      network: {
        accessMode: "NONE",
        endpointPolicies: [{
          endpointPolicyDigest: hex("8"),
          endpointPolicyRef: "network-policy:qualification",
          plane: "QUALIFICATION_BUILD",
          purpose: "BUILD_AGENT",
        }],
        plane: "QUALIFICATION_BUILD",
      },
      profileId: "execution-credential-bearing-verifier",
      purpose: "BUILD_AGENT",
      revisionId: "execution-credential-bearing-verifier-r1",
    },
  });
  expect(resolveCapabilityCatalogEntry(
    world.catalog, world.request, world.materials, world.authority,
  )).toEqual(mismatch);
});

it("refuses expired qualification replay and a revoked durable head", () => {
  const world = createWorld();
  expect(resolveCapabilityCatalogEntry(
    world.catalog,
    { ...world.request, atEpochMs: world.materials.deliveryProfileQualification.expiresAtEpochMs },
    world.materials,
    world.authority,
  )).toEqual(mismatch);

  const revokedAuthority = Object.freeze({
    ...world.authority,
    readDurableQualificationStatus: (binding: {
      qualificationDigest: string; qualificationId: string;
    }) => Object.freeze({
      qualificationDigest: binding.qualificationDigest,
      qualificationId: binding.qualificationId,
      status: "REVOKED" as const,
      statusDigest: hex("a"),
      statusRef: `qualification-status:${binding.qualificationId}`,
    }),
  });
  expect(resolveCapabilityCatalogEntry(
    world.catalog, world.request, world.materials, revokedAuthority,
  )).toEqual(mismatch);
});

it("refuses an extra bound verifier without an exact qualification receipt", () => {
  const world = createWorld({
    receiptVerifierCapabilityIds: ["capability-web-verify"],
    verifierCapabilityIds: ["capability-web-verify", "capability-web-verify-2"],
  });
  expect(resolveCapabilityCatalogEntry(
    world.catalog, world.request, world.materials, world.authority,
  )).toEqual(mismatch);
});

it("uses code-unit order for Z/a recipe revisions through resolution", () => {
  const world = createWorld();
  const profile = world.materials.deliveryProfileRevision;
  const recipes = Object.freeze([
    createVerificationRecipe(world.builderExecutionIsolationProfileRevision, {
      recipeId: "Z-recipe", revisionId: "Z-r1",
    }),
    createVerificationRecipe(world.builderExecutionIsolationProfileRevision, {
      recipeId: "a-recipe", revisionId: "a-r1",
    }),
  ]);
  const created = createCapabilityCatalogRevision(catalogDraft(
    profile,
    { execution: world.builderExecutionIsolationProfileRevision, recipes },
    [{
      capabilityId: "capability-web-verify",
      execution: world.verifierExecutionIsolationProfileRevision,
      recipes: world.verifierVerificationRecipeRevisions,
    }],
  ));
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const materials = {
    ...world.materials,
    entryMaterials: [
      {
        capabilityId: "capability-web-build",
        executionIsolationProfileRevision: world.builderExecutionIsolationProfileRevision,
        verificationRecipeRevisions: recipes,
      },
      world.materials.entryMaterials[1],
    ],
  };
  expect(resolveCapabilityCatalogEntry(
    created.revision, world.request, materials, durableQualificationAuthority(),
  ).ok).toBe(true);
});

it("refuses ungrounded typed resource claims", () => {
  const claims = [
    { kind: "EVIDENCE_CLASS", ref: "made-up-evidence" },
    { kind: "NETWORK_PLANE", ref: "trusted-github-publisher" },
    { kind: "RESOURCE_CLASS", ref: "imaginary-resource" },
    { kind: "SECRET_SCHEMA", ref: "imaginary-secret" },
  ];
  for (const claim of claims) {
    const world = createWorld({ builderPatch: { resourceScopes: [claim] } });
    expect(resolveCapabilityCatalogEntry(
      world.catalog, world.request, world.materials, world.authority,
    )).toEqual(mismatch);
  }
});

it("refuses swapping per-entry execution and recipe materials", () => {
  const world = createWorld();
  const [builder, verifier] = world.materials.entryMaterials;
  const materials = {
    ...world.materials,
    entryMaterials: [
      {
        capabilityId: builder!.capabilityId,
        executionIsolationProfileRevision: verifier!.executionIsolationProfileRevision,
        verificationRecipeRevisions: verifier!.verificationRecipeRevisions,
      },
      {
        capabilityId: verifier!.capabilityId,
        executionIsolationProfileRevision: builder!.executionIsolationProfileRevision,
        verificationRecipeRevisions: builder!.verificationRecipeRevisions,
      },
    ],
  };
  expect(resolveCapabilityCatalogEntry(
    world.catalog, world.request, materials, world.authority,
  )).toEqual(mismatch);
});

it("binds the qualified builder identity to the requested builder", () => {
  const world = createWorld({ qualificationPatch: {
    builderIdentity: {
      authorityRef: "authority-builder-other",
      capabilityId: "capability-builder-other",
      principalRef: "principal-builder-other",
    },
  } });
  expect(resolveCapabilityCatalogEntry(
    world.catalog, world.request, world.materials, world.authority,
  )).toEqual(mismatch);
});
