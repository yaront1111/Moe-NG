/**
 * Hostile arms for the four `apps/daemon/src/delivery-v2` boundary constants the digit-aware
 * roster scan surfaced without coverage: the authority layer and the resolution-selection
 * codec (both `integrity` by SUBJECT: an admission of who may append delivery authority, and
 * a digest-sealed canonical codec) and the persistence and reader layers (both
 * `durable-store` by SUBJECT: they answer for what is written to and read out of the event
 * store, and every refusal names that store's own layer).
 *
 * EVERY ARM IS DETERMINISTIC AND SIDE-EFFECT FREE. No store is opened, no file is touched,
 * no process is spawned and no timer runs: each refusal is driven either by pure hostile
 * SHAPE (`null`, `{}`, `[]`, a context signed by the wrong principal, a re-spaced copy of a
 * sealed record's bytes) or by an injected store port whose methods THROW, so the arm proves
 * the refusal answers BEFORE the port is touched. Where a refusal must follow a read (the
 * authority's transition check reads the status history first), the port answers that one
 * read EMPTY and still throws on commit, so the write side stays provably unreached.
 *
 * NEVER `null` FOR A CONTEXT. `snapshotDeliveryV2AppendContext(null)` reaches `Object.keys`
 * and throws a `TypeError` rather than refusing (the context type is non-nullable and the
 * function is internal), so an empty record `{}` is the hostile context here: it is a plain
 * record with none of the six required keys and is refused at the first check.
 *
 * NO `integrity` (forgery re-seal) THUNK IS DECLARED. `integrity-boundaries.security.ts` pins
 * the set of constants that carry one as an exact list, so a re-seal control for the
 * resolution-selection codec belongs with an edit to that pin, not to this table.
 *
 * Every expected layer is read OUT of the production constant and every expected code OUT
 * of the module's `*_CODES` roster (`memberOf` throws on a miss), so a renamed layer or a
 * retired code reddens here instead of being followed.
 */
import {
  createDeliveryProfileOperatorApprovalIngress,
  createDeliveryProfileQualificationStatusIngress,
} from "../../apps/daemon/src/delivery-v2/authority-ingress.js";
import {
  appendDeliveryProfileQualificationStatus,
} from "../../apps/daemon/src/delivery-v2/authority-persistence.js";
import {
  DELIVERY_V2_AUTHORITY_LAYER,
  DELIVERY_V2_CODES,
  DELIVERY_V2_PERSISTENCE_LAYER,
  DELIVERY_V2_READER_LAYER,
} from "../../apps/daemon/src/delivery-v2/contracts.js";
import type {
  DeliveryV2AppendContext,
  DeliveryV2QualificationStatusInput,
} from "../../apps/daemon/src/delivery-v2/contracts.js";
import {
  createCapabilityCatalogRevisionIngress,
} from "../../apps/daemon/src/delivery-v2/material-ingress.js";
import {
  appendCapabilityCatalogRevision,
} from "../../apps/daemon/src/delivery-v2/material-persistence.js";
import {
  readCapabilityCatalogRevision,
} from "../../apps/daemon/src/delivery-v2/material-readers.js";
import {
  appendDeliveryV2NodePlanningSource,
} from "../../apps/daemon/src/delivery-v2/node-planning-source-persistence.js";
import {
  readDeliveryV2NodePlanningSource,
} from "../../apps/daemon/src/delivery-v2/node-planning-source-reader.js";
import {
  readDeliveryV2PlannerAdmissionProfileRevision,
} from "../../apps/daemon/src/delivery-v2/planner-admission-profile-reader.js";
import {
  DELIVERY_V2_RESOLUTION_SELECTION_CODES,
  DELIVERY_V2_RESOLUTION_SELECTION_LAYER,
  createDeliveryV2ResolutionSelection,
  decodeDeliveryV2ResolutionSelection,
  encodeDeliveryV2ResolutionSelection,
} from "../../apps/daemon/src/delivery-v2/resolution-selection-contract.js";
import {
  readDeliveryV2SourceSnapshot,
} from "../../apps/daemon/src/delivery-v2/source-snapshot-reader.js";
import {
  PRODUCT_CONTRACT_V2_VERSION,
} from "../../packages/core/src/product-contract/product-contract-v2-contract.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";
import type { HostileCase } from "./integrity-hostile-cases.js";
import type { RecentDurableCase } from "./recent-durable-hostile-cases.js";

const BOUND_MS = 2_000;

