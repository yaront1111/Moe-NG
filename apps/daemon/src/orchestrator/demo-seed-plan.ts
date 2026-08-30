import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";

/**
 * The demo bootstrap's PURE half: the J1 envelope sequence.
 *
 * The wire-refusal echo lives beside it in `demo-seed-refusal.ts`.
 *
 * Zero IO, no clock, no randomness — every identity arrives as an input, so two
 * builds over the same input are byte-identical and the seed is replayable.
 *
 * The PAYLOADS mirror `bootstrap-test-fixtures.ts` (the durable pipeline's own
 * inputs) but this module imports nothing from it: a production bin that reached
 * into a test fixture would ship the fixture. The ENVELOPE is deliberately NOT the
 * fixture's: the fixture drives `runBootstrapCommand` directly, while `POST /command`
 * takes the runtime envelope (`moe-runtime-command/1`) and the daemon assembles the
 * internal request itself — projectId, principalId, decidedAt and the bootstrap schema
 * are server facts a payload may not carry. A seed that shipped the fixture envelope is
 * refused `SCHEMA_VERSION_UNSUPPORTED` at DECODE; measured against a live daemon. The
 * ORDER is not a copy either — it
 * satisfies `COMMAND_PREREQUISITES` in `bootstrap-sequence.ts`, which is why
 * `provider.probe` is here: `project.activate` names it as a prerequisite, so the
 * shorter register/bind/activate chain a human might write is refused. Probe rides
 * its own `${projectId}-provider` stream, so it never disturbs the project's
 * 0 -> 1 -> 2 version choreography.
 */

export interface DemoNodeSpec {
  readonly instructions: string;
  readonly nodeRef: string;
  readonly test: string;
  readonly title: string;
  readonly workspace: string;
}

export interface DemoSeedInput {
  /**
   * The approval's decide-time budget COMMITMENT, or `null` when the caller holds none yet. It is
   * `budgetCommitmentDigest(budgetCommitmentMaterial(...))` over material this plan's own finalize
   * terminal makes durable, so a caller who has not driven the plan CANNOT have one. `null` then
   * omits `approval.decide` rather than spelling a placeholder the bind-back refuses
   * (BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH) — a CAPABILITY omission, `stopBeforeApproval` a POLICY.
   */
  readonly budgetRef: string | null;
  readonly correlationId: string;
  /** Stamped on every envelope: the caller's clock reading, never this module's. */
  readonly decidedAt: string;
  readonly goalId: string;
  /** The operator-facing goal identity; absent falls back to the demo spelling. */
  readonly goalInstructions?: string | undefined;
  readonly goalTitle?: string | undefined;
  readonly node: DemoNodeSpec;
  readonly principalId: string;
  readonly projectId: string;
  readonly runId: string;
  /**
   * Ends the plan at the finalize terminal, leaving `approval.decide` pending
   * for the live board. The seed authenticates with the OPERATOR credential, so its own
   * approval dispatch counts as the human review — a chain that should wait for
   * a click on the board must therefore never send that command at all.
   */
  readonly stopBeforeApproval?: boolean;
}

/**
 * One command as the seed plans it: everything the wire envelope needs EXCEPT the
 * secret and the digest, so the plan can be built, printed and compared without a
 * credential anywhere near it.
 */
export interface SeedCommand {
  readonly commandId: string;
  readonly commandKind: string;
  readonly correlationId: string;
  readonly expectedVersion: number;
  readonly payload: Record<string, unknown>;
  readonly targetAggregateId: string;
}

/** The runtime envelope `POST /command` decodes. */
export interface SeedEnvelope extends SeedCommand {
  readonly requestDigest: string;
  readonly schemaVersion: typeof RUNTIME_COMMAND_ENVELOPE_VERSION;
  readonly sessionCredential: string;
}

/** The order the daemon's prerequisite table admits, pinned for the caller to print. */
export const DEMO_SEED_KINDS = Object.freeze([
  "project.register",
  "project.bind_repository",
  "provider.probe",
  "project.activate",
  // Three times, and before goal.create. The first two are the slices the daemon-side verifier
  // reads: without them `createVerifierAuthorityProvider` returns null and
  // `readReviewerCalibration` refuses REVIEWER_CALIBRATION_NOT_INSTALLED, so node-verifier.ts
  // reports VERIFICATION_AUTHORITY_UNAVAILABLE before any test runs and no seeded node can reach
  // COMMITTED. The third is the VALIDATABLE slice at the 64-hex address the development payload
  // hint names: the seeded surface offers `policy.validate` as a READY step, and without an
  // installed nameable revision that step is unsatisfiable by construction (the other two live
  // at non-hex addresses on purpose). `policy.install` names no prerequisite and rides the
  // project's `-policy` stream, so their position is free and their versions are their own.
  "policy.install",
  "policy.install",
  "policy.install",
  "goal.create",
  "plan.propose",
  // Twice: the proposal, then the finalize terminal. They may not share one chain -
  // `classifyPlanningChain` refuses that pairing with PLANNING_FINALIZE_CHAIN_MIXED - so the
  // seed finalizes in a request of its own, and the run reaches `approval.decide` at
  // lifecycle PLAN_REVIEW rather than PLANNING.
  "plan.propose",
  "approval.decide",
] as const);

import {
  activationWitness,
  approvalRecord,
  finalizeChain,
  planningActivation,
  planningChain,
  probeObservation,
  repositoryObservation,
  reviewerCalibrationSlice,
  validatablePolicySlice,
  verifierPolicySlice,
} from "./demo-seed-payloads.js";

/**
 * The aggregate this command targets. The bootstrap services derive their own
 * aggregate id from the request, so this is the envelope's honest statement of
 * intent rather than an instruction — probe and policy ride streams of their own
 * (bootstrap-sequence.ts aggregateIdFor), which is what keeps the probe out of the
 * project's version line.
 */
