import { NODE_DELIVER_KIND } from "../http/affordance-contract.js";
import type { SeedConfig } from "./demo-seed-env.js";
import { asObject, failure, isOutcome, refusalOutcome } from "./demo-seed-http.js";
import type { SeedOutcome, Wire } from "./demo-seed-http.js";

/**
 * What the seed READS off `/affordances/read` to decide whether it succeeded.
 *
 * Split out of `demo-seed-main.ts` by task-be80cb74, which added the budget-commitment read
 * and the second dispatch phase that consumes it. The cut is by subject, not by size: nothing
 * here sends a command or waits for a commit — these three only ask the daemon's own surface
 * what it is currently offering, and report what it said.
 */

export const MOE_SEED_NODE_NOT_READY = "MOE_SEED_NODE_NOT_READY" as const;

/** One step off the affordance surface, by kind and aggregate. */
async function surfaceStep(
  wire: Wire, config: SeedConfig, kind: string, aggregateId: string,
): Promise<SeedOutcome | Record<string, unknown> | undefined> {
  const frame = await wire.post("/affordances/read", { projectId: config.projectId });
  if (isOutcome(frame)) return frame;
  const refused = refusalOutcome("affordances/read", frame);
  if (refused !== null) return refused;
  const steps = Array.isArray(frame["steps"]) ? frame["steps"] : [];
  const rows = steps.map(asObject).filter((row): row is Record<string, unknown> => row !== null);
  return rows.find((row) => row["kind"] === kind && row["aggregateId"] === aggregateId);
}

/** The whole point of the seed: a READY node step the wrapper can staff. */
export async function checkNodeReady(
  wire: Wire, config: SeedConfig,
): Promise<SeedOutcome | null> {
  const node = await surfaceStep(wire, config, NODE_DELIVER_KIND, config.node.nodeRef);
  if (node !== undefined && isOutcome(node)) return node;
  if (node?.["status"] === "READY") return null;
  // Report what the surface DID say: an absent step and a blocked one are
  // different failures, and the operator needs to know which one they have.
  const stated = node === undefined ? "absent" : `status=${String(node["status"])}`;
  return failure(
    MOE_SEED_NODE_NOT_READY,
    `${NODE_DELIVER_KIND}@${config.node.nodeRef} is ${stated} on /affordances/read`,
  );
}

/**
 * The stop-before-approval handoff: the seed's success is a PENDING decision,
 * so what must be READY on the surface is `approval.decide` itself — the offer
 * the live board renders as its Dispatch button.
 */
export async function checkApprovalPending(
  wire: Wire, config: SeedConfig,
): Promise<SeedOutcome | null> {
  const approval = await surfaceStep(wire, config, "approval.decide", config.runId);
  if (approval !== undefined && isOutcome(approval)) return approval;
  if (approval?.["status"] === "READY") return null;
  const stated = approval === undefined ? "absent" : `status=${String(approval["status"])}`;
  return failure(
    MOE_SEED_NODE_NOT_READY,
    `approval.decide@${config.runId} is ${stated} on /affordances/read`,
  );
}
