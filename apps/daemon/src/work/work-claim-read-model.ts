import type { SqliteEventStore } from "@moe/store";

import { WORK_CLAIM_COMMAND_KINDS } from "./work-claim-contracts.js";

/**
 * The fold every claim decision must consult: who durably holds which work
 * item. Mirrors the session read model, including the fail-closed `unreadable`
 * flag — treating corrupt stored bytes as "no claim" would let a held item be
 * silently re-claimed.
 */

export interface WorkClaimRecord {
  readonly claimedBy: string;
  readonly expiresAt: string;
  readonly status: "OPEN" | "RELEASED";
  readonly version: number;
  readonly workItemId: string;
}

export interface WorkClaimLedger {
  readonly claims: ReadonlyMap<string, WorkClaimRecord>;
  readonly decisionCount: number;
  readonly unreadable: boolean;
}

const LEDGER_PAGE_SIZE = 200;
const KIND_SET: ReadonlySet<string> = new Set<string>(WORK_CLAIM_COMMAND_KINDS);
const decoder = new TextDecoder();

function parseResult(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readWorkClaimLedger(
  store: SqliteEventStore, projectId: string,
): WorkClaimLedger {
  const claims = new Map<string, WorkClaimRecord>();
  let decisionCount = 0;
  let unreadable = false;
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, LEDGER_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId) continue;
      if (!KIND_SET.has(decision.commandKind)) continue;
      decisionCount += 1;
      if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      const result = parseResult(decision.resultBytes);
      const workItemId = result === null ? null : text(result["workItemId"]);
      const claimedBy = result === null ? null : text(result["claimedBy"]);
      const expiresAt = result === null ? null : text(result["expiresAt"]);
      const status = result?.["status"];
      const version = decision.currentVersion;
      if (
        workItemId === null || claimedBy === null || expiresAt === null
        || (status !== "OPEN" && status !== "RELEASED") || typeof version !== "number"
      ) {
        unreadable = true;
        continue;
      }
      claims.set(workItemId, Object.freeze({
        claimedBy, expiresAt, status, version, workItemId,
      }));
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return Object.freeze({ claims, decisionCount, unreadable });
}
