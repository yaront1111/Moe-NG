import type {
  CapabilityCatalogRevision,
  DeliveryProfileQualification,
  DeliveryProfileRevision,
  ExecutionIsolationProfileRevision,
  VerificationRecipeRevision,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  DELIVERY_V2_MATERIAL_COMMAND_KINDS,
  DELIVERY_V2_MATERIAL_EVENT_TYPES,
  deriveDeliveryV2MaterialAggregateId,
  type DeliveryV2MaterialKind,
} from "./addresses.js";
import {
  DELIVERY_V2_READER_LAYER,
  type CapabilityCatalogRevisionRef,
  type DeliveryProfileQualificationRef,
  type DeliveryProfileRevisionRef,
  type DeliveryV2Refusal,
  type DeliveryV2MaterialPublisherPrincipalBindings,
  type DeliveryV2ResolutionMaterialRefs,
  type DeliveryV2ResolutionMaterialsResult,
  type ExecutionIsolationProfileRevisionRef,
  type VerificationRecipeRevisionRef,
} from "./contracts.js";
import { decodeDeliveryV2Material, type DeliveryV2Material } from "./material-codecs.js";
import {
  admitCapabilityCatalogRevisionRef,
  admitDeliveryProfileQualificationRef,
  admitDeliveryProfileRevisionRef,
  admitDeliveryV2ResolutionMaterialRefs,
  admitExecutionIsolationProfileRevisionRef,
  admitVerificationRecipeRevisionRef,
} from "./material-ref-admission.js";
import { admitDeliveryV2MaterialPublisherPrincipals } from
  "./material-publisher-admission.js";
import { validateDeliveryV2EventProvenance } from "./provenance.js";

type ReadStore = SqliteEventStore;
type ReadResult<T> = Readonly<{ ok: true; value: T }> | DeliveryV2Refusal;
const refuse = (code: DeliveryV2Refusal["code"]): DeliveryV2Refusal =>
  Object.freeze({ code, layer: DELIVERY_V2_READER_LAYER, ok: false as const });

function readMaterial<T extends DeliveryV2Material>(
  store: ReadStore,
  kind: DeliveryV2MaterialKind,
  expected: Readonly<{ digest: string; expectedPrincipalId: string; primaryId: string;
    projectId: string; revisionId: string }>,
): ReadResult<T> {
  const aggregateId = deriveDeliveryV2MaterialAggregateId(expected.projectId, kind, expected.digest);
  let page;
  try {
    page = store.readAggregateEvents(aggregateId, 0, 2);
  } catch { return refuse("STORAGE_DEGRADED"); }
  if (page.items.length === 0) return refuse("DELIVERY_V2_MATERIAL_ABSENT");
  const event = page.items[0];
  if (page.hasMore || page.items.length !== 1 || event === undefined
    || event.aggregateSequence !== 1
    || event.aggregateId !== aggregateId
    || event.decisionTrace === undefined
    || event.eventId !== `${event.decisionTrace.commandId}:delivery-v2-material`
    || event.eventType !== DELIVERY_V2_MATERIAL_EVENT_TYPES[kind]
    || event.decisionTrace.commandKind !== DELIVERY_V2_MATERIAL_COMMAND_KINDS[kind]) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  if (event.decisionTrace.projectId !== expected.projectId) {
    return refuse("DELIVERY_V2_MATERIAL_PROJECT_MISMATCH");
  }
  const decoded = decodeDeliveryV2Material(kind, event.payload);
  if (decoded === undefined || decoded.domainSchemaVersion !== event.domainSchemaVersion) {
    return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  }
  if (decoded.identity.digest !== expected.digest) {
    return refuse("DELIVERY_V2_MATERIAL_DIGEST_MISMATCH");
  }
  if (decoded.identity.primaryId !== expected.primaryId
    || decoded.identity.revisionId !== expected.revisionId) {
    return refuse("DELIVERY_V2_MATERIAL_REF_MISMATCH");
  }
  if (!validateDeliveryV2EventProvenance(store, event, {
    aggregateId,
    commandKind: DELIVERY_V2_MATERIAL_COMMAND_KINDS[kind],
    domainSchemaVersion: decoded.domainSchemaVersion,
    eventId: `${event.decisionTrace.commandId}:delivery-v2-material`,
    eventType: DELIVERY_V2_MATERIAL_EVENT_TYPES[kind],
    expectedPrincipalId: expected.expectedPrincipalId,
    expectedProjectId: expected.projectId,
    expectedVersion: 0,
    payloadBytes: decoded.bytes,
    requestBytes: decoded.bytes,
    resultBytes: decoded.bytes,
  })) return refuse("DELIVERY_V2_MATERIAL_UNREADABLE");
  return Object.freeze({ ok: true as const, value: decoded.value as T });
}

