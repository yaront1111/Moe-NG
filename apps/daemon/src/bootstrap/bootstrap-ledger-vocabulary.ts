import type { JsonValue, RuntimeError } from "@moe/contracts";
import {
  ACCEPTANCE_CONTRACT_LAYERS, APPROVAL_AUTHORITY_LAYERS, PLAN_REVISION_LAYERS,
} from "@moe/core";
import { GRAPH_CONTENT_LAYERS, NODE_AUTHORITY_RECURSION_LAYERS } from "@moe/scheduler";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import type { BootstrapCommandKind, BootstrapRequest } from "./bootstrap-contracts.js";

/**
 * WHAT A BOOTSTRAP REFUSAL MAY SAY, and the shapes a service hands back.
 *
 * Split out of `bootstrap-ledger.ts` (task-6646f888) when that file crossed the 400-line bar. The
 * seam is a real responsibility line, not an arbitrary cut: everything here answers "what CAN be
 * said" -- two frozen refusal rosters and the outcome/handler types built on them -- while
 * `bootstrap-ledger.ts` keeps "how a decision is READ and COMMITTED" against the durable store.
 * The rosters are the half that grows every time a slice contributes a layer, which is exactly why
 * they belong where they are not competing for room with the commit mechanics.
 *
 * `bootstrap-ledger.ts` re-exports every name below, so no importer moves.
 */
/**
 * The layer that answered. Several layers can refuse, so evidence must name which one did.
 *
 * A slice that owns a refusal vocabulary of its own contributes its layer here rather than
 * hiding it inside a message, exactly as `@moe/core`'s approval-authority layers do. The
 * provider-profile pair is spelled literally because the codec keeps its layer constants
 * module-private: exporting them would declare a production boundary the security roster then
 * demands a hostile trio for, and the compile-time check that keeps the two in agreement is
 * `recordProbe` passing the codec's closed layer TYPE straight into `refuse`.
 */