/**
 * Reads a member OUT of a production roster (a layer constant wrapped as a one-member list,
 * or a `*_CODES` list). A typed literal would stay green through a rename; this throws.
 */
function memberOf(declared: readonly string[], wanted: string): string {
  const found = declared.find((entry) => entry === wanted);
  if (found === undefined) {
    throw new Error(`${wanted} is not a member of the declared roster`);
  }
  return found;
}

const AUTHORITY_LAYER = memberOf([DELIVERY_V2_AUTHORITY_LAYER], "DAEMON_DELIVERY_V2_AUTHORITY");
const PERSISTENCE_LAYER = memberOf(
  [DELIVERY_V2_PERSISTENCE_LAYER], "DAEMON_DELIVERY_V2_PERSISTENCE",
);
const READER_LAYER = memberOf([DELIVERY_V2_READER_LAYER], "DAEMON_DELIVERY_V2_READER");
const SELECTION_LAYER = memberOf(
  [DELIVERY_V2_RESOLUTION_SELECTION_LAYER], "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION",
);

const deliveryCode = (wanted: string): string => memberOf(DELIVERY_V2_CODES, wanted);
const selectionCode = (wanted: string): string =>
  memberOf(DELIVERY_V2_RESOLUTION_SELECTION_CODES, wanted);

// -- Fixtures: identifiers, digests, contexts -------------------------------------------------

const PROJECT_ID = "project-delivery-v2";
const OPERATOR = "operator-principal";
const PUBLISHER = "publisher-principal";
const IMPOSTOR = "impostor-principal";
const DECIDED_AT = "2026-01-01T00:00:00.000Z";
const hex64 = (digit: string): string => digit.repeat(64);

/** A well-formed append context signed by `principalId` at expected version 0. */
function contextFor(principalId: string): DeliveryV2AppendContext {
  return Object.freeze({
    commandId: "command-1", correlationId: "correlation-1", decidedAt: DECIDED_AT,
    expectedVersion: 0, principalId, projectId: PROJECT_ID,
  });
}

const REVOCATION_INPUT: DeliveryV2QualificationStatusInput = Object.freeze({
  qualificationDigest: hex64("a"), qualificationId: "qualification-1",
  status: "REVOKED", statusRef: "status-1",
});

const CATALOG_REF = Object.freeze({
  catalogId: "catalog-1", projectId: PROJECT_ID, revisionDigest: hex64("b"),
  revisionId: "catalog-revision-1",
});
const PUBLISHERS = Object.freeze({
  capabilityCatalogPrincipalId: PUBLISHER,
  deliveryProfilePrincipalId: PUBLISHER,
  deliveryProfileQualificationPrincipalId: PUBLISHER,
  executionIsolationProfilePrincipalId: PUBLISHER,
  verificationRecipePrincipalId: PUBLISHER,
});
const SNAPSHOT_REF = Object.freeze({ projectId: PROJECT_ID, sourceSnapshotDigest: hex64("c") });

/** A complete, canonical draft the resolution-selection codec seals on its own. */
const SELECTION_DRAFT = Object.freeze({
  contractId: "contract-1",
  generation: 1,
  materialRefs: Object.freeze({
    catalog: Object.freeze({
      catalogId: "catalog-1", revisionDigest: hex64("1"), revisionId: "catalog-revision-1",
    }),
    deliveryProfile: Object.freeze({
      profileId: "profile-1", revisionDigest: hex64("2"), revisionId: "profile-revision-1",
    }),
    entries: Object.freeze([Object.freeze({
      capabilityId: "capability-1",
      executionIsolationProfile: Object.freeze({
        profileId: "isolation-1", revisionDigest: hex64("3"), revisionId: "isolation-revision-1",
      }),
      verificationRecipes: Object.freeze([Object.freeze({
        recipeId: "recipe-1", revisionDigest: hex64("4"), revisionId: "recipe-revision-1",
      })]),
    })]),
    projectId: PROJECT_ID,
    qualification: Object.freeze({
      qualificationDigest: hex64("5"), qualificationId: "qualification-1",
    }),
  }),
  productContract: Object.freeze({
    revisionDigest: hex64("6"), revisionId: "contract-revision-1",
    revisionVersion: PRODUCT_CONTRACT_V2_VERSION, slotDigest: hex64("7"),
    slotGeneration: 1, workflowGeneration: 1,
  }),
  projectId: PROJECT_ID,
  qualificationStatus: Object.freeze({
    qualificationDigest: hex64("5"), qualificationId: "qualification-1",
    statusDigest: hex64("8"), statusRef: "status-1",
  }),
});

