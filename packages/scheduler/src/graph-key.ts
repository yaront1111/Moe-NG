import { MAX_GRAPH_KEY_CODE_UNITS } from "./graph-policy.js";

/**
 * Machine graph identifiers are intentionally ASCII-only. Human-readable
 * labels belong in a separate field: accepting invisible or bidirectional
 * Unicode here would make logs, canonical JSON, and operator review disagree.
 * These values are opaque identifiers and must never be interpreted as paths.
 */
const SAFE_GRAPH_KEY = /^[A-Za-z0-9_][A-Za-z0-9._:@/+~-]*$/u;

export function isGraphKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_GRAPH_KEY_CODE_UNITS &&
    SAFE_GRAPH_KEY.test(value)
  );
}
