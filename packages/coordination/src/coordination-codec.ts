import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

import {
  COORDINATION_CONTROL_KINDS, COORDINATION_ENVELOPE_KINDS, COORDINATION_ENVELOPE_VERSION,
  COORDINATION_LIMITS,
} from "./coordination-contracts.js";
import type {
  CoordinationCode, CoordinationEnvelope, CoordinationEnvelopeKind,
} from "./coordination-contracts.js";
import {
  bad, decodeAddress, decodeAdvisory, decodeData, decodeHandoff,
} from "./coordination-parts.js";
import type { PartResult } from "./coordination-parts.js";
import {
  hasExactOwnKeys, isIdentifier, isPlainRecord, isSafeCount, readOwnDataProperty, textBytes,
} from "./coordination-shape.js";

export interface CoordinationDecodeOk {
  readonly canonicalBytes: Uint8Array;
  readonly digest: string;
  readonly envelope: CoordinationEnvelope;
  readonly ok: true;
}
/** Every codec refusal is a DECODE-layer refusal; the layer is carried so a caller can
 *  attribute it without knowing which module answered. */
export interface CoordinationDecodeError {
  readonly code: CoordinationCode; readonly detail: string; readonly layer: "DECODE";
  readonly ok: false;
}
export type CoordinationDecodeResult = CoordinationDecodeError | CoordinationDecodeOk;

const BASE_KEYS = [
  "advisory", "correlationId", "data", "kind", "messageId", "recipient", "sender",
  "ttlMilliseconds",
] as const;

function keysFor(kind: CoordinationEnvelopeKind): readonly string[] {
  if (kind === "RESPONSE") return [...BASE_KEYS, "inReplyTo"];
  if (kind === "CONTROL") return [...BASE_KEYS, "control"];
  if (kind === "HANDOFF") return [...BASE_KEYS, "handoff"];
  return BASE_KEYS;
}

function fail(code: CoordinationCode, detail: string): CoordinationDecodeError {
  return Object.freeze({ code, detail, layer: "DECODE" as const, ok: false as const });
}

function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const read = readOwnDataProperty(record, key);
  return read.ok && read.present ? read.value : undefined;
}

