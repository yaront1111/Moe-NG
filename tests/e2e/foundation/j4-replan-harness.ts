/**
 * J4 mechanics: read the daemon's OWN affordance surface, and drive `qualification.replan`
 * against the running daemon through the seed's wire and envelope builder.
 *
 * NOTHING HERE DECIDES ANYTHING. The classification is the daemon's, computed by `@moe/core`'s
 * `evaluateCarryForward` over the evidence this module supplies; the version comes from the
 * production affordance surface rather than from a count kept here, so a replan that would be
 * stale in production is stale here too.
 *
 * THE EVIDENCE IS MEASURED, NOT INVENTED. `workspaceDigest` hashes the exclusive node's actual
 * bytes on disk, and J4 takes it at two real instants — before the attempt and after it. A
 * hand-written pair of hashes would let the delta assert only that unequal strings are
 * unequal; a digest of the real workspace makes INVALIDATED a fact about the rejected work.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE — `e2e-harness.test.ts` scans every non-test module in
 * this directory for four needles by plain substring match.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isOutcome, wireFor } from "../../../apps/daemon/src/orchestrator/demo-seed-http.js";
import type { SeedConfig } from "../../../apps/daemon/src/orchestrator/demo-seed-env.js";
import type { SeedCommand } from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";
import { deterministicId } from "./e2e-harness.js";
import type { J1Scratch } from "./j1-loop-harness.js";

/** The canonicalizer the delta evidence is stated in; the payload also declares it supported. */
export const CANONICALIZER_VERSION = "moe-canonical/1";

const AFFORDANCE_PATH = "/affordances/read";

/**
 * A digest over the exclusive node's whole workspace: every file name paired with the hash of
 * its bytes.
 *
 * The FILE SET is part of the digest, not just the contents, because the rejected attempt's
 * change was to ADD a file. A digest that folded only the bytes of files present at both
 * instants would report "unchanged" across exactly the delta J4 exists to classify.
 */
export function workspaceDigest(scratch: J1Scratch): string {
  const names = readdirSync(scratch.workspace).sort();
  const lines = names.map((name) => {
    const bytes = readFileSync(join(scratch.workspace, name));
    return `${name}|${createHash("sha256").update(bytes).digest("hex")}`;
  });
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export interface SurfaceStep {
  readonly aggregateId: string;
  readonly kind: string;
  readonly missing: readonly string[];
  readonly status: string;
  readonly version: number;
}

export interface SurfaceOffer {
  readonly commandId: string;
  readonly commandKind: string;
  readonly expectedVersion: number;
  readonly targetAggregateId: string;
}

export interface AffordanceSurface {
  readonly offers: readonly SurfaceOffer[];
  readonly outcome: unknown;
  readonly steps: readonly SurfaceStep[];
}

/**
 * The production read surface, over the same wire the seed uses.
 *
 * Reading the version from HERE rather than from the store file is the point: it is the value
 * a real client would send, so a replan built from it is the replan a real client would issue.
 */
export async function readAffordanceSurface(config: SeedConfig): Promise<AffordanceSurface> {
  const wire = wireFor(config, fetch as never);
  const frame = await wire.post(AFFORDANCE_PATH, { projectId: config.projectId });
  if (isOutcome(frame)) {
    throw new Error(`transport refused the surface read: ${frame.ok ? "OK" : frame.code}`);
  }
  const steps = Array.isArray(frame["steps"]) ? (frame["steps"] as SurfaceStep[]) : [];
  const offers = Array.isArray(frame["nextAllowedCommands"])
    ? (frame["nextAllowedCommands"] as SurfaceOffer[])
    : [];
  return { offers, outcome: frame["outcome"], steps };
}

/** The surface's own record for one aggregate, or null when it lists none. */
export function stepFor(
  surface: AffordanceSurface, aggregateId: string,
): SurfaceStep | null {
  return surface.steps.find((step) => step.aggregateId === aggregateId) ?? null;
}

export interface DeltaEvidence {
  readonly sourceHash: string;
  readonly targetHash: string;
}

/**
 * One affected node in the delta, carrying MEASURED hashes.
 *
 * The five non-hash conditions are stated as `true` deliberately: this journey changed only
 * the node's bytes, so claiming a dependency or policy-slice change would be a fabrication
 * that also masks the hash mismatch behind extra reason codes.
 */
export function deltaNode(nodeRef: string, evidence: DeltaEvidence): Record<string, unknown> {
  return {
    evidence: {
      canonicalizerVersion: CANONICALIZER_VERSION,
      dependenciesPresent: true,
      environmentClosureUnchanged: true,
      policySliceUnchanged: true,
      predecessorResultUnchanged: true,
      sourceHash: evidence.sourceHash,
      targetHash: evidence.targetHash,
    },
    nodeRef,
  };
}

export interface ReplanRequest {
  readonly expectedVersion: number;
  readonly nodes: readonly Record<string, unknown>[];
  readonly ordinal: number;
  readonly subjectRef: string;
  readonly successorPlanRef: string;
}

/**
 * A `qualification.replan` command in the shape `toWireEnvelope` seals and `POST /command`
 * decodes. The ids are derived from the ordinal so a rerun sends the same bytes.
 */
export function replanCommand(request: ReplanRequest): SeedCommand {
  return Object.freeze({
    commandId: deterministicId("j4-replan", request.ordinal),
    commandKind: "qualification.replan",
    correlationId: deterministicId("j4-replan-correlation", request.ordinal),
    expectedVersion: request.expectedVersion,
    payload: {
      nodes: request.nodes,
      subjectRef: request.subjectRef,
      successorPlanRef: request.successorPlanRef,
      supportedCanonicalizerVersions: [CANONICALIZER_VERSION],
    },
    targetAggregateId: request.subjectRef,
  });
}