export const SERVICE_REFUSED_BY = Object.freeze([
  "DAEMON_INGRESS",
  "DAEMON_PREREQUISITE",
  "CORE_REDUCER",
  "DURABLE_STORE",
  "PROVIDER_PROFILE_CODEC",
  "PROVIDER_PROFILE_REGISTRATION",
  "PROVIDER_RUNTIME_OBSERVATION_CODEC",
  // Spelled literally for the same reason as the provider pair: the planning-authority
  // persistence module keeps its layer const private, and the compile-time agreement check is
  // `proposePlan` passing that module's closed layer TYPE straight into `refuse`.
  "PLANNING_AUTHORITY_PERSISTENCE",
  // Same discipline one seam later: the planning-authority ENVELOPE codec keeps its layer const
  // private too, and `proposePlan` passing the finalize module's closed layer TYPE into `refuse`
  // is what makes this literal verified rather than merely asserted.
  "PLANNING_AUTHORITY_ENVELOPE",
  // Same discipline once more at the approval seam: `approval-run-binding.ts` keeps its layer
  // const private and exports only the closed TYPE, and `decideApproval` passing that type
  // straight into `refuse` is what makes this literal verified rather than merely asserted.
  "APPROVAL_RUN_BINDING",
  // Same discipline at the daemon-owned approval INTENT seam (task-6646f888):
  // `planning/approval-intent.ts` keeps its layer const private and exports only the closed TYPE,
  // and `runApprovalIntentCommand` passing that type straight into `refuse` is what makes this
  // literal verified rather than merely asserted. It stays APART from APPROVAL_RUN_BINDING because
  // an operator repairs the two differently: that one is the daemon failing to bind a run, this one
  // is the daemon refusing to COMPOSE a record — either because the caller tried to supply
  // authority bytes, or because a fact the record needs has no durable producer yet.
  "DAEMON_APPROVAL_INTENT",
  // The SessionAuthority replay ledger's OWN layer, carried verbatim rather than restamped
  // (task-3b61860f). `observeReplayMarker` answers with a discriminant, and the pair its one
  // existing production consumer maps an observed replay to is `SESSION_REPLAYED` @ `REPLAY`
  // (`packages/core/src/identity/authenticate-session.ts:203`). The approval intent seam burns
  // the step-up reference through that same ledger, so its refusal travels back under the layer
  // that produced it -- restamping it as DAEMON_APPROVAL_INTENT would tell an operator the
  // record composition failed when what actually happened is that this authentication already
  // approved once.
  "REPLAY",
  // The budget family's two layers, spelled literally for the same reason as the pairs above:
  // `budget-ledger-contracts.ts` keeps BOTH constants module-private (its header explains that
  // exporting them would declare a boundary the security roster demands a hostile trio for) and
  // exports only the closed `BudgetRefusalLayer` TYPE. `activateInitialGraph` passing that type
  // straight into `refuse` is what makes these two literals verified rather than asserted, and
  // keeping them apart is load-bearing: BUDGET_LEDGER is a writer refusing, while
  // BUDGET_CURRENT_PROJECTION is the durable reader refusing, and an operator repairs the two
  // differently.
  "BUDGET_LEDGER",
  "BUDGET_CURRENT_PROJECTION",
  // The two BODY vocabularies, spread from their own exported rosters so a core codec's verdict
  // travels under the layer that produced it rather than under a daemon restatement.
  // Same discipline at the graph-content ingress: its layer const stays private and `proposePlan`
  // passing the closed TYPE into `refuse` is what makes this literal verified, not asserted.
  "PLANNING_GRAPH_CONTENT_INGRESS",
  // The initial active-graph transition's three layers. The first two keep their consts private
  // and export only closed TYPES, so `activateInitialGraph` passing those types straight into
  // `refuse` is the compile-time agreement check — same discipline as the pairs above. They stay
  // APART because an operator repairs each differently: GRAPH_ACTIVATION_BINDING is the daemon
  // failing to SOURCE or reconcile a binding member, GRAPH_REVISION_ACTIVATION is the daemon
  // refusing to START a transition (a revision already recorded, a project already holding an
  // ACTIVE revision), and GRAPH_REVISION is the CORE AGGREGATE ITSELF rejecting the lifecycle
  // move. Collapsing them would tell an operator to inspect the wrong authority.
  "GRAPH_ACTIVATION_BINDING",
  "GRAPH_REVISION_ACTIVATION",
  // Spelled literally because `@moe/core`'s root does not export `GRAPH_REVISION_LAYER`; the
  // compile-time check is `graph-revision-activation-leg.ts` typing its core refusal's `layer` as
  // this exact literal and `activateInitialGraph` passing it straight into `refuse`.
  "GRAPH_REVISION",
  ...ACCEPTANCE_CONTRACT_LAYERS,
  ...APPROVAL_AUTHORITY_LAYERS,
  // BOTH scheduler rosters, spread rather than retyped. What a graph-content READER may observe
  // is strictly wider than what that codec OWNS: `deriveNodeAuthoritySet`'s verdict travels out
  // unrestamped, so a body refusal can arrive under any of the recursion's thirteen layers.
  ...GRAPH_CONTENT_LAYERS,
  ...NODE_AUTHORITY_RECURSION_LAYERS,
  ...PLAN_REVISION_LAYERS,
] as const);

export type ServiceRefusedBy = (typeof SERVICE_REFUSED_BY)[number];

