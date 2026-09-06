import { decodeBoundedJsonBytes } from "@moe/contracts";
import { DurableStoreError } from "@moe/store";
import type { EventDraft, SqliteEventStore } from "@moe/store";

import { decisionsOf } from "../decision-ledger-memo.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { DurableDecision } from "../http/http-contract.js";
import {
  PREVIEW_DECIDE_COMMAND_KIND, PREVIEW_DECISIONS, PREVIEW_FINDING_KEYS, boundedPreviewText,
  decodePreviewDecidePayload, exactPreviewRecord, previewRefusal,
} from "./preview-contracts.js";
import type { PreviewDecision, PreviewFinding, PreviewRefusal } from "./preview-contracts.js";
import { readGoalLandingStatus } from "./preview-goal-landing.js";
import { readPreviewReceipt } from "./preview-ledger.js";
import {
  PREVIEW_RECEIPT_COMMAND_KIND, PREVIEW_RUNNER_PRINCIPAL_ID, previewAggregateId,
} from "./preview-receipt-contracts.js";
import type { PreviewReceiptV1 } from "./preview-receipt-contracts.js";
import { createPreviewSupervisor } from "./preview-supervisor.js";
import type { PreviewSupervisor } from "./preview-supervisor.js";
import type { PreviewRunnerConfig } from "./preview-runner.js";

/**
 * THE DAEMON'S EDGES INTO THE LANDED PREVIEW RUNNER: the port the daemon holds, the receipt fact
 * the affordance surface offers off, and the `preview.decide` command edge itself.
 *
 * COMPOSITION, NOT BEHAVIOUR. `preview-supervisor`, `preview-ledger` and `preview-goal-landing`
 * are landed and green; nothing here re-decides what they decide. This module exists because
 * `daemon-command-registry.ts` is already past the 400-line split threshold and because the
 * decide path needs an ORDER OF GATES a registry branch cannot state legibly. That order is the
 * runner's own (preview-runner.ts), read back off the durable record rather than re-derived, and
 * each gate is named at its own site below: the decoder (PREVIEW_DECISION_INVALID @ REQUEST),
 * the receipt (PREVIEW_GOAL_NOT_LANDED @ GOAL_AUTHORITY), the receipt's OWN refusal code
 * UNRESTAMPED, the landing, the findings' node refs, then the wired port (PREVIEW_COMMAND_MISSING
 * @ RUNNER — an unwired daemon FAILS CLOSED rather than committing a verdict nothing can act on).
 *
 * EVERY REFUSAL IS MINTED THROUGH `previewRefusal`, which takes NO layer: `PREVIEW_CODE_LAYERS`
 * decides, so no call site here can pair a code with a layer that contradicts the vocabulary.
 * The one refusal that is not a preview code is a FENCED commit, which travels back as the
 * store's own EXPECTED_VERSION_CONFLICT @ DURABLE_STORE (an existing rostered layer,
 * bootstrap-ledger-vocabulary.ts:39) — the vocabulary has no conflict code and inventing a fifth
 * spelling of one is exactly what the closed map exists to prevent.
 *
 * WHY THE DECISION TARGETS `preview:<goalId>` AND NEVER THE GOAL. `readDurableLedger` keys
 * aggregates by `targetAggregateId` and keeps the LAST committed decision's result, so a decide
 * committed on the bare goal aggregate would overwrite the goal's own durable state — and
 * `durableGoals` requires `state.goalId === aggregateId`, so the goal would disappear from the
 * whole affordance surface after one decide. `repository.publish` takes `publish:<goalId>` for
 * the same reason, stated at affordance-planning-offers.ts:181.
 *
 * WHY THE PROCESS STOP IS BEST-EFFORT AND THE RECORD IS NOT. `CommandHandler` is synchronous
 * (http-contract.ts:197) and `supervisor.decide` is not, so the decision is committed and THEN
 * the stop is requested. `stopPreview` never throws, `stop()` is memoised per handle and
 * `close()` sweeps every straggler at shutdown, so a stop that loses a race is still run once.
 */

