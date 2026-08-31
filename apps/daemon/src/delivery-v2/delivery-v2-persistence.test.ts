import { resolveQualifiedDeliveryProfile } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { resolvedCompilerWitness } from
  "../planning/v2-compiler/compiler-resolution-test-fixtures.js";
import {
  createCapabilityCatalogRevisionIngress,
  createDeliveryProfileQualificationIngress,
  createDeliveryProfileRevisionIngress,
  createExecutionIsolationProfileRevisionIngress,
  createVerificationRecipeRevisionIngress,
  createDeliveryProfileBuilderIdentityIngress,
  createDeliveryProfileOperatorApprovalIngress,
  createDeliveryProfileProviderProfileIngress,
  createDeliveryProfileQualificationAuthority,
  createDeliveryProfileQualificationStatusIngress,
  createDeliveryProfileVerifierReceiptIngress,
  readCapabilityCatalogRevision as readCapabilityCatalogRevisionBound,
  readDeliveryProfileQualification as readDeliveryProfileQualificationBound,
  readDeliveryProfileQualificationStatusFence,
  readDeliveryProfileRevision as readDeliveryProfileRevisionBound,
  readDeliveryV2ResolutionMaterials as readDeliveryV2ResolutionMaterialsBound,
  readExecutionIsolationProfileRevision as readExecutionIsolationProfileRevisionBound,
  readVerificationRecipeRevision as readVerificationRecipeRevisionBound,
  type DeliveryV2AppendContext,
  type DeliveryV2MaterialPublisherPrincipalBindings,
} from "./index.js";
import { deliveryV2Digest } from "./addresses.js";

const PROJECT = "project-delivery-v2";
const MATERIAL_PRINCIPAL = "principal:delivery-v2-material-publisher";
const PROVIDER_PRINCIPAL = "principal:provider-profile-codex";
const MATERIAL_PUBLISHERS: DeliveryV2MaterialPublisherPrincipalBindings = Object.freeze({
  capabilityCatalogPrincipalId: MATERIAL_PRINCIPAL,
  deliveryProfilePrincipalId: MATERIAL_PRINCIPAL,
  deliveryProfileQualificationPrincipalId: MATERIAL_PRINCIPAL,
  executionIsolationProfilePrincipalId: MATERIAL_PRINCIPAL,
  verificationRecipePrincipalId: MATERIAL_PRINCIPAL,
});
const context = (commandId: string, expectedVersion = 0): DeliveryV2AppendContext =>
  Object.freeze({
    commandId,
    correlationId: `correlation:${commandId}`,
    decidedAt: "2026-08-31T12:00:00.000Z",
    expectedVersion,
    principalId: "operator-1",
    projectId: PROJECT,
  });
const principalContext = (
  commandId: string, principalId: string, expectedVersion = 0,
): DeliveryV2AppendContext => Object.freeze({
  ...context(commandId, expectedVersion), principalId,
});

const materialContext = (request: DeliveryV2AppendContext): DeliveryV2AppendContext =>
  Object.freeze({ ...request, principalId: MATERIAL_PRINCIPAL });
const appendCapabilityCatalogRevision = (
  store: SqliteEventStore, request: DeliveryV2AppendContext, value: unknown,
) => createCapabilityCatalogRevisionIngress(
  store, MATERIAL_PRINCIPAL,
)(materialContext(request), value);
const appendDeliveryProfileRevision = (
  store: SqliteEventStore, request: DeliveryV2AppendContext, value: unknown,
) => createDeliveryProfileRevisionIngress(
  store, MATERIAL_PRINCIPAL,
)(materialContext(request), value);
const appendDeliveryProfileQualification = (
  store: SqliteEventStore, request: DeliveryV2AppendContext, value: unknown,
) => createDeliveryProfileQualificationIngress(
  store, MATERIAL_PRINCIPAL,
)(materialContext(request), value);
const appendExecutionIsolationProfileRevision = (
  store: SqliteEventStore, request: DeliveryV2AppendContext, value: unknown,
) => createExecutionIsolationProfileRevisionIngress(
  store, MATERIAL_PRINCIPAL,
)(materialContext(request), value);
const appendVerificationRecipeRevision = (
  store: SqliteEventStore, request: DeliveryV2AppendContext, value: unknown,
) => createVerificationRecipeRevisionIngress(
  store, MATERIAL_PRINCIPAL,
)(materialContext(request), value);
const readCapabilityCatalogRevision = (
  store: SqliteEventStore, ref: Parameters<typeof readCapabilityCatalogRevisionBound>[1],
) => readCapabilityCatalogRevisionBound(store, ref, MATERIAL_PUBLISHERS);
const readDeliveryProfileRevision = (
  store: SqliteEventStore, ref: Parameters<typeof readDeliveryProfileRevisionBound>[1],
) => readDeliveryProfileRevisionBound(store, ref, MATERIAL_PUBLISHERS);
const readDeliveryProfileQualification = (
  store: SqliteEventStore, ref: Parameters<typeof readDeliveryProfileQualificationBound>[1],
) => readDeliveryProfileQualificationBound(store, ref, MATERIAL_PUBLISHERS);
const readExecutionIsolationProfileRevision = (
  store: SqliteEventStore, ref: Parameters<typeof readExecutionIsolationProfileRevisionBound>[1],
) => readExecutionIsolationProfileRevisionBound(store, ref, MATERIAL_PUBLISHERS);
const readVerificationRecipeRevision = (
  store: SqliteEventStore, ref: Parameters<typeof readVerificationRecipeRevisionBound>[1],
) => readVerificationRecipeRevisionBound(store, ref, MATERIAL_PUBLISHERS);
const readDeliveryV2ResolutionMaterials = (
  store: SqliteEventStore, refs: Parameters<typeof readDeliveryV2ResolutionMaterialsBound>[1],
) => readDeliveryV2ResolutionMaterialsBound(store, refs, MATERIAL_PUBLISHERS);

