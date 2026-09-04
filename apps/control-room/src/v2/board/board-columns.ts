import type { RunNodeStatus, RunNodeView } from "../../live/live-runs.js";
import { MIDDOT, TIMES } from "../glyphs.js";
import { agoWords, seatWords } from "../ops/activity-words.js";
import { ROUTE_WORDS } from "../runs/runs-screen.js";

/**
 * THE BOARD'S COLUMNS: the daemon's nine node statuses folded into the six words a person
 * already reads on a task board, plus the ONE fact each column shows under a card. Pure:
 * no fetch, no clock beyond the `nowMs` it is handed.
 *
 * The one split the daemon does not make is REWORK. Its runs read leaves a node READY both
 * when no agent has touched it and when a review round just sent it back ("a rejected round
 * leaves the node READY; review.latestRoute says so"), so READY is split here on whether a
 * round exists. That split is what makes "one is stuck" legible; nothing new is on the wire.
 *
 * BLOCKED folds five rare statuses because every one of them means "this will not move
 * until something outside the agents changes"; each card names which of the five it is.
 */

export const BOARD_COLUMNS = ["QUEUED", "WORKING", "REVIEW", "REWORK", "DONE", "BLOCKED"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const COLUMN_WORDS: Readonly<Record<BoardColumn, string>> = Object.freeze({
  BLOCKED: "Blocked",
  DONE: "Done",
  QUEUED: "Queued",
  REVIEW: "In review",
  REWORK: "Rework",
  WORKING: "Working",
});

/** Why a card sits in BLOCKED, one sentence per folded status. */
const BLOCKED_WORDS: Readonly<Record<Exclude<RunNodeStatus, "ACCEPTED" | "DELIVERED" | "IN_PROGRESS" | "READY">, string>> =
  Object.freeze({
    BLOCKED: "its review ledger does not read",
    ESCALATED: "escalated; a human decided the exhausted review",
    ESCALATION_REQUIRED: "every review attempt used; needs your decision",
    REPLANNED: "replanned into a successor goal",
    UNATTRIBUTABLE: "its key is shared by two plans, so its work cannot be attributed",
  });

export function columnOf(node: RunNodeView): BoardColumn {
  switch (node.status) {
    case "ACCEPTED": return "DONE";
    case "IN_PROGRESS": return "WORKING";
    case "DELIVERED": return "REVIEW";
    case "READY": return node.review.rounds > 0 ? "REWORK" : "QUEUED";
    case "BLOCKED":
    case "ESCALATED":
    case "ESCALATION_REQUIRED":
    case "REPLANNED":
    case "UNATTRIBUTABLE":
      return "BLOCKED";
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

/** The ONE fact under a card, chosen by its column; never the runs screen's nine-clause sentence. */
export function cardLine(node: RunNodeView, column: BoardColumn, nowMs: number): string {
  switch (column) {
    case "QUEUED":
      return node.dependsOn.length === 0 ? "ready for an agent" : "waiting on other work";
    case "WORKING": {
      // `lastActivityAt` is the last DECISION on the node (a review round, an acceptance), never
      // the seat's claim or its renewals, so the card does not pretend to know when the seat
      // last moved; the lease end is the one instant the wire carries for the seat.
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
      const since = node.lastActivityAt === null ? null : agoWords(node.lastActivityAt, nowMs);
      return since === null ? "waiting on the verifier" : `delivered ${since} ${MIDDOT} waiting on the verifier`;
    }
    case "REWORK": {
      const route = node.review.latestRoute === null ? "sent back" : ROUTE_WORDS[node.review.latestRoute] ?? node.review.latestRoute;
      return `sent back ${TIMES}${String(Math.max(1, node.review.unsuccessfulRounds))} ${MIDDOT} ${route}`;
    }
    case "DONE": {
      if (node.landing === null) return "verified";
      if (node.landing.outcome === "COMMITTED") return `verified ${MIDDOT} landed`;
      return `verified ${MIDDOT} not landed yet`;
    }
    case "BLOCKED":
      return node.status === "ACCEPTED" || node.status === "DELIVERED" || node.status === "IN_PROGRESS" || node.status === "READY"
        ? "blocked" : BLOCKED_WORDS[node.status];
  }
}

export interface BoardCard {
  readonly column: BoardColumn;
  /** The top finding's detail, shown only where "why" is the next question: REWORK and BLOCKED. */
  readonly finding: string | null;
  readonly line: string;
  readonly node: RunNodeView;
}

export interface BoardFold {
  readonly cards: Readonly<Record<BoardColumn, readonly BoardCard[]>>;
  readonly counts: Readonly<Record<BoardColumn, number>>;
  /** Cards a person should look at first: REWORK plus BLOCKED. */
  readonly stuck: number;
  readonly total: number;
}

export function foldBoard(nodes: readonly RunNodeView[], nowMs: number): BoardFold {
  const cards: Record<BoardColumn, BoardCard[]> = {
    BLOCKED: [], DONE: [], QUEUED: [], REVIEW: [], REWORK: [], WORKING: [],
  };
  for (const node of nodes) {
    const column = columnOf(node);
    const finding = column === "REWORK" || column === "BLOCKED" ? node.review.findings[0]?.detail ?? null : null;
    cards[column].push(Object.freeze({ column, finding, line: cardLine(node, column, nowMs), node }));
  }
  const counts = Object.freeze({
    BLOCKED: cards.BLOCKED.length, DONE: cards.DONE.length, QUEUED: cards.QUEUED.length,
    REVIEW: cards.REVIEW.length, REWORK: cards.REWORK.length, WORKING: cards.WORKING.length,
  });
  return Object.freeze({
    cards: Object.freeze({
      BLOCKED: Object.freeze(cards.BLOCKED), DONE: Object.freeze(cards.DONE), QUEUED: Object.freeze(cards.QUEUED),
      REVIEW: Object.freeze(cards.REVIEW), REWORK: Object.freeze(cards.REWORK), WORKING: Object.freeze(cards.WORKING),
    }),
    counts,
    stuck: counts.REWORK + counts.BLOCKED,
    total: nodes.length,
  });
}

/** "8 nodes, 3 done, 2 working, 1 stuck" (middot-joined): the header's second line, nodes only, never criteria. */
export function nodesLine(fold: BoardFold): string {
  const parts = [`${String(fold.total)} node${fold.total === 1 ? "" : "s"}`];
  if (fold.counts.DONE > 0) parts.push(`${String(fold.counts.DONE)} done`);
  if (fold.counts.WORKING + fold.counts.REVIEW > 0) parts.push(`${String(fold.counts.WORKING + fold.counts.REVIEW)} working`);
  if (fold.stuck > 0) parts.push(`${String(fold.stuck)} stuck`);
  return parts.join(` ${MIDDOT} `);
}
