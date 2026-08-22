/**
 * THE ONE PLACE the portability matrices learn which commit their evidence
 * binds to.
 *
 * WHY THIS MODULE EXISTS. Before it, three call sites each answered the
 * question independently and each answered it by reading the MOVING head:
 * `projection-shadow-matrix.test.ts` and `transport-host-matrix.test.ts` both
 * spawned `git rev-parse HEAD`, and `shadow-matrix-cases.readSourceCommit()`
 * read `.git/HEAD` bytes. This repository is a shared worktree with peers
 * committing into it, so a gate run that straddles a peer commit binds two
 * different trees and still reports green -- the matrices would each be
 * internally consistent while the SUITE certified nothing. DoD 3 ("all
 * distribution handshakes and fixture hashes bind one source commit") is
 * exactly the property that hazard destroys.
 *
 * THE CONTRACT. Resolution is fail-closed and never consults git:
 *   1. `MOE_PORTABILITY_SOURCE_COMMIT` when set. CI binds this to the running
 *      commit, and the external evidence artifacts are stamped with the same
 *      value, so it names the tree the rows were actually produced from.
 *   2. otherwise the committed pin receipt, `portability-evidence-pin.json`.
 *   3. otherwise REFUSE. There is no fallback to `git rev-parse HEAD`; an
 *      unbound run must go red, not silently rebind to whatever HEAD is now.
 *
 * WHY THE ENVIRONMENT MAY OVERRIDE AN UNSEALED RECEIPT BUT NEVER A SEALED ONE.
 * The receipt answers "which commit was the accepted external evidence taken
 * at"; the environment answers "which commit is this run executing". Those are
 * different questions, so a run at a commit newer than the receipt is ordinary
 * and must stay green. But once the receipt is SEALED -- `externalRun` set,
 * meaning exact-sha-evidence-gate.mjs accepted a push run at that exact commit
 * -- reusing it to bless different bytes is precisely the "do not reuse the old
 * receipt" hazard this task exists to close. So a sealed receipt disagreeing
 * with the environment REFUSES, and an unsealed one yields to it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Stable refusal codes. Tests pin these, never a bare "it threw". */
export const SOURCE_COMMIT_CODES = Object.freeze({
  /** Neither the environment binding nor the pin receipt supplied a commit. */
  absent: "PORTABILITY_SOURCE_COMMIT_ABSENT",
  /** A SEALED receipt names a different commit than the running environment. */
  conflict: "PORTABILITY_SOURCE_COMMIT_SEALED_CONFLICT",
  /** A supplied value is not a lowercase 40-character hex object name. */
  malformed: "PORTABILITY_SOURCE_COMMIT_MALFORMED",
  /** The pin receipt exists but could not be read or parsed as its contract. */
  pinUnreadable: "PORTABILITY_SOURCE_COMMIT_PIN_UNREADABLE",
} as const);

export type SourceCommitCode = (typeof SOURCE_COMMIT_CODES)[keyof typeof SOURCE_COMMIT_CODES];

/** Which input supplied the answer. Recorded so evidence can name its origin. */
export type SourceCommitBinding = "ENV" | "PIN" | "PIN_AND_ENV";

export interface SourceCommitResolved {
  readonly boundBy: SourceCommitBinding;
  readonly ok: true;
  readonly sourceCommit: string;
}

export interface SourceCommitRefused {
  readonly code: SourceCommitCode;
  readonly ok: false;
}

export type SourceCommitOutcome = SourceCommitRefused | SourceCommitResolved;

export interface SourceCommitInputs {
  /** Raw environment value, or undefined when the variable is unset. */
  readonly env: string | undefined;
  /** Raw pin-receipt bytes, or undefined when no receipt is present. */
  readonly pinBytes: string | undefined;
}

/** The variable CI binds to the push run's `github.sha`. */
export const SOURCE_COMMIT_ENV = "MOE_PORTABILITY_SOURCE_COMMIT";

/** The committed receipt naming the commit the external evidence was taken at. */
export const SOURCE_COMMIT_PIN_FILE = "portability-evidence-pin.json";

