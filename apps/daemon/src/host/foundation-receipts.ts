/**
 * The receipts a Foundation host process publishes: one READY line when the
 * transport is composed and one SHUTDOWN line when the drain completes. A
 * supervisor (J3) reads them to learn WHICH process, for WHICH project, over
 * WHICH store became ready, and that the process stopped on purpose rather than
 * died.
 *
 * PURE BY CONSTRUCTION. This module holds no clock, no filesystem handle and no
 * store handle: every identity and every instant arrives as a validated input,
 * so "deterministic" is a property of the type rather than a promise in a
 * comment — two builds over identical inputs encode to identical bytes. The
 * entries own their own clock read, exactly as every other durable stamp in this
 * repo does.
 *
 * Fails closed: an absent identity, an unusable instant, a trigger outside the
 * closed list, a shutdown before readiness, and a SECOND shutdown are each
 * refused BY NAME. The layer constant stays module-private on purpose — the
 * declared-boundary roster treats an exported `*_LAYER` as a public security
 * boundary, and this stamp types one module's own refusals.
 */

const FOUNDATION_RECEIPTS_LAYER = "FOUNDATION_RECEIPTS" as const;

/** Bumped when the wire shape below changes; a reader pins it. */
export const FOUNDATION_RECEIPT_SCHEMA_VERSION = "moe-foundation-receipt/1" as const;

/** Every refusal this module can emit. Closed, so a consumer switches exhaustively. */
export const FOUNDATION_RECEIPT_REFUSAL_CODES = Object.freeze([
  "FOUNDATION_RECEIPT_ALREADY_READY",
  "FOUNDATION_RECEIPT_ALREADY_STOPPED",
  "FOUNDATION_RECEIPT_INSTANT_INVALID",
  "FOUNDATION_RECEIPT_PROCESS_IDENTITY_INVALID",
  "FOUNDATION_RECEIPT_PROJECT_IDENTITY_ABSENT",
  "FOUNDATION_RECEIPT_SHUTDOWN_BEFORE_READY",
  "FOUNDATION_RECEIPT_SHUTDOWN_TRIGGER_INVALID",
  "FOUNDATION_RECEIPT_STORE_IDENTITY_ABSENT",
] as const);

export type FoundationReceiptRefusalCode = (typeof FOUNDATION_RECEIPT_REFUSAL_CODES)[number];

/** The host process shapes that publish receipts. One per shipped entry. */
export const FOUNDATION_HOST_ENTRIES = Object.freeze([
  "CONTROL_ROOM_HTTP",
  "MCP_HTTP",
  "MCP_STDIO",
] as const);

export type FoundationHostEntry = (typeof FOUNDATION_HOST_ENTRIES)[number];

/**
 * Why the drain ran. A value outside this list is refused, never published:
 * PROGRAMMATIC_STOP is what an in-process owner calling the drain directly gets,
 * and it stays distinct from a signal so a supervisor can tell them apart.
 */
export const FOUNDATION_SHUTDOWN_TRIGGERS = Object.freeze([
  "PROGRAMMATIC_STOP",
  "SIGINT",
  "SIGTERM",
  "TRANSPORT_CLOSED",
] as const);

export type FoundationShutdownTrigger = (typeof FOUNDATION_SHUTDOWN_TRIGGERS)[number];

export interface FoundationReadinessInput {
  readonly entry: FoundationHostEntry;
  /** UTC millisecond stamp, read by the CALLER: this module owns no clock. */
  readonly instant: string;
  readonly pid: number;
  readonly projectId: string;
  readonly storePath: string;
}

export interface FoundationShutdownInput extends FoundationReadinessInput {
  /** Typed as a plain string because it arrives from a signal name at runtime. */
  readonly trigger: string;
}

interface ReceiptIdentity {
  readonly entry: FoundationHostEntry;
  readonly instant: string;
  readonly pid: number;
  readonly projectId: string;
  readonly schemaVersion: typeof FOUNDATION_RECEIPT_SCHEMA_VERSION;
  readonly storePath: string;
}

export interface FoundationReadinessReceipt extends ReceiptIdentity {
  readonly kind: "READY";
}

export interface FoundationShutdownReceipt extends ReceiptIdentity {
  readonly kind: "SHUTDOWN";
  readonly trigger: FoundationShutdownTrigger;
}

export type FoundationReceipt = FoundationReadinessReceipt | FoundationShutdownReceipt;

export interface FoundationReceiptRefused {
  readonly code: FoundationReceiptRefusalCode;
  readonly layer: typeof FOUNDATION_RECEIPTS_LAYER;
  readonly ok: false;
}

export type FoundationReceiptResult<T extends FoundationReceipt> =
  | FoundationReceiptRefused
  | { readonly ok: true; readonly receipt: T };

export type FoundationPublishResult =
  | FoundationReceiptRefused
  | { readonly ok: true; readonly line: string };