const appendDeliveryProfileOperatorApproval = (
  store: SqliteEventStore, request: DeliveryV2AppendContext,
  binding: Parameters<ReturnType<typeof createDeliveryProfileOperatorApprovalIngress>>[1],
) => createDeliveryProfileOperatorApprovalIngress(store, "operator-1")(request, binding);
const appendDeliveryProfileQualificationStatus = (
  store: SqliteEventStore, request: DeliveryV2AppendContext,
  input: Parameters<ReturnType<typeof createDeliveryProfileQualificationStatusIngress>>[1],
) => createDeliveryProfileQualificationStatusIngress(store, "operator-1")(request, input);
const appendDeliveryProfileBuilderIdentity = (
  store: SqliteEventStore, request: DeliveryV2AppendContext,
  builder: Parameters<ReturnType<typeof createDeliveryProfileBuilderIdentityIngress>>[1],
  binding: Parameters<ReturnType<typeof createDeliveryProfileBuilderIdentityIngress>>[2],
) => createDeliveryProfileBuilderIdentityIngress(store, {
  authorityRef: "authority-builder",
  capabilityId: "capability-web-build",
  principalId: "principal-builder",
})(request, builder, binding);
const appendDeliveryProfileProviderProfile = (
  store: SqliteEventStore, request: DeliveryV2AppendContext,
  profile: Parameters<ReturnType<typeof createDeliveryProfileProviderProfileIngress>>[1],
  binding: Parameters<ReturnType<typeof createDeliveryProfileProviderProfileIngress>>[2],
) => createDeliveryProfileProviderProfileIngress(store, {
  principalId: PROVIDER_PRINCIPAL, profileRef: "provider-profile:codex",
})(request, profile, binding);
const appendDeliveryProfileVerifierReceipt = (
  store: SqliteEventStore, request: DeliveryV2AppendContext,
  receipt: Parameters<ReturnType<typeof createDeliveryProfileVerifierReceiptIngress>>[1],
  binding: Parameters<ReturnType<typeof createDeliveryProfileVerifierReceiptIngress>>[2],
) => createDeliveryProfileVerifierReceiptIngress(store, {
  authorityRef: "authority:capability-web-verify",
  capabilityId: "capability-web-verify",
  principalId: "principal:capability-web-verify",
})(request, receipt, binding);

function fixture() {
  const fact = resolvedCompilerWitness();
  const bindings = [fact.witness.builderBinding, ...fact.witness.verifierBindings];
  return Object.freeze({
    catalog: fact.catalogRevision,
    entries: bindings.map((binding) => Object.freeze({
      capabilityId: binding.capability.capabilityId,
      execution: binding.executionIsolationProfileRevision,
      recipes: binding.verificationRecipeRevisions,
    })),
    profile: fact.witness.deliveryProfileRevision,
    qualification: fact.witness.deliveryProfileQualification,
  });
}

function evidenceBindingOf(value: ReturnType<typeof fixture>) {
  const { profile, qualification } = value;
  return Object.freeze({
    benchmarkManifest: qualification.benchmarkManifest,
    benchmarkVerdict: qualification.benchmarkVerdict,
    builderIdentity: qualification.builderIdentity,
    moeSourceCommit: qualification.moeSourceCommit,
    observedDigests: qualification.observedDigests,
    profileFamilyId: qualification.profileFamilyId,
    profileId: qualification.profileId,
    profileRevisionDigest: qualification.profileRevisionDigest,
    profileRevisionId: qualification.profileRevisionId,
    providerProfileRefs: qualification.providerProfileRefs,
    qualificationDigest: qualification.qualificationDigest,
    qualificationId: qualification.qualificationId,
    requiredModelProviderCapabilities: profile.requiredModelProviderCapabilities,
  });
}

function approvalBindingOf(value: ReturnType<typeof fixture>) {
  const { qualification } = value;
  return Object.freeze({
    operatorApprovalRef: qualification.operatorApprovalRef!,
    profileFamilyId: qualification.profileFamilyId,
    profileId: qualification.profileId,
    profileRevisionDigest: qualification.profileRevisionDigest,
    profileRevisionId: qualification.profileRevisionId,
    qualificationDigest: qualification.qualificationDigest,
    qualificationId: qualification.qualificationId,
  });
}

function authorityPrincipalsOf(value: ReturnType<typeof fixture>) {
  return Object.freeze({
    builderIdentityPrincipals: Object.freeze([Object.freeze({
      authorityRef: value.qualification.builderIdentity.authorityRef,
      capabilityId: value.qualification.builderIdentity.capabilityId,
      principalId: value.qualification.builderIdentity.principalRef,
    })]),
    operatorApprovalPrincipalId: "operator-1",
    providerProfilePrincipals: Object.freeze(value.qualification.providerProfileRefs.map(
      (profile) => Object.freeze({ principalId: PROVIDER_PRINCIPAL, profileRef: profile.profileRef }),
    )),
    qualificationStatusPrincipalId: "operator-1",
    verifierReceiptPrincipals: Object.freeze([Object.freeze({
      authorityRef: value.qualification.independentVerifierReceipts[0]!.verifierAuthorityRef,
      capabilityId: value.qualification.independentVerifierReceipts[0]!.verifierCapabilityId,
      principalId: value.qualification.independentVerifierReceipts[0]!.verifierRef,
    })]),
  });
}