function targetOf(input: DemoSeedInput, kind: string): string {
  if (kind === "provider.probe") return `${input.projectId}-provider`;
  if (kind === "policy.install") return `${input.projectId}-policy`;
  if (kind === "goal.create") return input.goalId;
  if (kind === "plan.propose" || kind === "approval.decide") return input.runId;
  return input.projectId;
}

/**
 * `idSuffix` exists because the plan sends `policy.install` TWICE and the durable decision key is
 * (commandId, principalId, projectId): two installs under one id would make the second a REPLAY
 * of the first, so the second slice would never be written and the seed would still report
 * success. It is the caller's job to keep the suffix stable — a generated one would break replay.
 */
const GOAL_PREFIX = "goal-";

/**
 * Production mints the goal aggregate as `goal-${commandId}` and derives the goal's planning run
 * and budget account from THAT goal, so the seed names its create command after the configured
 * goal subject: it is the only way the seeded goal lands on the id the rest of the plan
 * (`plan.propose`, the activation and the approval) already points at. The shipped subjects keep
 * the `goal-X` / `run-X` pairing the derivation reproduces; a configuration that breaks that
 * pairing seeds a goal whose derived run is not the configured one.
 */
function goalCreateCommandId(goalId: string): string {
  return goalId.startsWith(GOAL_PREFIX) ? goalId.slice(GOAL_PREFIX.length) : goalId;
}

function frozenCommand(
  input: DemoSeedInput,
  commandKind: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
  idSuffix = "",
): SeedCommand {
  return Object.freeze({
    commandId: commandKind === "goal.create"
      ? goalCreateCommandId(input.goalId)
      : `demo-seed-${commandKind}${idSuffix}`,
    commandKind,
    correlationId: input.correlationId,
    expectedVersion,
    payload: Object.freeze(payload),
    targetAggregateId: targetOf(input, commandKind),
  });
}
export function buildDemoSeedPlan(input: DemoSeedInput): readonly SeedCommand[] {
  const build = (
    kind: string,
    expectedVersion: number,
    payload: Record<string, unknown>,
    idSuffix = "",
  ): SeedCommand => frozenCommand(input, kind, expectedVersion, payload, idSuffix);
  const plan = [
    build("project.register", 0, { owner: input.principalId }),
    build("project.bind_repository", 1, { observation: repositoryObservation(input) }),
    build("provider.probe", 0, { observation: probeObservation(input) }),
    build("project.activate", 2, { witness: activationWitness(input) }),
    // The policy stream's own 0 -> 1 -> 2 line; `installPolicy` refuses
    // BOOTSTRAP_EXPECTED_VERSION_STALE on anything else.
    build("policy.install", 0, { slice: verifierPolicySlice(input) }, "-verifier-policy"),
    build("policy.install", 1, { slice: reviewerCalibrationSlice(input) }, "-reviewer-calibration"),
    build("policy.install", 2, { slice: validatablePolicySlice() }, "-validatable-policy"),
    // PROSE ONLY. The goal, its planning run, its budget account and the readiness witness are
    // all derived by the daemon; naming any of them here is refused INPUT_INVALID at
    // PAYLOAD_SHAPE before the handler runs.
    build("goal.create", 0, {
      instructions: input.goalInstructions ?? `Seeded demo goal for ${input.node.nodeRef}.`,
      title: input.goalTitle ?? `Demo seed goal ${input.goalId}`,
    }),
    build("plan.propose", 0, { commands: planningChain(input), runId: input.runId }),
    // The seed FINALIZES before it approves. The finalize terminal may not share a chain with
    // `plan.propose` - `classifyPlanningChain` refuses that with PLANNING_FINALIZE_CHAIN_MIXED -
    // so it rides its own request, and the run reaches `approval.decide` at lifecycle
    // PLAN_REVIEW with a durable graphRevisionRef instead of the PLANNING state a propose-only
    // chain leaves behind.
    build("plan.propose", 0, { commands: finalizeChain(input), runId: input.runId }, "-finalize"),
  ];
  // PLANNED ONLY WHEN IT CAN BE ANSWERED HONESTLY: a spelled `budgetRef` is REFUSED at activation,
  // not ignored. `stopBeforeApproval` withholds it because the seed holds the OPERATOR credential.
  if (input.stopBeforeApproval !== true && input.budgetRef !== null) {
    plan.push(build("approval.decide", 0, {
      activation: planningActivation(input),
      command: {
        decision: "APPROVE",
        decisionReason: `seed approval for ${input.node.nodeRef}`,
        kind: "approval.decide",
        stepUpAuthRef: `${input.runId}-stepup`,
      },
      graphRevisionRef: `${input.runId}-graph-revision`,
      record: approvalRecord(input, input.budgetRef),
      runId: input.runId,
    }));
  }
  return Object.freeze(plan);
}

/**
 * Seals a planned command into the wire envelope. The digest covers the REQUEST —
 * ids, kind, version, payload, target — and deliberately not the credential: the
 * secret is not part of what was requested, and two operators sending the same
 * request must produce the same request identity.
 */
export function toWireEnvelope(command: SeedCommand, sessionCredential: string): SeedEnvelope {
  const requestDigest = createHash("sha256").update(JSON.stringify({
    commandId: command.commandId,
    commandKind: command.commandKind,
    correlationId: command.correlationId,
    expectedVersion: command.expectedVersion,
    payload: command.payload,
    targetAggregateId: command.targetAggregateId,
  }), "utf8").digest("hex");
  return Object.freeze({
    ...command,
    requestDigest,
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential,
  });
}