/**
 * Canonical JSON: object keys in code-unit order, no whitespace, finite numbers only. The
 * bytes are a pure function of the caller-owned envelope fields, so an identical resend
 * hashes identically no matter when it arrives — which is what makes dedupe exact.
 */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonObject;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`);
  return `{${parts.join(",")}}`;
}

function envelopeToJson(envelope: CoordinationEnvelope): JsonValue {
  const record: Record<string, JsonValue> = {
    advisory: envelope.advisory === null
      ? null
      : { advisoryOnly: true, text: envelope.advisory.text },
    correlationId: envelope.correlationId,
    data: envelope.data,
    kind: envelope.kind,
    messageId: envelope.messageId,
    recipient: { ...envelope.recipient },
    sender: { ...envelope.sender },
    ttlMilliseconds: envelope.ttlMilliseconds,
    version: COORDINATION_ENVELOPE_VERSION,
  };
  if (envelope.kind === "RESPONSE") record["inReplyTo"] = envelope.inReplyTo;
  if (envelope.kind === "CONTROL") record["control"] = envelope.control;
  if (envelope.kind === "HANDOFF") {
    record["handoff"] = { ...envelope.handoff } as unknown as JsonValue;
  }
  return record;
}

export function canonicalEnvelopeBytes(envelope: CoordinationEnvelope): Uint8Array {
  return textBytes(canonicalJson(envelopeToJson(envelope)));
}

export function digestBytes(domain: string, ...parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  const header = Buffer.allocUnsafe(8);
  hash.update(textBytes(domain));
  for (const part of parts) {
    header.writeBigUInt64BE(BigInt(part.byteLength));
    hash.update(header);
    hash.update(part);
  }
  return hash.digest("hex");
}

function readTtl(raw: unknown): PartResult<number> {
  if (!isSafeCount(raw) || raw < COORDINATION_LIMITS.minTtlMilliseconds) {
    return bad(
      "COORDINATION_INPUT_INVALID",
      `ttlMilliseconds must be an integer of at least ${COORDINATION_LIMITS.minTtlMilliseconds}`,
    );
  }
  if (raw > COORDINATION_LIMITS.maxTtlMilliseconds) {
    return bad("COORDINATION_LIMIT_EXCEEDED", "ttlMilliseconds exceeds the supported window");
  }
  return Object.freeze({ ok: true as const, value: raw });
}

function readKindExtras(
  kind: CoordinationEnvelopeKind, record: Readonly<Record<string, unknown>>,
): PartResult<Record<string, unknown>> {
  if (kind === "RESPONSE") {
    const inReplyTo = own(record, "inReplyTo");
    return isIdentifier(inReplyTo, COORDINATION_LIMITS.maxIdentifierUtf8Bytes)
      ? Object.freeze({ ok: true as const, value: { inReplyTo } })
      : bad("COORDINATION_INPUT_INVALID", "inReplyTo must be a valid message identifier");
  }
  if (kind === "CONTROL") {
    const control = own(record, "control");
    return COORDINATION_CONTROL_KINDS.includes(control as never)
      ? Object.freeze({ ok: true as const, value: { control } })
      : bad("COORDINATION_INPUT_INVALID", "control is not a known coordination control kind");
  }
  if (kind === "HANDOFF") {
    const handoff = decodeHandoff(own(record, "handoff"));
    return handoff.ok
      ? Object.freeze({ ok: true as const, value: { handoff: handoff.value } })
      : handoff;
  }
  return Object.freeze({ ok: true as const, value: {} });
}

/** Decodes hostile input into a deeply frozen envelope plus its canonical bytes and digest. */
export function decodeCoordinationEnvelope(input: unknown): CoordinationDecodeResult {
  if (!isPlainRecord(input)) {
    return fail("COORDINATION_INPUT_INVALID", "the envelope must be a plain data record");
  }
  const kind = own(input, "kind");
  if (!COORDINATION_ENVELOPE_KINDS.includes(kind as never)) {
    return fail("COORDINATION_INPUT_INVALID", "kind is not a known coordination envelope kind");
  }
  const envelopeKind = kind as CoordinationEnvelopeKind;
  if (!hasExactOwnKeys(input, keysFor(envelopeKind))) {
    return fail(
      "COORDINATION_INPUT_INVALID",
      "the envelope key set must match its kind exactly; sequence and timestamps are server-owned",
    );
  }
  const assembled = assemble(envelopeKind, input);
  if (!assembled.ok) return fail(assembled.code, assembled.detail);
  return finish(assembled.value);
}

function assemble(
  kind: CoordinationEnvelopeKind, input: Readonly<Record<string, unknown>>,
): PartResult<CoordinationEnvelope> {
  const messageId = readIdentifier(own(input, "messageId"), "messageId");
  if (!messageId.ok) return messageId;
  const correlationId = readIdentifier(own(input, "correlationId"), "correlationId");
  if (!correlationId.ok) return correlationId;
  const sender = decodeAddress(own(input, "sender"), "sender");
  if (!sender.ok) return sender;
  const recipient = decodeAddress(own(input, "recipient"), "recipient");
  if (!recipient.ok) return recipient;
  const advisory = decodeAdvisory(own(input, "advisory"));
  if (!advisory.ok) return advisory;
  const data = decodeData(own(input, "data"));
  if (!data.ok) return data;
  const ttl = readTtl(own(input, "ttlMilliseconds"));
  if (!ttl.ok) return ttl;
  const extras = readKindExtras(kind, input);
  if (!extras.ok) return extras;
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      advisory: advisory.value, correlationId: correlationId.value, data: data.value, kind,
      messageId: messageId.value, recipient: recipient.value, sender: sender.value,
      ttlMilliseconds: ttl.value, ...extras.value,
    }) as unknown as CoordinationEnvelope,
  });
}

/** An over-long identifier is a LIMIT failure; any other malformation is an INPUT failure.
 *  The two are distinct so a caller can tell "too big" from "wrong shape". */
function readIdentifier(raw: unknown, label: string): PartResult<string> {
  const limit = COORDINATION_LIMITS.maxIdentifierUtf8Bytes;
  if (typeof raw === "string" && raw.length > limit) {
    return bad("COORDINATION_LIMIT_EXCEEDED", `${label} exceeds the identifier byte budget`);
  }
  if (!isIdentifier(raw, limit)) {
    return bad("COORDINATION_INPUT_INVALID", `${label} is not a valid identifier`);
  }
  return Object.freeze({ ok: true as const, value: raw });
}

/** Final independent gate: re-decode the canonical bytes through the shared bounded JSON
 *  decoder, so envelope size and Unicode validity are proven on the exact durable bytes. */
function finish(envelope: CoordinationEnvelope): CoordinationDecodeResult {
  const canonicalBytes = canonicalEnvelopeBytes(envelope);
  if (canonicalBytes.byteLength > COORDINATION_LIMITS.maxEnvelopeBytes) {
    return fail("COORDINATION_LIMIT_EXCEEDED", "the canonical envelope exceeds the byte budget");
  }
  const reread = decodeBoundedJsonBytes(canonicalBytes);
  if (!reread.ok) {
    return fail("COORDINATION_INPUT_INVALID", "the canonical envelope failed bounded re-decode");
  }
  return Object.freeze({
    canonicalBytes, digest: digestBytes(COORDINATION_ENVELOPE_VERSION, canonicalBytes),
    envelope, ok: true as const,
  });
}

/** Re-reads durable bytes. A stored envelope that no longer decodes is a corruption signal,
 *  never a silently repaired value. */
export function decodeStoredEnvelope(bytes: Uint8Array): CoordinationEnvelope | null {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !isPlainRecord(decoded.value)) return null;
  const record = { ...decoded.value } as Record<string, unknown>;
  if (record["version"] !== COORDINATION_ENVELOPE_VERSION) return null;
  delete record["version"];
  const result = decodeCoordinationEnvelope(record);
  return result.ok ? result.envelope : null;
}