function resolutionRefsOf(value: ReturnType<typeof fixture>) {
  return Object.freeze({
    catalog: Object.freeze({ catalogId: value.catalog.catalogId,
      revisionDigest: value.catalog.revisionDigest, revisionId: value.catalog.revisionId }),
    deliveryProfile: Object.freeze({ profileId: value.profile.profileId,
      revisionDigest: value.profile.revisionDigest, revisionId: value.profile.revisionId }),
    entries: Object.freeze(value.entries.map((entry) => Object.freeze({
      capabilityId: entry.capabilityId,
      executionIsolationProfile: Object.freeze({ profileId: entry.execution.profileId,
        revisionDigest: entry.execution.revisionDigest, revisionId: entry.execution.revisionId }),
      verificationRecipes: Object.freeze(entry.recipes.map((recipe) => Object.freeze({
        recipeId: recipe.recipeId, revisionDigest: recipe.revisionDigest,
        revisionId: recipe.revisionId,
      }))),
    }))),
    projectId: PROJECT,
    qualification: Object.freeze({ qualificationDigest: value.qualification.qualificationDigest,
      qualificationId: value.qualification.qualificationId }),
  });
}

function eventIdTampered(store: SqliteEventStore, suffix: string) {
  return Object.freeze({
    readAggregateEvents: (
      aggregateId: string, afterAggregateSequence?: number, limit?: number,
      maxDecodedBytes?: number,
    ) => {
      const page = store.readAggregateEvents(
        aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
      );
      return Object.freeze({ ...page, items: Object.freeze(page.items.map((event) =>
        Object.freeze({ ...event, eventId: `${event.eventId}:${suffix}` }))) });
    },
  });
}

function payloadTampered(store: SqliteEventStore) {
  return Object.freeze({
    readAggregateEvents: (
      aggregateId: string, afterAggregateSequence?: number, limit?: number,
      maxDecodedBytes?: number,
    ) => {
      const page = store.readAggregateEvents(
        aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
      );
      return Object.freeze({ ...page, items: Object.freeze(page.items.map((event) =>
        Object.freeze({ ...event, payload: new TextEncoder().encode("{tampered") }))) });
    },
  });
}

function traceTampered(store: SqliteEventStore, principalId?: string) {
  return Object.freeze({
    readAggregateEvents: (
      aggregateId: string, afterAggregateSequence?: number, limit?: number,
      maxDecodedBytes?: number,
    ) => {
      const page = store.readAggregateEvents(
        aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
      );
      return Object.freeze({ ...page, items: Object.freeze(page.items.map((event) =>
        event.decisionTrace === undefined ? event : Object.freeze({
          ...event,
          decisionTrace: Object.freeze({
            ...event.decisionTrace,
            principalId: principalId ?? event.decisionTrace.principalId,
            requestSha256: "f".repeat(64),
          }),
        }))) });
    },
  });
}

function principalSubstituted(store: SqliteEventStore, principalId: string) {
  return Object.freeze({
    getCommandDecision: store.getCommandDecision.bind(store),
    getCommandReceipt: store.getCommandReceipt.bind(store),
    readAggregateEvents: (
      aggregateId: string, afterAggregateSequence?: number, limit?: number,
      maxDecodedBytes?: number,
    ) => {
      const page = store.readAggregateEvents(
        aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
      );
      return Object.freeze({ ...page, items: Object.freeze(page.items.map((event) =>
        event.decisionTrace === undefined ? event : Object.freeze({
          ...event, decisionTrace: Object.freeze({ ...event.decisionTrace, principalId }),
        }))) });
    },
  });
}

function effectCommandSubstituted(store: SqliteEventStore) {
  const syntheticCommandId = "moe-internal:decision-effect:synthetic";
  let storedCommandId: string | undefined;
  return Object.freeze({
    getCommandDecision: store.getCommandDecision.bind(store),
    getCommandReceipt: (commandId: string) => {
      const receipt = store.getCommandReceipt(
        commandId === syntheticCommandId && storedCommandId !== undefined
          ? storedCommandId : commandId,
      );
      return receipt === null ? null : Object.freeze({ ...receipt, commandId });
    },
    readAggregateEvents: (
      aggregateId: string, afterAggregateSequence?: number, limit?: number,
      maxDecodedBytes?: number,
    ) => {
      const page = store.readAggregateEvents(
        aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
      );
      return Object.freeze({ ...page, items: Object.freeze(page.items.map((event) => {
        storedCommandId = event.commandId;
        return Object.freeze({ ...event, commandId: syntheticCommandId });
      })) });
    },
  });
}

function decisionVersionTampered(store: SqliteEventStore) {
  return Object.freeze({
    getCommandDecision: (key: Parameters<SqliteEventStore["getCommandDecision"]>[0]) => {
      const decision = store.getCommandDecision(key);
      return decision === null ? null : Object.freeze({
        ...decision, recordVersion: "synthetic-decision-version",
      });
    },
    getCommandReceipt: store.getCommandReceipt.bind(store),
    readAggregateEvents: store.readAggregateEvents.bind(store),
  });
}

function commitDispositionTampered(store: SqliteEventStore) {
  return Object.freeze({
    commitExpectedVersionDecisionLegs: (
      input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0],
    ) => Object.freeze({
      ...store.commitExpectedVersionDecisionLegs(input), disposition: "COMMITTED",
    }),
    getCommandDecision: store.getCommandDecision.bind(store),
    getCommandReceipt: store.getCommandReceipt.bind(store),
    readAggregateEvents: store.readAggregateEvents.bind(store),
  });
}

function decisionReplayMetadataTampered(store: SqliteEventStore) {
  return Object.freeze({
    commitExpectedVersionDecisionLegs: (
      input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0],
    ) => Object.freeze({
      ...store.commitExpectedVersionDecisionLegs(input), historical: true,
      requiresAffordanceRefresh: true,
    }),
    getCommandDecision: store.getCommandDecision.bind(store),
    getCommandReceipt: store.getCommandReceipt.bind(store),
    readAggregateEvents: store.readAggregateEvents.bind(store),
  });
}

