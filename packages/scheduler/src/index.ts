/**
 * @moe/scheduler — three zero-minting composition areas on one entry point.
 *
 * 1. Structural graph analysis and preview:
 *  - validateGraphSnapshot: fail-closed structural validation -> ValidatedGraph.
 *  - analyzeGraphStructure: deterministic structural facts about a ValidatedGraph.
 *  - analyzeHardEdgeCounterfactuals: review-only source-edge pressure facts.
 *  - partitionFrontier: readiness partition from caller-supplied frontier facts.
 *  - previewGraphSnapshot: zero-authority validation/frontier/analysis composition.
 *
 * 2. Caller-supplied authority fencing and resource reservation:
 *  - fenceAuthority and its parsers: the design-749 check order over a lease
 *    record and a proof the CALLER supplies; no lease, token, or epoch is minted.
 *  - reserveAll / adapterConfirm / adapterFail / grantSuccessorCapacity /
 *    reserveProviderSlot: all-or-none acquisition over a caller-supplied
 *    capacity snapshot. No slot is counted here.
 *  - activateProviderSlot: the sole RESERVED -> ACTIVE slot transition, binding
 *    exactly one caller-supplied attempt. It mints no slot and no attempt.
 *
 * 3. Caller-supplied conserved-budget admission reservation:
 *  - reserveForAdmission / cancelReservation: units move all-or-none between the
 *    AVAILABLE and RESERVED buckets of a caller-supplied account view; the
 *    caller's own view is never mutated, a shifted one is returned.
 *  - activateReservation: binds an attempt and moves NO units, because
 *    RESERVED -> COMMITTED belongs to settlement.
 *  - No policy is re-evaluated and no approval is composed — a supplied gate
 *    must already read ALLOW / APPROVE+CURRENT or the admission is refused.
 *
 * 4. Fairness contract families for the fair scheduler:
 *  - the frozen reason-code and refusing-layer vocabularies, plus total
 *    validators for the WorkItem, ring, resource, opportunity-evidence and
 *    cap-revision families. They DESCRIBE and VALIDATE only: no exported
 *    function decides rotation order, deficit accounting or aging, and a bypass
 *    claim the caller cannot prove is refused rather than admitted. The
 *    rotation algorithm and the aging policy are the consumer's, task-10cab3e5.
 *
 * 5. Graph-supersession dispositions (scheduler half). buildSupersessionDispositions
 *    is the complete, deterministic, hash-bound attempt/effect/resource/budget set
 *    for one supersession, and carryWaitProjection is the wait/blocker carry
 *    validated through admission-wait's own validateIntentionalWait. Both COMPOSE
 *    the landed drain, resource and budget authority and decide none of it; a kind
 *    with no disposition, a changed fact or an UNKNOWN fact refuses with an
 *    existing @moe/contracts code and the refusing layer, never a shorter set.
 *
 * Every area is contract-neutral and stays that way: the package reports exact
 * facts and never invents dependency, policy, lease, or execution authority. It
 * does not infer independence, delete edges, infer semantic dependency truth,
 * claim a decomposition is faster, mint authority, or create budget. See
 * ./graph-model.ts for the structural rationale.
 */

export { validateGraphSnapshot } from "./validate-graph.js";
export { analyzeGraphStructure } from "./analyze-graph.js";
export { analyzeHardEdgeCounterfactuals } from "./hard-edge-counterfactual.js";
export { GraphAnalysisError } from "./graph-analysis-error.js";
export { partitionFrontier } from "./frontier.js";
export { previewGraphSnapshot } from "./graph-preview.js";
export {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  ABSOLUTE_MAX_GRAPH_NODES,
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  DEFAULT_GRAPH_POLICY,
  DEFAULT_MAX_HARD_EDGES,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_TOTAL_EDGES,
  MIN_GATED_DESCENDANTS_FOR_REVIEW,
  MAX_GRAPH_KEY_CODE_UNITS,
  resolveGraphPolicy,
} from "./graph-policy.js";
export { createTraversalCounter } from "./graph-model.js";
/**
 * Canonical `GraphRevisionContent` identity — design 197's seven fields and the
 * domain-separated `graphContentHash` over ALL of them. NAMES ARE LOAD-BEARING
 * (dec-64b2391c): the STRUCTURE-ONLY value is `GraphContent.snapshotIdentity`,
 * never a symbol reachable by asking for content, so no caller binds a durable
 * revision to an identity omitting six fields while believing it asked for
 * content. The codec boundary is published; the wire mechanics in
 * `./graph-content-format.js` and the per-field canonicalisation and digest in
 * `./graph-content-fields.js` stay withheld, because they take an
 * already-validated graph and a consumer holding any of them could mint bytes or
 * a hash the kernel never accepted. `encodeGraphContent` is the only route to a
 * `graphContentHash`.
 */
