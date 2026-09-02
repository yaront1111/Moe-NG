import { createHash } from "node:crypto";

import {
  grantHumanAuthority,
  productContractGate1Authority,
  type ProductContractRevisionV2,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, driveThrough, envelope, send }
  from "../bootstrap/bootstrap-test-fixtures.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
} from "../product-contract/product-contract-gate-1-contract.js";
import {
  type ProductContractGate1Authority,
  type ProductContractGate1AuthorityInput,
} from "../product-contract/product-contract-gate-1-command.js";
import { runProductContractGate1V2Command }
  from "../product-contract/product-contract-v2-gate-1-command.js";
import { commitProductContractRevisionV2 }
  from "../product-contract/product-contract-v2-store.js";
import { deriveProductContractCurrentRevisionSlotV2AggregateId }
  from "../product-contract/product-contract-v2-address.js";
import { deriveProductContractV2WorkflowAggregateId }
  from "../product-contract/product-contract-v2-workflow-contract.js";
import { resolvedCompilerWitness }
  from "../planning/v2-compiler/compiler-resolution-test-fixtures.js";
import {
  createCapabilityCatalogRevisionIngress,
  createDeliveryProfileBuilderIdentityIngress,
  createDeliveryProfileOperatorApprovalIngress,
  createDeliveryProfileProviderProfileIngress,
  createDeliveryProfileQualificationIngress,
  createDeliveryProfileQualificationStatusIngress,
  createDeliveryProfileRevisionIngress,
  createDeliveryProfileVerifierReceiptIngress,
  createExecutionIsolationProfileRevisionIngress,
  createVerificationRecipeRevisionIngress,
  type DeliveryV2AppendContext,
  type DeliveryV2AuthorityPrincipalBindings,
  type DeliveryV2MaterialPublisherPrincipalBindings,
  type DeliveryV2ResolutionMaterialRefs,
} from "./index.js";
import { deriveDeliveryV2AuthorityAggregateId } from "./addresses.js";

import {
  DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
  DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY,
  createDeliveryV2ResolutionSelection,
  decodeDeliveryV2ResolutionSelection,
  encodeDeliveryV2ResolutionSelection,
  encodeDeliveryV2ResolutionSelectionRequest,
} from "./resolution-selection-contract.js";
import {
  DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
  DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
  commitDeliveryV2ResolutionSelection,
  deriveDeliveryV2ResolutionSelectionAggregateId,
  deriveDeliveryV2ResolutionSelectionEventId,
  type DeliveryV2ResolutionSelectionConfig,
} from "./resolution-selection-store.js";
import { readCurrentDeliveryV2ResolutionSelection }
  from "./resolution-selection-reader.js";

const hex = (digit: string): string => digit.repeat(64);

const MATERIAL_REFS = Object.freeze({
  catalog: Object.freeze({
    catalogId: "catalog-1", revisionDigest: hex("1"), revisionId: "catalog-revision-1",
  }),
  deliveryProfile: Object.freeze({
    profileId: "profile-1", revisionDigest: hex("2"), revisionId: "profile-revision-1",
  }),
  entries: Object.freeze([Object.freeze({
    capabilityId: "capability-1",
    executionIsolationProfile: Object.freeze({
      profileId: "isolation-1", revisionDigest: hex("3"), revisionId: "isolation-revision-1",
    }),
    verificationRecipes: Object.freeze([Object.freeze({
      recipeId: "recipe-1", revisionDigest: hex("4"), revisionId: "recipe-revision-1",
    })]),
  })]),
  projectId: "project-selection",
  qualification: Object.freeze({ qualificationDigest: hex("5"), qualificationId: "qualification-1" }),
});

const PROJECT = PROJECT_ID;
const OPERATOR = "operator-delivery-v2-selection";
const MATERIAL_PRINCIPAL = "principal:delivery-v2-selection-material";
const PROVIDER_PRINCIPAL = "principal:delivery-v2-selection-provider";
const DECIDED_AT = "1970-01-01T00:00:01.500Z";
const PRD = "# Resolution selection\n\nSelect qualified delivery materials.\n";
const PRD_SHA = createHash("sha256").update(PRD, "utf8").digest("hex");
const OPEN_STORES: SqliteEventStore[] = [];

afterEach(() => {
  while (OPEN_STORES.length > 0) OPEN_STORES.pop()!.close();
});

const context = (
  commandId: string,
  principalId = OPERATOR,
  expectedVersion = 0,
): DeliveryV2AppendContext => Object.freeze({
  commandId, correlationId: `correlation:${commandId}`, decidedAt: DECIDED_AT,
  expectedVersion, principalId, projectId: PROJECT,
});

