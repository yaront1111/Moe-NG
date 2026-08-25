/**
 * Every SERVER-OWNED fact of one expansion request, derived from durable bytes and the server
 * envelope alone. Nothing here reads a caller value except the rationale TEXT, and nothing here
 * touches the store: it is a pure function of the current authority the reader already resolved.
 *
 * WHY THE IDENTITIES EXCLUDE THE COMMAND ID. `holdId` and `planningRunRef` are a digest of the
 * CURRENT WORLD — project, goal, parent run, parent node, parent revision, generation, graph
 * epoch. A second, distinct request naming that same world therefore lands on the SAME aggregate
 * and is refused by the expected-version fence. Folding the command id in would have given every
 * request its own aggregate, and two ACTIVE holds for one parent would both look correct.
 *
 * WHY THE DEADLINE COMES FROM `decidedAt`. The server stamps that timestamp; `Date.now()` would
 * make two identical replays differ and put a clock inside a deterministic derivation.
 */

import { createHash } from "node:crypto";

import type {
  CreateExpansionHoldCommand,
  ExpansionHandoffBinding,
  ExpansionReleaseEvidence,
} from "@moe/core";

import type { ExpansionRequestPayload } from "./expansion-request-contracts.js";
import type { ExpansionRequestAuthority } from "./expansion-request-current-authority.js";

/** How long an opened hold stays live, measured from the server's own decision timestamp. */
export const EXPANSION_HOLD_DEADLINE_MS = 1_800_000;

/** The release facts the derivation needs, named structurally so it depends on no port type. */
export interface ExpansionReleaseFacts {
  readonly release: ExpansionReleaseEvidence;
  readonly workerHandoff: ExpansionHandoffBinding;
}

function digestOf(parts: readonly (number | string)[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

export function identitiesOf(authority: ExpansionRequestAuthority): {
  readonly holdId: string; readonly planningRunRef: string;
} {
  const digest = digestOf([
    authority.projectId, authority.goalRef, authority.parentRunRef, authority.parentNodeRef,
    authority.parentRevisionRef, authority.generation, authority.graphEpoch,
  ]).slice(0, 32);
  return { holdId: `expansion-hold-${digest}`, planningRunRef: `expansion-run-${digest}` };
}

export function holdCommandOf(
  authority: ExpansionRequestAuthority,
  payload: ExpansionRequestPayload,
  release: ExpansionReleaseFacts,
  commandId: string,
  decidedAt: string,
): CreateExpansionHoldCommand | null {
  const decided = Date.parse(decidedAt);
  if (!Number.isSafeInteger(decided) || decided < 0) return null;
  const { holdId, planningRunRef } = identitiesOf(authority);
  return {
    commandId,
    deadline: decided + EXPANSION_HOLD_DEADLINE_MS,
    expectedVersion: 0,
    generation: authority.generation,
    graphEpoch: authority.graphEpoch,
    holdId,
    kind: "graph.request_expansion",
    parentNodeRef: authority.parentNodeRef,
    parentRevisionRef: authority.parentRevisionRef,
    parentRunRef: authority.parentRunRef,
    planningRunRef,
    proposalBaseHash: authority.graphContentHash,
    rationale: { text: payload.rationale, truthClass: "AGENT_REPORTED" },
    release: release.release,
    sourceFingerprint: digestOf([
      authority.snapshotIdentity, authority.graphContentHash, authority.parentRevisionRef,
      authority.parentNodeRef, authority.parentRunRef, authority.generation, authority.graphEpoch,
      authority.goalVersion,
    ]),
    workerHandoff: release.workerHandoff,
  };
}

/** The external payload, canonicalised. The world is pinned by the hold aggregate id. */
export function requestBytesOf(payload: ExpansionRequestPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    payload.goalRef, payload.parentNodeRef, payload.parentRunRef, payload.rationale,
  ]));
}