export {
  GRAPH_CONTENT_ISSUE_CODES,
  GRAPH_CONTENT_LAYERS,
  GRAPH_CONTENT_SCHEMA_VERSION,
  GRAPH_REVISION_CONTENT_KEYS,
  MAX_GRAPH_CONTENT_BYTES,
  decodeGraphContent,
  encodeGraphContent,
} from "./graph-content.js";
export type {
  GraphContent,
  GraphContentIssue,
  GraphContentIssueCode,
  GraphContentLayer,
  GraphContentResult,
  GraphRevisionContent,
} from "./graph-content.js";

/**
 * The execution-facing half — authority, resource, budget and fairness — is
 * forwarded wholesale from a sibling surface so that neither source sits past the
 * per-file size rule. Curation is unchanged and lives in that module's export
 * specifiers: it publishes exactly the names this root published inline before,
 * with each family's reviewed rationale carried alongside its own block.
 */
export * from "./execution-surface.js";
export {
  SUPERSESSION_BOUND_DISPOSITION_FIELDS, SUPERSESSION_DISPOSITION_FAMILIES,
  SUPERSESSION_DISPOSITION_LAYERS, SUPERSESSION_REFUSAL_CODES,
} from "./supersession/supersession-disposition-contract.js";

/**
 * The scheduler half of the expansion admission protocol: derive evidence from a
 * sealed receipt, then admit ONE proposal all-or-none.
 *
 * CURATED, NOT COMPLETE. expansion-preparation.ts and expansion-receipt.ts export
 * their parsers and refusal constructors (parseExpansionRequest, prepare, digestOf,
 * own, issue, refuse, checkKeys, RECEIPT_KEYS, HEX_64 and the rest) so the two
 * composers can share them; none is published. admitExpansion IS the entry point,
 * and a consumer that could call `prepare` directly would skip every pure check
 * that makes the composition all-or-none.
 *
 * FORBIDDEN_VERDICT_KEYS is published because it is a declared CASE LIST, not
 * plumbing: a refusal matrix must sweep it from the production constant, or the
 * sweep silently shrinks when the vocabulary grows.
 */
export { admitExpansion } from "./expansion/expansion-admission.js";
export { deriveExpansionEvidence } from "./expansion/expansion-evidence.js";
export {
  EXPANSION_ADMISSION_ISSUE_CODES, EXPANSION_ADMISSION_ORIGINS,
} from "./expansion/expansion-preparation.js";
/**
 * The admission-to-preparation bridge. `bindExpansionAdmission` is the ONLY way
 * an admitted expansion becomes core's `ExpansionAdmittedFacts` and its
 * `PlanningExpansionHoldBinding`, so no consumer has to hand-map the two shapes
 * and none can invent an opportunity ref or a DAEMON_VERIFIED marker on the way.
 * `validateOpportunityAttestation` is published beside it because the daemon
 * must be able to validate the evidence it is about to pass in.
 *
 * `bindCurrentExpansionHold` is the same authority WITHOUT the admission half:
 * one ACTIVE reducer-produced hold plus the daemon's five current values in,
 * one validated `PlanningExpansionHoldBinding` out. A caller that has a durable
 * hold but no scheduler preparation — the atomic expansion-request path — needs
 * it, and publishing it is what stops that caller from hand-rolling a second
 * projection. It is the SOLE producer; `bindExpansionAdmission` calls it too.
 * The refusal vocabulary is shared, so both surfaces speak the same words.
 */
