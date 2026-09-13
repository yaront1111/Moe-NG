import type { LaunchVariable } from "../orchestrator/moe-up-env.js";

/**
 * The launcher's overlay as the project stack carries it: what the operator PRESET and what
 * the launcher MINTED, never what it DEFAULTED.
 *
 * `resolveLaunchEnv` restates every variable it resolved, defaults included, because the dev
 * launcher's children read that overlay as their whole configuration. Inside a stack a
 * defaulted value means something else: `MOE_AGENT_COMMAND=claude (defaulted)` landed in the
 * hosted daemon's and wrapper's `process.env`, `resolveAgentProvider`'s first rung read it as
 * the host operator's override, and the durable `project.set_agent_provider` setting - still
 * offered on every surface read - never reached a spawn, while `/sessions/read` reported
 * `envOverride: true` on a host where nobody set one (measured 2026-09-13 from
 * project-manager-main.ts handing `provider.env` to the stack). A default the child computes
 * for itself is not a fact the launcher may promote to a preset. The same holds for the
 * sign-in directory the credential gate DEFAULTED under USERPROFILE: the seat's CLI searches
 * that directory on its own, and a PRESET `CLAUDE_CONFIG_DIR` (a relocated sign-in) still
 * crosses because it is the operator's word.
 */
export function projectStackLaunchOverlay(
  variables: readonly LaunchVariable[],
): Readonly<Record<string, string>> {
  const overlay: Record<string, string> = {};
  for (const entry of variables) {
    if (entry.source === "DEFAULTED") continue;
    overlay[entry.name] = entry.value;
  }
  return Object.freeze(overlay);
}
