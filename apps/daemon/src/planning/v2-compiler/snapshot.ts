import { isProxy } from "node:util/types";

type SnapshotResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false }>;

const FAILED = Object.freeze({ ok: false as const });

/** Descriptor-only copy: accessors, proxies, cycles, exotic prototypes, and excess work fail. */
export function snapshotCompilerInput(value: unknown): SnapshotResult {
  const seen = new WeakSet<object>();
  const budget = { remaining: 200_000 };

  const visit = (candidate: unknown, depth: number): SnapshotResult => {
    budget.remaining -= 1;
    if (budget.remaining < 0 || depth > 24) return FAILED;
    if (candidate === null || typeof candidate === "boolean"
      || typeof candidate === "number" || typeof candidate === "string") {
      return Object.freeze({ ok: true as const, value: candidate });
    }
    if (typeof candidate !== "object" || isProxy(candidate)) return FAILED;
    if (seen.has(candidate)) return FAILED;
    seen.add(candidate);
    try {
      const prototype = Object.getPrototypeOf(candidate);
      if (Array.isArray(candidate)) {
        if (prototype !== Array.prototype || candidate.length > 4_096) return FAILED;
        const own = Reflect.ownKeys(candidate).filter((key) => key !== "length");
        if (own.length !== candidate.length) return FAILED;
        const values: unknown[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            return FAILED;
          }
          const nested = visit(descriptor.value, depth + 1);
          if (!nested.ok) return nested;
          values.push(nested.value);
        }
        return Object.freeze({ ok: true as const, value: values });
      }
      if (prototype !== Object.prototype && prototype !== null) return FAILED;
      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") return FAILED;
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          return FAILED;
        }
        const nested = visit(descriptor.value, depth + 1);
        if (!nested.ok) return nested;
        copy[key] = nested.value;
      }
      return Object.freeze({ ok: true as const, value: copy });
    } catch {
      return FAILED;
    } finally {
      seen.delete(candidate);
    }
  };

  return visit(value, 0);
}

export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
}

export function exact(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  const source = record(value);
  return source !== undefined && Reflect.ownKeys(source).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(source, key));
}

export function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value.trim() === value && !value.includes("\0") && value.isWellFormed()
    && value.normalize("NFC") === value;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const UNIFORM = /^(.)\1{63}$/u;

/** Uniform hex strings are fixtures/placeholders, not evidence-bearing material identities. */
export function materialDigest(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value) && !UNIFORM.test(value);
}