const encoder = new TextEncoder();
const RECEIPT_LEDGER_PAGE_SIZE = 512;

/** What a decided preview leaves behind: the operator's verdict, and what to rework. */
export const PREVIEW_DECIDE_RESULT_CODE = "PREVIEW_DECISION_RECORDED" as const;
export const PREVIEW_DECISION_VERSION = "moe-preview-decision/1" as const;

const PREVIEW_DECISION_KEYS = Object.freeze([
  "decidedAt", "decision", "findings", "goalId", "previewRef", "projectId", "sha", "version",
] as const);

export interface PreviewDecisionRecord {
  readonly decidedAt: string;
  readonly decision: PreviewDecision;
  /** Empty for APPROVE. For REJECT, every element names a node of the goal's active graph. */
  readonly findings: readonly PreviewFinding[];
  readonly goalId: string;
  readonly previewRef: string;
  readonly projectId: string;
  readonly sha: string;
  readonly version: typeof PREVIEW_DECISION_VERSION;
}

/** The receipt state a goal is in, as the offer surface asks about it. */
export type PreviewReceiptState = PreviewReceiptV1["outcome"];

/** The half of the supervisor the daemon holds. NARROW on purpose: the edge may stop a decided
 *  preview and the entry may sweep every live one, and neither may START one — starting is an
 *  async command's act (task-dbc79d25), which takes `supervisor` off the runtime below. */
export interface PreviewDaemonPort {
  /** Daemon shutdown: stops every live preview and refuses to start any more. */
  readonly close: () => Promise<void>;
  /** The decided preview no longer needs its server. Best-effort and idempotent by contract. */
  readonly release: (receiptId: string, decision: PreviewDecision) => void;
}

export interface PreviewDaemonRuntime extends PreviewDaemonPort {
  readonly supervisor: PreviewSupervisor;
}

/** ONE supervisor per daemon. Two instances would each hold half the live roster, so shutdown
 *  would sweep one and the other's servers would keep their ports after the daemon was gone. */
export function createPreviewDaemonPort(config: PreviewRunnerConfig): PreviewDaemonRuntime {
  const supervisor = createPreviewSupervisor(config);
  return Object.freeze({
    close: (): Promise<void> => supervisor.close(),
    // Deliberately not awaited (see the header): a rejection on a path the operator has already
    // been answered on is swallowed the same way `stopPreview` swallows its own.
    release: (receiptId: string, decision: PreviewDecision): void => {
      void supervisor.decide(receiptId, decision).catch(() => undefined);
    },
    supervisor,
  });
}

/**
 * The goal->receipt-state fact, resolved from the runner's OWN committed receipts and re-read
 * through `readPreviewReceipt`, so the offer surface and the decide edge share one authority.
 * ONE LEDGER WALK, SHARED: built on the FIRST goal that asks and reused for the rest, matching
 * `landedCommit`'s discipline on the affordance hot path — a poll over many goals must not pay a
 * ledger read per goal (the 2026-09-05 incident). Built per READER, never cached across reads,
 * so a receipt written between two polls appears on the next one.
 */
export function createPreviewReceiptReader(
  store: SqliteEventStore, projectId: string,
): (goalId: string) => PreviewReceiptState | null {
  let states: Map<string, PreviewReceiptState> | null = null;
  return (goalId: string): PreviewReceiptState | null => {
    if (states === null) {
      states = new Map<string, PreviewReceiptState>();
      for (const decision of decisionsOf(store, RECEIPT_LEDGER_PAGE_SIZE)) {
        if (decision.commandKind !== PREVIEW_RECEIPT_COMMAND_KIND
          || decision.effectDisposition !== "EFFECTS_COMMITTED"
          || decision.key.projectId !== projectId
          || decision.key.principalId !== PREVIEW_RUNNER_PRINCIPAL_ID) continue;
        // Re-READ, never decoded here: `readPreviewReceipt` re-validates principal, kind, project
        // and aggregate, so a record written under another identity can never be reported as
        // this goal's state. A later receipt wins, so the state follows the newest revision.
        const read = readPreviewReceipt(store, projectId, decision.key.commandId);
        if (read.ok) states.set(read.receipt.goalId, read.receipt.outcome);
      }
    }
    return states.get(goalId) ?? null;
  };
}

