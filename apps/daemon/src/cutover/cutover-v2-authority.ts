/**
 * "May a v2 authoritative command run yet?" - the ONE question the activation marker exists to
 * answer (design :1286: the transition and the marker commit together, and ONLY THEN may the
 * first v2 authoritative command run).
 *
 * The marker is the sole evidence. This module reads it and refuses closed when it is absent:
 * there is no default, no config flag and no caller-supplied override, because a v2 command
 * admitted without the marker would be authority the cutover never granted.
 *
 * IT IS DELIBERATELY NOT WIRED INTO ANY COMMAND TABLE HERE. Registration - making the daemon's
 * ingress consult this before dispatching - is task-b8272ee020a940009a11c6eb6355d578, which
 * also registers `cutover.activate` itself. This module is the seam that row wires TO.
 */
import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";
import type { StoredEvent } from "@moe/store";

import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
  decodeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId,
} from "./cutover-activation-marker.js";
import type { CutoverActivationMarker } from "./cutover-activation-marker.js";

export const CUTOVER_V2_AUTHORITY_LAYER = "DAEMON_CUTOVER_V2_AUTHORITY" as const;

export const CUTOVER_V2_AUTHORITY_CODES = Object.freeze([
  "CUTOVER_V2_NOT_ACTIVE",
  "CUTOVER_V2_COMMAND_UNKNOWN",
] as const);

export type CutoverV2AuthorityCode = (typeof CUTOVER_V2_AUTHORITY_CODES)[number];

export interface CutoverV2AuthorityRefusal {
  readonly code: CutoverV2AuthorityCode;
  readonly layer: typeof CUTOVER_V2_AUTHORITY_LAYER;
  readonly ok: false;
}

export interface CutoverV2AuthorityAdmitted {
  readonly commandKind: RuntimeCommandKind;
  readonly marker: CutoverActivationMarker;
  readonly ok: true;
}

export type CutoverV2AuthorityResult = CutoverV2AuthorityAdmitted | CutoverV2AuthorityRefusal;

export interface CutoverMarkerStore {
  readEvents(aggregateId: string): readonly StoredEvent[];
}

const COMMAND_KIND_SET: ReadonlySet<string> = new Set(RUNTIME_COMMAND_KINDS);

function refuse(code: CutoverV2AuthorityCode): CutoverV2AuthorityRefusal {
  return Object.freeze({ code, layer: CUTOVER_V2_AUTHORITY_LAYER, ok: false as const });
}

/**
 * The durable v2 authority marker, or null when v2 is not authoritative yet. A store failure and
 * an unreadable record both read as "not authoritative": this reader can only ever WITHHOLD
 * authority, never manufacture it, so a degraded read cannot open the gate.
 */
export function readCutoverActivationMarker(
  store: CutoverMarkerStore,
  input: Readonly<{ projectId: string }>,
): CutoverActivationMarker | null {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(deriveCutoverActivationMarkerAggregateId(input.projectId));
  } catch {
    return null;
  }
  const last = events.at(-1);
  if (last === undefined || last.eventType !== CUTOVER_ACTIVATION_MARKER_EVENT_TYPE) return null;
  const decoded = decodeCutoverActivationMarker(last.payload);
  return decoded.ok ? decoded.marker : null;
}

/**
 * Admits one v2 authoritative command, or refuses closed. The command kind is checked against
 * the frozen runtime vocabulary first so an unknown name cannot be waved through as "some
 * command", and the marker is then required: before the activation commits there is no marker
 * and every v2 command is refused CUTOVER_V2_NOT_ACTIVE.
 */
export function admitV2AuthoritativeCommand(
  store: CutoverMarkerStore,
  input: Readonly<{ commandKind: string; projectId: string }>,
): CutoverV2AuthorityResult {
  if (!COMMAND_KIND_SET.has(input.commandKind)) return refuse("CUTOVER_V2_COMMAND_UNKNOWN");
  const marker = readCutoverActivationMarker(store, { projectId: input.projectId });
  if (marker === null) return refuse("CUTOVER_V2_NOT_ACTIVE");
  return Object.freeze({
    commandKind: input.commandKind as RuntimeCommandKind,
    marker,
    ok: true as const,
  });
}