export function readCapabilityCatalogRevision(store: ReadStore, ref: CapabilityCatalogRevisionRef,
  publishers: DeliveryV2MaterialPublisherPrincipalBindings) {
  const safe = admitCapabilityCatalogRevisionRef(ref);
  const trusted = admitDeliveryV2MaterialPublisherPrincipals(publishers);
  if (safe === undefined || trusted === undefined) return refuse("DELIVERY_V2_INPUT_INVALID");
  const result = readMaterial<CapabilityCatalogRevision>(store, "CAPABILITY_CATALOG", {
    digest: safe.revisionDigest, expectedPrincipalId: trusted.capabilityCatalogPrincipalId,
    primaryId: safe.catalogId,
    projectId: safe.projectId, revisionId: safe.revisionId,
  });
  return result.ok ? Object.freeze({ ok: true as const, revision: result.value }) : result;
}
export function readDeliveryProfileRevision(store: ReadStore, ref: DeliveryProfileRevisionRef,
  publishers: DeliveryV2MaterialPublisherPrincipalBindings) {
  const safe = admitDeliveryProfileRevisionRef(ref);
  const trusted = admitDeliveryV2MaterialPublisherPrincipals(publishers);
  if (safe === undefined || trusted === undefined) return refuse("DELIVERY_V2_INPUT_INVALID");
  const result = readMaterial<DeliveryProfileRevision>(store, "DELIVERY_PROFILE", {
    digest: safe.revisionDigest, expectedPrincipalId: trusted.deliveryProfilePrincipalId,
    primaryId: safe.profileId,
    projectId: safe.projectId, revisionId: safe.revisionId,
  });
  return result.ok ? Object.freeze({ ok: true as const, revision: result.value }) : result;
}
export function readDeliveryProfileQualification(
  store: ReadStore, ref: DeliveryProfileQualificationRef,
  publishers: DeliveryV2MaterialPublisherPrincipalBindings,
) {
  const safe = admitDeliveryProfileQualificationRef(ref);
  const trusted = admitDeliveryV2MaterialPublisherPrincipals(publishers);
  if (safe === undefined || trusted === undefined) return refuse("DELIVERY_V2_INPUT_INVALID");
  const result = readMaterial<DeliveryProfileQualification>(
    store, "DELIVERY_PROFILE_QUALIFICATION", {
      digest: safe.qualificationDigest,
      expectedPrincipalId: trusted.deliveryProfileQualificationPrincipalId,
      primaryId: safe.qualificationId,
      projectId: safe.projectId, revisionId: safe.qualificationId,
    },
  );
  return result.ok ? Object.freeze({ ok: true as const, qualification: result.value }) : result;
}
export function readExecutionIsolationProfileRevision(
  store: ReadStore, ref: ExecutionIsolationProfileRevisionRef,
  publishers: DeliveryV2MaterialPublisherPrincipalBindings,
) {
  const safe = admitExecutionIsolationProfileRevisionRef(ref);
  const trusted = admitDeliveryV2MaterialPublisherPrincipals(publishers);
  if (safe === undefined || trusted === undefined) return refuse("DELIVERY_V2_INPUT_INVALID");
  const result = readMaterial<ExecutionIsolationProfileRevision>(
    store, "EXECUTION_ISOLATION_PROFILE", {
      digest: safe.revisionDigest,
      expectedPrincipalId: trusted.executionIsolationProfilePrincipalId,
      primaryId: safe.profileId,
      projectId: safe.projectId, revisionId: safe.revisionId,
    },
  );
  return result.ok ? Object.freeze({ ok: true as const, revision: result.value }) : result;
}
export function readVerificationRecipeRevision(
  store: ReadStore, ref: VerificationRecipeRevisionRef,
  publishers: DeliveryV2MaterialPublisherPrincipalBindings,
) {
  const safe = admitVerificationRecipeRevisionRef(ref);
  const trusted = admitDeliveryV2MaterialPublisherPrincipals(publishers);
  if (safe === undefined || trusted === undefined) return refuse("DELIVERY_V2_INPUT_INVALID");
  const result = readMaterial<VerificationRecipeRevision>(store, "VERIFICATION_RECIPE", {
    digest: safe.revisionDigest, expectedPrincipalId: trusted.verificationRecipePrincipalId,
    primaryId: safe.recipeId,
    projectId: safe.projectId, revisionId: safe.revisionId,
  });
  return result.ok ? Object.freeze({ ok: true as const, revision: result.value }) : result;
}

export function readDeliveryV2ResolutionMaterials(
  store: ReadStore,
  refs: DeliveryV2ResolutionMaterialRefs,
  publishers: DeliveryV2MaterialPublisherPrincipalBindings,
): DeliveryV2ResolutionMaterialsResult {
  const safe = admitDeliveryV2ResolutionMaterialRefs(refs);
  const trusted = admitDeliveryV2MaterialPublisherPrincipals(publishers);
  if (safe === undefined || trusted === undefined) return refuse("DELIVERY_V2_INPUT_INVALID");
  const catalog = readCapabilityCatalogRevision(store, {
    ...safe.catalog, projectId: safe.projectId,
  }, trusted);
  if (!catalog.ok) return catalog;
  const profile = readDeliveryProfileRevision(
    store, { ...safe.deliveryProfile, projectId: safe.projectId }, trusted,
  );
  if (!profile.ok) return profile;
  const qualification = readDeliveryProfileQualification(
    store, { ...safe.qualification, projectId: safe.projectId }, trusted,
  );
  if (!qualification.ok) return qualification;
  const entries = [];
  for (const entry of safe.entries) {
    const execution = readExecutionIsolationProfileRevision(
      store, { ...entry.executionIsolationProfile, projectId: safe.projectId }, trusted,
    );
    if (!execution.ok) return execution;
    const recipes: VerificationRecipeRevision[] = [];
    for (const recipeRef of entry.verificationRecipes) {
      const recipe = readVerificationRecipeRevision(
        store, { ...recipeRef, projectId: safe.projectId }, trusted,
      );
      if (!recipe.ok) return recipe;
      recipes.push(recipe.revision);
    }
    entries.push(Object.freeze({ capabilityId: entry.capabilityId,
      executionIsolationProfileRevision: execution.revision,
      verificationRecipeRevisions: Object.freeze(recipes) }));
  }
  return Object.freeze({ catalogRevision: catalog.revision, materials: Object.freeze({
    deliveryProfileQualification: qualification.qualification,
    deliveryProfileRevision: profile.revision,
    entryMaterials: Object.freeze(entries),
  }), ok: true as const });
}
