/**
 * The editor-neutral IDE adapter contract: the ONE boundary every IDE adapter
 * implements — discover a running daemon, start one when absent, open the
 * control room (embedded, or browser fallback).
 *
 * THIS PACKAGE DECLARES A BOUNDARY AND CERTIFIES NOTHING. It spawns no process,
 * launches no browser, opens no socket and proves no IDE works. Every operation
 * here is a pure function from injected port evidence to a typed result; the
 * real I/O lives behind the port interfaces, in the adapters that implement them.
 *
 * Consumers, named by task id per global rail Clause 1. They are named by id and
 * not by editor: naming the editor here would make this file that editor's
 * adapter, which is exactly what the boundary exists to prevent.
 * - task-9fd52b41 IMPLEMENTS this contract as a thin editor adapter, in the
 *   sibling package it owns. It supplies the ports; it does not restate the codes.
 * - task-05ce9b8f (Security fault matrix) SCHEDULES hostile, stale and replay
 *   cases against this declared boundary, and was blocked on its absence.
 *
 * Fail-closed rule, binding on every operation: evidence that cannot establish an
 * outcome yields UNKNOWN carrying its reason, never an optimistic success. A
 * daemon claimed to be listening without an endpoint, and a process launched
 * without confirmed listening, are both UNKNOWN.
 */

/** The layer label for a refusal this contract itself makes, rather than a port. */
export const IDE_ADAPTER_LAYER = "IDE_ADAPTER" as const;

/** Every layer that may refuse. More than one, so "which layer" is a real answer. */
export const IDE_ADAPTER_LAYERS = Object.freeze([
  "IDE_ADAPTER",
  "DAEMON_DISCOVERY_PORT",
  "DAEMON_START_PORT",
  "CONTROL_ROOM_OPEN_PORT",
] as const);

export type IdeAdapterLayer = (typeof IDE_ADAPTER_LAYERS)[number];

/** The frozen stable reason-code vocabulary. Every entry is producible below. */
export const IDE_ADAPTER_REASON_CODES = Object.freeze([
  "DAEMON_RUNNING",
  "DAEMON_ABSENT",
  "DAEMON_STATE_UNKNOWN",
  "DAEMON_DISCOVERY_REFUSED",
  "DAEMON_ENDPOINT_MISSING",
  "DAEMON_STARTED",
  "DAEMON_START_UNVERIFIED",
  "DAEMON_START_REFUSED",
  "CONTROL_ROOM_EMBEDDED",
  "CONTROL_ROOM_BROWSER_FALLBACK",
  "CONTROL_ROOM_ASSETS_MISSING",
  "CONTROL_ROOM_BROWSER_REFUSED",
  "CONTROL_ROOM_OPEN_UNKNOWN",
  "EVIDENCE_MALFORMED",
] as const);

export type IdeAdapterReasonCode = (typeof IDE_ADAPTER_REASON_CODES)[number];

export interface IdeAdapterSuccess {
  readonly code: IdeAdapterReasonCode;
  readonly detail: string;
  readonly outcome: "OK";
}

/** A refusal names its code AND the layer that refused. UNKNOWN is a failure. */
export interface IdeAdapterFailure {
  readonly code: IdeAdapterReasonCode;
  readonly detail: string;
  readonly layer: IdeAdapterLayer;
  readonly outcome: "REFUSED" | "UNKNOWN";
}

export type IdeAdapterResult = IdeAdapterFailure | IdeAdapterSuccess;

export type DaemonDiscoveryEvidence =
  | { readonly endpoint: string | null; readonly status: "LISTENING" }
  | { readonly status: "NOT_LISTENING" }
  | { readonly detail: string; readonly status: "UNDETERMINED" }
  | { readonly detail: string; readonly status: "REFUSED" };

export type DaemonStartEvidence =
  | { readonly endpoint: string | null; readonly status: "LISTENING_CONFIRMED" }
  | { readonly detail: string; readonly status: "LAUNCHED_UNCONFIRMED" }
  | { readonly detail: string; readonly status: "REFUSED" };

export interface BrowserFallbackEvidence {
  readonly detail: string;
  readonly status: "OPENED" | "REFUSED" | "UNDETERMINED";
}

export type ControlRoomOpenEvidence =
  | { readonly assets: "ABSENT"; readonly detail: string }
  | { readonly assets: "PRESENT"; readonly embedded: "OPENED" }
  | {
    readonly assets: "PRESENT";
    readonly browser: BrowserFallbackEvidence;
    readonly embedded: "UNAVAILABLE";
  };

/** Implemented by an IDE adapter. This package never implements a port. */
export interface DaemonDiscoveryPort {
  readonly probeDaemon: () => Promise<DaemonDiscoveryEvidence>;
}

export interface DaemonStartPort {
  readonly startDaemon: () => Promise<DaemonStartEvidence>;
}

export interface ControlRoomOpenPort {
  readonly openControlRoom: () => Promise<ControlRoomOpenEvidence>;
}

export interface IdeAdapterPorts {
  readonly controlRoom: ControlRoomOpenPort;
  readonly discovery: DaemonDiscoveryPort;
  readonly start: DaemonStartPort;
}