// -- Injected store ports ------------------------------------------------------------------

const touched = (method: string) => (): never => {
  throw new Error(`the boundary touched store.${method} before refusing`);
};
const unavailable = (): never => {
  throw new Error("store unavailable");
};
const EMPTY_PAGE = Object.freeze({ hasMore: false, items: Object.freeze([]), nextCursor: null });

/** Every method throws: the refusal under test must answer before the store is touched. */
function inertStore(): never {
  return Object.freeze({
    commitExpectedVersionDecisionLegs: touched("commitExpectedVersionDecisionLegs"),
    getCommandDecision: touched("getCommandDecision"),
    getCommandReceipt: touched("getCommandReceipt"),
    readAggregateEvents: touched("readAggregateEvents"),
    readEventHorizon: touched("readEventHorizon"),
  }) as never;
}

/** Reads answer EMPTY (no decision, no events); every write still throws. */
function emptyStore(): never {
  return Object.freeze({
    commitExpectedVersionDecisionLegs: touched("commitExpectedVersionDecisionLegs"),
    getCommandDecision: () => null,
    getCommandReceipt: touched("getCommandReceipt"),
    readAggregateEvents: () => EMPTY_PAGE,
    readEventHorizon: touched("readEventHorizon"),
  }) as never;
}

/** Every call fails with a plain error, NOT a `DurableStoreError`: the caller's own layer
 *  must report `STORAGE_DEGRADED` rather than forwarding a store code it never received. */
function degradedStore(): never {
  return Object.freeze({
    commitExpectedVersionDecisionLegs: unavailable,
    getCommandDecision: unavailable,
    getCommandReceipt: unavailable,
    readAggregateEvents: unavailable,
    readEventHorizon: unavailable,
  }) as never;
}

// -- DELIVERY_V2_AUTHORITY_LAYER (integrity) ----------------------------------------------------

const AUTHORITY_INPUT_INVALID: RefusalExpectation = {
  code: deliveryCode("DELIVERY_V2_INPUT_INVALID"), layer: AUTHORITY_LAYER,
};
const AUTHORITY_TRANSITION_INVALID: RefusalExpectation = {
  code: deliveryCode("DELIVERY_V2_AUTHORITY_TRANSITION_INVALID"), layer: AUTHORITY_LAYER,
};

/** The ingress is bound to the operator; a context signed by anyone else never reaches it. */
const unauthorizedPrincipal = async (): Promise<unknown> =>
  createDeliveryProfileOperatorApprovalIngress(inertStore(), OPERATOR)(
    contextFor(IMPOSTOR), {} as never,
  );

/** The operator is admitted, the status history reads EMPTY, and a revocation with no prior
 *  CURRENT status is refused by the transition check - before the commit port is touched. */
const revocationWithoutHistory = async (): Promise<unknown> =>
  createDeliveryProfileQualificationStatusIngress(emptyStore(), OPERATOR)(
    contextFor(OPERATOR), REVOCATION_INPUT,
  );

const authorityArms: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE", constant: "DELIVERY_V2_AUTHORITY_LAYER", expect: AUTHORITY_INPUT_INVALID,
    name: "delivery-v2-authority: a non-operator context is refused before any store call",
    run: async () => (await probeBefore(
      { label: "delivery-v2-authority-before", timeoutMs: BOUND_MS },
      unauthorizedPrincipal, revocationWithoutHistory,
    )).probe,
  },
  {
    arm: "AFTER", constant: "DELIVERY_V2_AUTHORITY_LAYER", expect: AUTHORITY_TRANSITION_INVALID,
    name: "delivery-v2-authority: a revocation over an empty history is refused after the read",
    run: async () => (await probeAfter(
      { label: "delivery-v2-authority-after", timeoutMs: BOUND_MS },
      unauthorizedPrincipal, revocationWithoutHistory,
    )).probe,
  },
  {
    arm: "RACE", constant: "DELIVERY_V2_AUTHORITY_LAYER",
    name: "delivery-v2-authority: a non-operator races a history-less revocation; nothing appends",
    expectLeft: AUTHORITY_INPUT_INVALID, expectRight: AUTHORITY_TRANSITION_INVALID,
    run: async () => probeRacing(
      { label: "delivery-v2-authority-race", timeoutMs: BOUND_MS },
      unauthorizedPrincipal, revocationWithoutHistory,
    ),
  },
]);

