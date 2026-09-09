/**
 * THE SEAT'S OWN REPORT, recorded over the daemon's real command edge.
 *
 * Split out of `lane-landing.ts` so that module stays about the LANDING CHAIN and this one about
 * the one round the chain needs. Nothing here is authority: `node-verifier.ts` states that
 * "acceptance is EARNED from a test run the daemon performed itself, never taken from an
 * agent's word", so a round recorded here only moves the node to SUBMITTED - the daemon still
 * runs the node's own `test` command before it accepts, and a failing node cannot be talked
 * into a landing receipt from this file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import { laneWorkspaceIdentity, readWireProtocolVersion } from "./daemon-ports.js";
import type { DaemonLane, LaneScratch } from "./daemon-ports.js";
import { LANDED_PATH } from "./lane-landing-contract.js";

/** Domain-separated so two items built from the same bytes cannot collide. */
function digestOf(domain: string, bytes: string): string {
  return createHash("sha256").update(`${domain}\u0000${bytes}`).digest("hex");
}

/**
 * The evidence package the round carries.
 *
 * SHAPE ONLY IS CHECKED, and that is the daemon's decision, not this module's:
 * `review-package.ts` validates 64-hex digests and binds them, because "the evidence receipt
 * pipeline owns their internals". They are still derived from REAL BYTES this lane holds - the
 * seat's own file, the workspace head, and `nodeRef`, which for a compiled node is itself a
 * sha-256 over the sealed graph tuple (`compiled-execution-ref.ts`) - rather than from
 * `hex64("c1")` constants, so a reader can recompute every one and nothing here is a literal
 * standing in for a measurement.
 */
function reviewPackageItems(
  lane: DaemonLane, scratch: LaneScratch, nodeRef: string,
): readonly { digest: string; kind: string; locator: string }[] {
  const landed = readFileSync(join(scratch.workspace, LANDED_PATH), "utf8");
  const head = laneWorkspaceIdentity(scratch.root)?.sha ?? "";
  return [
    { digest: digestOf("criterion", nodeRef), kind: "CRITERION", locator: `${nodeRef}/test` },
    { digest: digestOf("receipt", nodeRef), kind: "DAEMON_RECEIPT", locator: `${nodeRef}/baseline` },
    { digest: digestOf("graph", lane.projectId), kind: "GRAPH_HASH", locator: lane.projectId },
    { digest: digestOf("tree", head), kind: "INTEGRATED_TREE", locator: head },
    { digest: digestOf("plan", nodeRef), kind: "PLAN_HASH", locator: `${nodeRef}/spec` },
    { digest: digestOf("rubric", nodeRef), kind: "RUBRIC", locator: `${nodeRef}/rubric` },
    { digest: createHash("sha256").update(landed).digest("hex"), kind: "SUBMITTED_BYTES", locator: LANDED_PATH },
  ];
}

/**
 * Records the seat's round over the daemon's real command edge.
 *
 * `round = expectedVersion + 1` and empty findings are the SAME instruction the shipped mission
 * gives a real coding seat (`agent-mission-text.ts`'s `codeMission`), so this is the seat's own
 * documented protocol rather than a private one. Returns null on ACCEPTED and the daemon's
 * verbatim answer otherwise - a refusal here must surface its code, never a bare "failed".
 */
export async function submitLaneRound(
  lane: DaemonLane, scratch: LaneScratch, nodeRef: string,
): Promise<string | null> {
  const store = SqliteEventStore.openForProject(scratch.storePath, lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(nodeRef); } finally { store.close(); }
  const payload = {
    findings: [], packageItems: reviewPackageItems(lane, scratch, nodeRef),
    round: expectedVersion + 1, subjectRef: nodeRef,
  };
  const response = await fetch(`${lane.daemonOrigin}/command`, {
    body: JSON.stringify({
      commandId: `lane-review-${nodeRef}`, commandKind: "review.submit",
      correlationId: "lane-landing", expectedVersion, payload, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1", sessionCredential: lane.credential,
      targetAggregateId: nodeRef,
    }),
    headers: {
      "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken, "x-moe-session-credential": lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "",
    },
    method: "POST",
  });
  const answer: unknown = await response.json();
  return (answer as { outcome?: unknown }).outcome === "ACCEPTED"
    ? null
    : `REVIEW_SUBMIT ${String(response.status)}: ${JSON.stringify(answer)}`;
}