const ENDPOINT_MISSING_DETAIL = "listening was claimed without an endpoint";
const NO_DETAIL = "no detail was provided";

const ok = (code: IdeAdapterReasonCode, detail: string): IdeAdapterSuccess =>
  Object.freeze({ code, detail, outcome: "OK" as const });

const refused = (
  code: IdeAdapterReasonCode,
  detail: string,
  layer: IdeAdapterLayer,
): IdeAdapterFailure => Object.freeze({ code, detail, layer, outcome: "REFUSED" as const });

const unknown = (
  code: IdeAdapterReasonCode,
  detail: string,
  layer: IdeAdapterLayer,
): IdeAdapterFailure => Object.freeze({ code, detail, layer, outcome: "UNKNOWN" as const });

/**
 * Evidence crosses a boundary from a foreign editor runtime that does not honour
 * these types, so every operation ends here rather than trusting its input.
 */
const malformed = (detail: string): IdeAdapterFailure =>
  refused("EVIDENCE_MALFORMED", detail, IDE_ADAPTER_LAYER);

const detailOf = (value: unknown): string =>
  typeof value === "string" && value.trim().length > 0 ? value : NO_DETAIL;

const endpointOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const readBrowser = (value: unknown): BrowserFallbackEvidence | null => {
  const candidate = value as Partial<BrowserFallbackEvidence> | null | undefined;
  const status = candidate?.status;
  return status === "OPENED" || status === "REFUSED" || status === "UNDETERMINED"
    ? { detail: detailOf(candidate?.detail), status }
    : null;
};

/**
 * DISCOVER. A determinate absence (DAEMON_ABSENT) is a success — it is what
 * licenses a start. Only an established, addressable daemon is DAEMON_RUNNING.
 */
export function decideDaemonDiscovery(evidence: DaemonDiscoveryEvidence): IdeAdapterResult {
  if (evidence.status === "LISTENING") {
    const endpoint = endpointOf(evidence.endpoint);
    return endpoint === null
      ? unknown("DAEMON_ENDPOINT_MISSING", ENDPOINT_MISSING_DETAIL, IDE_ADAPTER_LAYER)
      : ok("DAEMON_RUNNING", endpoint);
  }
  if (evidence.status === "NOT_LISTENING") return ok("DAEMON_ABSENT", "no daemon is listening");
  if (evidence.status === "UNDETERMINED") {
    return unknown("DAEMON_STATE_UNKNOWN", detailOf(evidence.detail), "DAEMON_DISCOVERY_PORT");
  }
  if (evidence.status === "REFUSED") {
    return refused("DAEMON_DISCOVERY_REFUSED", detailOf(evidence.detail), "DAEMON_DISCOVERY_PORT");
  }
  return malformed("unrecognised daemon discovery evidence");
}

/**
 * START. A launched process is not a started daemon: without confirmed listening
 * the outcome is UNKNOWN, so a caller cannot mistake a spawn for a service.
 */
export function decideDaemonStart(evidence: DaemonStartEvidence): IdeAdapterResult {
  if (evidence.status === "LISTENING_CONFIRMED") {
    const endpoint = endpointOf(evidence.endpoint);
    return endpoint === null
      ? unknown("DAEMON_ENDPOINT_MISSING", ENDPOINT_MISSING_DETAIL, IDE_ADAPTER_LAYER)
      : ok("DAEMON_STARTED", endpoint);
  }
  if (evidence.status === "LAUNCHED_UNCONFIRMED") {
    return unknown("DAEMON_START_UNVERIFIED", detailOf(evidence.detail), IDE_ADAPTER_LAYER);
  }
  if (evidence.status === "REFUSED") {
    return refused("DAEMON_START_REFUSED", detailOf(evidence.detail), "DAEMON_START_PORT");
  }
  return malformed("unrecognised daemon start evidence");
}

/**
 * OPEN. An unavailable embedded view is not a failure: it is the browser
 * fallback, and that fallback succeeding is a success outcome of its own.
 */
export function decideControlRoomOpen(evidence: ControlRoomOpenEvidence): IdeAdapterResult {
  if (evidence.assets === "ABSENT") {
    return refused(
      "CONTROL_ROOM_ASSETS_MISSING",
      detailOf(evidence.detail),
      "CONTROL_ROOM_OPEN_PORT",
    );
  }
  if (evidence.assets !== "PRESENT") return malformed("unrecognised control room open evidence");
  if (evidence.embedded === "OPENED") return ok("CONTROL_ROOM_EMBEDDED", "embedded view opened");
  if (evidence.embedded !== "UNAVAILABLE") {
    return malformed("unrecognised control room open evidence");
  }
  const browser = readBrowser(evidence.browser);
  if (browser === null) return malformed("unrecognised control room open evidence");
  if (browser.status === "OPENED") {
    return ok("CONTROL_ROOM_BROWSER_FALLBACK", browser.detail);
  }
  return browser.status === "REFUSED"
    ? refused("CONTROL_ROOM_BROWSER_REFUSED", browser.detail, "CONTROL_ROOM_OPEN_PORT")
    : unknown("CONTROL_ROOM_OPEN_UNKNOWN", browser.detail, IDE_ADAPTER_LAYER);
}