// -- DELIVERY_V2_RESOLUTION_SELECTION_LAYER (integrity) ---------------------------------------

const SELECTION_INPUT_INVALID: RefusalExpectation = {
  code: selectionCode("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID"), layer: SELECTION_LAYER,
};
const SELECTION_UNREADABLE: RefusalExpectation = {
  code: selectionCode("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE"), layer: SELECTION_LAYER,
};

/** Not a record: refused before any field is read. */
const selectionNotARecord = async (): Promise<unknown> =>
  createDeliveryV2ResolutionSelection(null);

/**
 * Seals a genuine selection through production, encodes its canonical bytes, then hands the
 * decoder a RE-SPACED copy: the same JSON value (digest intact, every field admitted) in a
 * non-canonical byte form. The codec must refuse it as UNREADABLE rather than accept a record
 * whose bytes it would not itself have written. A failed seal is returned unread, so a broken
 * fixture surfaces as the wrong refusal code instead of a silent pass.
 */
const selectionRespaced = async (): Promise<unknown> => {
  const sealed = createDeliveryV2ResolutionSelection(SELECTION_DRAFT);
  if (!sealed.ok) return sealed;
  const encoded = encodeDeliveryV2ResolutionSelection(sealed.selection);
  if (!encoded.ok) return encoded;
  const canonical = new TextDecoder("utf-8", { fatal: true }).decode(encoded.bytes);
  const respaced = JSON.stringify(JSON.parse(canonical), null, 2);
  return decodeDeliveryV2ResolutionSelection(new TextEncoder().encode(respaced));
};

const selectionArms: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE", constant: "DELIVERY_V2_RESOLUTION_SELECTION_LAYER",
    expect: SELECTION_INPUT_INVALID,
    name: "delivery-v2-resolution-selection: a non-record draft is refused before any field read",
    run: async () => (await probeBefore(
      { label: "delivery-v2-selection-before", timeoutMs: BOUND_MS },
      selectionNotARecord, selectionRespaced,
    )).probe,
  },
  {
    arm: "AFTER", constant: "DELIVERY_V2_RESOLUTION_SELECTION_LAYER",
    expect: SELECTION_UNREADABLE,
    name: "delivery-v2-resolution-selection: re-spaced sealed bytes are refused after the seal",
    run: async () => (await probeAfter(
      { label: "delivery-v2-selection-after", timeoutMs: BOUND_MS },
      selectionNotARecord, selectionRespaced,
    )).probe,
  },
  {
    arm: "RACE", constant: "DELIVERY_V2_RESOLUTION_SELECTION_LAYER",
    name: "delivery-v2-resolution-selection: a non-record races non-canonical bytes; none admitted",
    expectLeft: SELECTION_INPUT_INVALID, expectRight: SELECTION_UNREADABLE,
    run: async () => probeRacing(
      { label: "delivery-v2-selection-race", timeoutMs: BOUND_MS },
      selectionNotARecord, selectionRespaced,
    ),
  },
]);

export const RECENT_DELIVERY_V2_INTEGRITY_CASES: readonly HostileCase[] = Object.freeze([
  ...authorityArms,
  ...selectionArms,
]);

// -- DELIVERY_V2_PERSISTENCE_LAYER and DELIVERY_V2_READER_LAYER (durable-store) --------------

const persistence = (code: string): Readonly<{ code: string; layer: string }> =>
  Object.freeze({ code: deliveryCode(code), layer: PERSISTENCE_LAYER });
const reader = (code: string): Readonly<{ code: string; layer: string }> =>
  Object.freeze({ code: deliveryCode(code), layer: READER_LAYER });

/** Same BEFORE / AFTER / RACE shape as `recent-durable-hostile-cases.ts`. */
const casesFor = (
  boundary: string,
  expected: Readonly<{ code: string; layer: string }>,
  refused: () => unknown,
): readonly RecentDurableCase[] => Object.freeze([
  { arm: "BEFORE", boundary, expected, run: async () => refused() },
  { arm: "AFTER", boundary, expected, run: async () => { refused(); return refused(); } },
  {
    arm: "RACE", boundary, expected,
    run: async () => Promise.all([
      Promise.resolve().then(refused),
      Promise.resolve().then(refused),
    ]),
  },
]);

// Persistence: one refusal per producer module, each answered before the commit port.

