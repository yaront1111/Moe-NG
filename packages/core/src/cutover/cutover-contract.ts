/**
 * CutoverAttempt contract: the aggregate's states, its own command roster, its witnesses,
 * and the transition table (design section 21.12, aggregate at design :243).
 *
 * SCOPE FENCE — THIS ROSTER IS INTERNAL. `CUTOVER_COMMAND_KINDS` is this reducer's own
 * domain vocabulary and is deliberately NOT added to `RUNTIME_COMMAND_KINDS`, exactly as
 * `GOAL_COMMAND_KINDS` carries `goal.activate_initial_graph`, `goal.advance_graph_epoch`
 * and `goal.qualification_invalidated` without them being wire commands. The four wire
 * names (`cutover.preview`, `cutover.quiesce`, `cutover.activate`, `cutover.abort`) already
 * exist in the frozen runtime vocabulary as NAMES ONLY; this module reads the CUTOVER
 * lifecycle tuple and writes no vocabulary. Wiring a wire kind fans out to generated
 * clients, MCP schemas and digest mirrors and belongs to the daemon handler row
 * (task-b254847909ca4199a70a3a06173f1cd9), not here.
 *
 * The wire `cutover.quiesce` spans QUIESCE_APPROVED -> QUIESCING -> QUIESCED in one act
 * (design :1288). This reducer splits that run into three separately admissible edges so
 * each is individually refusable; the state ORDER and the terminal rules are the design's.
 */
import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { RuntimeError, RuntimeTruthClass } from "@moe/contracts";

/** Derived from the frozen vocabulary, never hand-written: a second roster would drift. */
export type CutoverState = typeof RUNTIME_LIFECYCLES.CUTOVER[number];

export const CUTOVER_COMMAND_KINDS = Object.freeze([
  "cutover.preview",
  "cutover.admit_quiesce_approval",
  "cutover.begin_quiesce",
  "cutover.complete_quiesce",
  "cutover.verify_import",
  "cutover.admit_activate_approval",
  "cutover.activate",
  "cutover.abort",
] as const);

export type CutoverCommandKind = (typeof CUTOVER_COMMAND_KINDS)[number];

/**
 * The edge table: command kind -> the source states that admit it. `cutover.preview` is the
 * creation command and admits NO prior state, so its list is empty. ACTIVE and ABORTED are
 * terminal and appear as the source of no edge — design :1289-1290 promises no rollback once
 * the first v2 authoritative command may run, so an abort edge out of ACTIVE would encode a
 * guarantee the system cannot keep.
 */
export const CUTOVER_TRANSITIONS = Object.freeze({
  "cutover.preview": Object.freeze([]),
  "cutover.admit_quiesce_approval": Object.freeze(["PREVIEWED"]),
  "cutover.begin_quiesce": Object.freeze(["QUIESCE_APPROVED"]),
  "cutover.complete_quiesce": Object.freeze(["QUIESCING"]),
  "cutover.verify_import": Object.freeze(["QUIESCED"]),
  "cutover.admit_activate_approval": Object.freeze(["IMPORT_VERIFIED"]),
  "cutover.activate": Object.freeze(["ACTIVATE_APPROVED"]),
  "cutover.abort": Object.freeze([
    "PREVIEWED", "QUIESCE_APPROVED", "QUIESCING", "QUIESCED", "IMPORT_VERIFIED",
    "ACTIVATE_APPROVED",
  ]),
} as const satisfies Readonly<Record<CutoverCommandKind, readonly CutoverState[]>>);

/** The state each command lands in when admitted. */
export const CUTOVER_TARGET_STATES = Object.freeze({
  "cutover.preview": "PREVIEWED",
  "cutover.admit_quiesce_approval": "QUIESCE_APPROVED",
  "cutover.begin_quiesce": "QUIESCING",
  "cutover.complete_quiesce": "QUIESCED",
  "cutover.verify_import": "IMPORT_VERIFIED",
  "cutover.admit_activate_approval": "ACTIVATE_APPROVED",
  "cutover.activate": "ACTIVE",
  "cutover.abort": "ABORTED",
} as const satisfies Readonly<Record<CutoverCommandKind, CutoverState>>);

