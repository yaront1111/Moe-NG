/**
 * THE FROZEN FOUNDATION CONTEXT MATRIX `foundation-context-matrix/1` — design section 14.2's
 * mandatory context, read from durable authority and from nowhere else.
 *
 * ELEVEN MANDATORY ITEMS, each with a stable id and section: objective, criteria, policy, graph,
 * approved plan, node closure, input tree, activation authority, workspace scope, budget
 * coverage, legal next commands. TWO OPTIONAL: the attempt journal (priority 200) and the prior
 * findings lineage (priority 100). An optional item that is READABLY absent becomes a named
 * exclusion — `JOURNAL_RECORD_ABSENT`, `NO_DURABLE_REVIEW_FINDINGS` — and every other read
 * failure REFUSES. An absence and an unreadability demand opposite repairs, so they never
 * collapse into one answer, and `exclusions: []` is never an implicit default.
 *
 * NO SPEC FILE, NO CALLER ITEM, NO LIVE FILESYSTEM. The input tree and the workspace scope come
 * from the SEALED capture record, not from re-observing a tree any agent in a shared worktree
 * could have written since. Projections are narrow on purpose: the lease TOKEN, the boot id, the
 * source repository root and the worktree parent are omitted, because context is handed to a
 * provider and a secret in context is a secret in a prompt.
 *
 * THIS MODULE MINTS NO AUTHORITY. Every field is copied verbatim from one successful reader, and
 * every refusal keeps its author under `source`. Splitting the projection out of
 * `foundation-context-selection.ts` keeps both files inside the per-file size rail.
 */
import { createHash } from "node:crypto";

import type { ContextExclusion, MandatoryContextItem, OptionalContextItem } from "@moe/context";
import type { SqliteEventStore } from "@moe/store";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { readCurrentBudgetCoverage } from "../budget/budget-coverage-reader.js";
import { createAffordancePort } from "../http/affordance-read.js";
import { readCurrentAttemptJournal } from "../journal/journal-reader.js";
import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import { nodeClosureOf, readCurrentNodeClosure } from "../planning/node-closure-reader.js";
import { readApprovedCriteria, readApprovedPlan } from "../planning/planning-authority-reader.js";
import { resolveCurrentProviderProfile } from "../provider-profile/provider-profile-resolver.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import {
  deriveFoundationCaptureRef, readFoundationCaptureContext,
} from "./foundation-capture-context-ledger.js";

export const FOUNDATION_CONTEXT_MATRIX_VERSION = "foundation-context-matrix/1" as const;
/** MODULE-PRIVATE, only the TYPE escapes: the security boundary roster owes every exported
 *  `*_LAYER` a hostile trio, and a pure composition of readers is no boundary. */
const LAYER = "FOUNDATION_CONTEXT_SELECTION";
export type FoundationContextLayer = typeof LAYER;
export const FOUNDATION_CONTEXT_SELECTION_CODES = Object.freeze([
  "FOUNDATION_CONTEXT_BINDING_MISMATCH", "FOUNDATION_CONTEXT_CONFIGURATION_BINDING_INVALID",
  "FOUNDATION_CONTEXT_FINDINGS_UNREADABLE", "FOUNDATION_CONTEXT_ITEM_ENCODING_FAILED",
  "FOUNDATION_CONTEXT_LIMIT_UNKNOWN", "FOUNDATION_CONTEXT_LIMIT_UNSUPPORTED",
  "FOUNDATION_CONTEXT_REQUEST_INVALID", "FOUNDATION_CONTEXT_SNAPSHOT_MOVED",
  "FOUNDATION_CONTEXT_SOURCE_REFUSED", "FOUNDATION_CONTEXT_STORE_UNAVAILABLE",
] as const);
export type FoundationContextSelectionCode = (typeof FOUNDATION_CONTEXT_SELECTION_CODES)[number];

export interface FoundationContextRefused {
  readonly code: FoundationContextSelectionCode | "CONTEXT_TOO_LARGE" | "INVALID_CONTEXT_BUDGET";
  readonly detail: string;
  readonly layer: FoundationContextLayer | "CONTEXT_SELECTION";
  readonly ok: false;
  /** The lower authority's verdict WHOLE, or `null` when this composition decided alone. */
  readonly source: unknown;
}
/** The four-key identity a request is narrowed to before any read happens. */
export interface FoundationContextIdentity {
  readonly attemptRef: string; readonly nodeKey: string;
  readonly projectId: string; readonly sessionId: string;
}
export interface FoundationContextFacts {
  readonly bytes: number; readonly exclusions: ContextExclusion[];
  readonly journalDigest: string | null; readonly mandatory: MandatoryContextItem[];
  readonly manifestSha256: string; readonly optional: OptionalContextItem[];
  readonly revision: { readonly epoch: number; readonly hash: string; readonly id: string };
}

export const JOURNAL_ITEM_ID = "foundation.attempt-journal";
export const FINDINGS_ITEM_ID = "foundation.prior-findings";

