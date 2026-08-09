import type { FixtureAffordanceSnapshot, FixtureFact, FixtureSurfaceId } from "../fixtures.js";
import { CONTROL_ROOM_FIXTURES, MUTATION_BLOCK_ISOLATION } from "../fixtures.js";
import type { BoardJ1Card } from "../board/board-j1.js";
import type { EvidenceJ1Receipt } from "../evidence/evidence-j1.js";
import type { NavLabel } from "../shell/nav-rail.js";

export const PREVIEW_GOAL_TITLE = "Ship the J1 vertical slice";

export interface PreviewContext {
  readonly eyebrow: string;
  readonly title: string;
}

export const PREVIEW_CONTEXT: Readonly<Record<NavLabel, PreviewContext>> = Object.freeze({
  Approvals: Object.freeze({ eyebrow: "Decision desk", title: "Two decisions need review" }),
  Goals: Object.freeze({ eyebrow: "Active goal", title: PREVIEW_GOAL_TITLE }),
  Health: Object.freeze({ eyebrow: "System integrity", title: "Daemon health" }),
  Policy: Object.freeze({ eyebrow: "Read-only authority", title: "Policy" }),
  Resources: Object.freeze({ eyebrow: "Shared capacity", title: "Resources" }),
  "Runs & leases": Object.freeze({ eyebrow: "Active execution", title: "Runs & leases" }),
});

export function previewFacts(surfaceId: FixtureSurfaceId): readonly FixtureFact[] {
  const surface = CONTROL_ROOM_FIXTURES.surfaces.find((candidate) =>
    candidate.surfaceId === surfaceId);
  if (surface === undefined) throw new Error(`CONTROL_ROOM_PREVIEW_SURFACE_MISSING:${surfaceId}`);
  return surface.facts;
}

export function previewAffordance(): FixtureAffordanceSnapshot {
  const affordance = MUTATION_BLOCK_ISOLATION.find((candidate) =>
    candidate.connection === "DISCONNECTED" && candidate.nextAllowedCommands.length > 0);
  if (affordance === undefined) throw new Error("CONTROL_ROOM_PREVIEW_AFFORDANCE_MISSING");
  return affordance;
}

export const PREVIEW_BOARD_CARDS: readonly BoardJ1Card[] = Object.freeze([
  Object.freeze({
    column: "review",
    name: "Fix the stale-port crash",
    nodeId: "node-j1",
    phase: "WORK_REVIEW",
    truthClass: "OBSERVED",
  }),
]);

export const PREVIEW_RECEIPT: EvidenceJ1Receipt = Object.freeze({
  baseSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  command: "pnpm typecheck && pnpm test",
  exitCode: 0,
  headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f098765432",
});

export function previewRunFacts(): readonly FixtureFact[] {
  return previewFacts("node").map((fact) => Object.freeze({
    ...fact,
    factId: `run.${fact.factId}`,
  }));
}
