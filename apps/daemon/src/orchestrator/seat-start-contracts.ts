import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

import { instant } from "./provider-pause-contracts.js";

/**
 * THE DURABLE SHAPE OF A SEAT'S START: which provider the wrapper actually spawned it with,
 * and what that provider's CLI answered to `--version` at that moment.
 *
 * A WRAPPER-SIDE FACT, exactly like the seat exit beside it: nobody asks for it and nobody may
 * forge it from the browser. It rides `store.commitExpectedVersionDecision` under the reserved
 * `AGENT_WRAPPER_PRINCIPAL_ID` with an internal command kind, so it never enters the daemon
 * command registry and is never reachable over MCP.
 *
 * WHY DURABLE RATHER THAN PROBED AT READ TIME: the daemon and the wrapper are separate
 * processes, so a daemon probing `claude --version` would measure ITS OWN PATH and publish the
 * answer as if it were the seat's. Writing it down at spawn is the only way the fact belongs to
 * the seat. The cost is one small record per seat; `internal.wrapper.seat_exit` already pays it.
 *
 * EXACT-KEY, like both records beside it: a decode that finds one key too many or too few
 * refuses, so a record written by a future shape is ignored rather than half-read.
 */

export const SEAT_START_COMMAND_KIND = "internal.wrapper.seat_start" as const;
export const SEAT_START_VERSION = "moe-seat-start/1" as const;

/**
 * THE ONE STATED UNKNOWN, for every reason the daemon has no measurement.
 *
 * A seat opened before this record existed, a browser pairing that never had a seat, a probe
 * that failed, timed out or answered something unreadable — all publish THIS, and only this.
 * One token, one meaning: "nobody measured it". A second vocabulary would teach an operator a
 * distinction that does not exist, and an empty string or a plausible default would vouch for
 * a `--version` reading no process ever took (`demo-seed-payloads.ts` refuses the same way).
 */
export const SEAT_FACT_UNMEASURED = "UNKNOWN" as const;

/** A version line is a version line. Anything longer is not one, and is not stored. */
export const AGENT_VERSION_MAX_CHARS = 96;

/**
 * The shape a version reading must have to be stored at all.
 *
 * A `--version` probe runs an OPERATOR-NAMED command, so its stdout is untrusted input on its
 * way to a browser. Storing it raw would publish whatever that process printed. This admits a
 * bounded, single-line, printable token that CONTAINS a dotted number — which is what a version
 * is — and refuses everything else to `SEAT_FACT_UNMEASURED`. It is deliberately narrower than
 * "not a secret": a credential that happened to match this would still have to be one short
 * printable line carrying a dotted number, and no provider's `--version` prints one.
 */
const VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._()@/-]*$/u;
const DOTTED_NUMBER = /\d+\.\d+/u;

export interface SeatStartRecordV1 {
  /** The CLI's own reported version, shaped and clipped, or `SEAT_FACT_UNMEASURED`. */
  readonly agentVersion: string;
  readonly projectId: string;
  /** The agent command this seat was spawned with, as a provider name where one is known. */
  readonly provider: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly version: typeof SEAT_START_VERSION;
}

const SEAT_START_KEYS = [
  "agentVersion", "projectId", "provider", "sessionId", "startedAt", "version",
] as const;

/** Every seat's start lands beside its session, on a stream of its own. */
export function seatStartAggregateId(projectId: string, sessionId: string): string {
  return `seat-start:${projectId}:${sessionId}`;
}

/**
 * Command ids are DERIVED FROM THE INPUTS, never minted fresh: two wrapper processes that
 * start the same session at the same instant replay one decision instead of writing two.
 */
export function seatStartRecordId(projectId: string, sessionId: string, startedAt: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([projectId, sessionId, startedAt]), "utf8").digest("hex").slice(0, 32);
  return `seat-start-${digest}`;
}

/**
 * The stored form of a probe's output: the FIRST and ONLY line, shaped, clipped, or the stated
 * unknown. Extra output means something other than a version answered — `doctor-version.node.ts`
 * takes the same posture, and "I could not read it" is the correct and only honest answer.
 */
export function shapeAgentVersion(stdout: string | null): string {
  if (stdout === null) return SEAT_FACT_UNMEASURED;
  const lines = stdout.trim().split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const only = lines.length === 1 ? lines[0]?.trim() : undefined;
  if (only === undefined || only.length === 0 || only.length > AGENT_VERSION_MAX_CHARS) {
    return SEAT_FACT_UNMEASURED;
  }
  return VERSION_SHAPE.test(only) && DOTTED_NUMBER.test(only) ? only : SEAT_FACT_UNMEASURED;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}

function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export type SeatStartDecodeResult =
  | Readonly<{ ok: true; record: SeatStartRecordV1 }>
  | Readonly<{ code: "SEAT_START_RECORD_INVALID"; ok: false }>;

export function decodeSeatStartBytes(input: unknown): SeatStartDecodeResult {
  const refused = { code: "SEAT_START_RECORD_INVALID", ok: false } as const;
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, SEAT_START_KEYS)) {
    return refused;
  }
  const { agentVersion, projectId, provider, sessionId, startedAt, version } = decoded.value;
  // The version member is re-shaped on the way OUT as well as in: a row written by a build
  // whose shaping was looser must not publish what this one would have refused.
  if (version !== SEAT_START_VERSION || !instant(startedAt) || !ref(projectId) || !ref(provider)
    || !ref(agentVersion) || !ref(sessionId)
    || agentVersion.length > AGENT_VERSION_MAX_CHARS || provider.length > AGENT_VERSION_MAX_CHARS
    || (agentVersion !== SEAT_FACT_UNMEASURED && shapeAgentVersion(agentVersion) !== agentVersion)) {
    return refused;
  }
  return {
    ok: true,
    record: Object.freeze({
      agentVersion, projectId, provider, sessionId, startedAt, version: SEAT_START_VERSION,
    }),
  };
}
