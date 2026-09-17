import {
  MAX_DIAGNOSTIC_CAUSES, MAX_DIAGNOSTIC_MESSAGE_CHARS, MAX_DIAGNOSTIC_STACK_LINES,
} from "./diagnostic-record.js";
import type { DiagnosticThrown } from "./diagnostic-record.js";

/**
 * TURNS AN UNKNOWN THROW INTO BOUNDED FACTS.
 *
 * `strict` implies `useUnknownInCatchVariables`, so every bound catch value in this repository
 * is `unknown`: it may be an Error, a string, a frozen object, `undefined`, or a Proxy whose
 * every trap throws. This function is the single place that reckons with all of them, so no call
 * site has to, and so no call site reaches for `(error as Error).message` and crashes its own
 * failure path.
 *
 * TOTAL BY CONSTRUCTION. Every read of the thrown value is fenced, because a hostile or merely
 * exotic object must not be able to convert "we caught an error" into "the logger threw". The
 * fences here are the one class of bare catch this repository keeps deliberately empty: the
 * throw IS the probe's answer, and the trap's own error says nothing a reader could act on.
 */

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

/** A fenced property read. An accessor that throws answers `undefined`, which is the finding. */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A fenced stringification, for a value whose `toString`/`Symbol.toPrimitive` may be hostile. */
function stringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "";
  }
}

function constructorName(value: object): string {
  try {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name !== "" ? clamp(name, 64) : "Unknown";
  } catch {
    return "Unknown";
  }
}

function nameOf(value: unknown): string {
  if (value === null) return "Null";
  if (value === undefined) return "Undefined";
  if (typeof value !== "object" && typeof value !== "function") {
    const kind = typeof value;
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  const direct = read(value, "name");
  if (typeof direct === "string" && direct !== "") return clamp(direct, 64);
  return constructorName(value);
}

function messageOf(value: unknown): string {
  if (value === null || value === undefined) return stringify(value);
  if (typeof value !== "object" && typeof value !== "function") {
    return clamp(stringify(value), MAX_DIAGNOSTIC_MESSAGE_CHARS);
  }
  const direct = read(value, "message");
  if (typeof direct === "string") return clamp(direct, MAX_DIAGNOSTIC_MESSAGE_CHARS);
  return clamp(stringify(value), MAX_DIAGNOSTIC_MESSAGE_CHARS);
}

/**
 * The errno/sqlite code, which is the entire reason a store or filesystem catch is worth
 * binding: ENOENT and EBUSY, or SQLITE_BUSY and SQLITE_CORRUPT, demand different operator
 * actions and are otherwise collapsed into one refusal code by the call site.
 */
function codeOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const code = read(value, "code");
  return typeof code === "string" && code !== "" ? clamp(code, 64) : null;
}

function stackOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const stack = read(value, "stack");
  if (typeof stack !== "string" || stack === "") return null;
  // The HEAD, not the tail: the throw site and its immediate callers are what identify the
  // defect. A deep async stack's tail is scheduler frames that are identical everywhere.
  return stack.split("\n").slice(0, MAX_DIAGNOSTIC_STACK_LINES).join("\n");
}

function summarise(value: unknown): string {
  const message = messageOf(value);
  return clamp(`${nameOf(value)}: ${message}`, MAX_DIAGNOSTIC_MESSAGE_CHARS);
}

function related(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return [];
  const out: unknown[] = [];
  const errors = read(value, "errors");
  // AggregateError is how this repository reports multi-seat containment failure.
  if (Array.isArray(errors)) out.push(...errors.slice(0, MAX_DIAGNOSTIC_CAUSES + 1));
  const cause = read(value, "cause");
  if (cause !== undefined) out.push(cause);
  return out;
}

/**
 * The cause chain and aggregate members, breadth-first, deduplicated by identity so a cycle
 * terminates. `Error("a", { cause: b })` where `b.cause === a` is a real shape once two layers
 * wrap each other's failures, and it must cost a bounded walk, not a hang.
 */
function causesOf(root: unknown): readonly string[] {
  const out: string[] = [];
  const seen = new Set<unknown>([root]);
  let frontier = [...related(root)];
  while (frontier.length > 0 && out.length < MAX_DIAGNOSTIC_CAUSES) {
    const next: unknown[] = [];
    for (const entry of frontier) {
      if (out.length >= MAX_DIAGNOSTIC_CAUSES) break;
      if (entry === undefined || seen.has(entry)) continue;
      seen.add(entry);
      out.push(summarise(entry));
      next.push(...related(entry));
    }
    frontier = next;
  }
  return Object.freeze(out);
}

export function describeThrown(value: unknown): DiagnosticThrown {
  return Object.freeze({
    causes: causesOf(value),
    code: codeOf(value),
    message: messageOf(value),
    name: nameOf(value),
    stack: stackOf(value),
  });
}