const OBJECT_NAME = /^[0-9a-f]{40}$/u;

/** A blank or whitespace-only value counts as unset, never as malformed. */
const supplied = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** What the committed receipt says, once its bytes are known to be well formed. */
interface PinFacts {
  /** `externalRun` is set, so an exact-SHA push run was accepted at this commit. */
  readonly sealed: boolean;
  readonly sourceCommit: string | undefined;
}

const readPin = (pinBytes: string | undefined): PinFacts | SourceCommitRefused => {
  const unreadable: SourceCommitRefused = { code: SOURCE_COMMIT_CODES.pinUnreadable, ok: false };
  const raw = supplied(pinBytes);
  if (raw === undefined) return { sealed: false, sourceCommit: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unreadable;
  const record = parsed as { readonly externalRun?: unknown; readonly sourceCommit?: unknown };
  const value = record.sourceCommit;
  if (typeof value !== "string" && value !== undefined && value !== null) return unreadable;
  const externalRun = record.externalRun;
  return {
    sealed: externalRun !== undefined && externalRun !== null,
    sourceCommit: typeof value === "string" ? supplied(value) : undefined,
  };
};

/**
 * Pure resolution over explicit inputs. The production reader below is a thin
 * shell over this, so a test that drives this function is testing the same
 * decision production takes -- not a reimplementation of it.
 */
export function resolveSourceCommit(inputs: SourceCommitInputs): SourceCommitOutcome {
  const pin = readPin(inputs.pinBytes);
  if ("ok" in pin) return pin;
  const fromPin = pin.sourceCommit;
  const fromEnv = supplied(inputs.env);

  if (fromEnv === undefined && fromPin === undefined) {
    return { code: SOURCE_COMMIT_CODES.absent, ok: false };
  }
  for (const candidate of [fromEnv, fromPin]) {
    if (candidate !== undefined && !OBJECT_NAME.test(candidate)) {
      return { code: SOURCE_COMMIT_CODES.malformed, ok: false };
    }
  }
  // A sealed receipt is an assertion about ONE commit's bytes. Letting a
  // different running commit borrow it is the "reuse the old receipt" defect.
  if (pin.sealed && fromEnv !== undefined && fromPin !== undefined && fromEnv !== fromPin) {
    return { code: SOURCE_COMMIT_CODES.conflict, ok: false };
  }
  const sourceCommit = fromEnv ?? fromPin;
  /* c8 ignore next -- both-undefined already returned `absent` above. */
  if (sourceCommit === undefined) return { code: SOURCE_COMMIT_CODES.absent, ok: false };
  const boundBy: SourceCommitBinding =
    fromEnv === undefined ? "PIN" : fromPin === fromEnv ? "PIN_AND_ENV" : "ENV";
  return { boundBy, ok: true, sourceCommit };
}

/** Reads the committed pin receipt, or undefined when it is absent. */
export function readPinBytes(directory: string = import.meta.dirname): string | undefined {
  try {
    return readFileSync(join(directory, SOURCE_COMMIT_PIN_FILE), "utf8");
  } catch {
    return undefined;
  }
}

/** The production surface: real environment, real committed receipt. */
export function resolvePortabilitySourceCommit(): SourceCommitOutcome {
  return resolveSourceCommit({ env: process.env[SOURCE_COMMIT_ENV], pinBytes: readPinBytes() });
}

/**
 * Captured ONCE per process. Every matrix reads this constant, so two matrices
 * in one gate run cannot bind different trees even if a peer commits mid-run.
 * Throws with the stable code in its message when the run is unbound.
 */
export function readPortabilitySourceCommit(): string {
  const outcome = resolvePortabilitySourceCommit();
  if (!outcome.ok) {
    throw new Error(
      `${outcome.code}: portability evidence is unbound. Set ${SOURCE_COMMIT_ENV} or land a ${SOURCE_COMMIT_PIN_FILE} receipt.`,
    );
  }
  return outcome.sourceCommit;
}

/** The single pinned value shared by every portability matrix. */
export const PORTABILITY_SOURCE_COMMIT: string = readPortabilitySourceCommit();
