import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";

import {
  MAX_JSON_BODY_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_STRING_UTF8_BYTES,
} from "@moe/contracts";

/**
 * Internal (non-barrel) totality seam for live-quiesce evidence.
 *
 * Invariants, in order, because every later step assumes the earlier one held:
 *  1. Nothing here reads a user accessor, invokes a proxy trap, or iterates via
 *     `Symbol.iterator`. Proxies are refused before any reflective operation,
 *     because `Array.isArray` and `Object.getPrototypeOf` THROW on a revoked one.
 *  2. Traversal is iterative. A recursive walker dies with `RangeError` on deeply
 *     nested input, which is a caller-visible throw, not a refusal.
 *  3. Only OWN, ENUMERABLE, DATA descriptors on `Object.prototype`/null records and
 *     `Array.prototype` arrays are copied, so symbols, non-enumerables, inherited
 *     keys, sparse holes and extra array indices cannot smuggle state past the
 *     exact-key schema in cutover-quiesce-evidence.ts.
 *  4. Depth, node count and scalar UTF-8 length are bounded BEFORE the detached
 *     copy can grow, and the canonical body budget is checked BEFORE joining.
 */
export type LiveQuiesceSafeJson =
  | null | boolean | number | string
  | readonly LiveQuiesceSafeJson[]
  | { readonly [key: string]: LiveQuiesceSafeJson };

export type LiveQuiesceSafeValueIssue =
  | "PROXY" | "ACCESSOR" | "HOSTILE_SHAPE" | "ARRAY_SHAPE" | "CYCLE"
  | "DEPTH_LIMIT" | "WORK_LIMIT" | "STRING_LIMIT" | "BODY_LIMIT";

export type LiveQuiesceSafeValueRefusal = Readonly<{
  ok: false; issue: LiveQuiesceSafeValueIssue;
}>;

export type LiveQuiesceSafeValueResult =
  | LiveQuiesceSafeValueRefusal
  | Readonly<{ ok: true; value: LiveQuiesceSafeJson }>;

export type LiveQuiesceSafeCanonicalResult =
  | LiveQuiesceSafeValueRefusal
  | Readonly<{ ok: true; canonicalJson: string }>;

/** Every node costs at least two canonical bytes, so this bounds work by the body budget. */
const MAX_SAFE_VALUE_NODES = MAX_JSON_BODY_BYTES >> 1;

const refuse = (issue: LiveQuiesceSafeValueIssue): LiveQuiesceSafeValueRefusal =>
  Object.freeze({ ok: false, issue });

const utf8Length = (text: string): number => Buffer.byteLength(text, "utf8");

type MutableRecord = Record<string, LiveQuiesceSafeJson>;
type Container = LiveQuiesceSafeJson[] | MutableRecord;

interface Frame {
  readonly source: object;
  readonly target: Container;
  /** Own enumerable data keys for records; index strings for arrays. */
  readonly keys: readonly string[];
  cursor: number;
}

/** A scalar copy, a container to descend into, or the issue that refused it. */
type Admission =
  | { readonly step: "scalar"; readonly value: LiveQuiesceSafeJson }
  | { readonly step: "container"; readonly target: Container; readonly keys: readonly string[] }
  | { readonly step: "refused"; readonly issue: LiveQuiesceSafeValueIssue };

const scalar = (value: LiveQuiesceSafeJson): Admission => ({ step: "scalar", value });
const refused = (issue: LiveQuiesceSafeValueIssue): Admission => ({ step: "refused", issue });

function admitScalar(value: unknown): Admission {
  if (value === null || typeof value === "boolean") return scalar(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? scalar(value) : refused("HOSTILE_SHAPE");
  }
  if (typeof value === "string") {
    return utf8Length(value) > MAX_JSON_STRING_UTF8_BYTES
      ? refused("STRING_LIMIT") : scalar(value);
  }
  return refused("HOSTILE_SHAPE");
}

/**
 * Arrays must be `Array.prototype`-backed and densely indexed with no extra own keys.
 *
 * The key-count check and the per-slot presence check are BOTH required and neither
 * subsumes the other: `new Array(1)` fails only the count, while an array carrying a
 * hole plus one padding key has `ownKeys.length === length + 1` and fails only the
 * per-slot check. Both emit ARRAY_SHAPE rather than HOSTILE_SHAPE so that a hole
 * slipping through to be read as `undefined` — which the scalar fence would also
 * refuse — is still distinguishable from a hole refused here.
 */
function admitArray(value: readonly unknown[]): Admission {
  if (Object.getPrototypeOf(value) !== Array.prototype) return refused("HOSTILE_SHAPE");
  const { length } = value;
  if (!Number.isSafeInteger(length) || length < 0) return refused("HOSTILE_SHAPE");
  const own = Reflect.ownKeys(value);
  if (own.length !== length + 1) return refused("ARRAY_SHAPE");
  const keys: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return refused("ARRAY_SHAPE");
    if (!("value" in descriptor)) return refused("ACCESSOR");
    if (descriptor.enumerable !== true) return refused("ARRAY_SHAPE");
    keys.push(key);
  }
  return { step: "container", target: new Array<LiveQuiesceSafeJson>(length), keys };
}

