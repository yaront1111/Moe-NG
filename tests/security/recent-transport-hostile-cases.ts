import {
  BUDGET_COMMITMENT_INVALID_RESPONSE_CODE,
  LIVE_BUDGET_COMMITMENT_LAYER,
  mapBudgetCommitmentAnswer,
} from "../../apps/control-room/src/live/live-budget-commitment.js";
import {
  APPROVAL_COMMAND_KIND,
  PLAN_APPROVAL_BUILD_LAYER,
  PLAN_APPROVAL_LAYER,
  PLAN_APPROVAL_TRANSPORT_LAYER,
  authorizeApproval,
  createPlanApprovalPort,
} from "../../apps/control-room/src/v2/goals/plan-approval.js";
import type {
  ApprovalGrant,
  PlanApprovalWire,
} from "../../apps/control-room/src/v2/goals/plan-approval.js";
import {
  PAIRING_OPEN_LAYER,
  createPairingOpenCompletion,
} from "../../apps/daemon/src/http/pairing-open-completion.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";
import type { HostileCase } from "./transport-hostile-cases.js";
import { BOUND } from "./transport-hostile-fixtures.js";

const grant: ApprovalGrant = Object.freeze({ affordance: Object.freeze({}), runId: "run-1" });

const buildRefusal = async (): Promise<unknown> => createPlanApprovalPort({
  client: { commands: { [APPROVAL_COMMAND_KIND]: () => ({
    error: { code: "APPROVAL_COMMAND_BUILD_REFUSED" }, ok: false,
  }) } },
  sessionCredential: "session-credential",
  transport: { sendCommand: async () => ({ delivered: true, response: {} }) },
} as unknown as PlanApprovalWire).submit(grant);

const transportRefusal = async (): Promise<unknown> => createPlanApprovalPort({
  client: { commands: { [APPROVAL_COMMAND_KIND]: () => ({
    envelope: { commandId: "approval-command-1" }, ok: true,
  }) } },
  sessionCredential: "session-credential",
  transport: { sendCommand: async () => ({
    code: "APPROVAL_TRANSPORT_REFUSED", delivered: false,
  }) },
} as unknown as PlanApprovalWire).submit(grant);

const pairingRefusal = (): unknown => createPairingOpenCompletion({
  openSession: () => { throw new Error("invalid bytes reached pairing authority"); },
}).complete(new Uint8Array());

const casesFor = (
  boundary: string,
  expected: RefusalExpectation,
  hostile: () => unknown | Promise<unknown>,
): readonly HostileCase[] => Object.freeze([
  {
    arm: "BEFORE", boundary, expected,
    name: "hostile input is refused before it can mint authority",
    run: async () => (await probeBefore(
      BOUND, async () => hostile(), async () => hostile(),
    )).probe,
  },
  {
    arm: "AFTER", boundary, expected,
    name: "a repeated hostile input remains refused after a prior observation",
    run: async () => (await probeAfter(
      BOUND, async () => hostile(), async () => hostile(),
    )).probe,
  },
  {
    arm: "RACE", boundary, expected: { left: expected, right: expected },
    name: "two hostile callers racing are both refused",
    run: async () => probeRacing(BOUND, async () => hostile(), async () => hostile()),
  },
]);

export const RECENT_TRANSPORT_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  ...casesFor(
    "LIVE_BUDGET_COMMITMENT_LAYER",
    { code: BUDGET_COMMITMENT_INVALID_RESPONSE_CODE, layer: LIVE_BUDGET_COMMITMENT_LAYER },
    () => mapBudgetCommitmentAnswer(200, null),
  ),
  ...casesFor(
    "PLAN_APPROVAL_LAYER",
    { code: "APPROVAL_SURFACE_UNREAD", layer: PLAN_APPROVAL_LAYER },
    () => authorizeApproval(null, "run-1"),
  ),
  ...casesFor(
    "PLAN_APPROVAL_BUILD_LAYER",
    { code: "APPROVAL_COMMAND_BUILD_REFUSED", layer: PLAN_APPROVAL_BUILD_LAYER },
    buildRefusal,
  ),
  ...casesFor(
    "PLAN_APPROVAL_TRANSPORT_LAYER",
    { code: "APPROVAL_TRANSPORT_REFUSED", layer: PLAN_APPROVAL_TRANSPORT_LAYER },
    transportRefusal,
  ),
  ...casesFor(
    "PAIRING_OPEN_LAYER",
    { code: "PAIRING_OPEN_REQUEST_INVALID", layer: PAIRING_OPEN_LAYER },
    pairingRefusal,
  ),
]);