function materialFixture() {
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

function evidenceBindingOf(value: ReturnType<typeof materialFixture>) {
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

function approvalBindingOf(value: ReturnType<typeof materialFixture>) {
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

function authorityPrincipalsOf(
  value: ReturnType<typeof materialFixture>,
): DeliveryV2AuthorityPrincipalBindings {
  return Object.freeze({
    builderIdentityPrincipals: Object.freeze([Object.freeze({
      authorityRef: value.qualification.builderIdentity.authorityRef,
      capabilityId: value.qualification.builderIdentity.capabilityId,
      principalId: value.qualification.builderIdentity.principalRef,
    })]),
    operatorApprovalPrincipalId: OPERATOR,
    providerProfilePrincipals: Object.freeze(value.qualification.providerProfileRefs.map(
      (profile) => Object.freeze({ principalId: PROVIDER_PRINCIPAL, profileRef: profile.profileRef }),
    )),
    qualificationStatusPrincipalId: OPERATOR,
    verifierReceiptPrincipals: Object.freeze([Object.freeze({
      authorityRef: value.qualification.independentVerifierReceipts[0]!.verifierAuthorityRef,
      capabilityId: value.qualification.independentVerifierReceipts[0]!.verifierCapabilityId,
      principalId: value.qualification.independentVerifierReceipts[0]!.verifierRef,
    })]),
  });
}

const MATERIAL_PUBLISHERS: DeliveryV2MaterialPublisherPrincipalBindings = Object.freeze({
  capabilityCatalogPrincipalId: MATERIAL_PRINCIPAL,
  deliveryProfilePrincipalId: MATERIAL_PRINCIPAL,
  deliveryProfileQualificationPrincipalId: MATERIAL_PRINCIPAL,
  executionIsolationProfilePrincipalId: MATERIAL_PRINCIPAL,
  verificationRecipePrincipalId: MATERIAL_PRINCIPAL,
});

function resolutionRefsOf(
  value: ReturnType<typeof materialFixture>,
): DeliveryV2ResolutionMaterialRefs {
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

function seedMaterials(store: SqliteEventStore, value: ReturnType<typeof materialFixture>): void {
  createCapabilityCatalogRevisionIngress(store, MATERIAL_PRINCIPAL)(
    context("material-catalog", MATERIAL_PRINCIPAL), value.catalog,
  );
  createDeliveryProfileRevisionIngress(store, MATERIAL_PRINCIPAL)(
    context("material-profile", MATERIAL_PRINCIPAL), value.profile,
  );
  createDeliveryProfileQualificationIngress(store, MATERIAL_PRINCIPAL)(
    context("material-qualification", MATERIAL_PRINCIPAL), value.qualification,
  );
  value.entries.forEach((entry, entryIndex) => {
    createExecutionIsolationProfileRevisionIngress(store, MATERIAL_PRINCIPAL)(
      context(`material-execution-${entryIndex}`, MATERIAL_PRINCIPAL), entry.execution,
    );
    entry.recipes.forEach((recipe, recipeIndex) =>
      createVerificationRecipeRevisionIngress(store, MATERIAL_PRINCIPAL)(
        context(`material-recipe-${entryIndex}-${recipeIndex}`, MATERIAL_PRINCIPAL), recipe,
      ));
  });

  const qualification = value.qualification;
  createDeliveryProfileQualificationStatusIngress(store, OPERATOR)(context("status-current"), {
    qualificationDigest: qualification.qualificationDigest,
    qualificationId: qualification.qualificationId,
    status: "CURRENT",
    statusRef: `qualification-status:${qualification.qualificationId}`,
  });
  createDeliveryProfileOperatorApprovalIngress(store, OPERATOR)(
    context("qualification-approval"), approvalBindingOf(value),
  );
  const evidence = evidenceBindingOf(value);
  createDeliveryProfileBuilderIdentityIngress(store, {
    authorityRef: qualification.builderIdentity.authorityRef,
    capabilityId: qualification.builderIdentity.capabilityId,
    principalId: qualification.builderIdentity.principalRef,
  })(context("qualification-builder", qualification.builderIdentity.principalRef),
    qualification.builderIdentity, evidence);
  qualification.providerProfileRefs.forEach((provider, index) =>
    createDeliveryProfileProviderProfileIngress(store, {
      principalId: PROVIDER_PRINCIPAL, profileRef: provider.profileRef,
    })(context(`qualification-provider-${index}`, PROVIDER_PRINCIPAL), provider, evidence));
  qualification.independentVerifierReceipts.forEach((receipt, index) =>
    createDeliveryProfileVerifierReceiptIngress(store, {
      authorityRef: receipt.verifierAuthorityRef,
      capabilityId: receipt.verifierCapabilityId,
      principalId: receipt.verifierRef,
    })(context(`qualification-receipt-${index}`, receipt.verifierRef), receipt, evidence));
}

const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Verify ${criterionId}.`,
});
const CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

function contractDraft(revisionId: string, lineage: ProductContractRevisionV2["lineage"] = null) {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: OPERATOR,
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "contract-delivery-v2-selection",
    criteria: [criterion("criterion-deployment", "deployment-loopback"),
      criterion("criterion-keyboard", "ux-keyboard"),
      criterion("criterion-latency", "nfr-latency"),
      criterion("criterion-login", "requirement-login"),
      criterion("criterion-runtime", "technology-runtime"),
      criterion("criterion-session", "security-session")],
    deploymentRequirements: [requirement("deployment-loopback", ["technology-runtime"])],
    functionalRequirements: [requirement("requirement-login")],
    journeys: [{ criterionIds: ["criterion-login", "criterion-session"],
      journeyId: "journey-login", statement: "A user signs in.", userJobId: "job-access" }],
    lineage,
    materialDecisions: [{ decisionId: "decision-profile", options: [
      { optionId: "option-primary", statement: "Use the qualified primary profile." },
      { optionId: "option-secondary", statement: "Use another qualified profile." },
    ], question: "Which qualified profile?", selectedOptionId: "option-primary" }],
    negativeScope: [{ scopeId: "scope-native", statement: "No native client." }],
    nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first use." }],
    productCompleteDefinition: { criterionIds: [...CRITERIA],
      statement: "Every criterion is independently verified." },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId,
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [PRD_SHA],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
  };
}

const TEST_HUMAN_AUTHORITY: ProductContractGate1Authority = Object.freeze({
  authorize: (input: ProductContractGate1AuthorityInput) => {
    const granted = grantHumanAuthority(
      productContractGate1Authority(input.ref),
      { kind: "HUMAN", principalId: OPERATOR },
      input.grantedAtEpochMs,
    );
    if (!granted.ok) throw new Error(`${granted.code}@${granted.layer}`);
    return Object.freeze({ gate: granted.gate, ok: true as const });
  },
});

function commitContract(
  store: SqliteEventStore,
  value: ReturnType<typeof contractDraft>,
): ProductContractRevisionV2 {
  const outcome = commitProductContractRevisionV2(store, {
    commandId: `command-${value.revisionId}`,
    correlationId: `correlation-${value.revisionId}`,
    decidedAt: DECIDED_AT,
    draft: value,
    goalRef: GOAL_ID,
    principalId: OPERATOR,
    projectId: PROJECT,
  });
  if (!outcome.ok) throw new Error(`${outcome.code}@${outcome.layer}`);
  return outcome.revision;
}

function approveContract(store: SqliteEventStore, revision: ProductContractRevisionV2): void {
  const commandId = `approve-${revision.revisionId}`;
  const outcome = runProductContractGate1V2Command(store, new TextEncoder().encode(JSON.stringify({
    commandId,
    correlationId: `correlation-${commandId}`,
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: { authentication: { kind: "TEST_ONLY_NON_BEARER" },
      contractId: revision.contractId, revisionDigest: revision.revisionDigest,
      revisionId: revision.revisionId },
    principalId: OPERATOR,
    projectId: PROJECT,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  })), TEST_HUMAN_AUTHORITY, {
    sessionId: "test-only-selection-session", transportOrigin: "MCP_STDIO",
  });
  if (!outcome.ok) throw new Error(`${outcome.code}@${outcome.refusedBy}`);
}

interface Harness {
  readonly config: DeliveryV2ResolutionSelectionConfig;
  readonly contract: ProductContractRevisionV2;
  readonly materials: ReturnType<typeof materialFixture>;
  readonly refs: DeliveryV2ResolutionMaterialRefs;
  readonly store: SqliteEventStore;
}

function harness(): Harness {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
  OPEN_STORES.push(store);
  driveThrough(store, "goal.create");
  const bound = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind the resolution-selection product source.",
    source: { displayPath: "docs/resolution-selection.md", mediaType: "text/markdown", text: PRD },
    title: "Resolution selection goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!bound.ok) throw new Error(`${bound.code}@fixture`);
  const contract = commitContract(store, contractDraft("revision-selection-1"));
  approveContract(store, contract);
  const materials = materialFixture();
  seedMaterials(store, materials);
  const refs = resolutionRefsOf(materials);
  return Object.freeze({
    config: Object.freeze({
      authorityPrincipals: authorityPrincipalsOf(materials),
      configuredOperatorPrincipalId: OPERATOR,
      materialPublishers: MATERIAL_PUBLISHERS,
    }),
    contract, materials, refs, store,
  });
}

const selectionInput = (value: Harness, commandId: string) => Object.freeze({
  commandId,
  contractId: value.contract.contractId,
  correlationId: `correlation:${commandId}`,
  decidedAt: DECIDED_AT,
  materialRefs: value.refs,
  principalId: OPERATOR,
  projectId: PROJECT,
});

describe("DeliveryV2 resolution selection contract", () => {
  it("seals one exact canonical /1 record without actor or clock payload", () => {
    const created = createDeliveryV2ResolutionSelection({
      contractId: "contract-1",
      generation: 1,
      materialRefs: MATERIAL_REFS,
      productContract: {
        revisionDigest: hex("6"),
        revisionId: "contract-revision-1",
        revisionVersion: "moe-product-contract-revision/2",
        slotDigest: hex("7"),
        slotGeneration: 2,
        workflowGeneration: 3,
      },
      projectId: "project-selection",
      qualificationStatus: {
        qualificationDigest: hex("5"),
        qualificationId: "qualification-1",
        statusDigest: hex("8"),
        statusRef: "qualification-status:qualification-1",
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(Object.keys(created.selection).sort()).toEqual([
      "contractId", "generation", "materialRefs", "productContract", "projectId",
      "qualificationStatus", "selectionDigest", "version",
    ]);
    expect(created.selection).not.toHaveProperty("selectedAt");
    expect(created.selection).not.toHaveProperty("selectedBy");
    expect(created.selection.version).toBe(DELIVERY_V2_RESOLUTION_SELECTION_VERSION);
    expect(Object.isFrozen(created.selection)).toBe(true);
    const encoded = encodeDeliveryV2ResolutionSelection(created.selection);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeDeliveryV2ResolutionSelection(encoded.bytes)).toEqual(created);
  });
});

describe("durable DeliveryV2 resolution selection", () => {
  it("commits initial and replacement selections and exposes four exact downstream fences", () => {
    const value = harness();
    const first = commitDeliveryV2ResolutionSelection(
      value.store, value.config, selectionInput(value, "select-initial"),
    );
    expect(first).toMatchObject({ disposition: "DECIDED", ok: true,
      selection: { generation: 1 } });
    if (!first.ok) return;

    const initialRead = readCurrentDeliveryV2ResolutionSelection(value.store, value.config, {
      contractId: value.contract.contractId, projectId: PROJECT,
    });
    expect(initialRead).toMatchObject({
      catalogRevision: value.materials.catalog,
      fences: {
        productContractSlot: {
          aggregateId: deriveProductContractCurrentRevisionSlotV2AggregateId(
            PROJECT, value.contract.contractId,
          ),
          expectedVersion: 1,
        },
        qualificationStatus: { expectedVersion: 1,
          qualificationId: value.materials.qualification.qualificationId },
        resolutionSelection: {
          aggregateId: deriveDeliveryV2ResolutionSelectionAggregateId(
            PROJECT, value.contract.contractId,
          ),
          expectedVersion: 1,
        },
        workflow: {
          aggregateId: deriveProductContractV2WorkflowAggregateId(
            PROJECT, value.contract.contractId,
          ),
          expectedVersion: 2,
        },
      },
      materials: { deliveryProfileQualification: value.materials.qualification,
        deliveryProfileRevision: value.materials.profile },
      ok: true,
      selection: first.selection,
    });

    const replacement = commitDeliveryV2ResolutionSelection(
      value.store, value.config, selectionInput(value, "select-replacement"),
    );
    expect(replacement).toMatchObject({ disposition: "DECIDED", ok: true,
      selection: { generation: 2 } });
    if (!replacement.ok) return;
    expect(replacement.selection.selectionDigest).not.toBe(first.selection.selectionDigest);
    expect(readCurrentDeliveryV2ResolutionSelection(value.store, value.config, {
      contractId: value.contract.contractId, projectId: PROJECT,
    })).toMatchObject({ fences: { resolutionSelection: { expectedVersion: 2 } },
      ok: true, selection: replacement.selection });
  });

  it("answers exact and historical replay before consulting live authority", () => {
    const value = harness();
    const firstInput = selectionInput(value, "select-historical");
    const first = commitDeliveryV2ResolutionSelection(value.store, value.config, firstInput);
    expect(first).toMatchObject({ disposition: "DECIDED", ok: true,
      selection: { generation: 1 } });
    commitDeliveryV2ResolutionSelection(
      value.store, value.config, selectionInput(value, "select-newer"),
    );
    const aggregateId = deriveDeliveryV2ResolutionSelectionAggregateId(
      PROJECT, value.contract.contractId,
    );
    const replayOnlyStore = Object.freeze({
      getCommandDecision: value.store.getCommandDecision.bind(value.store),
      getCommandReceipt: value.store.getCommandReceipt.bind(value.store),
      readAggregateEvents: (
        observedAggregateId: string, afterAggregateSequence?: number,
        limit?: number, maxDecodedBytes?: number,
      ) => {
        if (observedAggregateId !== aggregateId) {
          throw new Error(`live authority read after historical replay: ${observedAggregateId}`);
        }
        return value.store.readAggregateEvents(
          observedAggregateId, afterAggregateSequence, limit, maxDecodedBytes,
        );
      },
    }) as unknown as SqliteEventStore;
    expect(commitDeliveryV2ResolutionSelection(
      replayOnlyStore, value.config, firstInput,
    )).toEqual(first.ok ? { disposition: "REPLAYED", ok: true, selection: first.selection } : first);
    expect(commitDeliveryV2ResolutionSelection(
      value.store, value.config, selectionInput(value, "select-newer"),
    )).toMatchObject({ disposition: "REPLAYED", ok: true,
      selection: { generation: 2 } });
  });

  it("refuses a reused command whose canonical material request changed", () => {
    const value = harness();
    const input = selectionInput(value, "select-conflict");
    expect(commitDeliveryV2ResolutionSelection(value.store, value.config, input).ok).toBe(true);
    expect(commitDeliveryV2ResolutionSelection(value.store, value.config, {
      ...input,
      materialRefs: { ...input.materialRefs,
        catalog: { ...input.materialRefs.catalog, revisionDigest: "f".repeat(64) } },
    })).toEqual({ code: "COMMAND_ID_CONFLICT", layer: "DURABLE_STORE", ok: false });
  });

  it("accepts only the configured operator shared by approval and qualification status", () => {
    const value = harness();
    expect(commitDeliveryV2ResolutionSelection(value.store, value.config, {
      ...selectionInput(value, "select-attacker"), principalId: "principal:attacker",
    })).toEqual({ code: "DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID",
      layer: "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION", ok: false });
    expect(commitDeliveryV2ResolutionSelection(value.store, {
      ...value.config,
      authorityPrincipals: { ...value.config.authorityPrincipals,
        qualificationStatusPrincipalId: "operator-other" },
    }, selectionInput(value, "select-config-mismatch"))).toEqual({
      code: "DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID",
      layer: "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION",
      ok: false,
    });
  });

  it("submits exactly one selection append and three no-event authority fences", () => {
    const value = harness();
    let captured: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0] | undefined;
    const observingStore = Object.freeze({
      commitExpectedVersionDecisionLegs: (
        request: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0],
      ) => {
        if (request.commandKind === DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND) {
          captured = request;
        }
        return value.store.commitExpectedVersionDecisionLegs(request);
      },
      getCommandDecision: value.store.getCommandDecision.bind(value.store),
      getCommandReceipt: value.store.getCommandReceipt.bind(value.store),
      readAggregateEvents: value.store.readAggregateEvents.bind(value.store),
      readCommandDecisionsAfter: value.store.readCommandDecisionsAfter.bind(value.store),
      readEvents: value.store.readEvents.bind(value.store),
    }) as unknown as SqliteEventStore;
    const input = selectionInput(value, "select-four-legs");
    const committed = commitDeliveryV2ResolutionSelection(
      observingStore, value.config, input,
    );
    expect(committed).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(captured).toBeDefined();
    if (captured === undefined || !committed.ok) return;
    expect(captured.legs).toHaveLength(4);
    expect(captured.legs.map((leg) => ({ aggregateId: leg.aggregateId,
      eventCount: leg.events.length, expectedVersion: leg.expectedVersion }))).toEqual([
      {
        aggregateId: deriveDeliveryV2ResolutionSelectionAggregateId(
          PROJECT, value.contract.contractId,
        ),
        eventCount: 1,
        expectedVersion: 0,
      },
      {
        aggregateId: deriveProductContractCurrentRevisionSlotV2AggregateId(
          PROJECT, value.contract.contractId,
        ),
        eventCount: 0,
        expectedVersion: 1,
      },
      {
        aggregateId: deriveProductContractV2WorkflowAggregateId(
          PROJECT, value.contract.contractId,
        ),
        eventCount: 0,
        expectedVersion: 2,
      },
      {
        aggregateId: deriveDeliveryV2AuthorityAggregateId(
          PROJECT, "QUALIFICATION_STATUS", value.materials.qualification.qualificationId,
        ),
        eventCount: 0,
        expectedVersion: 1,
      },
    ]);
    const decision = value.store.getCommandDecision({
      commandId: input.commandId, principalId: OPERATOR, projectId: PROJECT,
    });
    expect(decision).toMatchObject({
      businessEventIds: [captured.legs[0]!.events[0]!.eventId],
      commandKind: DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
      currentVersion: 1,
      effectDisposition: "EFFECTS_COMMITTED",
      expectedVersion: 0,
      previousVersion: 0,
      resultCode: "EFFECTS_COMMITTED",
      targetAggregateId: captured.legs[0]!.aggregateId,
    });
    const event = value.store.readAggregateEvents(captured.legs[0]!.aggregateId, 0, 1).items[0]!;
    expect(value.store.getCommandReceipt(event.commandId)).toMatchObject({
      aggregateId: captured.legs[0]!.aggregateId,
      currentVersion: 1,
      eventIds: [captured.legs[0]!.events[0]!.eventId],
      previousVersion: 0,
    });
    expect(readCurrentDeliveryV2ResolutionSelection(value.store, value.config, {
      contractId: value.contract.contractId, projectId: PROJECT,
    })).toMatchObject({ ok: true, selection: committed.selection });
  });

  it.each(["selection", "contract-slot", "workflow", "qualification"] as const)(
    "aborts all selection effects when the %s leg races",
    (raceKind) => {
      const value = harness();
      const losingInput = selectionInput(value, `select-loser-${raceKind}`);
      const selectionAggregateId = deriveDeliveryV2ResolutionSelectionAggregateId(
        PROJECT, value.contract.contractId,
      );
      let raced = false;
      const racingStore = Object.freeze({
        commitExpectedVersionDecisionLegs: (
          request: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0],
        ) => {
          if (!raced && request.commandKind === DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND) {
            raced = true;
            if (raceKind === "selection") {
              const winner = commitDeliveryV2ResolutionSelection(
                value.store, value.config, selectionInput(value, "select-race-winner"),
              );
              if (!winner.ok) throw new Error(`${winner.code}@race-selection`);
            } else if (raceKind === "contract-slot") {
              commitContract(value.store, contractDraft("revision-selection-race", {
                parentRevisionDigest: value.contract.revisionDigest,
                parentRevisionId: value.contract.revisionId,
              }));
            } else if (raceKind === "workflow") {
              const bytes = new TextEncoder().encode("synthetic workflow race");
              value.store.commitExpectedVersionDecisionLegs({
                commandKind: "delivery_v2.test_workflow_race",
                committedResultBytes: bytes,
                correlationId: "correlation:workflow-race",
                decidedAt: DECIDED_AT,
                key: { commandId: "workflow-race", principalId: OPERATOR, projectId: PROJECT },
                legs: [{
                  aggregateId: deriveProductContractV2WorkflowAggregateId(
                    PROJECT, value.contract.contractId,
                  ),
                  events: [{ domainSchemaVersion: "delivery-v2-test-workflow-race/1",
                    eventId: "workflow-race-event", eventType: "DeliveryV2TestWorkflowRace",
                    payload: bytes }],
                  expectedVersion: 2,
                }],
                requestBytes: bytes,
              });
            } else {
              const qualification = value.materials.qualification;
              const revoked = createDeliveryProfileQualificationStatusIngress(
                value.store, OPERATOR,
              )(context("status-race-revoked", OPERATOR, 1), {
                qualificationDigest: qualification.qualificationDigest,
                qualificationId: qualification.qualificationId,
                status: "REVOKED",
                statusRef: `qualification-status:${qualification.qualificationId}`,
              });
              if (!revoked.ok) throw new Error(`${revoked.code}@race-qualification`);
            }
          }
          return value.store.commitExpectedVersionDecisionLegs(request);
        },
        getCommandDecision: value.store.getCommandDecision.bind(value.store),
        getCommandReceipt: value.store.getCommandReceipt.bind(value.store),
        readAggregateEvents: value.store.readAggregateEvents.bind(value.store),
        readCommandDecisionsAfter: value.store.readCommandDecisionsAfter.bind(value.store),
        readEvents: value.store.readEvents.bind(value.store),
      }) as unknown as SqliteEventStore;
      expect(commitDeliveryV2ResolutionSelection(
        racingStore, value.config, losingInput,
      )).toEqual({ code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE", ok: false });

      const selectionEvents = value.store.readAggregateEvents(
        selectionAggregateId, 0, 3,
      ).items;
      expect(selectionEvents).toHaveLength(raceKind === "selection" ? 1 : 0);
      expect(selectionEvents.some((event) => event.decisionTrace?.commandId
        === losingInput.commandId)).toBe(false);
      const losingDecision = value.store.getCommandDecision({
        commandId: losingInput.commandId, principalId: OPERATOR, projectId: PROJECT,
      });
      expect(losingDecision).toMatchObject({
        businessEventIds: [],
        effectDisposition: "NO_BUSINESS_EFFECT",
        resultCode: "EXPECTED_VERSION_CONFLICT",
      });
      if (losingDecision !== null) {
        const rejectionReceipt = value.store.getCommandReceipt(
          `moe-internal:decision-effect:${losingDecision.decisionId}`,
        );
        expect(rejectionReceipt).toMatchObject({
          aggregateId: expect.stringMatching(/^moe-internal:command-rejection:/u),
          eventIds: [expect.stringMatching(/^moe-internal:command-rejection-event:/u)],
        });
        expect(rejectionReceipt?.aggregateId).not.toBe(selectionAggregateId);
      }
    },
  );

  it("refuses the 129th selection at the selection-history bound before live reads", () => {
    const value = harness();
    const first = commitDeliveryV2ResolutionSelection(
      value.store, value.config, selectionInput(value, "select-bound-1"),
    );
    expect(first).toMatchObject({ ok: true, selection: { generation: 1 } });
    if (!first.ok) return;
    const aggregateId = deriveDeliveryV2ResolutionSelectionAggregateId(
      PROJECT, value.contract.contractId,
    );
    const requestBytes = encodeDeliveryV2ResolutionSelectionRequest(
      PROJECT, value.contract.contractId, value.refs,
    );
    expect(requestBytes).toBeDefined();
    if (requestBytes === undefined) return;
    const { selectionDigest: _digest, version: _version, ...firstDraft } = first.selection;
    for (let generation = 2;
      generation <= DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY;
      generation += 1) {
      const created = createDeliveryV2ResolutionSelection({ ...firstDraft, generation });
      if (!created.ok) throw new Error(`${created.code}@bound-fixture`);
      const encoded = encodeDeliveryV2ResolutionSelection(created.selection);
      if (!encoded.ok) throw new Error(`${encoded.code}@bound-fixture`);
      const commandId = `select-bound-${generation}`;
      const response = value.store.commitExpectedVersionDecisionLegs({
        commandKind: DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND,
        committedResultBytes: encoded.bytes,
        correlationId: `correlation:${commandId}`,
        decidedAt: DECIDED_AT,
        key: { commandId, principalId: OPERATOR, projectId: PROJECT },
        legs: [{
          aggregateId,
          events: [{
            domainSchemaVersion: DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
            eventId: deriveDeliveryV2ResolutionSelectionEventId(
              PROJECT, OPERATOR, commandId,
            ),
            eventType: DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE,
            payload: encoded.bytes,
          }],
          expectedVersion: generation - 1,
        }],
        requestBytes,
      });
      expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    }
    expect(value.store.readAggregateEvents(aggregateId, 0, 200).items).toHaveLength(128);
    let nonSelectionReads = 0;
    const boundedStore = Object.freeze({
      getCommandDecision: value.store.getCommandDecision.bind(value.store),
      getCommandReceipt: value.store.getCommandReceipt.bind(value.store),
      readAggregateEvents: (
        observedAggregateId: string, afterAggregateSequence?: number,
        limit?: number, maxDecodedBytes?: number,
      ) => {
        if (observedAggregateId !== aggregateId) {
          nonSelectionReads += 1;
          throw new Error(`live read beyond full selection history: ${observedAggregateId}`);
        }
        return value.store.readAggregateEvents(
          observedAggregateId, afterAggregateSequence, limit, maxDecodedBytes,
        );
      },
    }) as unknown as SqliteEventStore;
    const input = selectionInput(value, "select-bound-129");
    expect(commitDeliveryV2ResolutionSelection(
      boundedStore, value.config, input,
    )).toEqual({ code: "DELIVERY_V2_RESOLUTION_SELECTION_LIMIT_EXCEEDED",
      layer: "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION", ok: false });
    expect(nonSelectionReads).toBe(0);
    expect(value.store.getCommandDecision({
      commandId: input.commandId, principalId: OPERATOR, projectId: PROJECT,
    })).toBeNull();
    expect(value.store.readAggregateEvents(aggregateId, 0, 200).items).toHaveLength(128);
  });

  it("refuses current reads after the Product Contract advances", () => {
    const value = harness();
    expect(commitDeliveryV2ResolutionSelection(
      value.store, value.config, selectionInput(value, "select-before-contract-change"),
    ).ok).toBe(true);
    commitContract(value.store, contractDraft("revision-selection-2", {
      parentRevisionDigest: value.contract.revisionDigest,
      parentRevisionId: value.contract.revisionId,
    }));
    expect(readCurrentDeliveryV2ResolutionSelection(value.store, value.config, {
      contractId: value.contract.contractId, projectId: PROJECT,
    })).toEqual({ code: "DELIVERY_V2_RESOLUTION_SELECTION_CONTRACT_STALE",
      layer: "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION", ok: false });
  });

  it("refuses current reads after the exact qualification is revoked", () => {
    const value = harness();
    expect(commitDeliveryV2ResolutionSelection(
      value.store, value.config, selectionInput(value, "select-before-revoke"),
    ).ok).toBe(true);
    createDeliveryProfileQualificationStatusIngress(value.store, OPERATOR)(
      context("status-revoked", OPERATOR, 1), {
        qualificationDigest: value.materials.qualification.qualificationDigest,
        qualificationId: value.materials.qualification.qualificationId,
        status: "REVOKED",
        statusRef: `qualification-status:${value.materials.qualification.qualificationId}`,
      },
    );
    expect(readCurrentDeliveryV2ResolutionSelection(value.store, value.config, {
      contractId: value.contract.contractId, projectId: PROJECT,
    })).toEqual({ code: "DELIVERY_V2_RESOLUTION_SELECTION_QUALIFICATION_STALE",
      layer: "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION", ok: false });
  });

  it.each(["event", "decision", "receipt", "prior-history"] as const)(
    "refuses %s corruption even when the current payload remains decodable",
    (kind) => {
      const value = harness();
      commitDeliveryV2ResolutionSelection(
        value.store, value.config, selectionInput(value, "select-corruption-first"),
      );
      commitDeliveryV2ResolutionSelection(
        value.store, value.config, selectionInput(value, "select-corruption-current"),
      );
      const aggregateId = deriveDeliveryV2ResolutionSelectionAggregateId(
        PROJECT, value.contract.contractId,
      );
      const corrupted = Object.freeze({
        getCommandDecision: (key: Parameters<SqliteEventStore["getCommandDecision"]>[0]) => {
          const decision = value.store.getCommandDecision(key);
          return kind === "decision" && decision !== null
            ? Object.freeze({ ...decision, recordVersion: "synthetic-decision-version" })
            : decision;
        },
        getCommandReceipt: (commandId: string) => {
          const receipt = value.store.getCommandReceipt(commandId);
          return kind === "receipt" && receipt !== null
            ? Object.freeze({ ...receipt, eventIds: Object.freeze([]) }) : receipt;
        },
        readAggregateEvents: (
          observedAggregateId: string, afterAggregateSequence?: number,
          limit?: number, maxDecodedBytes?: number,
        ) => {
          const page = value.store.readAggregateEvents(
            observedAggregateId, afterAggregateSequence, limit, maxDecodedBytes,
          );
          if (observedAggregateId !== aggregateId) return page;
          return Object.freeze({ ...page, items: Object.freeze(page.items.map((event) => {
            if (kind === "event" && event.aggregateSequence === 2) {
              return Object.freeze({ ...event, eventId: `${event.eventId}:tampered` });
            }
            if (kind === "prior-history" && event.aggregateSequence === 1) {
              return Object.freeze({ ...event, eventType: "SyntheticPriorSelection" });
            }
            return event;
          })) });
        },
      }) as unknown as SqliteEventStore;
      expect(readCurrentDeliveryV2ResolutionSelection(corrupted, value.config, {
        contractId: value.contract.contractId, projectId: PROJECT,
      })).toEqual({ code: "DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE",
        layer: "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION", ok: false });
    },
  );

  it("refuses a 129-event selection history before folding any fabricated event", () => {
    const value = harness();
    commitDeliveryV2ResolutionSelection(
      value.store, value.config, selectionInput(value, "select-limit-template"),
    );
    const aggregateId = deriveDeliveryV2ResolutionSelectionAggregateId(
      PROJECT, value.contract.contractId,
    );
    const template = value.store.readAggregateEvents(aggregateId, 0, 1).items[0]!;
    const oversized = Object.freeze({
      getCommandDecision: value.store.getCommandDecision.bind(value.store),
      getCommandReceipt: value.store.getCommandReceipt.bind(value.store),
      readAggregateEvents: (
        observedAggregateId: string, afterAggregateSequence = 0,
        limit = 100, maxDecodedBytes?: number,
      ) => {
        if (observedAggregateId !== aggregateId) {
          return value.store.readAggregateEvents(
            observedAggregateId, afterAggregateSequence, limit, maxDecodedBytes,
          );
        }
        const final = Math.min(129, afterAggregateSequence + limit);
        const items = Array.from({ length: final - afterAggregateSequence }, (_, index) =>
          Object.freeze({ ...template, aggregateSequence: afterAggregateSequence + index + 1 }));
        return Object.freeze({ hasMore: final < 129, items: Object.freeze(items) });
      },
    }) as unknown as SqliteEventStore;
    expect(readCurrentDeliveryV2ResolutionSelection(oversized, value.config, {
      contractId: value.contract.contractId, projectId: PROJECT,
    })).toEqual({ code: "DELIVERY_V2_RESOLUTION_SELECTION_LIMIT_EXCEEDED",
      layer: "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION", ok: false });
  });

  it("pins the durable command and event identity literals", () => {
    expect(DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND)
      .toBe("delivery_v2.resolution_selection.commit");
    expect(DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE)
      .toBe("DeliveryV2ResolutionSelectionCommitted");
  });
});
