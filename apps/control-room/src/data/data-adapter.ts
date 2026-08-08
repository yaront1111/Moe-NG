import type { CommandBuildResult, ControlRoomClientSurface } from "@moe/control-room-client";

import { MAX_VIEW_RECORDS, UNSTATED } from "./data-contract.js";
import type {
  AdvisoryMessage,
  AdvisoryReceipt,
  CommandDispatchResult,
  CommandKind,
  ControlRoomDataAdapter,
  DaemonTransport,
  FieldProvenance,
  QueryKind,
  ReadResult,
  ViewRecord,
  WireRequest,
} from "./data-contract.js";

/**
 * Fetches and shapes. Nothing here computes a transition, derives truth strength, or
 * infers a status the daemon did not state: `lifecycleState` and `truthClass` are COPIED
 * from the payload, and their absence stays UNKNOWN with an ABSENT provenance rather than
 * being filled in. Distinguishing "stated" from "not stated" is a record of what arrived,
 * not a derivation from it.
 *
 * The truth class is deliberately NOT validated against a known set here. Checking it
 * would mean this layer held an opinion about which classes are real; the presentation
 * kernel already answers that question downstream.
 */

/**
 * The generated builders are keyed by kind, so a statically indexed call would need the
 * caller to have already narrowed the kind. Widening the builder's static signature is
 * safe because the builder VALIDATES its own affordance at runtime and returns
 * INPUT_INVALID for a hand-authored one — the runtime contract is unchanged, and the
 * adapter mints no identity field of its own.
 */
type LooseCommandBuilder = (affordance: unknown, caller: unknown) => CommandBuildResult;
type LooseQueryBuilder = (caller: unknown) => unknown;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stated field is a non-empty string. Anything else was not stated. */
function stated(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function provenance(value: string | null): FieldProvenance {
  return value === null ? "ABSENT" : "DAEMON_STATED";
}

function toViewRecord(entry: unknown): ViewRecord {
  const record = isPlainObject(entry) ? entry : {};
  const lifecycle = stated(record["lifecycleState"]);
  const truth = stated(record["truthClass"]);
  return Object.freeze({
    id: stated(record["id"]) ?? UNSTATED,
    lifecycleProvenance: provenance(lifecycle),
    lifecycleState: lifecycle ?? UNSTATED,
    truthClass: truth ?? UNSTATED,
    truthProvenance: provenance(truth),
  });
}

function refusedRead(code: string): ReadResult {
  return Object.freeze({ code, ok: false as const, outcome: "REFUSED" as const });
}

function refusedCommand(code: string): CommandDispatchResult {
  return Object.freeze({ code, ok: false as const, outcome: "REFUSED" as const });
}

/**
 * Builds the adapter over a GATED client surface. Taking the admitted surface rather than
 * the raw generated module means an incompatible build has no adapter at all, because the
 * gate is the only way to obtain a `ControlRoomClientSurface`.
 */
export function createDataAdapter(
  client: ControlRoomClientSurface,
  transport: DaemonTransport,
): ControlRoomDataAdapter {
  function envelope(body: unknown): WireRequest {
    return Object.freeze({
      body: JSON.stringify(body),
      protocolVersion: client.wireProtocolVersion,
    });
  }

  return {
    dispatchCommand(
      kind: CommandKind,
      affordance: unknown,
      caller: unknown,
    ): CommandDispatchResult {
      const build = client.commands[kind] as unknown as LooseCommandBuilder | undefined;
      if (typeof build !== "function") return refusedCommand("INPUT_INVALID");
      const built = build(affordance, caller);
      if (!built.ok) return refusedCommand(built.error.code);

      const response = transport.sendCommand(envelope(built.envelope));
      if (!response.ok) return refusedCommand(response.code);
      return Object.freeze({
        ok: true as const,
        outcome: "DISPATCHED" as const,
        payload: response.payload,
      });
    },

    read(kind: QueryKind, caller: unknown): ReadResult {
      const build = client.queries[kind] as unknown as LooseQueryBuilder | undefined;
      if (typeof build !== "function") return refusedRead("INPUT_INVALID");

      const response = transport.sendQuery(envelope(build(caller)));
      if (!response.ok) return refusedRead(response.code);
      if (!Array.isArray(response.payload)) return refusedRead("INPUT_INVALID");
      if (response.payload.length > MAX_VIEW_RECORDS) {
        return refusedRead("INPUT_LIMIT_EXCEEDED");
      }

      return Object.freeze({
        ok: true as const,
        outcome: "DELIVERED" as const,
        records: Object.freeze(response.payload.map(toViewRecord)),
      });
    },

    /**
     * Session and terminal text is advisory and terminal-in-itself. The receipt carries no
     * affordance and this method touches no transport, so free-form text has no path to a
     * state change: a caller must separately choose a daemon-issued affordance and
     * dispatch it through the command path.
     */
    receiveAdvisoryMessage(message: AdvisoryMessage): AdvisoryReceipt {
      return Object.freeze({
        advisoryOnly: true as const,
        authority: "NONE" as const,
        kind: message.kind,
        outcome: "RECORDED" as const,
      });
    },
  };
}