/** Records must be plain (or null-prototype) with only own enumerable string data keys. */
function admitRecord(value: object): Admission {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return refused("HOSTILE_SHAPE");
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return refused("HOSTILE_SHAPE");
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return refused("HOSTILE_SHAPE");
    if (!("value" in descriptor)) return refused("ACCESSOR");
    if (descriptor.enumerable !== true) return refused("HOSTILE_SHAPE");
    if (utf8Length(key) > MAX_JSON_STRING_UTF8_BYTES) return refused("STRING_LIMIT");
    keys.push(key);
  }
  return { step: "container", target: Object.create(null) as MutableRecord, keys };
}

function admit(value: unknown): Admission {
  if (typeof value !== "object" && typeof value !== "function") return admitScalar(value);
  if (value === null) return scalar(null);
  if (isProxy(value)) return refused("PROXY");
  if (typeof value === "function") return refused("HOSTILE_SHAPE");
  return Array.isArray(value) ? admitArray(value) : admitRecord(value);
}

const attach = (frame: Frame, key: string, child: LiveQuiesceSafeJson): void => {
  if (Array.isArray(frame.target)) frame.target[Number(key)] = child;
  else (frame.target as MutableRecord)[key] = child;
};

/**
 * Copy `input` into a detached own-data graph, or refuse. Never throws for any
 * JavaScript value: the catch fence converts a hostile reflective failure into
 * HOSTILE_SHAPE rather than letting it escape to the caller.
 */
export function snapshotLiveQuiesceSafeValue(input: unknown): LiveQuiesceSafeValueResult {
  try {
    const root = admit(input);
    if (root.step === "refused") return refuse(root.issue);
    if (root.step === "scalar") return Object.freeze({ ok: true, value: root.value });
    let nodes = 1;
    const active = new Set<object>([input as object]);
    const stack: Frame[] = [
      { source: input as object, target: root.target, keys: root.keys, cursor: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      if (frame.cursor >= frame.keys.length) {
        active.delete(frame.source);
        stack.pop();
        continue;
      }
      const key = frame.keys[frame.cursor] as string;
      frame.cursor += 1;
      const child = (frame.source as Record<string, unknown>)[key];
      const admitted = admit(child);
      if (admitted.step === "refused") return refuse(admitted.issue);
      nodes += 1;
      if (nodes > MAX_SAFE_VALUE_NODES) return refuse("WORK_LIMIT");
      if (admitted.step === "scalar") {
        attach(frame, key, admitted.value);
        continue;
      }
      if (stack.length + 1 > MAX_JSON_DEPTH) return refuse("DEPTH_LIMIT");
      const source = child as object;
      if (active.has(source)) return refuse("CYCLE");
      active.add(source);
      attach(frame, key, admitted.target);
      stack.push({ source, target: admitted.target, keys: admitted.keys, cursor: 0 });
    }
    return Object.freeze({ ok: true, value: root.target });
  } catch {
    return refuse("HOSTILE_SHAPE");
  }
}

type Emission =
  | { readonly emit: "text"; readonly text: string }
  | { readonly emit: "node"; readonly node: LiveQuiesceSafeJson };

const text = (value: string): Emission => ({ emit: "text", text: value });
const node = (value: LiveQuiesceSafeJson): Emission => ({ emit: "node", node: value });

function expand(value: LiveQuiesceSafeJson): readonly Emission[] {
  if (Array.isArray(value)) {
    const parts: Emission[] = [text("[")];
    value.forEach((element: LiveQuiesceSafeJson, index: number) => {
      if (index > 0) parts.push(text(","));
      parts.push(node(element));
    });
    parts.push(text("]"));
    return parts;
  }
  const record = value as { readonly [key: string]: LiveQuiesceSafeJson };
  const parts: Emission[] = [text("{")];
  Object.keys(record).sort().forEach((key: string, index: number) => {
    if (index > 0) parts.push(text(","));
    parts.push(text(`${JSON.stringify(key)}:`), node(record[key] as LiveQuiesceSafeJson));
  });
  parts.push(text("}"));
  return parts;
}

/**
 * Canonical JSON (sorted keys, no whitespace) for an already detached snapshot.
 * Iterative, and the body budget is enforced BEFORE the pieces are joined, so a
 * value over MAX_JSON_BODY_BYTES never materialises as one oversized string.
 */
export function canonicalizeLiveQuiesceSafeValue(
  value: LiveQuiesceSafeJson,
): LiveQuiesceSafeCanonicalResult {
  const pieces: string[] = [];
  let bytes = 0;
  const stack: Emission[] = [node(value)];
  while (stack.length > 0) {
    const next = stack.pop() as Emission;
    if (next.emit === "node" && typeof next.node === "object" && next.node !== null) {
      const parts = expand(next.node);
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        stack.push(parts[index] as Emission);
      }
      continue;
    }
    const piece = next.emit === "text" ? next.text : JSON.stringify(next.node);
    if (typeof piece !== "string") return refuse("HOSTILE_SHAPE");
    bytes += utf8Length(piece);
    if (bytes > MAX_JSON_BODY_BYTES) return refuse("BODY_LIMIT");
    pieces.push(piece);
  }
  return Object.freeze({ ok: true, canonicalJson: pieces.join("") });
}
