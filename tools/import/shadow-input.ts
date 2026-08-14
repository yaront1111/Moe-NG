import { readFileSync } from "node:fs";

import { refuseImport } from "../../packages/import/src/index.js";
import type { ImportRefused, ShadowEntity, ShadowProjection } from "../../packages/import/src/index.js";
import { SHADOW_PROJECTION_VERSION } from "../../packages/import/src/index.js";

/**
 * The UNTRUSTED-INPUT boundary of `import-shadow`: argv and the optional new-side
 * projection file. Split out of `import-shadow.ts` when that file passed the 250-line
 * target, and a good seam independently — everything here turns bytes a caller supplied
 * into either a typed refusal or a value the rest of the tool may trust.
 *
 * Nothing here writes, and nothing here guesses: a malformed entity refuses with an exact
 * code rather than being coerced into a comparison that would then report confident
 * mismatches derived from junk.
 */

export const USAGE = "usage: import-shadow <copied-snapshot-root> [--current <projection.json>]";

export interface Options {
  readonly currentPath: string | null;
  readonly root: string;
}

export function parseOptions(args: readonly string[]): ImportRefused | Options {
  const operands = [...args];
  const root = operands[0];
  if (root === undefined || root.startsWith("--")) {
    return refuseImport("IMPORT_ROOT_INVALID", "INPUT", USAGE);
  }
  const rest = operands.slice(1);
  if (rest.length === 0) return { currentPath: null, root };
  if (rest.length !== 2 || rest[0] !== "--current" || rest[1] === undefined) {
    return refuseImport("IMPORT_ROOT_INVALID", "INPUT", USAGE);
  }
  return { currentPath: rest[1], root };
}

export function readCurrent(path: string | null): ImportRefused | ShadowProjection {
  if (path === null) {
    return Object.freeze({ entities: Object.freeze([]), version: SHADOW_PROJECTION_VERSION });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImport("IMPORT_SOURCE_MALFORMED", "INPUT", `${path}: ${detail}`);
  }
  return parseCurrent(path, parsed);
}

/**
 * The new-side projection is UNTRUSTED input: it comes from a file, so every entity is
 * checked structurally before it can reach the comparator. A malformed entity refuses
 * with an exact code rather than being coerced into a comparison that would then report
 * confident mismatches derived from junk.
 */
function parseCurrent(path: string, parsed: unknown): ImportRefused | ShadowProjection {
  const document = asRecord(parsed);
  const entities = document === null ? undefined : document["entities"];
  if (!Array.isArray(entities)) {
    return refuseImport("IMPORT_SOURCE_MALFORMED", "INPUT", `${path}: no entities array`);
  }
  const parsedEntities: ShadowEntity[] = [];
  for (const candidate of entities) {
    const entity = asRecord(candidate);
    const fields = entity === null ? null : asRecord(entity["fields"]);
    if (entity === null || fields === null
      || typeof entity["id"] !== "string" || typeof entity["kind"] !== "string") {
      return refuseImport("IMPORT_SOURCE_MALFORMED", "INPUT", `${path}: malformed entity`);
    }
    const pairs: (readonly [string, string])[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== "string") {
        return refuseImport("IMPORT_SOURCE_MALFORMED", "INPUT", `${path}: ${key} is not text`);
      }
      pairs.push([key, value] as const);
    }
    // fromEntries rather than `text[key] = value`: assigning to "__proto__" hits the
    // inherited setter, so that field would vanish from an untrusted document without a
    // refusal - a silent drop, in the one place this tool handles bytes it did not derive.
    parsedEntities.push(Object.freeze({
      fields: Object.freeze(Object.fromEntries(pairs)),
      id: entity["id"],
      kind: entity["kind"] as ShadowEntity["kind"],
    }));
  }
  return Object.freeze({
    entities: Object.freeze(parsedEntities),
    version: SHADOW_PROJECTION_VERSION,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

