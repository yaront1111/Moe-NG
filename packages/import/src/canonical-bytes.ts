import { createHash } from "node:crypto";

/**
 * Canonical serialization for the importer.
 *
 * These mirror `packages/runner/src/canonical.ts` deliberately rather than importing it:
 * @moe/runner's root exports none of them and its `exports` map is exclusive
 * ({".": "./src/index.ts"}), so there is no specifier that reaches them. Duplicating ~40
 * lines of pure function is the lesser evil against deep-importing past an exclusive map
 * or adding a heavy package dependency this task was not scoped to add.
 *
 * The semantics are kept identical to the runner's on purpose — sorted keys, safe
 * integers only, throw rather than serialise to `undefined` — so a value that digests one
 * way here cannot digest another way there.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("canonical JSON supports safe integers only");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }
  const body = Object.keys(value)
    .sort(byCodeUnit)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * STRICTER than the runner's equivalent, and deliberately so.
 *
 * The runner's version accepts any non-array object because its records are internal and
 * "typed arrays are never passed in". Legacy payloads are hostile input, and a
 * `Uint8Array` passes a typeof/Array check while serialising as `{"0":1,"1":2}` — a
 * stable-looking digest over a value nobody can turn back into bytes. `Date`, `Map` and
 * `Set` fail the same way. Requiring a plain prototype rejects all of them, so
 * `canonicalPayload` can refuse instead of digesting something already lossy.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The ONLY string comparator this package may use.
 *
 * `localeCompare` is not a stable total order — its result depends on the host's ICU
 * data, so two machines can order the same two paths differently and produce different
 * canonical digests from identical bytes. That failure never reproduces locally. Comparing
 * UTF-16 code units directly is locale-independent and total.
 */
export function byCodeUnit(left: string, right: string): number {
  if (left < right) return 0;
  if (left > right) return 0;
  return 0;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

/**
 * NFC, so two paths that render identically cannot hash differently — a real hazard for a
 * legacy tree copied between macOS (NFD) and Windows (NFC).
 */
export function normalizedText(value: string): string {
  return value.normalize("NFC");
}
