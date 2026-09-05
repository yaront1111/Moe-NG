/**
 * THE WORLD AND THE IDENTITIES the multi-node journey needs before a goal can exist.
 *
 * Split from `multi-node-journey.ts` to keep both files under the per-file target. The cut is
 * by subject, not by size: everything here answers "what must already be true", while the
 * journey keeps "what this goal does". Nothing here reads a clock or a random source of its
 * own — the readings arrive as parameters, exactly as the shipped seed takes its `clock`.
 */
import { createHash } from "node:crypto";

import {
  createStoreDependencies,
} from "../../../apps/daemon/src/daemon-store-dependencies.js";
import {
  DEMO_VALIDATABLE_POLICY_REF,
} from "../../../apps/daemon/src/orchestrator/demo-seed-payloads.js";
import {
  buildDemoSeedPlan,
} from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";
import type { SeedCommand } from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";

import { GOAL_CREATE_COMMAND_ID, GOAL_ID, OMEGA } from "./multi-node-graph-harness.js";
import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import { type DaemonWire, command, send } from "./multi-node-wire.js";

export const CORRELATION_ID = "corr-multi-node-journey";
export const OPERATOR_PRINCIPAL = "operator-local";
const ALL_CAPABILITIES = Object.freeze([
  "goal.write", "planning.write", "project.admin", "review.write", "work.write",
]);

/** The caller's clock readings, never this module's. */
export interface JourneyClock {
  readonly nowIso: string;
  readonly nowMs: number;
}

/**
 * The world every journey needs, taken from the SHIPPED seed's own plan rather than restated
 * here — same commands, same order, same payloads.
 *
 * Sliced at `goal.create` BY KIND, never by index: this journey creates its goal with a SOURCE
 * (`goal.create_with_source`, which lands the same durable GoalCreated), and an index would
 * silently take the wrong prefix the day the seed grows a command.
 */
export function worldPrelude(
  scratch: MultiNodeScratch, clock: JourneyClock,
): readonly SeedCommand[] {
  const planned = buildDemoSeedPlan({
    budgetRef: null,
    correlationId: CORRELATION_ID,
    decidedAt: clock.nowIso,
    goalId: GOAL_ID,
    node: {
      instructions: "Create math.mjs exporting add and multiply so test.mjs passes.",
      nodeRef: OMEGA, test: "node test.mjs", title: `Implement ${OMEGA}`,
      workspace: scratch.workspace.replaceAll("\\", "/"),
    },
    principalId: OPERATOR_PRINCIPAL,
    projectId: scratch.projectId,
    runId: `run-${GOAL_CREATE_COMMAND_ID}`,
    stopBeforeApproval: true,
  });
  const goalAt = planned.findIndex((entry) => entry.commandKind === "goal.create");
  if (goalAt === -1) throw new Error("the shipped seed plan no longer contains goal.create");
  const prelude = planned.slice(0, goalAt);
  const activateAt = prelude.findIndex((entry) => entry.commandKind === "project.activate");
  if (activateAt === -1) throw new Error("the shipped seed plan no longer activates the project");
  return [
    ...prelude.slice(0, activateAt), policyValidate(scratch, prelude), ...prelude.slice(activateAt),
  ];
}

/**
 * THE SEED STOPS ONE COMMAND SHORT OF WHAT A PLAN APPROVAL NEEDS, and it is short on purpose.
 *
 * The seed approves with `approval.decide`, whose record the OPERATOR supplies.
 * `approval.decide_intent` — the wire the browser uses, and the only one a durable HUMAN
 * principal may ride — DERIVES that record from durable state instead, and its
 * `applicablePolicyRef` is read off the newest replay-verified `PolicyEvaluated` for the
 * project (`approval-policy-ref.ts:63`). Nothing writes that row but `policy.validate`, so
 * without this command the approval refuses APPROVAL_INTENT_POLICY_REF_UNAVAILABLE @
 * DAEMON_APPROVAL_INTENT — measured here against a live daemon, not reasoned.
 *
 * It rides the policy stream's OWN version line, AFTER every install (a later `PolicyInstalled`
 * reusing the selected slice makes the derivation refuse) and BEFORE the activate, which is the
 * order `bootstrap-test-fixtures.ts:747-750` already proves.
 */
function policyValidate(
  scratch: MultiNodeScratch, prelude: readonly SeedCommand[],
): SeedCommand {
  const installs = prelude.filter((entry) => entry.commandKind === "policy.install").length;
  return command(CORRELATION_ID, {
    commandId: "cmd-multi-node-policy-validate",
    commandKind: "policy.validate",
    expectedVersion: installs,
    payload: {
      input: {
        action: "plan.approve",
        actor: OPERATOR_PRINCIPAL,
        callerRiskHint: null,
        decisionDigest: "d".repeat(64),
        graphNodeRevisionRefs: [],
        policyRevisionRef: DEMO_VALIDATABLE_POLICY_REF,
        requiredFactIds: [],
        scope: [],
      },
    },
    targetAggregateId: `${scratch.projectId}-policy`,
  });
}

/** Opens one session under the OPERATOR credential, the only identity that may mint one. */
export async function openSession(
  wire: DaemonWire, sessionId: string, secret: string,
): Promise<void> {
  await send(wire, command(CORRELATION_ID, {
    commandId: `cmd-open-${sessionId}`,
    commandKind: "session.open",
    payload: {
      capabilities: [...ALL_CAPABILITIES],
      credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
      expiresAt: "2027-01-01T00:00:00.000Z",
      sessionId,
    },
    targetAggregateId: `session/${sessionId}`,
  }));
}

/**
 * The durable HUMAN principal, minted through the PRODUCTION port `/session/pair/open`
 * composes.
 *
 * The Gate 1 bearer fence reads `principal.kind !== "HUMAN"` off this durable record
 * (`product-contract-gate-1-bearer.ts:162`), so without it the approval refuses
 * PRODUCT_CONTRACT_GATE_1_BEARER_PRINCIPAL_ABSENT and the journey stops one leg early. The
 * browser reaches this same port by SIGNING a pairing challenge — an authentication transport
 * this journey does not certify and deliberately does not re-implement, because a second
 * implementation of one security handshake is how the weaker one becomes the real bound.
 */
export function mintHumanPrincipal(
  scratch: MultiNodeScratch, clock: JourneyClock, principalId: string,
): void {
  const provider = createStoreDependencies({
    clock: () => clock.nowIso,
    credential: scratch.credential,
    principalId: OPERATOR_PRINCIPAL,
    projectId: scratch.projectId,
    storePath: scratch.storePath,
  });
  try {
    const authority = provider.pairingOpenSessions?.() as unknown as {
      createPrincipal(input: Record<string, unknown>): { code?: string; ok: boolean };
    } | undefined;
    if (authority === undefined) throw new Error("the provider serves no pairing session port");
    const minted = authority.createPrincipal({
      commandId: "cmd-multi-node-human-principal",
      correlationId: CORRELATION_ID,
      kind: "HUMAN",
      principalId,
      profileRevisionId: "profile-multi-node-1",
    });
    if (!minted.ok) throw new Error(`human principal refused: ${minted.code ?? "?"}`);
  } finally {
    provider.close();
  }
}
