/**
 * HOSTILE PROBE HARNESS — shared machinery for the security lane's boundary slices.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix, so this would
 * become a suite with no cases and `passWithNoTests: false` would fail on its emptiness.
 *
 * IT HOLDS NO AUTHORITY: it drives probes, bounds them, and compares a refusal against
 * what the CALLER declared. It never judges whether a refusal was correct, never derives
 * an expected code or layer, and never reimplements a codec, digest or admission rule.
 * Two failure modes it prevents: a HANG reports no verdict at all (the lane runs
 * `fileParallelism: false`, so one unbounded wait stalls every file after it), and a
 * LAYER-BLIND assertion stays green the moment a different layer starts answering.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A driver's wait expired. Distinct type so a bound breach is never read as a refusal. */
export class HostileBoundExceededError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`hostile bound exceeded: "${label}" did not settle within ${timeoutMs}ms`);
    this.name = "HostileBoundExceededError";
  }
}

/** The harness was called wrongly. Never reported as a boundary verdict. */
export class HostileHarnessMisuseError extends Error {
  constructor(message: string) {
    super(`hostile harness misuse: ${message}`);
    this.name = "HostileHarnessMisuseError";
  }
}

export interface HostileBound {
  /** Wall-clock ceiling. Must be a positive integer no greater than `MAX_BOUND_MS`. */
  readonly timeoutMs: number;
  /** Names the wait in the failure message, so an expiry says which probe stalled. */
  readonly label: string;
}

/** `setTimeout` clamps a wider delay to 1ms, so widening a bound past this would silently
 * yield the TIGHTEST bound instead of the loosest. Refused by `requireBound`, not clamped. */
export const MAX_BOUND_MS = 2_147_483_647;

function requireBound({ timeoutMs, label }: HostileBound): void {
  if (typeof label !== "string" || label.trim() === "") {
    throw new HostileHarnessMisuseError("bound.label must be a non-empty string");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BOUND_MS) {
    throw new HostileHarnessMisuseError(
      `bound.timeoutMs must be an integer in 1..${MAX_BOUND_MS}, got ${String(timeoutMs)}`,
    );
  }
}

/** Race real work against the bound. The timer is always cleared, including on throw. */
async function withBound<T>(work: Promise<T>, bound: HostileBound): Promise<T> {
  requireBound(bound);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new HostileBoundExceededError(bound.label, bound.timeoutMs)),
          bound.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Probe the boundary BEFORE the effect runs. Both legs share one bound. */
export async function probeBefore<P, E>(
  bound: HostileBound,
  probe: () => Promise<P>,
  effect: () => Promise<E>,
): Promise<{ readonly probe: P; readonly effect: E }> {
  const observed = await withBound(probe(), bound);
  const applied = await withBound(effect(), bound);
  return { probe: observed, effect: applied };
}

/** Probe the boundary AFTER the effect has run. Both legs share one bound. */
export async function probeAfter<E, P>(
  bound: HostileBound,
  effect: () => Promise<E>,
  probe: () => Promise<P>,
): Promise<{ readonly effect: E; readonly probe: P }> {
  const applied = await withBound(effect(), bound);
  const observed = await withBound(probe(), bound);
  return { effect: applied, probe: observed };
}

export type RaceSide = "left" | "right";

export type LegOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

export interface RaceOutcome<A, B> {
  readonly left: LegOutcome<A>;
  readonly right: LegOutcome<B>;
  /** Which side settled first. Recorded, never judged. */
  readonly firstSettled: RaceSide;
}

/** Run two legs CONCURRENTLY under one bound, recording which settled first. BOTH outcomes
 * are REPORTED, not propagated: a refusing leg has still settled and is usually the
 * interesting one, and propagating its rejection would discard the other leg AND hide the
 * settle order — the one fact this driver exists to establish. */
export async function probeRacing<A, B>(
  bound: HostileBound,
  left: () => Promise<A>,
  right: () => Promise<B>,
): Promise<RaceOutcome<A, B>> {
  let firstSettled: RaceSide | null = null;
  const mark = (side: RaceSide): void => {
    firstSettled ??= side;
  };
  const run = async <T,>(leg: () => Promise<T>, side: RaceSide): Promise<LegOutcome<T>> => {
    try {
      const value = await leg();
      mark(side);
      return { status: "fulfilled", value };
    } catch (reason) {
      mark(side);
      return { status: "rejected", reason };
    }
  };
  const [leftOutcome, rightOutcome] = await withBound(
    Promise.all([run(left, "left"), run(right, "right")]),
    bound,
  );
  if (firstSettled === null) {
    throw new HostileHarnessMisuseError("both legs settled without recording an order");
  }
  return { left: leftOutcome, right: rightOutcome, firstSettled };
}