function refuse(code: FoundationReceiptRefusalCode): FoundationReceiptRefused {
  return Object.freeze({ code, layer: FOUNDATION_RECEIPTS_LAYER, ok: false } as const);
}

/** The repo's UTC millisecond stamp, matched by four other daemon modules. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function refuseIdentity(input: FoundationReadinessInput): FoundationReceiptRefused | null {
  // Order is deliberate: the durable identities first, so a host started against
  // no store is told THAT rather than being told about its clock.
  if (input.storePath === "") return refuse("FOUNDATION_RECEIPT_STORE_IDENTITY_ABSENT");
  if (input.projectId === "") return refuse("FOUNDATION_RECEIPT_PROJECT_IDENTITY_ABSENT");
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    return refuse("FOUNDATION_RECEIPT_PROCESS_IDENTITY_INVALID");
  }
  if (!ISO_INSTANT.test(input.instant) || Number.isNaN(Date.parse(input.instant))) {
    return refuse("FOUNDATION_RECEIPT_INSTANT_INVALID");
  }
  return null;
}

function identityOf(input: FoundationReadinessInput): ReceiptIdentity {
  return {
    entry: input.entry,
    instant: input.instant,
    pid: input.pid,
    projectId: input.projectId,
    schemaVersion: FOUNDATION_RECEIPT_SCHEMA_VERSION,
    storePath: input.storePath,
  };
}

export function buildReadinessReceipt(
  input: FoundationReadinessInput,
): FoundationReceiptResult<FoundationReadinessReceipt> {
  const refused = refuseIdentity(input);
  if (refused !== null) return refused;
  return Object.freeze({
    ok: true as const,
    receipt: Object.freeze({ ...identityOf(input), kind: "READY" as const }),
  });
}

function isTrigger(value: string): value is FoundationShutdownTrigger {
  return (FOUNDATION_SHUTDOWN_TRIGGERS as readonly string[]).includes(value);
}

export function buildShutdownReceipt(
  input: FoundationShutdownInput,
): FoundationReceiptResult<FoundationShutdownReceipt> {
  const refused = refuseIdentity(input);
  if (refused !== null) return refused;
  if (!isTrigger(input.trigger)) return refuse("FOUNDATION_RECEIPT_SHUTDOWN_TRIGGER_INVALID");
  return Object.freeze({
    ok: true as const,
    receipt: Object.freeze({
      ...identityOf(input), kind: "SHUTDOWN" as const, trigger: input.trigger,
    }),
  });
}

/**
 * One line, keys written in a FIXED order rather than left to object-literal
 * insertion order: the byte-identity property belongs to this function, so a
 * future field cannot reorder a receipt a supervisor already diffs.
 */
export function encodeReceipt(receipt: FoundationReceipt): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    entry: receipt.entry,
    pid: receipt.pid,
    projectId: receipt.projectId,
    storePath: receipt.storePath,
    instant: receipt.instant,
  };
  if (receipt.kind === "SHUTDOWN") ordered["trigger"] = receipt.trigger;
  return JSON.stringify(ordered);
}

export interface FoundationReceiptPublisher {
  publishReadiness(input: FoundationReadinessInput): FoundationPublishResult;
  publishShutdown(input: FoundationShutdownInput): FoundationPublishResult;
}

/**
 * The one stateful thing here, and it holds two booleans: a host publishes
 * readiness once and shuts down once. Both second attempts refuse rather than
 * pass silently — a duplicate usually means two owners believe they hold the
 * lifecycle, which is worth a code (the discipline `startDaemon` already keeps
 * for `DAEMON_ENTRY_ALREADY_STOPPED`).
 */
export function createFoundationReceiptPublisher(options: {
  readonly sink: (line: string) => void;
}): FoundationReceiptPublisher {
  let ready = false;
  let stopped = false;
  const publish = (line: string): FoundationPublishResult => {
    options.sink(line);
    return Object.freeze({ line, ok: true as const });
  };
  return Object.freeze({
    publishReadiness: (input: FoundationReadinessInput): FoundationPublishResult => {
      if (ready) return refuse("FOUNDATION_RECEIPT_ALREADY_READY");
      const built = buildReadinessReceipt(input);
      // A refused build never counts as published: the drain path stays closed,
      // so a broken identity cannot be laundered into a graceful shutdown.
      if (!built.ok) return built;
      ready = true;
      return publish(encodeReceipt(built.receipt));
    },
    publishShutdown: (input: FoundationShutdownInput): FoundationPublishResult => {
      if (!ready) return refuse("FOUNDATION_RECEIPT_SHUTDOWN_BEFORE_READY");
      if (stopped) return refuse("FOUNDATION_RECEIPT_ALREADY_STOPPED");
      const built = buildShutdownReceipt(input);
      if (!built.ok) return built;
      stopped = true;
      return publish(encodeReceipt(built.receipt));
    },
  });
}
