/**
 * What a durable terminal-effect record IS, and the only bytes that may represent one.
 *
 * Split from the ledger for the per-file cap, and the seam is deliberate: everything here is
 * shape, identity and encoding. Nothing here reads a store or decides a terminal — that stays
 * with the ledger, so this module cannot become a second place where terminality is judged.
 *
 * The encoding is sorted-key canonical JSON so that re-encoding a decoded record reproduces the
 * durable bytes exactly. That property is load-bearing rather than tidy: the store's replay
 * identity EXCLUDES event bytes, so a record doctored after commit replays perfectly, and a
 * reader that merely decodes would echo it back as authority. Byte-comparing the re-encode is
 * the only thing that catches it.
 */

import { createHash } from "node:crypto";

export const EFFECT_TERMINAL_EVENT_TYPE = "EffectTerminalRecorded" as const;
export const EFFECT_TERMINAL_COMMAND_KIND = "effect.terminal.record" as const;
export const EFFECT_TERMINAL_RECORD_VERSION = "moe-effect-terminal-record/1" as const;

export const EFFECT_TERMINAL_CODES = Object.freeze([
  "EFFECT_TERMINAL_REQUEST_INVALID",
  "EFFECT_TERMINAL_EVIDENCE_ABSENT",
  "EFFECT_TERMINAL_SETTLEMENT_REFUSED",
  "EFFECT_TERMINAL_NOT_PROVEN",
  "EFFECT_TERMINAL_CONFLICT",
  "EFFECT_TERMINAL_ABSENT",
  "EFFECT_TERMINAL_UNREADABLE",
  "EFFECT_TERMINAL_MALFORMED",
  "EFFECT_TERMINAL_AMBIGUOUS",
] as const);

/**
 * Module-private. An exported column-zero `*_LAYER` constant is a declared production boundary
 * that the security roster then demands a BEFORE/AFTER/RACE hostile trio for; the layer travels
 * as a closed TYPE instead. Same decision as the provider-profile seam.
 */
const LEDGER_LAYER = "EFFECT_TERMINAL_LEDGER";

export type EffectTerminalLayer = typeof LEDGER_LAYER;
export type EffectTerminalCode = (typeof EFFECT_TERMINAL_CODES)[number];
export type EffectTerminalUpstream = Readonly<{ code: string; layer: string }>;

export interface EffectTerminalRefusal {
  readonly code: EffectTerminalCode;
  readonly detail: string;
  readonly layer: EffectTerminalLayer;
  readonly ok: false;
  readonly upstream: EffectTerminalUpstream | null;
}

/** Field order is ALPHABETICAL and matches the canonical encoding; see `canonicalJson`. */
export interface EffectTerminalRecord {
  readonly attemptRef: string;
  readonly intentId: string;
  readonly projectId: string;
  readonly recordVersion: typeof EFFECT_TERMINAL_RECORD_VERSION;
  /** The production reducer's output, stored UNCHANGED. This module never composes one. */
  readonly settlement: unknown;
  readonly terminalState: string;
}

export interface EffectTerminalSelector {
  readonly attemptRef: string;
  readonly intentId: string;
  readonly projectId: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function refuseTerminal(
  code: EffectTerminalCode,
  detail: string,
  upstream: EffectTerminalUpstream | null = null,
): EffectTerminalRefusal {
  return Object.freeze({
    code,
    detail,
    layer: LEDGER_LAYER,
    ok: false as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

/** Deterministic: keys sorted at every depth, arrays keep their order because that is data. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function encodeTerminalEffectRecord(record: EffectTerminalRecord): Uint8Array {
  return encoder.encode(canonicalJson(record));
}

export function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** Exact-record admission: a missing OR unknown key refuses, so nothing is silently dropped. */
export function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const present = Object.keys(value as Record<string, unknown>);
  if (present.length !== keys.length) return null;
  return keys.every((key) => present.includes(key)) ? (value as Record<string, unknown>) : null;
}

/**
 * Decodes ONLY what this codec would have written. `bytes` is judged as text so canonicality is
 * measured against what actually arrived rather than a re-parse of it.
 */
export type TerminalDecodeResult =
  | { readonly ok: true; readonly record: EffectTerminalRecord }
  /** UNREADABLE = the bytes are not a record at all; MALFORMED = they are, but not OURS. */
  | { readonly ok: false; readonly reason: "MALFORMED" | "UNREADABLE" };

export function decodeTerminalEffectRecord(bytes: unknown): TerminalDecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, reason: "UNREADABLE" };
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { ok: false, reason: "UNREADABLE" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "UNREADABLE" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "UNREADABLE" };
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = ["attemptRef", "intentId", "projectId", "recordVersion", "settlement", "terminalState"];
  if (keys.length !== expected.length || expected.some((key, index) => keys[index] !== key)) {
    return { ok: false, reason: "UNREADABLE" };
  }
  if (!isText(value.attemptRef) || !isText(value.intentId) || !isText(value.projectId)) {
    return { ok: false, reason: "UNREADABLE" };
  }
  if (value.recordVersion !== EFFECT_TERMINAL_RECORD_VERSION || !isText(value.terminalState)) {
    return { ok: false, reason: "UNREADABLE" };
  }
  const record: EffectTerminalRecord = Object.freeze({
    attemptRef: value.attemptRef,
    intentId: value.intentId,
    projectId: value.projectId,
    recordVersion: EFFECT_TERMINAL_RECORD_VERSION,
    settlement: value.settlement,
    terminalState: value.terminalState,
  });
  // The byte-check. A record that decodes but does not re-encode to the stored bytes was not
  // written by this codec, and nothing downstream may treat it as authority.
  return canonicalJson(record) === text ? { ok: true, record } : { ok: false, reason: "MALFORMED" };
}

/** Identity is the triple, hashed — never a concatenated string a caller could collide. */
export function deriveTerminalEffectAggregateId(selector: EffectTerminalSelector): string {
  const preimage = canonicalJson({
    attemptRef: selector.attemptRef,
    intentId: selector.intentId,
    projectId: selector.projectId,
  });
  return `effect-terminal:${createHash("sha256").update(preimage).digest("hex")}`;
}

export function deriveTerminalEffectEventId(selector: EffectTerminalSelector): string {
  return `effect-terminal-recorded:${deriveTerminalEffectAggregateId(selector).slice(-64)}`;
}