export { validateOpportunityAttestation } from "./fairness/fairness-evidence.js";
export { bindExpansionAdmission } from "./expansion/expansion-binding.js";
export {
  EXPANSION_BINDING_ISSUE_CODES, EXPANSION_BINDING_LAYERS, EXPANSION_BINDING_ORIGINS,
  bindCurrentExpansionHold,
} from "./expansion/expansion-current-hold.js";
export {
  EXPANSION_EVIDENCE_ISSUE_CODES, EXPANSION_EVIDENCE_LAYERS, FORBIDDEN_VERDICT_KEYS,
} from "./expansion/expansion-receipt.js";
export { buildSupersessionDispositions, carryWaitProjection }
  from "./supersession/supersession-dispositions.js";

export type {
  BlockedNode,
  BlockedReason,
  BlockedReasonCode,
  CriticalPathEdge,
  FrontierCursor,
  FrontierError,
  FrontierOk,
  FrontierPartition,
  FrontierResult,
  GraphEdge,
  GraphEdgeKind,
  GraphIssue,
  GraphIssueCode,
  GraphKey,
  GraphNode,
  GraphPolicy,
  GraphSnapshot,
  GraphStructuralAnalysis,
  GraphValidationError,
  GraphValidationOk,
  GraphValidationResult,
  HardEdgeFact,
  HardEdgeSatisfaction,
  NodeAvailabilityFact,
  NodeStructuralFacts,
  RedundancyCandidate,
  StructuralDiagnostic,
  TraversalCounter,
  ValidatedGraph,
} from "./graph-model.js";
export type {
  GraphPreviewAdvisoryEnvelope,
  GraphPreviewAnalyzed,
  GraphPreviewFrontierInvalid,
  GraphPreviewGraphInvalid,
  GraphPreviewOptions,
  GraphPreviewOptionsInvalid,
  GraphPreviewPolicyInvalid,
  GraphPreviewResult,
} from "./graph-preview-model.js";
export type { GraphAnalysisErrorCode } from "./graph-analysis-error.js";
export type {
  HardEdgeCounterfactual,
  HardEdgeCounterfactualAnalysis,
} from "./hard-edge-counterfactual-model.js";

export type {
  ExpansionAdmissionIssue, ExpansionAdmissionIssueCode, ExpansionAdmissionOrigin,
  ExpansionAdmissionRefusal, ExpansionAdmissionRequest, ExpansionAdmissionResult,
  ExpansionAdmissionUnwind, ExpansionBoundFacts, ExpansionBudgetFacts, ExpansionCapacityFact,
  ExpansionFairnessFacts, ExpansionLineageFacts, ExpansionPreparation, ExpansionResourceFacts,
  ExpansionRestoredMeter,
} from "./expansion/expansion-preparation.js";
export type {
  DerivedExpansionEvidence, ExpansionChildFacts, ExpansionEvidenceIssue,
  ExpansionEvidenceIssueCode, ExpansionEvidenceLayer, ExpansionEvidenceRefusal,
  ExpansionEvidenceResult, ExpansionInputFact,
} from "./expansion/expansion-receipt.js";
export type {
  ExpansionAdmissionBinding, ExpansionBindingRequest, ExpansionBindingResult,
} from "./expansion/expansion-binding.js";
export type {
  ExpansionBindingIssue, ExpansionBindingIssueCode, ExpansionBindingLayer, ExpansionBindingOrigin,
  ExpansionBindingRefusal, ExpansionCurrentAuthority, ExpansionCurrentHoldRequest,
  ExpansionCurrentHoldResult,
} from "./expansion/expansion-current-hold.js";
/**
 * The two core types the request and the result above are written IN. Re-exported
 * by name so a consumer completes the type closure from the bare `@moe/scheduler`
 * specifier alone and never has to reach into `@moe/core` to name a parameter.
 */
export type { ExpansionPlanningHoldState, PlanningExpansionHoldBinding } from "@moe/core";

export type {
  SupersessionBoundDispositionField,
  SupersessionBudgetFacts,
  SupersessionCarryRefusal,
  SupersessionDispositionFamily,
  SupersessionDispositionLayer,
  SupersessionDispositionResult,
  SupersessionDispositionSet,
  SupersessionFamilyDisposition,
  SupersessionNodeFacts,
  SupersessionRefusalCode,
  SupersessionResourceFacts,
} from "./supersession/supersession-disposition-contract.js";