/** One finding as the STORE holds it, refused rather than read around when it does not decode. */
function persistedFinding(value: unknown): PreviewFinding | null {
  const item = exactPreviewRecord(value, PREVIEW_FINDING_KEYS);
  if (item === null || !PREVIEW_FINDING_KEYS.every((key) => boundedPreviewText(item[key]))) {
    return null;
  }
  return Object.freeze({ detail: item["detail"] as string, nodeRef: item["nodeRef"] as string });
}

/** THE PRODUCTION READ of a committed preview decision: the operator's verdict and the roster
 *  they named, re-validated against the record carrying them. `/activity/read` reports the
 *  VERDICT for this kind (activity-read.ts VERDICT_KINDS); the findings live here, because an
 *  activity entry states a decision's facts and carries no payload. */
export function readPreviewDecision(
  store: SqliteEventStore, projectId: string, principalId: string, commandId: string,
): PreviewDecisionRecord | null {
  let decision;
  try {
    decision = store.getCommandDecision({ commandId, principalId, projectId });
  } catch { return null; }
  if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== PREVIEW_DECIDE_COMMAND_KIND) return null;
  const decoded = decodeBoundedJsonBytes(decision.resultBytes);
  if (!decoded.ok) return null;
  const record = exactPreviewRecord(decoded.value, PREVIEW_DECISION_KEYS);
  const verdict = PREVIEW_DECISIONS.find((one) => one === record?.["decision"]);
  if (record === null || verdict === undefined || !Array.isArray(record["findings"])
    || record["version"] !== PREVIEW_DECISION_VERSION || record["projectId"] !== projectId
    || !["decidedAt", "goalId", "previewRef", "sha"].every((k) => boundedPreviewText(record[k]))) {
    return null;
  }
  const findings = (record["findings"] as readonly unknown[]).map(persistedFinding);
  if (findings.some((finding) => finding === null)) return null;
  return Object.freeze({
    decidedAt: record["decidedAt"] as string,
    decision: verdict,
    findings: Object.freeze(findings as readonly PreviewFinding[]),
    goalId: record["goalId"] as string,
    previewRef: record["previewRef"] as string,
    projectId,
    sha: record["sha"] as string,
    version: PREVIEW_DECISION_VERSION,
  });
}

