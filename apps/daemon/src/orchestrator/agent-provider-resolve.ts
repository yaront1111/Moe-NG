import type { SqliteEventStore } from "@moe/store";

import { NODE_DELIVER_KIND } from "../http/affordance-contract.js";
import { KNOWN_PROVIDERS } from "../http/health-read.js";
import type { ProviderPauseGate } from "./agent-provider-pause.js";
import { readAgentProvider } from "./agent-provider-store.js";
import type { ProviderPauseFacts } from "./agent-spawn-contract.js";
import type { AgentProviderReadResult } from "./agent-provider-store.js";
import { DEFAULT_AGENT_COMMAND, providerFor } from "./moe-up-credentials.js";

/**
 * WHICH AGENT COMMAND ONE SEAT IS SPAWNED WITH.
 *
 * The wrapper serves MANY providers: the command is resolved PER SPAWN, not once
 * per wrapper process. Precedence, highest first:
 *
 *   1. `MOE_AGENT_COMMAND` — the host operator's override. It still wins at spawn,
 *      whatever the durable setting says, so a scripted or pinned seat is reachable
 *      without touching project state.
 *   2. the per-GOAL setting, for a goal-targeted step.
 *   3. the per-PROJECT setting (the durable store's `""` scope).
 *   4. the literal `claude`.
 *
 * The durable setting arrives as a LAZY FACT — `(goalId) => string | null` — rather
 * than a store handle, so this module stays pure, needs no sqlite to test, and the
 * composition root (agent-wrapper-main.ts) keeps ownership of the read port.
 *
 * Rung 3 is not decoration: a `node.deliver` seat's `aggregateId` is a nodeRef, not
 * a goal, so node seats carry NO goal ref and take the project setting directly.
 */

/** The project-default scope in the durable store's goal-keyed ledger. */
const PROJECT_SCOPE = "";

/**
 * A codex seat, by COMMAND rather than by provider name: the operator may point
 * `MOE_AGENT_COMMAND` at any path. One definition, imported by the spawner, so a
 * codex seat can never pick up the claude invocation shape (or its MCP config
 * file) because a second copy of this regex drifted.
 */
const CODEX_COMMAND = /(?:^|[\\/])codex(?:\.[a-z]+)?$/iu;

export interface AgentProviderResolveInput {
  /** `MOE_AGENT_COMMAND` as the host set it. Blank or absent reads as unset. */
  readonly envCommand?: string | null | undefined;
  /** The goal the step targets; null for a seat with no goal (e.g. `node.deliver`). */
  readonly goalRef?: string | null | undefined;
  /**
   * The durable setting recorded for EXACTLY this scope, or null when the scope
   * carries none and when the store refuses. Never throws through: a store that
   * cannot be read must not wedge staffing.
   */
  readonly settingFor?: ((goalId: string) => string | null) | undefined;
}

function present(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** One rung's read, fail-safe: an unreadable store answers "no setting", not a throw. */
function settingAt(
  settingFor: ((goalId: string) => string | null) | undefined, scope: string,
): string | null {
  if (settingFor === undefined) return null;
  try {
    return present(settingFor(scope));
  } catch {
    return null;
  }
}

/** The command one seat is spawned with. Always a non-empty string. */
export function resolveAgentProvider(input: AgentProviderResolveInput): string {
  const env = present(input.envCommand);
  if (env !== null) return env;
  const goalRef = present(input.goalRef);
  if (goalRef !== null) {
    const override = settingAt(input.settingFor, goalRef);
    if (override !== null) return override;
  }
  return settingAt(input.settingFor, PROJECT_SCOPE) ?? DEFAULT_AGENT_COMMAND;
}

/**
 * The durable store's read adapted to the fact shape above. A REFUSAL reads as "no
 * setting for this scope", never as a provider: an unreadable store must not repoint a
 * seat, and it must not wedge staffing either. Keeps the composition root to one line.
 */
export function settingOf(read: AgentProviderReadResult): string | null {
  return read.ok ? read.provider : null;
}

/**
 * The lazy fact `AgentWrapperConfig.agentProvider` wants, bound to one durable store and
 * project. Read FRESH per staffed seat, so an operator's `project.set_agent_provider`
 * reaches the very next spawn instead of the next wrapper restart.
 */
export function agentProviderFact(
  store: SqliteEventStore, projectId: string,
): (goalId: string) => string | null {
  return (goalId: string) => settingOf(readAgentProvider(
    { now: () => new Date().toISOString(), projectId, store }, goalId,
  ));
}

/**
 * ONE STEP'S SEAT: which command staffs it, and whether THAT provider is paused right
 * now. Both answers come from one resolution, so the command the pause was checked
 * against is provably the command the seat is spawned with.
 *
 * The caller skips a step whose `pause` is non-null and charges it no attempt — the
 * provider refused, the item never got its turn. It reports PROVIDER_PAUSED for the pass
 * only when a pause is why the pass staffed NOTHING: claiming it while another provider's
 * seat started would make the wrapper's only operator-facing signal lie.
 */
export function decideSeatProvider(input: {
  readonly aggregateId: string | null;
  readonly kind: string;
  readonly nowMs: number;
  readonly pauseGate?: ProviderPauseGate | undefined;
  readonly settingFor?: ((goalId: string) => string | null) | undefined;
}): { readonly command: string; readonly pause: ProviderPauseFacts | null } {
  const command = resolveAgentProvider({
    envCommand: process.env["MOE_AGENT_COMMAND"],
    // A node.deliver seat's aggregateId is a nodeRef, NOT a goal: no per-goal override
    // applies to it and the project setting answers. A stated limit, not an oversight.
    goalRef: input.kind === NODE_DELIVER_KIND ? null : input.aggregateId,
    settingFor: input.settingFor,
  });
  const pause = input.pauseGate?.paused(input.nowMs, pauseProviderOf(command)) ?? null;
  return { command, pause };
}

/** Whether this command is a codex seat (invocation shape, env bearer, no MCP file). */
export function isCodexCommand(command: string): boolean {
  return CODEX_COMMAND.test(command);
}

/**
 * ONE SEAT'S COMMAND AS THE SPAWNER SEES IT, resolved PER SPAWN rather than once per
 * wrapper process: the wrapper's per-seat choice first, then the spawner's own option,
 * then the host env, then claude. That trailing chain is the pre-2026-09-07 resolution
 * verbatim, so a request carrying no provider spawns exactly as it always did.
 */
export function spawnSeatFor(
  requested: string | undefined, option: string | undefined,
): { readonly codex: boolean; readonly command: string } {
  const command = requested ?? option
    ?? process.env["MOE_AGENT_COMMAND"] ?? DEFAULT_AGENT_COMMAND;
  return { codex: isCodexCommand(command), command };
}

/**
 * The provider name the PAUSE LEDGER is keyed by, derived from the resolved command.
 * An unknown command reads as `claude`: a scripted seat printing the claude limit
 * line must park the provider it is imitating, never a name no ledger row uses.
 */
export function pauseProviderOf(command: string): (typeof KNOWN_PROVIDERS)[number] {
  return providerFor(command)?.leaf ?? DEFAULT_AGENT_COMMAND;
}
