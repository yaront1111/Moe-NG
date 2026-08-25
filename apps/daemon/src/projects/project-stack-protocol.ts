import { isAbsolute, win32 } from "node:path";

export const PROJECT_STACK_PROTOCOL_VERSION = "moe-project-stack/2" as const;
export const PROJECT_STACK_PROTOCOL_LAYER = "PROJECT_STACK_PROTOCOL" as const;
export const PROJECT_STACK_PROTOCOL_MALFORMED = "PROJECT_STACK_PROTOCOL_MALFORMED" as const;
export const PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE
  = "PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE" as const;
export const MAX_PROJECT_STACK_FRAME_BYTES = 16 * 1024;

type ProtocolCode =
  | typeof PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE
  | typeof PROJECT_STACK_PROTOCOL_MALFORMED;

export interface ProjectStackProtocolRefused {
  readonly code: ProtocolCode;
  readonly layer: typeof PROJECT_STACK_PROTOCOL_LAYER;
  readonly ok: false;
}

export type ProjectStackControlFrame =
  | Readonly<{
    confirmationLabel: string;
    instanceId: string;
    kind: "APPROVE_PAIRING";
    schemaVersion: typeof PROJECT_STACK_PROTOCOL_VERSION;
  }>
  | Readonly<{
    instanceId: string;
    kind: "STOP";
    schemaVersion: typeof PROJECT_STACK_PROTOCOL_VERSION;
  }>;

export type ProjectStackHostFrame =
  | Readonly<{
    code: string;
    incarnationId: string;
    kind: "START_REFUSED";
    layer: string;
    schemaVersion: typeof PROJECT_STACK_PROTOCOL_VERSION;
  }>
  | Readonly<{
    incarnationId: string;
    instanceId: string;
    kind: "READY";
    origin: string;
    projectId: string;
    schemaVersion: typeof PROJECT_STACK_PROTOCOL_VERSION;
    storePath: string;
  }>
  | Readonly<{
    incarnationId: string;
    instanceId: string;
    kind: "PAIRING_APPROVED";
    schemaVersion: typeof PROJECT_STACK_PROTOCOL_VERSION;
  }>
  | Readonly<{
    code: string;
    incarnationId: string;
    instanceId: string;
    kind: "PAIRING_REFUSED";
    layer: string;
    schemaVersion: typeof PROJECT_STACK_PROTOCOL_VERSION;
  }>
  | Readonly<{
    exitCode: number;
    incarnationId: string;
    instanceId: string;
    kind: "TERMINAL";
    schemaVersion: typeof PROJECT_STACK_PROTOCOL_VERSION;
  }>;

export type ProjectStackProtocolDecoded<T> =
  | ProjectStackProtocolRefused
  | Readonly<{ readonly frame: T; readonly ok: true }>;

export type ProjectStackProtocolEncoded =
  | ProjectStackProtocolRefused
  | Readonly<{ readonly line: string; readonly ok: true }>;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

function refuse(code: ProtocolCode = PROJECT_STACK_PROTOCOL_MALFORMED): ProjectStackProtocolRefused {
  return Object.freeze({ code, layer: PROJECT_STACK_PROTOCOL_LAYER, ok: false });
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).toSorted();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

const uuid = (value: unknown): value is string => typeof value === "string" && UUID_V4.test(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER.test(value);
const reason = (value: unknown): value is string => typeof value === "string" && REASON.test(value);

function localAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 2
    && value.length <= 4096
    && !value.includes("\0")
    && (isAbsolute(value) || win32.isAbsolute(value));
}

function loopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.port === String(port)
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      && parsed.origin === value;
  } catch {
    return false;
  }
}

