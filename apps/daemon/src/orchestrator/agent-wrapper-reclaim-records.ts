import type { StoredEvent } from "@moe/store";

/**
 * The READ half of the staffing log, kept beside the reclaim pass rather than
 * inside `agent-session-fence.ts` — that module owns ADMISSION and is already at
 * its size ceiling, and its fold is private on purpose. This is a second, purpose
 * built reader over the same append-only aggregates: which children were admitted
 * and never retired.
 *
 * It never throws and never guesses. An unknown event type, an undecodable
 * payload, or a record missing the ids the reclaim needs all read UNREADABLE, and
 * the caller skips that aggregate with a log line — the fail-closed posture the
 * fence takes, applied to the reading side.
 */

export interface LiveChildRecord {
  /** `null` when the admission recorded no probeable pid; never a guessed value. */
  readonly childPid: number | null;
  readonly claimAggregateVersion: number;
  readonly sessionId: string;
  readonly workItemId: string;
}

const ADMITTED = "AgentStaffingAdmitted";
const RETIRED = "AgentStaffingRetired";
const decoder = new TextDecoder("utf-8", { fatal: true });

function parsed(payload: Uint8Array): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function admittedRecord(payload: Uint8Array): LiveChildRecord | "UNREADABLE" {
  const facts = parsed(payload);
  if (facts === null) return "UNREADABLE";
  const sessionId = facts["sessionId"];
  const workItemId = facts["workItemId"];
  const version = facts["claimAggregateVersion"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return "UNREADABLE";
  if (typeof workItemId !== "string" || workItemId.length === 0) return "UNREADABLE";
  if (typeof version !== "number" || !Number.isSafeInteger(version)) return "UNREADABLE";
  const pid = facts["childPid"];
  // Integer and positive, exactly as the fence writes it: 0 and negatives address
  // process GROUPS, and a fractional pid can never identify a process.
  const childPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  return { childPid, claimAggregateVersion: version, sessionId, workItemId };
}

/**
 * Folds ONE staffing aggregate: the last transition wins. `null` is idle (never
 * admitted, or admitted and retired); `"UNREADABLE"` refuses to guess.
 */
export function liveChildOf(
  events: readonly StoredEvent[],
): LiveChildRecord | null | "UNREADABLE" {
  let live: LiveChildRecord | "UNREADABLE" | null = null;
  const ordered = [...events].sort((a, b) => a.aggregateSequence - b.aggregateSequence);
  for (const event of ordered) {
    if (event.eventType === ADMITTED) {
      live = admittedRecord(event.payload);
      continue;
    }
    // A RETIRE clears even an unreadable admission, so one bad payload cannot
    // wedge an item forever — the same escape the fence's fold keeps open.
    if (event.eventType === RETIRED) {
      live = null;
      continue;
    }
    return "UNREADABLE";
  }
  return live;
}