/** Exactly the envelope fields this edge reads; a field it cannot see it cannot let a caller forge. */
export interface PreviewDecideEdgeEnvelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly expectedVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PreviewDecideEdgeContext {
  readonly envelope: PreviewDecideEdgeEnvelope;
  readonly now: () => string;
  /** ABSENT is a REFUSING state, never a skipped one: an unwired daemon fails closed. */
  readonly port?: PreviewDaemonPort | undefined;
  /** The AUTHENTICATED principal's id. Never read from the payload. */
  readonly principalId: string;
  /** The AUTHENTICATED principal's project. Never read from the payload. */
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

function refuse(refusal: PreviewRefusal): never {
  throw new DomainRefusal(
    refusal.code,
    refusal.layer,
    refusal.sourceCode === null
      ? `preview.decide refused: ${refusal.code}`
      : `preview.decide refused: ${refusal.code} (${refusal.sourceLayer}/${refusal.sourceCode})`,
  );
}

/** Serve one `preview.decide`. See the header for why the gates run in this order. */
export function runPreviewDecideEdge(context: PreviewDecideEdgeContext): DurableDecision {
  const { envelope, principalId, projectId, store } = context;
  const decoded = decodePreviewDecidePayload(envelope.payload);
  if (!decoded.ok) refuse(decoded);
  const { payload } = decoded;

  const read = readPreviewReceipt(store, projectId, payload.previewRef);
  // An absent receipt and an unreadable one are the same fact to an operator: there is no
  // preview here to judge. The ledger's own code travels along as the SOURCE, unrestamped.
  if (!read.ok) refuse(previewRefusal("PREVIEW_GOAL_NOT_LANDED", read.code, "DURABLE_STORE"));
  const receipt = read.receipt;
  // A REFUSED receipt refuses, FULL STOP — the `?? ` is not a fallback to be reasoned around.
  // The decoder makes outcome and code an equivalence, so a REFUSED receipt without a code
  // cannot be read back; if one ever were, letting it fall through to the gates below could
  // COMMIT a verdict on a preview that never served. It refuses at GOAL_AUTHORITY instead.
  if (receipt.outcome === "REFUSED") {
    refuse(previewRefusal(receipt.code ?? "PREVIEW_GOAL_NOT_LANDED"));
  }

  const landing = readGoalLandingStatus(store, projectId, receipt.goalId);
  if (!landing.allLanded) refuse(previewRefusal("PREVIEW_GOAL_NOT_LANDED"));

  const findings = payload.decision === "REJECT" ? payload.findings : Object.freeze([]);
  const nodes = new Set(landing.nodes);
  if (findings.some((finding) => !nodes.has(finding.nodeRef))) {
    refuse(previewRefusal("PREVIEW_DECISION_INVALID"));
  }

  const port = context.port;
  if (port === undefined) refuse(previewRefusal("PREVIEW_COMMAND_MISSING"));

  const decidedAt = context.now();
  const record: PreviewDecisionRecord = Object.freeze({
    decidedAt,
    decision: payload.decision,
    findings,
    goalId: receipt.goalId,
    previewRef: receipt.receiptId,
    projectId,
    sha: receipt.sha,
    version: PREVIEW_DECISION_VERSION,
  });
  const resultBytes = encoder.encode(JSON.stringify(record));
  const event: EventDraft = {
    eventId: `${envelope.commandId}-PreviewDecided`,
    eventType: payload.decision === "APPROVE" ? "PreviewApproved" : "PreviewRejected",
    payload: encoder.encode(JSON.stringify({
      decision: record.decision, findings: findings.length, goalId: record.goalId,
      previewRef: record.previewRef, sha: record.sha,
    })),
  };
  let response;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: PREVIEW_DECIDE_COMMAND_KIND,
      committedResultBytes: resultBytes,
      correlationId: envelope.correlationId,
      decidedAt,
      events: [event],
      expectedVersion: envelope.expectedVersion,
      key: { commandId: envelope.commandId, principalId, projectId },
      requestBytes: encoder.encode(JSON.stringify({
        decision: record.decision, previewRef: record.previewRef,
      })),
      targetAggregateId: previewAggregateId(receipt.goalId),
    });
  } catch (error) {
    // The STORE's own code and layer, forwarded UNRESTAMPED. No fifth preview code is minted for
    // a condition the preview vocabulary does not own (its map is closed at four), and a throw
    // that is not a DurableStoreError is not this slice's to classify either -- it travels on
    // unchanged rather than being relabelled as something the operator could act on.
    if (!(error instanceof DurableStoreError)) throw error;
    throw new DomainRefusal(error.code, "DURABLE_STORE", "preview.decide could not be recorded");
  }
  // A FENCED decision is RETURNED, not thrown. Reading "it did not throw" as success is how a
  // second decide would be reported as recorded while history was never extended.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new DomainRefusal(
      "EXPECTED_VERSION_CONFLICT",
      "DURABLE_STORE",
      `preview.decide was fenced: ${response.decision.resultCode}`,
    );
  }
  // AFTER the record, never before: a stop that preceded a fenced commit would take down a
  // preview whose decision never landed.
  port.release(receipt.receiptId, payload.decision);
  return Object.freeze({
    commandId: envelope.commandId,
    disposition: "DECIDED" as const,
    effectId: null,
    resultCode: PREVIEW_DECIDE_RESULT_CODE,
  });
}