describe("durable v2 delivery materials", () => {
  it("length-frames every content-address digest part", () => {
    expect(deliveryV2Digest("delivery-v2-test/1", "a\0b", "c"))
      .not.toBe(deliveryV2Digest("delivery-v2-test/1", "a", "b", "c"));
  });

  it("writes, replays, and reads every core-coded material by exact content address", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();

    expect(appendCapabilityCatalogRevision(store, context("catalog"), value.catalog).disposition)
      .toBe("DECIDED");
    expect(appendDeliveryProfileRevision(store, context("profile"), value.profile).disposition)
      .toBe("DECIDED");
    expect(appendDeliveryProfileQualification(
      store, context("qualification"), value.qualification,
    ).disposition).toBe("DECIDED");
    for (const [entryIndex, entry] of value.entries.entries()) {
      expect(appendExecutionIsolationProfileRevision(
        store, context(`execution-${entryIndex}`), entry.execution,
      ).ok).toBe(true);
      for (const [recipeIndex, recipe] of entry.recipes.entries()) {
        expect(appendVerificationRecipeRevision(
          store, context(`recipe-${entryIndex}-${recipeIndex}`), recipe,
        ).ok).toBe(true);
      }
    }

    expect(appendCapabilityCatalogRevision(store, context("catalog"), value.catalog))
      .toMatchObject({ disposition: "REPLAYED", ok: true });
    expect(readCapabilityCatalogRevision(store, {
      catalogId: value.catalog.catalogId,
      projectId: PROJECT,
      revisionDigest: value.catalog.revisionDigest,
      revisionId: value.catalog.revisionId,
    })).toEqual({ ok: true, revision: value.catalog });
    expect(readDeliveryProfileRevision(store, {
      profileId: value.profile.profileId,
      projectId: PROJECT,
      revisionDigest: value.profile.revisionDigest,
      revisionId: value.profile.revisionId,
    })).toEqual({ ok: true, revision: value.profile });
    expect(readDeliveryProfileQualification(store, {
      projectId: PROJECT,
      qualificationDigest: value.qualification.qualificationDigest,
      qualificationId: value.qualification.qualificationId,
    })).toEqual({ ok: true, qualification: value.qualification });
    for (const entry of value.entries) {
      expect(readExecutionIsolationProfileRevision(store, {
        profileId: entry.execution.profileId,
        projectId: PROJECT,
        revisionDigest: entry.execution.revisionDigest,
        revisionId: entry.execution.revisionId,
      })).toEqual({ ok: true, revision: entry.execution });
      for (const recipe of entry.recipes) {
        expect(readVerificationRecipeRevision(store, {
          projectId: PROJECT,
          recipeId: recipe.recipeId,
          revisionDigest: recipe.revisionDigest,
          revisionId: recipe.revisionId,
        })).toEqual({ ok: true, revision: recipe });
      }
    }
  });

  it("assembles only explicitly persisted planning resolution materials", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();
    appendCapabilityCatalogRevision(store, context("catalog"), value.catalog);
    appendDeliveryProfileRevision(store, context("profile"), value.profile);
    appendDeliveryProfileQualification(store, context("qualification"), value.qualification);
    value.entries.forEach((entry, entryIndex) => {
      appendExecutionIsolationProfileRevision(
        store, context(`execution-${entryIndex}`), entry.execution,
      );
      entry.recipes.forEach((recipe, recipeIndex) => appendVerificationRecipeRevision(
        store, context(`recipe-${entryIndex}-${recipeIndex}`), recipe,
      ));
    });

    const read = readDeliveryV2ResolutionMaterials(store, {
      catalog: {
        catalogId: value.catalog.catalogId,
        revisionDigest: value.catalog.revisionDigest,
        revisionId: value.catalog.revisionId,
      },
      deliveryProfile: {
        profileId: value.profile.profileId,
        revisionDigest: value.profile.revisionDigest,
        revisionId: value.profile.revisionId,
      },
      entries: value.entries.map((entry) => ({
        capabilityId: entry.capabilityId,
        executionIsolationProfile: {
          profileId: entry.execution.profileId,
          revisionDigest: entry.execution.revisionDigest,
          revisionId: entry.execution.revisionId,
        },
        verificationRecipes: entry.recipes.map((recipe) => ({
          recipeId: recipe.recipeId,
          revisionDigest: recipe.revisionDigest,
          revisionId: recipe.revisionId,
        })),
      })),
      projectId: PROJECT,
      qualification: {
        qualificationDigest: value.qualification.qualificationDigest,
        qualificationId: value.qualification.qualificationId,
      },
    });
    expect(read).toMatchObject({
      catalogRevision: value.catalog,
      materials: {
        deliveryProfileQualification: value.qualification,
        deliveryProfileRevision: value.profile,
      },
      ok: true,
    });
    if (read.ok) expect(read.materials.entryMaterials).toHaveLength(value.entries.length);

    const validRefs = resolutionRefsOf(value);
    expect(readDeliveryV2ResolutionMaterials(store, {
      ...validRefs,
      catalog: { ...validRefs.catalog, revisionId: "wrong-revision" },
    })).toMatchObject({ code: "DELIVERY_V2_MATERIAL_REF_MISMATCH", ok: false });
  });

  it("admits one proxy-safe bounded canonical snapshot of resolution references", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();
    appendCapabilityCatalogRevision(store, context("catalog"), value.catalog);
    appendDeliveryProfileRevision(store, context("profile"), value.profile);
    appendDeliveryProfileQualification(store, context("qualification"), value.qualification);
    value.entries.forEach((entry, entryIndex) => {
      appendExecutionIsolationProfileRevision(
        store, context(`execution-${entryIndex}`), entry.execution,
      );
      entry.recipes.forEach((recipe, recipeIndex) => appendVerificationRecipeRevision(
        store, context(`recipe-${entryIndex}-${recipeIndex}`), recipe,
      ));
    });
    const refs = resolutionRefsOf(value);
    expect(readDeliveryV2ResolutionMaterials(store, {
      ...refs, entries: [...refs.entries].reverse(),
    })).toMatchObject({ code: "DELIVERY_V2_INPUT_INVALID", ok: false });
    expect(readDeliveryV2ResolutionMaterials(store, {
      ...refs, entries: [...refs.entries, refs.entries[0]!],
    })).toMatchObject({ code: "DELIVERY_V2_INPUT_INVALID", ok: false });

    let propertyReads = 0;
    const hostile = new Proxy(refs, { get(target, property, receiver) {
      propertyReads += 1;
      return Reflect.get(target, property, receiver);
    } });
    expect(readDeliveryV2ResolutionMaterials(store, hostile)).toMatchObject({
      code: "DELIVERY_V2_INPUT_INVALID", ok: false,
    });
    expect(propertyReads).toBe(0);

    const prototypeKey = { ...refs } as Record<string, unknown>;
    Object.defineProperty(prototypeKey, "__proto__", {
      configurable: true, enumerable: true, value: { injected: true }, writable: true,
    });
    expect(readDeliveryV2ResolutionMaterials(
      store, prototypeKey as never,
    )).toMatchObject({ code: "DELIVERY_V2_INPUT_INVALID", ok: false });
  });

  it("rejects changed command fences and tampered event identity", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const { catalog } = fixture();
    expect(appendCapabilityCatalogRevision(store, context("catalog"), catalog))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    expect(appendCapabilityCatalogRevision(store, context("catalog-second"), catalog))
      .toMatchObject({ code: "EXPECTED_VERSION_CONFLICT", ok: false });
    expect(appendCapabilityCatalogRevision(store, context("catalog-bad-version", 1), catalog))
      .toEqual({
        code: "DELIVERY_V2_INPUT_INVALID",
        layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
        ok: false,
      });
    expect(readCapabilityCatalogRevision(eventIdTampered(store, "tampered") as SqliteEventStore, {
      catalogId: catalog.catalogId,
      projectId: PROJECT,
      revisionDigest: catalog.revisionDigest,
      revisionId: catalog.revisionId,
    })).toEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_READER",
      ok: false,
    });
    expect(readCapabilityCatalogRevision(payloadTampered(store) as SqliteEventStore, {
      catalogId: catalog.catalogId,
      projectId: PROJECT,
      revisionDigest: catalog.revisionDigest,
      revisionId: catalog.revisionId,
    })).toMatchObject({ code: "DELIVERY_V2_MATERIAL_UNREADABLE", ok: false });
    expect(readCapabilityCatalogRevision(traceTampered(store) as SqliteEventStore, {
      catalogId: catalog.catalogId,
      projectId: PROJECT,
      revisionDigest: catalog.revisionDigest,
      revisionId: catalog.revisionId,
    })).toMatchObject({ code: "DELIVERY_V2_MATERIAL_UNREADABLE", ok: false });
    expect(readCapabilityCatalogRevision(effectCommandSubstituted(store) as SqliteEventStore, {
      catalogId: catalog.catalogId,
      projectId: PROJECT,
      revisionDigest: catalog.revisionDigest,
      revisionId: catalog.revisionId,
    })).toMatchObject({ code: "DELIVERY_V2_MATERIAL_UNREADABLE", ok: false });
    expect(readCapabilityCatalogRevision(decisionVersionTampered(store) as SqliteEventStore, {
      catalogId: catalog.catalogId,
      projectId: PROJECT,
      revisionDigest: catalog.revisionDigest,
      revisionId: catalog.revisionId,
    })).toMatchObject({ code: "DELIVERY_V2_MATERIAL_UNREADABLE", ok: false });
    expect(readCapabilityCatalogRevision(store, {
      catalogId: catalog.catalogId,
      projectId: "wrong-project",
      revisionDigest: catalog.revisionDigest,
      revisionId: catalog.revisionId,
    })).toMatchObject({ code: "DELIVERY_V2_MATERIAL_ABSENT", ok: false });
    expect(readCapabilityCatalogRevision(store, {
      catalogId: catalog.catalogId,
      projectId: PROJECT,
      revisionDigest: "f".repeat(64),
      revisionId: catalog.revisionId,
    })).toMatchObject({ code: "DELIVERY_V2_MATERIAL_ABSENT", ok: false });
  });

  it("rejects self-consistent material provenance from an untrusted publisher", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const { catalog } = fixture();
    expect(createCapabilityCatalogRevisionIngress(
      store, "principal:attacker",
    )(principalContext("attacker-catalog", "principal:attacker"), catalog))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    const ref = {
      catalogId: catalog.catalogId, projectId: PROJECT,
      revisionDigest: catalog.revisionDigest, revisionId: catalog.revisionId,
    };
    expect(readCapabilityCatalogRevision(store, ref)).toMatchObject({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE", ok: false,
    });

    let propertyReads = 0;
    const hostilePublishers = new Proxy(MATERIAL_PUBLISHERS, {
      get(target, property, receiver) {
        propertyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(readCapabilityCatalogRevisionBound(
      store, ref, hostilePublishers,
    )).toMatchObject({ code: "DELIVERY_V2_INPUT_INVALID", ok: false });
    expect(propertyReads).toBe(0);
  });

  it("rejects a fabricated lower-level COMMITTED disposition", () => {
    const materialStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(appendCapabilityCatalogRevision(
      commitDispositionTampered(materialStore) as unknown as SqliteEventStore,
      context("catalog-fabricated-disposition"), fixture().catalog,
    )).toMatchObject({ code: "DELIVERY_V2_MATERIAL_UNREADABLE", ok: false });

    const metadataStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(appendCapabilityCatalogRevision(
      decisionReplayMetadataTampered(metadataStore) as unknown as SqliteEventStore,
      context("catalog-fabricated-replay-metadata"), fixture().catalog,
    )).toMatchObject({ code: "DELIVERY_V2_MATERIAL_UNREADABLE", ok: false });

    const authorityStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const qualification = fixture().qualification;
    const ingress = createDeliveryProfileQualificationStatusIngress(
      commitDispositionTampered(authorityStore) as unknown as SqliteEventStore, "operator-1",
    );
    expect(ingress(context("status-fabricated-disposition"), {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      status: "CURRENT",
      statusRef: `qualification-status:${qualification.qualificationId}`,
    })).toMatchObject({ code: "DELIVERY_V2_AUTHORITY_UNREADABLE", ok: false });
  });
});

