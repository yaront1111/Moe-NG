import type { RunNodeStatus, RunNodeView } from "../../live/live-runs.js";
import { MIDDOT, TIMES } from "../glyphs.js";
import { agoWords, seatWords } from "../ops/activity-words.js";

/**
 * THE BOARD'S COLUMNS: the daemon's nine node statuses folded into the six pipeline
 * words a person already reads (planned → published). Stuck work stays in the column
 * it reached, marked stuck, so "is anything stuck?" is a card treatment not a seventh
 * lane. Pure: no fetch, no clock beyond the `nowMs` it is handed.
 *
 * READY is both "not yet started" and "sent back after review"; the latter is stuck
 * Planned. Exhausted reviews sit in Review, stuck. Publication requires a node's
 * exact landing SHA to match the goal's pushed receipt. The read has no ancestry
 * evidence, so other landings remain Landed even if they might be ancestors.
 */

export const BOARD_COLUMNS = [
  "PLANNED", "WORKING", "REVIEW", "VERIFIED", "LANDED", "PUBLISHED",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const COLUMN_WORDS: Readonly<Record<BoardColumn, string>> = Object.freeze({
  LANDED: "Landed",
  PLANNED: "Planned",
  PUBLISHED: "Published",
  REVIEW: "Review",
  VERIFIED: "Verified",
  WORKING: "Working",
});

/** Review routes in a person's words; an unknown token stays as the daemon spelled it. */
export const ROUTE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ACCEPT: "review passed",
  ESCALATE: "review escalated",
  REJECT_IMPLEMENTATION: "rejected: implementation",
  REJECT_PLAN: "rejected: same finding again",
  UNKNOWN_EVIDENCE: "rejected: evidence unknown",
});

const STOP_WORDS: Readonly<Record<Exclude<RunNodeStatus, "ACCEPTED" | "DELIVERED" | "IN_PROGRESS" | "READY">, string>> =
  Object.freeze({
    BLOCKED: "its review ledger does not read",
    ESCALATED: "escalated; a human decided the exhausted review",
    ESCALATION_REQUIRED: "every review attempt used; needs your decision",
    REPLANNED: "replanned into a successor goal",
    UNATTRIBUTABLE: "earlier execution has no scoped identity; attribution is required",
  });

export function isStuck(node: RunNodeView): boolean {
  if (node.status === "READY") return node.review.rounds > 0;
  if (node.status === "ACCEPTED") return node.landing?.outcome === "REFUSED";
  return node.status === "BLOCKED" || node.status === "ESCALATED"
    || node.status === "ESCALATION_REQUIRED" || node.status === "REPLANNED"
    || node.status === "UNATTRIBUTABLE";
}

export function columnOf(node: RunNodeView, publishedSha: string | null = null): BoardColumn {
  switch (node.status) {
    case "IN_PROGRESS": return "WORKING";
    case "DELIVERED": return "REVIEW";
    case "ESCALATED":
    case "ESCALATION_REQUIRED":
      return "REVIEW";
    case "ACCEPTED":
      if (node.landing?.outcome === "COMMITTED") {
        return publishedSha !== null && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(publishedSha)
          && node.landing.sha === publishedSha ? "PUBLISHED" : "LANDED";
      }
      return "VERIFIED";
    default:
      return "PLANNED";
  }
}

/** "in 12 min" / "in 2 h" for an instant ahead of now; null once it has passed or does not parse. */
export function untilWords(iso: string, nowMs: number): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at <= nowMs) return null;
  const minutes = Math.max(1, Math.round((at - nowMs) / 60_000));
  if (minutes < 60) return `in ${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${String(hours)} h` : `in ${String(Math.round(hours / 24))} d`;
}

const LEASE_WARNING_MS = 60 * 60_000;

function stopLine(node: RunNodeView): string {
  return node.status === "ACCEPTED" || node.status === "DELIVERED"
    || node.status === "IN_PROGRESS" || node.status === "READY"
    ? "blocked" : STOP_WORDS[node.status];
}