/** No command leaves either of these. Derived by the reducer, asserted by its arms. */
export const CUTOVER_TERMINAL_STATES = Object.freeze(["ACTIVE", "ABORTED"] as const);

interface CutoverCommandBase {
  readonly commandId: string;
  readonly expectedVersion: number;
}

export interface CutoverSourceInventoryWitness {
  readonly inventoryRef: string;
  readonly truthClass: RuntimeTruthClass;
}

/**
 * An ALREADY-DECIDED step-up decision, carried opaquely. Admitting the decision is the
 * handler row's job: this reducer never validates a human grant and never reimplements
 * `admitActivationBinding` or `checkHumanAuthority`.
 */
export interface CutoverApprovalWitness {
  readonly approvalRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface CutoverQuiesceProofWitness {
  readonly identicalManifestRef: string;
  readonly truthClass: RuntimeTruthClass;
  readonly writeLockRef: string;
}

export interface CutoverImportVerificationWitness {
  readonly importHeadRef: string;
  readonly restoreDrillRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface CutoverAbortWitness {
  readonly legacyUnfrozenRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface CutoverPreviewCommand extends CutoverCommandBase {
  readonly attemptId: string;
  readonly kind: "cutover.preview";
  readonly sourceManifestRef: string;
  readonly witness: CutoverSourceInventoryWitness;
}

export interface CutoverAdmitQuiesceApprovalCommand extends CutoverCommandBase {
  readonly kind: "cutover.admit_quiesce_approval";
  readonly witness: CutoverApprovalWitness;
}

export interface CutoverBeginQuiesceCommand extends CutoverCommandBase {
  readonly kind: "cutover.begin_quiesce";
}

export interface CutoverCompleteQuiesceCommand extends CutoverCommandBase {
  readonly kind: "cutover.complete_quiesce";
  readonly witness: CutoverQuiesceProofWitness;
}

export interface CutoverVerifyImportCommand extends CutoverCommandBase {
  readonly kind: "cutover.verify_import";
  readonly witness: CutoverImportVerificationWitness;
}

export interface CutoverAdmitActivateApprovalCommand extends CutoverCommandBase {
  readonly kind: "cutover.admit_activate_approval";
  readonly witness: CutoverApprovalWitness;
}

export interface CutoverActivateCommand extends CutoverCommandBase {
  readonly kind: "cutover.activate";
}

export interface CutoverAbortCommand extends CutoverCommandBase {
  readonly kind: "cutover.abort";
  readonly witness: CutoverAbortWitness;
}

export type CutoverCommand =
  | CutoverPreviewCommand
  | CutoverAdmitQuiesceApprovalCommand
  | CutoverBeginQuiesceCommand
  | CutoverCompleteQuiesceCommand
  | CutoverVerifyImportCommand
  | CutoverAdmitActivateApprovalCommand
  | CutoverActivateCommand
  | CutoverAbortCommand;

export interface CutoverAttemptState {
  readonly activateApprovalRef: string | null;
  readonly attemptId: string;
  readonly importHeadRef: string | null;
  readonly lifecycle: CutoverState;
  readonly quiesceApprovalRef: string | null;
  readonly sourceManifestRef: string;
  readonly version: number;
}

export interface CutoverAttemptEvent {
  readonly commandId: string;
  readonly commandKind: CutoverCommandKind;
  readonly kind: "CutoverAttemptPreviewed" | "CutoverAttemptAdvanced" | "CutoverAttemptAborted";
  readonly lifecycle: CutoverState;
  readonly version: number;
}

export interface CutoverAcceptedResult {
  readonly events: readonly CutoverAttemptEvent[];
  readonly ok: true;
  readonly state: CutoverAttemptState;
}

/** `layer` names the refusing layer, because `RuntimeError` cannot carry it. */
export interface CutoverRejectedResult {
  readonly error: RuntimeError;
  readonly layer: "CUTOVER";
  readonly ok: false;
}

export type CutoverReducerResult = CutoverAcceptedResult | CutoverRejectedResult;