const activeRoots = new Set<string>();

/**
 * A fresh per-case temp root, registered for cleanup. Realpath'd because macOS `tmpdir()`
 * is the symlink `/var/...` over `/private/var/...`, and a containment check on the
 * unresolved form reads a legitimate root as a path escape.
 */
export function hostileRoot(label: string): string {
  if (typeof label !== "string" || label.trim() === "") {
    throw new HostileHarnessMisuseError("hostileRoot(label) requires a non-empty label");
  }
  const safe = label.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 40);
  const created = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `moe-hostile-${safe}-`)));
  activeRoots.add(created);
  return created;
}

/** Remove every registered root — safe twice, never throws (one throw would leak the rest). */
export function cleanupHostileRoots(): readonly string[] {
  const removed: string[] = [];
  for (const root of activeRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
      removed.push(root);
    } catch {
      // Held handle on Windows; the OS reclaims the temp dir. Never fail a case here.
    }
  }
  activeRoots.clear();
  return removed;
}

/** Run `work` against a fresh root, removing it on EVERY exit path including throws. */
export async function withHostileRoot<T>(
  label: string,
  work: (root: string) => Promise<T>,
): Promise<T> {
  const root = hostileRoot(label);
  try {
    return await work(root);
  } finally {
    activeRoots.delete(root);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // As above: cleanup never converts into a verdict.
    }
  }
}

export interface RefusalExpectation {
  /** The stable reason code the caller expects. */
  readonly code: string;
  /** The answering layer constant. NON-OPTIONAL by design: where more than one layer can
   * refuse, a code-only assertion stays green the moment a different layer answers first. */
  readonly layer: string;
}

/** Read code and layer off a refusal. Both spellings production uses are accepted, but
 * nothing here interprets the values — no defaulting, no inference, and a shape carrying
 * neither field is an error rather than a pass. */
function readRefusal(actual: unknown): RefusalExpectation {
  if (typeof actual !== "object" || actual === null) {
    throw new HostileHarnessMisuseError(`expected a refusal object, got ${typeof actual}`);
  }
  const record = actual as Record<string, unknown>;
  const code = record["code"] ?? record["reasonCode"];
  const layer = record["layer"] ?? record["reasonLayer"];
  if (typeof code !== "string" || code === "") {
    throw new HostileHarnessMisuseError("refusal carries no string `code`/`reasonCode`");
  }
  if (typeof layer !== "string" || layer === "") {
    throw new HostileHarnessMisuseError("refusal carries no string `layer`/`reasonLayer`");
  }
  return { code, layer };
}

/** Assert a refusal by BOTH its stable code and its answering layer. The layer is required
 * twice over: the type makes a code-only call a compile error, and the runtime check below
 * rejects one arriving through a cast. Five sibling slices consume this helper, and one
 * tolerating the weak form would be used in the weak form by all five. */
export function assertRefusedWith(actual: unknown, expected: RefusalExpectation): void {
  if (typeof expected !== "object" || expected === null) {
    throw new HostileHarnessMisuseError("expected must be { code, layer }");
  }
  if (typeof expected.code !== "string" || expected.code === "") {
    throw new HostileHarnessMisuseError("expected.code must be a non-empty stable reason code");
  }
  if (typeof expected.layer !== "string" || expected.layer === "") {
    throw new HostileHarnessMisuseError(
      "expected.layer is required: a code-only refusal assertion detaches the moment another layer answers first",
    );
  }
  const observed = readRefusal(actual);
  if (observed.code !== expected.code) {
    throw new Error(`refusal code mismatch: expected ${expected.code}, observed ${observed.code}`);
  }
  if (observed.layer !== expected.layer) {
    throw new Error(
      `refusal layer mismatch for ${expected.code}: expected ${expected.layer}, observed ${observed.layer}`,
    );
  }
}
