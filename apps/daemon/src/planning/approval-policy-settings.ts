import type { ApprovalPolicy } from "@moe/core";

/**
 * The daemon's approval settings, decoded into a typed `ApprovalPolicy`.
 *
 * WHERE IT READS FROM. The process environment, following the daemon's existing
 * configuration precedent — `readStoreDependencyEnv` (daemon-store-dependencies.ts) and
 * `readWrapperKnobs` (orchestrator/wrapper-knobs.ts) — rather than inventing a mechanism.
 * The two settings are the transitional orchestrator's own `approvalMode` and
 * `speedModeDelayMs`, carried on `MOE_APPROVAL_MODE` and `MOE_SPEED_MODE_DELAY_MS`.
 *
 * IT FAILS CLOSED, AND THAT IS DELIBERATE — NOT AN OVERSIGHT TO "FIX". There is no default
 * delay and no permissive fallback anywhere below. An absent, empty or malformed setting
 * returns `REQUIRE_HUMAN`, including the case that looks most like a candidate for a
 * sensible default: `approvalMode` naming SPEED with no delay stated. The contract this
 * decodes into says why, at packages/core/src/planning/approval-policy.ts:47-52 — "An
 * auto-approval delay that defaults implicitly is the incident's actual mechanism: that
 * board ran a 2s auto-approval nobody had stated per unit of work. A policy that cannot be
 * constructed without naming its delay cannot hide one." A decoder that substitutes a
 * default re-creates that incident one layer out, where the type can no longer catch it.
 *
 * IT IS NOT THE GATE. Nothing here approves gated work: `decideApprovalAuthority` consults
 * the per-unit-of-work human authority gate FIRST and short-circuits. A settings file can
 * only ever say what happens to work that carries no gate.
 */

/** The transitional settings this module understands, by their own names. */
export interface ApprovalModeSettings {
  readonly approvalMode?: unknown;
  readonly speedModeDelayMs?: unknown;
}

export const APPROVAL_MODE_ENV_KEY = "MOE_APPROVAL_MODE" as const;
export const SPEED_MODE_DELAY_ENV_KEY = "MOE_SPEED_MODE_DELAY_MS" as const;

/** The one mode that can authorise proceeding without a human, matched exactly. */
export const SPEED_APPROVAL_MODE = "SPEED" as const;

const REQUIRE_HUMAN: ApprovalPolicy = Object.freeze({ kind: "REQUIRE_HUMAN" as const });

/** A delay, not a moment: a safe non-negative integer count of milliseconds. */
function statedDelay(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function settingsObject(settings: unknown): ApprovalModeSettings | null {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return null;
  return settings as ApprovalModeSettings;
}

/**
 * The single decision point. `PROCEED_WITHOUT_HUMAN` is constructed from the stated delay
 * and from nothing else, so no code path below can reach it without one.
 */
export function decodeApprovalPolicy(settings: unknown): ApprovalPolicy {
  const stated = settingsObject(settings);
  if (stated === null || stated.approvalMode !== SPEED_APPROVAL_MODE) return REQUIRE_HUMAN;
  const delayMs = statedDelay(stated.speedModeDelayMs);
  if (delayMs === null) return REQUIRE_HUMAN;
  return Object.freeze({ delayMs, kind: "PROCEED_WITHOUT_HUMAN" as const });
}

/**
 * Converts an environment string ONLY when it is unambiguously a non-negative integer, and
 * otherwise hands the raw value straight to the decoder to be refused. The regex is what
 * keeps `Number()` from inventing a delay: it would read "" as 0, " 25 " as 25, "1e3" as
 * 1000 and "0x10" as 16, and each of those is a delay the settings did not state.
 */
function delaySetting(raw: string | undefined): unknown {
  if (raw === undefined || !/^\d+$/u.test(raw)) return raw;
  return Number(raw);
}

/** Reads the approval settings off an environment. No default, no permissive fallback. */
export function readApprovalPolicySettings(
  env: Readonly<Record<string, string | undefined>>,
): ApprovalPolicy {
  return decodeApprovalPolicy({
    approvalMode: env[APPROVAL_MODE_ENV_KEY],
    speedModeDelayMs: delaySetting(env[SPEED_MODE_DELAY_ENV_KEY]),
  });
}