/** The ONE fact under a card, chosen by its column; never a hash, enum, or id. */
export function cardLine(node: RunNodeView, column: BoardColumn, nowMs: number): string {
  switch (column) {
    case "PLANNED":
      if (node.status === "READY" && node.review.rounds > 0) {
        const route = node.review.latestRoute === null
          ? "sent back" : ROUTE_WORDS[node.review.latestRoute] ?? node.review.latestRoute;
        return `sent back ${TIMES}${String(Math.max(1, node.review.unsuccessfulRounds))} ${MIDDOT} ${route}`;
      }
      if (node.status !== "READY") return stopLine(node);
      return node.dependsOn.length === 0 ? "ready for an agent" : "waiting on other work";
    case "WORKING": {
      const who = node.claim === null ? "an agent seat" : seatWords(node.claim.claimedBy);
      const parts = [who];
      if (node.claim !== null && Date.parse(node.claim.expiresAt) - nowMs < LEASE_WARNING_MS) {
        const left = untilWords(node.claim.expiresAt, nowMs);
        parts.push(left === null ? "lease expired" : `lease ends ${left}`);
      }
      if (node.review.unsuccessfulRounds > 0) parts.push(`retry ${String(node.review.unsuccessfulRounds + 1)}`);
      return parts.join(` ${MIDDOT} `);
    }
    case "REVIEW": {
      if (isStuck(node)) return stopLine(node);
      const since = node.lastActivityAt === null ? null : agoWords(node.lastActivityAt, nowMs);
      return since === null ? "waiting on the verifier" : `delivered ${since} ${MIDDOT} waiting on the verifier`;
    }
    case "VERIFIED":
      return node.landing?.outcome === "REFUSED" ? "verified · not landed yet" : "verified";
    case "LANDED":
      return "landed on the workspace branch";
    case "PUBLISHED":
      return "published";
  }
}

export interface BoardCard {
  readonly column: BoardColumn;
  /** The top finding's detail, shown only where "why" is the next question: stuck cards. */
  readonly finding: string | null;
  readonly line: string;
  readonly node: RunNodeView;
}

export interface BoardFold {
  readonly cards: Readonly<Record<BoardColumn, readonly BoardCard[]>>;
  readonly counts: Readonly<Record<BoardColumn, number>>;
  readonly stuck: number;
  readonly total: number;
}

function emptyCards(): Record<BoardColumn, BoardCard[]> {
  return { LANDED: [], PLANNED: [], PUBLISHED: [], REVIEW: [], VERIFIED: [], WORKING: [] };
}

export function foldBoard(
  nodes: readonly RunNodeView[], nowMs: number, publishedSha: string | null = null,
): BoardFold {
  const cards = emptyCards();
  let stuck = 0;
  for (const node of nodes) {
    const column = columnOf(node, publishedSha);
    const stuckCard = isStuck(node);
    if (stuckCard) stuck += 1;
    cards[column].push(Object.freeze({
      column, finding: stuckCard ? node.review.findings[0]?.detail ?? null : null,
      line: cardLine(node, column, nowMs), node,
    }));
  }
  const counts = Object.freeze({
    LANDED: cards.LANDED.length, PLANNED: cards.PLANNED.length, PUBLISHED: cards.PUBLISHED.length,
    REVIEW: cards.REVIEW.length, VERIFIED: cards.VERIFIED.length, WORKING: cards.WORKING.length,
  });
  return Object.freeze({
    cards: Object.freeze({
      LANDED: Object.freeze(cards.LANDED), PLANNED: Object.freeze(cards.PLANNED),
      PUBLISHED: Object.freeze(cards.PUBLISHED), REVIEW: Object.freeze(cards.REVIEW),
      VERIFIED: Object.freeze(cards.VERIFIED), WORKING: Object.freeze(cards.WORKING),
    }),
    counts,
    stuck,
    total: nodes.length,
  });
}

/** "8 nodes · 3 landed · 2 working · 1 stuck": the header's second line. */
export function nodesLine(fold: BoardFold): string {
  const parts = [`${String(fold.total)} node${fold.total === 1 ? "" : "s"}`];
  if (fold.counts.PUBLISHED > 0) parts.push(`${String(fold.counts.PUBLISHED)} published`);
  else if (fold.counts.LANDED > 0) parts.push(`${String(fold.counts.LANDED)} landed`);
  else if (fold.counts.VERIFIED > 0) parts.push(`${String(fold.counts.VERIFIED)} verified`);
  if (fold.counts.WORKING > 0) parts.push(`${String(fold.counts.WORKING)} working`);
  if (fold.stuck > 0) parts.push(`${String(fold.stuck)} stuck`);
  return parts.join(` ${MIDDOT} `);
}