/** material-persistence: a well-formed context carrying `null` where a revision is due. */
const materialNotARevision = (): unknown =>
  appendCapabilityCatalogRevision(inertStore(), contextFor(PUBLISHER), null);
/** material-ingress: the ingress is bound to the publisher; another principal is refused. */
const materialIngressImpostor = (): unknown =>
  createCapabilityCatalogRevisionIngress(inertStore(), PUBLISHER)(contextFor(IMPOSTOR), {});
/** node-planning-source-persistence: an empty record where an append context is due. */
const planningSourceEmptyContext = (): unknown =>
  appendDeliveryV2NodePlanningSource(inertStore(), {} as never, null);
/** authority-persistence: the store's first read fails with a plain error, so the persistence
 *  layer itself reports STORAGE_DEGRADED (no `DurableStoreError` code exists to forward). */
const authorityStoreUnavailable = (): unknown =>
  appendDeliveryProfileQualificationStatus(degradedStore(), contextFor(OPERATOR), REVOCATION_INPUT);

// Readers: one refusal per producer module, plus the two store-shaped refusals of the shared
// material reader (an absent aggregate, and a store that fails its first read).

/** material-readers: `null` where a revision ref and a publisher roster are due. */
const materialRefNotARecord = (): unknown =>
  readCapabilityCatalogRevision(inertStore(), null as never, null as never);
/** material-readers: an admitted ref whose aggregate holds no event. */
const materialAbsent = (): unknown =>
  readCapabilityCatalogRevision(emptyStore(), CATALOG_REF, PUBLISHERS);
/** material-readers: an admitted ref over a store that fails its first read. */
const materialStoreUnavailable = (): unknown =>
  readCapabilityCatalogRevision(degradedStore(), CATALOG_REF, PUBLISHERS);
/** node-planning-source-reader: an array where a source ref is due. */
const planningSourceRefArray = (): unknown =>
  readDeliveryV2NodePlanningSource(inertStore(), [] as never, PUBLISHER);
/** planner-admission-profile-reader: an empty record where a revision ref is due. */
const plannerProfileRefEmpty = (): unknown =>
  readDeliveryV2PlannerAdmissionProfileRevision(inertStore(), {} as never, PUBLISHER);
/** source-snapshot-reader: the core admits the ref; the reader refuses an empty expected
 *  publisher principal before its first store call. */
const snapshotPublisherEmpty = (): unknown =>
  readDeliveryV2SourceSnapshot(inertStore(), SNAPSHOT_REF, "");

export const RECENT_DELIVERY_V2_DURABLE_CASES: readonly RecentDurableCase[] = Object.freeze([
  ...casesFor(
    "DELIVERY_V2_PERSISTENCE_LAYER", persistence("DELIVERY_V2_MATERIAL_INVALID"),
    materialNotARevision,
  ),
  ...casesFor(
    "DELIVERY_V2_PERSISTENCE_LAYER", persistence("DELIVERY_V2_INPUT_INVALID"),
    materialIngressImpostor,
  ),
  ...casesFor(
    "DELIVERY_V2_PERSISTENCE_LAYER", persistence("DELIVERY_V2_INPUT_INVALID"),
    planningSourceEmptyContext,
  ),
  ...casesFor(
    "DELIVERY_V2_PERSISTENCE_LAYER", persistence("STORAGE_DEGRADED"),
    authorityStoreUnavailable,
  ),
  ...casesFor(
    "DELIVERY_V2_READER_LAYER", reader("DELIVERY_V2_INPUT_INVALID"), materialRefNotARecord,
  ),
  ...casesFor(
    "DELIVERY_V2_READER_LAYER", reader("DELIVERY_V2_MATERIAL_ABSENT"), materialAbsent,
  ),
  ...casesFor(
    "DELIVERY_V2_READER_LAYER", reader("STORAGE_DEGRADED"), materialStoreUnavailable,
  ),
  ...casesFor(
    "DELIVERY_V2_READER_LAYER", reader("DELIVERY_V2_INPUT_INVALID"), planningSourceRefArray,
  ),
  ...casesFor(
    "DELIVERY_V2_READER_LAYER", reader("DELIVERY_V2_INPUT_INVALID"), plannerProfileRefEmpty,
  ),
  ...casesFor(
    "DELIVERY_V2_READER_LAYER", reader("DELIVERY_V2_INPUT_INVALID"), snapshotPublisherEmpty,
  ),
]);
