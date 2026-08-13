/**
 * Shared durable-store doubles for the authority-overlay suites.
 *
 * Both stores answer from their OWN rows, never from the bytes the caller
 * presented. That is what makes a replay assertion non-vacuous: the shipped pure
 * `consumeActivationGrant` cannot see a first call, so a refusal the default port
 * could also have produced would prove nothing about the injected one.
 *
 * Every answer a store hands back is also recorded, so a substitution case can
 * assert POSITIVELY that the hostile record it meant to produce was produced and
 * decodes on its own — a "well-formed but different" case that silently degraded
 * into a malformed one would otherwise pass while testing a different guard.
 *
 * `composed` is the INTERNAL composition seam. The public `createClaudeLauncher`
 * refuses caller-supplied dependencies outright, because a caller that could hand
 * in a whole dependency set would replace the runtime pin, the OS lock and the
 * Windows physical boundary while the factory still advertised them. A suite that
 * needs to script the eight non-authority ports therefore composes here instead
 * of widening the published seam.
 */
import { type WindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { type WindowsProcessOutcome } from "../../platform/windows/windows-process-contract.js";
import { consumeActivationGrant, grantRefusal } from "../../supervisor/effect-grant.js";
import { parseActivationGrant } from "../../supervisor/effect-parse.js";
import { launchLockFailure, type LaunchLockRegistration } from "../../supervisor/launch-lock.js";
import { composeDurableLauncher } from "./claude-launcher-authority.js";
import { type ClaudeLaunchOptions, type ClaudeLaunchResult, type ClaudeLauncherAuthority,
  type ClaudeLauncherDependencies, type ClaudeRegistrationCommit } from "./claude-launcher-contract.js";
import { CLAIM, COMMIT, PROCESS, dependencies, type BoundaryHarness } from "./claude-launcher-test-fixtures.js";

export const PASS = Symbol("fall through to the durable store");
/**
 * Written out rather than built with `pendingProcessIdentity` /
 * `startedProcessIdentity`: an identity assertion that called the production
 * builder would follow a format change instead of catching it.
 */
export const STARTED_IDENTITY = `windows:${PROCESS.pid}:${PROCESS.creationTime}`;
export const PENDING_IDENTITY = `pending:${CLAIM.wrapperIdentity}`;
export const AT = "2026-08-12T08:00:00.000Z";

type Row = Record<string, unknown>;
export interface GrantStore {
  readonly calls: (readonly [unknown, unknown])[];
  readonly answers: unknown[];
  readonly rows: Map<string, Row>;
  consumeGrantDurably(grant: unknown, wrapperIdentity: unknown): unknown;
}
export interface RegistrationStore {
  readonly commits: ClaudeRegistrationCommit[];
  readonly answers: unknown[];
  readonly rows: Map<string, LaunchLockRegistration>;
  commitProcessRegistration(commit: ClaudeRegistrationCommit): unknown;
}

/** The row-owned half of the CAS: the presented bytes only SELECT a row. */
function casRow(rows: Map<string, Row>, grant: unknown, wrapperIdentity: unknown): unknown {
  const presented = parseActivationGrant(grant);
  const row = presented === null ? undefined : rows.get(presented.grantId);
  if (row === undefined) {
    return grantRefusal("ACTIVATION_COMMIT_INCOHERENT", "ACTIVATION",
      "no durable activation carries this grant");
  }
  const outcome = consumeActivationGrant(row, wrapperIdentity);
  if (outcome.kind === "CONSUMED") rows.set(outcome.grant.grantId, { ...outcome.grant });
  return outcome;
}

/** A one-use CAS over durable rows. `seed` is copied per call, never shared. */
export function durableGrants(
  seed: Row = { ...COMMIT.grant },
  script: (grant: unknown) => unknown = () => PASS,
): GrantStore {
  const rows = new Map<string, Row>([[String(seed["grantId"]), { ...seed }]]);
  const calls: (readonly [unknown, unknown])[] = [];
  const answers: unknown[] = [];
  return {
    calls,
    answers,
    rows,
    consumeGrantDurably(grant, wrapperIdentity) {
      calls.push([grant, wrapperIdentity]);
      const scripted = script(grant);
      const answer = scripted === PASS ? casRow(rows, grant, wrapperIdentity) : scripted;
      answers.push(answer);
      return answer;
    },
  };
}

/** A durable lock row already carrying a STARTED identity refuses a new reservation. */
function commitRow(
  rows: Map<string, LaunchLockRegistration>, commit: ClaudeRegistrationCommit,
): unknown {
  const { phase, registration } = commit;
  const stored = rows.get(registration.lockIdentity);
  const superseded = stored !== undefined &&
    stored.processIdentity !== `pending:${registration.wrapperIdentity}`;
  if (phase === "PREFLIGHT" && superseded) {
    return Object.freeze({ kind: "REFUSED", failure: launchLockFailure(
      "LAUNCH_LOCK_IDENTITY_CONFLICT", "LAUNCH_LOCK",
      "this lock already carries a durable process registration", "launchLock.register") });
  }
  rows.set(registration.lockIdentity, registration);
  return Object.freeze({ kind: "REGISTERED", ok: true, registration });
}

/** PREFLIGHT reserves the pending identity; STARTED supersedes that reservation. */
export function durableRegistrations(
  script: (commit: ClaudeRegistrationCommit) => unknown = () => PASS,
): RegistrationStore {
  const commits: ClaudeRegistrationCommit[] = [];
  const answers: unknown[] = [];
  const rows = new Map<string, LaunchLockRegistration>();
  return {
    commits,
    answers,
    rows,
    commitProcessRegistration(commit) {
      commits.push(commit);
      const scripted = script(commit);
      const answer = scripted === PASS ? commitRow(rows, commit) : scripted;
      answers.push(answer);
      return answer;
    },
  };
}

export function authorityOf(grants: GrantStore, regs: RegistrationStore): ClaudeLauncherAuthority {
  return {
    consumeGrantDurably: grants.consumeGrantDurably,
    commitProcessRegistration: regs.commitProcessRegistration,
  };
}

/**
 * `close` and the lock release land in two different fixture logs, so cleanup
 * ORDER is unassertable without one array. This wrapper adds a trace push and
 * nothing else; every port underneath is still the shipped production function.
 */
export function tracedDeps(harness: BoundaryHarness, trace: string[]): ClaudeLauncherDependencies {
  const base = dependencies(harness, trace);
  return Object.freeze({
    ...base,
    openBoundary: (value: unknown, options?: { readonly timeoutMs?: number }): unknown => {
      const boundary = base.openBoundary(value, options) as WindowsProcessBoundary;
      return { ...boundary, close: async (): Promise<WindowsProcessOutcome> => {
        trace.push("close");
        return await boundary.close();
      } };
    },
  });
}

/** The internal seam: the same production composition the public factory runs. */
export function composed(
  grants: GrantStore, regs: RegistrationStore, deps: ClaudeLauncherDependencies,
): (value: unknown, options?: ClaudeLaunchOptions) => Promise<ClaudeLaunchResult> {
  return composeDurableLauncher(deps, authorityOf(grants, regs));
}
