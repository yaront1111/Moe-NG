/**
 * Whether the daemon may answer a review escalation ITSELF, and how many times per node.
 *
 * WHY THIS EXISTS. A node whose review is exhausted parks until a human presses a button. On
 * UnAI 2026-09-16 one node spent rounds 1, 2, 4 and 5 re-deriving the same finding — an
 * unresolved product question it had already answered in its own proposal — because nothing but
 * a human could record the answer. The owner's direction that day: "i dont want moe-next stop
 * make it take the best decsion without me". This setting is that permission, stated once,
 * durably, and readable at the seam that enforces it.
 *
 * WHERE IT READS FROM. The process environment, following the daemon's existing configuration
 * precedent — `readApprovalPolicySettings` (planning/approval-policy-settings.ts) and
 * `readWrapperKnobs` (orchestrator/wrapper-knobs.ts) — rather than inventing a mechanism.
 *
 * IT FAILS CLOSED, AND IT CANNOT BE CONSTRUCTED WITHOUT NAMING ITS BOUND. An absent, empty or
 * malformed setting returns `REQUIRE_HUMAN`, INCLUDING the case that looks most like a candidate
 * for a sensible default: the mode naming AI_GOVERNOR with no decision bound stated. This copies
 * the reasoning at packages/core/src/planning/approval-policy.ts:47-52 verbatim in shape — an
 * implicit bound is the incident's actual mechanism. The failure mode a bound prevents is
 * specific and worse than a stalled node: a governor that may answer without limit can fund
 * attempt after attempt on a node that will never pass, and every attempt spends real tokens on
 * a real repository. A policy that cannot be built without naming its bound cannot hide one.
 *
 * `maxDecisions` is a count of governance-authored ALLOW_MORE_ATTEMPTS decisions admissible for
 * ONE node. Zero is a stated, meaningful stance and is accepted: governance may then only ever
 * choose REPLAN, never fund another attempt.
 *
 * IT IS NOT THE AUTHORITY. Nothing here decides anything: `escalation.decide` still runs its
 * whole prerequisite chain, and the reserved governance principal is still compared at the
 * command registry's fence. A settings module can only ever say whether that seat is open.
 */

/** The settings this module understands, by their own names. */
export interface GovernanceModeSettings {
  readonly governanceMode?: unknown;
  readonly governanceMaxDecisions?: unknown;
}

export const GOVERNANCE_MODE_ENV_KEY = "MOE_GOVERNANCE_MODE" as const;
export const GOVERNANCE_MAX_DECISIONS_ENV_KEY = "MOE_GOVERNANCE_MAX_DECISIONS" as const;

/** The one mode that opens the governance seat, matched exactly. */
export const AI_GOVERNOR_MODE = "AI_GOVERNOR" as const;

/**
 * The seat governance decides from. Reserved exactly as `daemon:node-verifier` and
 * `daemon:criterion-verifier` are, and for the same reason: a node session that could
 * authenticate as this id could grant ITSELF another review attempt, which is precisely what
 * `review-escalation-authority.test.ts` exists to refuse. The reservation is what keeps that
 * refusal true while the seat is open.
 */
export const GOVERNANCE_PRINCIPAL_ID = "daemon:governor" as const;

/** Both members, so a sweep can prove neither branch is dead. */
export const GOVERNANCE_POLICY_KINDS = Object.freeze(["REQUIRE_HUMAN", AI_GOVERNOR_MODE] as const);

export type GovernancePolicyKind = (typeof GOVERNANCE_POLICY_KINDS)[number];

export type GovernancePolicy =
  | { readonly kind: "REQUIRE_HUMAN" }
  | { readonly kind: typeof AI_GOVERNOR_MODE; readonly maxDecisions: number };

const REQUIRE_HUMAN: GovernancePolicy = Object.freeze({ kind: "REQUIRE_HUMAN" as const });

/** A count, not a moment and not a ratio: a safe non-negative integer. */
function statedBound(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function settingsObject(settings: unknown): GovernanceModeSettings | null {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return null;
  return settings as GovernanceModeSettings;
}

/**
 * The single decision point. The AI_GOVERNOR arm is constructed from the stated bound and from
 * nothing else, so no path below can reach it without one.
 */
export function decodeGovernancePolicy(settings: unknown): GovernancePolicy {
  const stated = settingsObject(settings);
  if (stated === null || stated.governanceMode !== AI_GOVERNOR_MODE) return REQUIRE_HUMAN;
  const maxDecisions = statedBound(stated.governanceMaxDecisions);
  if (maxDecisions === null) return REQUIRE_HUMAN;
  return Object.freeze({ kind: AI_GOVERNOR_MODE, maxDecisions });
}

/**
 * Converts an environment string ONLY when it is unambiguously a non-negative integer, and
 * otherwise hands the raw value straight to the decoder to be refused. The regex is what keeps
 * `Number()` from inventing a bound: it would read "" as 0, " 2 " as 2, "1e3" as 1000 and
 * "0x10" as 16, and each of those is a bound the settings did not state.
 */
function boundSetting(raw: string | undefined): unknown {
  if (raw === undefined || !/^\d+$/u.test(raw)) return raw;
  return Number(raw);
}

/** Reads the governance settings off an environment. No default, no permissive fallback. */
export function readGovernancePolicySettings(
  env: Readonly<Record<string, string | undefined>>,
): GovernancePolicy {
  return decodeGovernancePolicy({
    governanceMaxDecisions: boundSetting(env[GOVERNANCE_MAX_DECISIONS_ENV_KEY]),
    governanceMode: env[GOVERNANCE_MODE_ENV_KEY],
  });
}

/**
 * Whether this policy opens the governance seat at all. An ABSENT policy is a closed one: a
 * composition that forgot to wire the setting must not thereby open the seat, so the undefined
 * case is answered here rather than left to each call site to remember.
 */
export function governanceOpen(policy: GovernancePolicy | undefined): policy is
  { readonly kind: typeof AI_GOVERNOR_MODE; readonly maxDecisions: number } {
  return policy !== undefined && policy.kind === AI_GOVERNOR_MODE;
}