export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  return value;
}
export function refuse(
  code: FoundationContextRefused["code"], detail: string, source: unknown = null,
  layer: FoundationContextRefused["layer"] = LAYER,
): FoundationContextRefused {
  return Object.freeze({ code, detail, layer, ok: false as const, source: freezeDeep(source) });
}
const sourced = (detail: string, source: unknown): FoundationContextRefused =>
  refuse("FOUNDATION_CONTEXT_SOURCE_REFUSED", detail, source);
const mismatch = (detail: string): FoundationContextRefused =>
  refuse("FOUNDATION_CONTEXT_BINDING_MISMATCH", detail);
/** Canonical JSON through the production payload encoder, so item content is byte-stable. */
const canonical = (value: unknown): string | null => {
  const encoded = encodeFoundationPayload(value);
  return encoded.ok ? new TextDecoder("utf-8", { fatal: true }).decode(encoded.bytes) : null;
};

/** Deterministic per (matrix version, snapshot horizon, identity): the same durable snapshot read
 *  twice must render byte-identical, so a random or clock-seeded id is disqualifying. */
export function mintIdFactory(horizon: bigint, id: FoundationContextIdentity): () => string {
  const seed = [FOUNDATION_CONTEXT_MATRIX_VERSION, String(horizon), id.projectId, id.sessionId,
    id.attemptRef, id.nodeKey].join(" ");
  let issued = 0;
  return (): string => {
    issued += 1;
    return `cmd-${createHash("sha256").update(`${seed} ${issued}`).digest("hex").slice(0, 32)}`;
  };
}

/**
 * Read every matrix cell from `store` under the snapshot `horizon` names, or refuse. The caller
 * owns the horizon fence; this function owns WHAT is read and WHICH projection of it is served.
 */