/** Refusals owned by the daemon's durable-sequence gate; core codes are never restated here. */
export const PREREQUISITE_REFUSAL_CODES = Object.freeze([
  "BOOTSTRAP_PAYLOAD_INVALID",
  "BOOTSTRAP_PREREQUISITE_MISSING",
  "BOOTSTRAP_EXPECTED_VERSION_STALE",
  "BOOTSTRAP_POLICY_UNKNOWN",
  "BOOTSTRAP_POLICY_SLICE_ALREADY_INSTALLED",
  "BOOTSTRAP_POLICY_SLICE_DIGEST_MISMATCH",
  "BOOTSTRAP_REVISION_HASH_MISMATCH",
  // A caller's activation `budgetHash` that disagrees with the digest of the root the SERVER
  // built. Deliberately its own code rather than the revision-hash one next door: the two name
  // different disagreements and an operator repairs them differently — one is the plan bytes,
  // the other is the budget authorization.
  "BOOTSTRAP_BUDGET_HASH_MISMATCH",
  // task-61a2e8ad: decide-time budget commitment vs activation material. A SIBLING of the
  // code above and deliberately not the same one: that one says "your prediction of the root
  // disagrees with mine", this one says "the material you approved against is not the
  // material I am about to authorize". One code for both would make the two guards
  // indistinguishable to an operator and to a test.
  "BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH",
  "BOOTSTRAP_POLICY_TIME_UNAVAILABLE",
  "BOOTSTRAP_COMMAND_ID_REUSED",
  "BOOTSTRAP_COMMAND_BYTES_CONFLICT",
] as const);

export type PrerequisiteRefusalCode = (typeof PREREQUISITE_REFUSAL_CODES)[number];

export interface DurableAggregate {
  readonly currentVersion: number;
  readonly result: JsonValue;
}

export interface DurableLedger {
  readonly aggregates: ReadonlyMap<string, DurableAggregate>;
  readonly decisionCount: number;
  readonly kinds: ReadonlySet<string>;
}

export interface ServiceAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: BootstrapCommandKind;
  readonly ok: true;
}

export interface ServiceRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly kind: BootstrapCommandKind | null;
  readonly ok: false;
  readonly refusedBy: ServiceRefusedBy;
}

export type ServiceOutcome = ServiceAccepted | ServiceRefused;

/**
 * SERVER-ASSEMBLED evidence that a named human authenticated THIS request. Only
 * the composition root may supply it — it knows the authenticated principal and
 * the configured operator — and it is never decoded from request bytes, so no
 * payload can present one. A handler holding this witness may treat the request
 * itself as the human review the approval policy is waiting for; a handler
 * without it must keep refusing exactly as before.
 */
export interface HumanReviewWitness {
  readonly principalId: string;
  /**
   * The SERVER-KNOWN transport identity of the request that carried this witness. Absent only
   * where a composition root had no request identity to resolve; never defaulted.
   */
  readonly transport?: HumanReviewWitnessTransport | undefined;
}

/**
 * The transport identity the INGRESS itself resolved, carried as a fact rather than re-derived.
 *
 * `commandId` is the envelope's own id and `sessionRef` is the AUTHENTICATED principal id. For
 * the session-less local operator credential — the only identity that holds this witness today,
 * because `session-authenticator.ts:139` hands a PAIRED session its session id as its principal
 * and no paired principal ever equals the configured operator — that authenticated principal id
 * IS the transport identity. A future paired operator's session id lands in this same field with
 * NO loosening of the minting condition.
 *
 * Like the witness itself it is assembled ONLY at the composition root and never decoded from
 * request bytes, so no payload, header or fixture can present one.
 */
export interface HumanReviewWitnessTransport {
  readonly commandId: string;
  readonly sessionRef: string;
}

/**
 * The ONE witness constructor every composition root calls, so the mint sites cannot disagree
 * about the shape of the same operator's evidence. Both arguments are server facts the ingress
 * has already resolved; nothing here reads a payload, a header, a clock or a random source, so
 * the same authenticated request always mints the same witness.
 */
export function humanReviewWitness(principalId: string, commandId: string): HumanReviewWitness {
  return Object.freeze({
    principalId,
    transport: Object.freeze({ commandId, sessionRef: principalId }),
  });
}

export interface HandlerContext {
  readonly humanReview?: HumanReviewWitness;
  readonly ledger: DurableLedger;
  readonly request: BootstrapRequest;
  readonly store: SqliteEventStore;
}

export type CommandHandler = (context: HandlerContext) => ServiceOutcome;

export type HandlerTable = Readonly<Partial<Record<BootstrapCommandKind, CommandHandler>>>;
