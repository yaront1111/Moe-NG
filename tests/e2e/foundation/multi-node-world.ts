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

import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import { DEFAULT_MULTI_NODE_IDENTITY } from "./multi-node-identity.js";
import type { MultiNodeIdentity } from "./multi-node-identity.js";
import { withStore } from "./multi-node-reads.js";
import { type DaemonWire, command, send } from "./multi-node-wire.js";

export const CORRELATION_ID = DEFAULT_MULTI_NODE_IDENTITY.correlationId;
export const OPERATOR_PRINCIPAL = DEFAULT_MULTI_NODE_IDENTITY.operatorPrincipal;
const ALL_CAPABILITIES = Object.freeze([
  "goal.write", "planning.write", "project.admin", "review.write", "work.write",
]);

/** The caller's clock readings, never this module's. */
export interface JourneyClock {
  readonly nowIso: string;
  readonly nowMs: number;
}

/**
 * THE PRELUDE HAS THREE PARTS, AND A CALLER CAN NEED THE MIDDLE ONE ALONE.
 *
 * (a) the shipped seed's prefix, (b) a `policy.validate` THIS MODULE INSERTS — see
 * `policyValidate` below for why the seed lacks it — and (c) `project.activate` and the rest.
 * A caller that has already run the SHIPPED seed has (a) and (c) but has never run (b), which
 * is precisely the part `approval.decide_intent` needs. So the selection NAMES which parts run
 * instead of being a boolean skip, because a boolean would drop exactly the one part such a
 * caller is missing and the approval would refuse with no hint at where the hole is.
 */
export type WorldPreludeMode =
  /** (a)+(b)+(c), in today's order. What every existing caller gets. */
  | "SEED_POLICY_AND_ACTIVATE"
  /** (a)+(c): exactly what the SHIPPED seed sends, with no `policy.validate` inserted. */
  | "SEED_AND_ACTIVATE"
  /** (b) alone: the caller's project is ALREADY installed, seeded and activated. */
  | "POLICY_VALIDATE_ONLY";

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
  identity: MultiNodeIdentity = DEFAULT_MULTI_NODE_IDENTITY,
  mode: WorldPreludeMode = "SEED_POLICY_AND_ACTIVATE",
): readonly SeedCommand[] {
  if (mode === "POLICY_VALIDATE_ONLY") {
    return [policyValidate(scratch, identity, policyStreamVersion(scratch))];
  }
  const planned = buildDemoSeedPlan({
    budgetRef: null,
    correlationId: identity.correlationId,
    decidedAt: clock.nowIso,
    goalId: identity.goalId,
    node: {
      instructions: "Create math.mjs exporting add and multiply so test.mjs passes.",
      nodeRef: identity.omega, test: "node test.mjs", title: `Implement ${identity.omega}`,
      workspace: scratch.workspace.replaceAll("\\", "/"),
    },
    principalId: identity.operatorPrincipal,
    projectId: scratch.projectId,
    runId: `run-${identity.goalCreateCommandId}`,
    stopBeforeApproval: true,
  });
  const goalAt = planned.findIndex((entry) => entry.commandKind === "goal.create");
  if (goalAt === -1) throw new Error("the shipped seed plan no longer contains goal.create");
  const prelude = planned.slice(0, goalAt);
  const activateAt = prelude.findIndex((entry) => entry.commandKind === "project.activate");
  if (activateAt === -1) throw new Error("the shipped seed plan no longer activates the project");
  if (mode === "SEED_AND_ACTIVATE") return prelude;
  const validate = policyValidate(scratch, identity, countInstalls(prelude));
  return [...prelude.slice(0, activateAt), validate, ...prelude.slice(activateAt)];
}

/** The policy stream's version line, counted off a prelude the caller is about to send. */
function countInstalls(prelude: readonly SeedCommand[]): number {
  return prelude.filter((entry) => entry.commandKind === "policy.install").length;
}

/**
 * The same version line, read off DURABLE STATE instead of off an array.
 *
 * A `POLICY_VALIDATE_ONLY` caller never builds the prelude, so it has nothing to count. The
 * two answers agree by construction on the default path: the seed's three `policy.install`
 * commands all target `${projectId}-policy` at expected versions 0, 1 and 2
 * (`demo-seed-plan.ts:144,211-213`), so the stream stands at exactly the install count once
 * they have landed. Reading it here also keeps the fence honest for a caller whose project
 * carries installs this module never planned.
 */
function policyStreamVersion(scratch: MultiNodeScratch): number {
  return withStore(scratch, (store) =>
    store.getAggregateVersion(policyAggregateId(scratch.projectId)));
}

const policyAggregateId = (projectId: string): string => `${projectId}-policy`;

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
export function policyValidate(
  scratch: MultiNodeScratch, identity: MultiNodeIdentity, expectedVersion: number,
): SeedCommand {
  return command(identity.correlationId, {
    commandId: "cmd-multi-node-policy-validate",
    commandKind: "policy.validate",
    expectedVersion,
    payload: {
      input: {
        action: "plan.approve",
        actor: identity.operatorPrincipal,
        callerRiskHint: null,
        decisionDigest: "d".repeat(64),
        graphNodeRevisionRefs: [],
        policyRevisionRef: DEMO_VALIDATABLE_POLICY_REF,
        requiredFactIds: [],
        scope: [],
      },
    },
    targetAggregateId: policyAggregateId(scratch.projectId),
  });
}

/** Opens one session under the OPERATOR credential, the only identity that may mint one. */
export async function openSession(
  wire: DaemonWire, sessionId: string, secret: string,
  identity: MultiNodeIdentity = DEFAULT_MULTI_NODE_IDENTITY,
): Promise<void> {
  await send(wire, command(identity.correlationId, {
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
  identity: MultiNodeIdentity = DEFAULT_MULTI_NODE_IDENTITY,
): void {
  const provider = createStoreDependencies({
    clock: () => clock.nowIso,
    credential: scratch.credential,
    principalId: identity.operatorPrincipal,
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
      correlationId: identity.correlationId,
      kind: "HUMAN",
      principalId,
      profileRevisionId: "profile-multi-node-1",
    });
    if (!minted.ok) throw new Error(`human principal refused: ${minted.code ?? "?"}`);
  } finally {
    provider.close();
  }
}