describe("independent delivery qualification authorities", () => {
  it("authorizes only after all five durable namespaces independently bind", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const { profile, qualification } = fixture();
    const status = {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      status: "CURRENT" as const,
      statusRef: `qualification-status:${qualification.qualificationId}`,
    };
    expect(appendDeliveryProfileQualificationStatus(
      store, context("status-current"), status,
    ).ok).toBe(true);
    expect(appendDeliveryProfileQualificationStatus(
      store, context("status-current"), status,
    )).toMatchObject({ disposition: "REPLAYED", ok: true });
    const value = { ...fixture(), profile, qualification };
    expect(appendDeliveryProfileOperatorApproval(
      store, context("approval"), approvalBindingOf(value),
    ).ok).toBe(true);

    const evidenceBinding = evidenceBindingOf(value);
    appendDeliveryProfileBuilderIdentity(
      store, principalContext("builder", qualification.builderIdentity.principalRef),
      qualification.builderIdentity, evidenceBinding,
    );
    qualification.providerProfileRefs.forEach((provider, index) =>
      appendDeliveryProfileProviderProfile(
        store, principalContext(`provider-${index}`, PROVIDER_PRINCIPAL), provider, evidenceBinding,
      ));
    qualification.independentVerifierReceipts.forEach((receipt, index) =>
      appendDeliveryProfileVerifierReceipt(
        store, principalContext(`receipt-${index}`, receipt.verifierRef), receipt, evidenceBinding,
      ));

    const authority = createDeliveryProfileQualificationAuthority(
      store, PROJECT, authorityPrincipalsOf(value),
    );
    expect(resolveQualifiedDeliveryProfile(profile, qualification, 1_500, authority))
      .toMatchObject({ ok: true });
    expect(readDeliveryProfileQualificationStatusFence(store, PROJECT, {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    }, authorityPrincipalsOf(value))).toMatchObject({
      expectedVersion: 1,
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      statusRef: status.statusRef,
    });

    expect(appendDeliveryProfileQualificationStatus(
      store, context("status-revoked", 1), { ...status, status: "REVOKED" },
    )).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(resolveQualifiedDeliveryProfile(profile, qualification, 1_500, authority))
      .toEqual({
        code: "DELIVERY_PROFILE_NOT_QUALIFIED",
        layer: "DELIVERY_PROFILE_QUALIFICATION",
        ok: false,
      });
    expect(readDeliveryProfileQualificationStatusFence(store, PROJECT, {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    }, authorityPrincipalsOf(value))).toBeUndefined();
  });

  it("fails closed for missing, wrong-project, wrong-ref, or wrong-digest authority", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const { profile, qualification } = fixture();
    const authority = createDeliveryProfileQualificationAuthority(
      store, PROJECT, authorityPrincipalsOf(fixture()),
    );
    expect(authority.readDurableQualificationStatus({
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    })).toBeUndefined();
    expect(authority.verifyDurableOperatorApproval({
      operatorApprovalRef: qualification.operatorApprovalRef!,
      profileFamilyId: qualification.profileFamilyId,
      profileId: qualification.profileId,
      profileRevisionDigest: profile.revisionDigest,
      profileRevisionId: profile.revisionId,
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    })).toBe(false);
    const evidence = evidenceBindingOf(fixture());
    expect(authority.verifyDurableBuilderIdentity(
      qualification.builderIdentity, evidence,
    )).toBe(false);
    expect(authority.verifyDurableProviderProfile(
      qualification.providerProfileRefs[0]!, evidence,
    )).toBe(false);
    expect(authority.verifyDurableVerifierReceipt(
      qualification.independentVerifierReceipts[0]!, evidence,
    )).toBe(false);
    expect(createDeliveryProfileQualificationAuthority(
      store, "other-project", authorityPrincipalsOf(fixture()),
    )
      .readDurableQualificationStatus({
        qualificationDigest: qualification.qualificationDigest,
        qualificationId: qualification.qualificationId,
      })).toBeUndefined();
  });

  it("rejects tampered durable event identity in status and evidence namespaces", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();
    const { qualification } = value;
    appendDeliveryProfileQualificationStatus(store, context("status-current"), {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      status: "CURRENT",
      statusRef: `qualification-status:${qualification.qualificationId}`,
    });
    appendDeliveryProfileOperatorApproval(
      store, context("approval"), approvalBindingOf(value),
    );
    const authority = createDeliveryProfileQualificationAuthority(
      eventIdTampered(store, "tampered") as SqliteEventStore,
      PROJECT, authorityPrincipalsOf(value),
    );
    expect(authority.readDurableQualificationStatus({
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    })).toBeUndefined();
    expect(authority.verifyDurableOperatorApproval(approvalBindingOf(value))).toBe(false);
    const payloadAuthority = createDeliveryProfileQualificationAuthority(
      payloadTampered(store) as SqliteEventStore,
      PROJECT, authorityPrincipalsOf(value),
    );
    expect(payloadAuthority.readDurableQualificationStatus({
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    })).toBeUndefined();
    expect(payloadAuthority.verifyDurableOperatorApproval(approvalBindingOf(value))).toBe(false);
  });

  it("refuses authority bindings whose reference or digest changed", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();
    appendDeliveryProfileOperatorApproval(
      store, context("approval"), approvalBindingOf(value),
    );
    const authority = createDeliveryProfileQualificationAuthority(
      store, PROJECT, authorityPrincipalsOf(value),
    );
    expect(authority.verifyDurableOperatorApproval({
      ...approvalBindingOf(value), operatorApprovalRef: "approval:wrong",
    })).toBe(false);
    expect(authority.verifyDurableOperatorApproval({
      ...approvalBindingOf(value), qualificationDigest: "f".repeat(64),
    })).toBe(false);
  });

  it("rejects substituted issuer provenance and proxy-backed authority claims", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();
    appendDeliveryProfileOperatorApproval(
      store, context("approval"), approvalBindingOf(value),
    );
    const substituted = createDeliveryProfileQualificationAuthority(
      principalSubstituted(store, "principal:attacker") as SqliteEventStore,
      PROJECT,
      {
        builderIdentityPrincipals: [],
        operatorApprovalPrincipalId: "operator-1",
        providerProfilePrincipals: [],
        qualificationStatusPrincipalId: "operator-1",
        verifierReceiptPrincipals: [],
      } as never,
    );
    expect(substituted.verifyDurableOperatorApproval(approvalBindingOf(value))).toBe(false);

    let propertyReads = 0;
    const hostile = new Proxy(approvalBindingOf(value), {
      get(target, property, receiver) {
        propertyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(appendDeliveryProfileOperatorApproval(
      store, context("proxy-approval"), hostile,
    )).toEqual({
      code: "DELIVERY_V2_INPUT_INVALID",
      layer: "DAEMON_DELIVERY_V2_AUTHORITY",
      ok: false,
    });
    expect(propertyReads).toBe(0);

    const honest = createDeliveryProfileQualificationAuthority(
      store, PROJECT, authorityPrincipalsOf(value),
    );
    propertyReads = 0;
    expect(honest.verifyDurableOperatorApproval(hostile)).toBe(false);
    expect(propertyReads).toBe(0);
    propertyReads = 0;
    const hostileStatus = new Proxy({
      qualificationDigest: value.qualification.qualificationDigest,
      qualificationId: value.qualification.qualificationId,
    }, { get(target, property, receiver) {
      propertyReads += 1;
      return Reflect.get(target, property, receiver);
    } });
    expect(honest.readDurableQualificationStatus(hostileStatus)).toBeUndefined();
    expect(propertyReads).toBe(0);

    propertyReads = 0;
    const hostilePrincipals = new Proxy(authorityPrincipalsOf(value), {
      get(target, property, receiver) {
        propertyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const failClosed = createDeliveryProfileQualificationAuthority(
      store, PROJECT, hostilePrincipals,
    );
    expect(failClosed.verifyDurableOperatorApproval(approvalBindingOf(value))).toBe(false);
    expect(propertyReads).toBe(0);
  });

  it("rejects synthetic provenance and malformed status history", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();
    const { qualification } = value;
    const status = Object.freeze({
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      status: "CURRENT" as const,
      statusRef: `qualification-status:${qualification.qualificationId}`,
    });
    appendDeliveryProfileQualificationStatus(store, context("status-current"), status);
    appendDeliveryProfileOperatorApproval(store, context("approval"), approvalBindingOf(value));
    const structuralOnly = Object.freeze({
      readAggregateEvents: store.readAggregateEvents.bind(store),
    }) as unknown as SqliteEventStore;
    const synthetic = createDeliveryProfileQualificationAuthority(
      structuralOnly, PROJECT, authorityPrincipalsOf(value),
    );
    expect(synthetic.readDurableQualificationStatus({
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    })).toBeUndefined();
    expect(synthetic.verifyDurableOperatorApproval(approvalBindingOf(value))).toBe(false);

    const principals = authorityPrincipalsOf(value);
    const builderPrincipalId = principals.builderIdentityPrincipals[0]!.principalId;
    const roleCollision = Object.freeze({
      ...principals,
      verifierReceiptPrincipals: Object.freeze(principals.verifierReceiptPrincipals.map(
        (issuer) => Object.freeze({ ...issuer, principalId: builderPrincipalId }),
      )),
    });
    expect(createDeliveryProfileQualificationAuthority(
      store, PROJECT, roleCollision,
    ).readDurableQualificationStatus({
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    })).toBeUndefined();

    const malformed = Object.freeze({
      commitExpectedVersionDecisionLegs: store.commitExpectedVersionDecisionLegs.bind(store),
      getCommandDecision: store.getCommandDecision.bind(store),
      getCommandReceipt: store.getCommandReceipt.bind(store),
      readAggregateEvents: (
        aggregateId: string, afterAggregateSequence?: number, limit?: number,
        maxDecodedBytes?: number,
      ) => {
        const page = store.readAggregateEvents(
          aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
        );
        return Object.freeze({ ...page, items: Object.freeze(page.items.map((event) =>
          Object.freeze({ ...event, aggregateSequence: event.aggregateSequence + 1 }))) });
      },
    }) as unknown as SqliteEventStore;
    expect(createDeliveryProfileQualificationStatusIngress(
      malformed, "operator-1",
    )(context("status-revoke-malformed", 1), { ...status, status: "REVOKED" })).toMatchObject({
      code: "DELIVERY_V2_AUTHORITY_UNREADABLE", ok: false,
    });

    const degraded = Object.freeze({
      getCommandDecision: () => { throw new Error("decision ledger unavailable"); },
    }) as unknown as SqliteEventStore;
    expect(createDeliveryProfileQualificationStatusIngress(
      degraded, "operator-1",
    )(context("status-degraded"), status)).toMatchObject({
      code: "STORAGE_DEGRADED", ok: false,
    });

    const extraStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(createDeliveryProfileQualificationStatusIngress(
      extraStore, "operator-1",
    )(context("status-extra"), { ...status, extra: true } as never)).toMatchObject({
      code: "DELIVERY_V2_INPUT_INVALID", ok: false,
    });
    const invalidStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(createDeliveryProfileQualificationStatusIngress(
      invalidStore, "operator-1",
    )(context("status-invalid"), { ...status, status: "ACTIVE" } as never)).toMatchObject({
      code: "DELIVERY_V2_INPUT_INVALID", ok: false,
    });
  });

  it("returns a no-event status fence that atomically blocks a stale plan", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();
    const { qualification } = value;
    const binding = Object.freeze({
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    });
    const status = Object.freeze({ ...binding, status: "CURRENT" as const,
      statusRef: `qualification-status:${qualification.qualificationId}` });
    appendDeliveryProfileQualificationStatus(store, context("status-current"), status);
    const fence = readDeliveryProfileQualificationStatusFence(
      store, PROJECT, binding, authorityPrincipalsOf(value),
    );
    expect(fence).toBeDefined();
    if (fence === undefined) return;
    const resultBytes = new TextEncoder().encode("planned");
    const commitPlan = (commandId: string, aggregateId: string) =>
      store.commitExpectedVersionDecisionLegs({
        commandKind: "delivery_v2.test_plan.commit",
        committedResultBytes: resultBytes,
        correlationId: `correlation:${commandId}`,
        decidedAt: "2026-08-31T12:00:00.000Z",
        key: { commandId, principalId: "operator-1", projectId: PROJECT },
        legs: [
          { aggregateId, events: [{ domainSchemaVersion: "delivery-v2-test-plan/1",
            eventId: `${commandId}:event`, eventType: "DeliveryV2TestPlanCommitted",
            payload: resultBytes }], expectedVersion: 0 },
          { aggregateId: fence.aggregateId, events: [], expectedVersion: fence.expectedVersion },
        ],
        requestBytes: resultBytes,
      });
    expect(commitPlan("plan-before-revoke", "delivery-v2-test-plan:before").decision)
      .toMatchObject({ effectDisposition: "EFFECTS_COMMITTED" });
    expect(store.readAggregateEvents(fence.aggregateId, 0, 3).items).toHaveLength(1);

    appendDeliveryProfileQualificationStatus(
      store, context("status-revoked", 1), { ...status, status: "REVOKED" },
    );
    expect(commitPlan("plan-after-revoke", "delivery-v2-test-plan:after").decision)
      .toMatchObject({ effectDisposition: "NO_BUSINESS_EFFECT",
        resultCode: "EXPECTED_VERSION_CONFLICT" });
    expect(store.readAggregateEvents("delivery-v2-test-plan:after", 0, 1).items).toHaveLength(0);
  });

  it("refuses a qualification revoked between status and evidence reads", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const value = fixture();
    const { profile, qualification } = value;
    const status = {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      status: "CURRENT" as const,
      statusRef: `qualification-status:${qualification.qualificationId}`,
    };
    appendDeliveryProfileQualificationStatus(store, context("status-current"), status);
    appendDeliveryProfileOperatorApproval(store, context("approval"), approvalBindingOf(value));
    const evidence = evidenceBindingOf(value);
    appendDeliveryProfileBuilderIdentity(
      store, principalContext("builder", qualification.builderIdentity.principalRef),
      qualification.builderIdentity, evidence,
    );
    qualification.providerProfileRefs.forEach((provider, index) =>
      appendDeliveryProfileProviderProfile(
        store, principalContext(`provider-${index}`, PROVIDER_PRINCIPAL), provider, evidence,
      ));
    qualification.independentVerifierReceipts.forEach((receipt, index) =>
      appendDeliveryProfileVerifierReceipt(
        store, principalContext(`receipt-${index}`, receipt.verifierRef), receipt, evidence,
      ));
    let revoked = false;
    const racingStore = Object.freeze({
      getCommandDecision: store.getCommandDecision.bind(store),
      getCommandReceipt: store.getCommandReceipt.bind(store),
      readAggregateEvents: (
        aggregateId: string, afterAggregateSequence?: number, limit?: number,
        maxDecodedBytes?: number,
      ) => {
        if (!revoked && !aggregateId.includes("qualification-status")) {
          revoked = true;
          appendDeliveryProfileQualificationStatus(
            store, context("status-race-revoked", 1), { ...status, status: "REVOKED" },
          );
        }
        return store.readAggregateEvents(
          aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
        );
      },
    }) as unknown as SqliteEventStore;
    const principals = authorityPrincipalsOf(value);
    const authority = createDeliveryProfileQualificationAuthority(
      racingStore, PROJECT, principals,
    );
    expect(resolveQualifiedDeliveryProfile(profile, qualification, 1_500, authority)).toEqual({
      code: "DELIVERY_PROFILE_NOT_QUALIFIED",
      layer: "DELIVERY_PROFILE_QUALIFICATION",
      ok: false,
    });
    expect(readDeliveryProfileQualificationStatusFence(racingStore, PROJECT, {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
    }, principals)).toBeUndefined();
  });
});