function decodeControl(value: unknown): ProjectStackControlFrame | null {
  const record = recordOf(value);
  if (record === null || record["schemaVersion"] !== PROJECT_STACK_PROTOCOL_VERSION
    || !uuid(record["instanceId"])) return null;
  if (record["kind"] === "STOP"
    && exactKeys(record, ["instanceId", "kind", "schemaVersion"])) {
    return Object.freeze({
      instanceId: record["instanceId"], kind: "STOP",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
  }
  if (record["kind"] === "APPROVE_PAIRING"
    && exactKeys(record, ["confirmationLabel", "instanceId", "kind", "schemaVersion"])
    && typeof record["confirmationLabel"] === "string"
    && CONFIRMATION_LABEL.test(record["confirmationLabel"])) {
    return Object.freeze({
      confirmationLabel: record["confirmationLabel"], instanceId: record["instanceId"],
      kind: "APPROVE_PAIRING", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
  }
  return null;
}

function decodeHost(value: unknown): ProjectStackHostFrame | null {
  const record = recordOf(value);
  if (record === null || record["schemaVersion"] !== PROJECT_STACK_PROTOCOL_VERSION) return null;
  switch (record["kind"]) {
    case "START_REFUSED":
      if (!exactKeys(record, ["code", "incarnationId", "kind", "layer", "schemaVersion"])
        || !uuid(record["incarnationId"]) || !reason(record["code"]) || !reason(record["layer"])) {
        return null;
      }
      return Object.freeze(record) as ProjectStackHostFrame;
    case "READY":
      if (!exactKeys(record, [
        "incarnationId", "instanceId", "kind", "origin", "projectId", "schemaVersion", "storePath",
      ]) || !uuid(record["incarnationId"]) || !uuid(record["instanceId"])
        || !identifier(record["projectId"]) || !loopbackOrigin(record["origin"])
        || !localAbsolutePath(record["storePath"])) return null;
      return Object.freeze(record) as ProjectStackHostFrame;
    case "PAIRING_APPROVED":
      if (!exactKeys(record, ["incarnationId", "instanceId", "kind", "schemaVersion"])
        || !uuid(record["incarnationId"]) || !uuid(record["instanceId"])) return null;
      return Object.freeze(record) as ProjectStackHostFrame;
    case "PAIRING_REFUSED":
      if (!exactKeys(record, [
        "code", "incarnationId", "instanceId", "kind", "layer", "schemaVersion",
      ]) || !uuid(record["incarnationId"]) || !uuid(record["instanceId"])
        || !reason(record["code"]) || !reason(record["layer"])) return null;
      return Object.freeze(record) as ProjectStackHostFrame;
    case "TERMINAL":
      if (!exactKeys(record, ["exitCode", "incarnationId", "instanceId", "kind", "schemaVersion"])
        || !uuid(record["incarnationId"]) || !uuid(record["instanceId"])
        || !Number.isSafeInteger(record["exitCode"])
        || (record["exitCode"] as number) < 0 || (record["exitCode"] as number) > 0xffff_ffff) return null;
      return Object.freeze(record) as ProjectStackHostFrame;
    default:
      return null;
  }
}

function bytesOf(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? encoder.encode(input) : input;
}

function decodeLine<T>(
  input: string | Uint8Array,
  decode: (value: unknown) => T | null,
): ProjectStackProtocolDecoded<T> {
  const bytes = bytesOf(input);
  if (bytes.byteLength > MAX_PROJECT_STACK_FRAME_BYTES) {
    return refuse(PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE);
  }
  let line: string;
  try {
    line = decoder.decode(bytes);
  } catch {
    return refuse();
  }
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line === "" || line.includes("\n") || line.includes("\r")) return refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return refuse();
  }
  const frame = decode(parsed);
  return frame === null ? refuse() : Object.freeze({ frame, ok: true });
}

function encodeFrame<T>(frame: T, decode: (value: unknown) => T | null): ProjectStackProtocolEncoded {
  if (decode(frame) === null) return refuse();
  const line = `${JSON.stringify(frame)}\n`;
  return encoder.encode(line).byteLength > MAX_PROJECT_STACK_FRAME_BYTES
    ? refuse(PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE)
    : Object.freeze({ line, ok: true });
}

export const decodeProjectStackControlLine = (
  input: string | Uint8Array,
): ProjectStackProtocolDecoded<ProjectStackControlFrame> => decodeLine(input, decodeControl);

export const decodeProjectStackHostLine = (
  input: string | Uint8Array,
): ProjectStackProtocolDecoded<ProjectStackHostFrame> => decodeLine(input, decodeHost);

export const encodeProjectStackControlFrame = (
  frame: ProjectStackControlFrame,
): ProjectStackProtocolEncoded => encodeFrame(frame, decodeControl);

export const encodeProjectStackHostFrame = (
  frame: ProjectStackHostFrame,
): ProjectStackProtocolEncoded => encodeFrame(frame, decodeHost);