export function readFoundationContextFacts(
  store: SqliteEventStore, configurationDigest: string, id: FoundationContextIdentity,
  horizon: bigint,
): FoundationContextFacts | FoundationContextRefused {
  const { attemptRef, nodeKey, projectId, sessionId } = id;
  const mandatory: MandatoryContextItem[] = [];
  const optional: OptionalContextItem[] = [];
  const exclusions: ContextExclusion[] = [];
  let failed: string | null = null;
  const keep = (itemId: string, section: string, content: unknown, priority?: number): void => {
    const text = canonical(content);
    if (text === null) { failed ??= itemId; return; }
    if (priority === undefined) {
      mandatory.push({ content: text, id: itemId, kind: "MANDATORY", section });
    } else optional.push({ content: text, id: itemId, kind: "OPTIONAL", priority, section });
  };
  const graph = readCurrentActiveGraph(store, projectId);
  if (!graph.ok) return sourced("active graph", graph);
  const goalRef = graph.provenance.goalRef;
  const closure = readCurrentNodeClosure(store, projectId);
  if (!closure.ok) return sourced("node closure", closure);
  const node = nodeClosureOf(closure, nodeKey);
  if (!node.ok) return sourced("node authority", node);
  const def = node.definition;
  const plan = readApprovedPlan(store, projectId, goalRef);
  if (!plan.ok) return sourced("approved plan", plan);
  if (plan.graphRevisionRef !== graph.revisionId) return mismatch("plan names another revision");
  const criteria = readApprovedCriteria(store, projectId, goalRef);
  if (!criteria.ok) return sourced("acceptance criteria", criteria);
  const bound = readFoundationActivationByAttempt(store, projectId, attemptRef);
  if (bound.status !== "BOUND") return sourced("activation binding", bound);
  if (bound.ownerSessionRef !== sessionId) return mismatch("attempt is another session's");
  const target = bound.activationAggregateId;
  const past = readFoundationActivationHistory(target, store.readEvents(target), projectId);
  if (!past.ok) return sourced("activation history", past.result);
  const { lease, providerSlot: slot } = past.history.record;
  if (slot.attemptRef !== null && slot.attemptRef !== attemptRef) {
    return mismatch("provider slot holds another attempt");
  }
  const capture = readFoundationCaptureContext(store, deriveFoundationCaptureRef({
    attemptAggregateId: target, attemptId: attemptRef, nodeKey, projectId, sessionId,
  }));
  if (!capture.ok) return sourced("capture context", capture);
  const { assignment, catalogAuthority: cat, inputManifest, observation } = capture.record;
  const budget = readCurrentBudgetCoverage(store, projectId, goalRef);
  if (!budget.ok) return sourced("budget coverage", budget);
  if (budget.binding.graphRevisionRef !== graph.revisionId
    || budget.binding.graphEpoch !== graph.graphEpoch) {
    return mismatch("budget binds another graph revision");
  }
  const profile = resolveCurrentProviderProfile(store, {
    expectedConfigurationDigest: configurationDigest, projectId,
  });
  if (!profile.ok) return sourced("provider profile", profile);
  const limit = profile.contextLimit;
  if (limit.kind === "UNKNOWN") {
    return refuse("FOUNDATION_CONTEXT_LIMIT_UNKNOWN", "provider declares no context limit");
  }
  if (limit.kind !== "CONSERVATIVE_INPUT_BYTES") {
    return refuse("FOUNDATION_CONTEXT_LIMIT_UNSUPPORTED", "a token limit needs a tokenizer");
  }
  const surface = createAffordancePort({
    clock: () => capture.record.observedAt, mintId: mintIdFactory(horizon, id), projectId, store,
  }).readSurface();
  if (surface.outcome !== "SURFACE") return sourced("affordance surface", surface);
  const journal = readCurrentAttemptJournal(store, bound.activationDigest, projectId);
  if (!journal.ok && journal.code !== "JOURNAL_RECORD_ABSENT") {
    return sourced("attempt journal", journal);
  }
  if (journal.ok) {
    if (journal.nodeKey !== nodeKey || journal.sessionId !== sessionId
      || journal.attemptRef !== attemptRef) return mismatch("journal binds another attempt");
    keep(JOURNAL_ITEM_ID, "journal", {
      activationDigest: journal.activationDigest, attemptRef: journal.attemptRef,
      authority: journal.authority, effectId: journal.effectId, entries: journal.entries,
      journalDigest: journal.journalDigest, leaseRef: journal.leaseRef, nodeKey: journal.nodeKey,
      sessionId: journal.sessionId,
    }, 200);
  } else exclusions.push({ itemId: JOURNAL_ITEM_ID, reason: "JOURNAL_RECORD_ABSENT" });
  const review = readReviewLedger(store, projectId, nodeKey);
  if (review.unreadable) {
    return refuse("FOUNDATION_CONTEXT_FINDINGS_UNREADABLE", "a review decision did not parse");
  }
  const { digest, highestRound, records, unsuccessfulRounds } = review.lineage;
  if (records.length === 0) {
    exclusions.push({ itemId: FINDINGS_ITEM_ID, reason: "NO_DURABLE_REVIEW_FINDINGS" });
  } else {
    keep(FINDINGS_ITEM_ID, "findings", { digest, highestRound, records, unsuccessfulRounds }, 100);
  }
  keep("foundation.objective", "objective", { matrixVersion: FOUNDATION_CONTEXT_MATRIX_VERSION,
    nodeKey, objective: def.objective });
  keep("foundation.criteria", "criteria", { contract: criteria.contract,
    criteriaDigest: criteria.criteriaDigest, criteriaRef: criteria.criteriaRef,
    runId: criteria.runId });
  keep("foundation.policy", "policy", { constraints: def.constraints,
    policyRevision: graph.content.policyRevision, policySliceHash: def.policySliceHash });
  keep("foundation.graph", "graph", { goalRef, graphContentHash: graph.graphContentHash,
    graphEpoch: graph.graphEpoch, planHash: graph.planHash, revisionId: graph.revisionId,
    snapshotIdentity: graph.snapshotIdentity });
  keep("foundation.approved-plan", "plan", { authorityRef: plan.authorityRef,
    graphRevisionRef: plan.graphRevisionRef, planHash: plan.planHash, revision: plan.revision,
    revisionId: plan.revisionId, runId: plan.runId });
  keep("foundation.node-closure", "node-authority",
    { definition: def, nodeAuthorityHash: node.nodeAuthorityHash });
  keep("foundation.input-tree", "input", inputManifest);
  keep("foundation.activation", "authority", { activationDigest: bound.activationDigest,
    attemptRef: bound.attemptId, effectIntentId: bound.effectIntentId, epoch: bound.epoch,
    leaseAuthorityHashRef: lease.authorityHashRef, leaseKind: lease.kind, leaseRef: lease.leaseId,
    leaseState: lease.state, leaseVersion: lease.version, ownerSessionRef: bound.ownerSessionRef,
    providerDimension: slot.dimension, providerSlotRef: slot.slotRef,
    providerSlotState: slot.state, serverWallDeadline: lease.serverWallDeadline });
  keep("foundation.workspace-scope", "scope", { baseRevisionHash: cat.baseRevisionHash,
    catalogDigest: cat.catalogDigest, declaredPaths: cat.declaredPaths,
    observationDigest: observation.sha256, readScopes: def.readScopes,
    repositoryRef: cat.repositoryRef, scopeRef: cat.scopeRef,
    worktreeIdentity: observation.worktreeIdentity, worktreePath: assignment.worktreePath });
  keep("foundation.budget-coverage", "budget", { aggregateId: budget.aggregateId,
    binding: budget.binding, headVersion: budget.headVersion, meters: budget.meters });
  keep("foundation.legal-next-commands", "commands",
    { nextAllowedCommands: surface.nextAllowedCommands });
  if (failed !== null) return refuse("FOUNDATION_CONTEXT_ITEM_ENCODING_FAILED", failed);
  return {
    bytes: limit.bytes, exclusions, journalDigest: journal.ok ? journal.journalDigest : null,
    mandatory, manifestSha256: inputManifest.sha256, optional,
    revision: { epoch: graph.graphEpoch, hash: graph.graphContentHash, id: graph.revisionId },
  };
}
