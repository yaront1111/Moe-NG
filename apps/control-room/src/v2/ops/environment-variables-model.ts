import type { ProductContractRevisionV2 } from "@moe/core";

import type { EnvironmentVariablesOutcome } from "../../live/live-environment-variables.js";

/**
 * THE REQUIRED-VS-SET MERGE, as a pure function over the two reads that feed it: the approved
 * contract's required names and the daemon's table of what is set.
 *
 * PURE AND SHARED DELIBERATELY. The Environments screen renders these rows and the goal card
 * counts them; deriving the count separately would let the card and the table disagree about the
 * same environment, and the card is the one an operator reads before a deploy. One function
 * means "N required variables unset" is the table with a filter applied, by construction.
 *
 * NO VALUE APPEARS IN THIS MODULE'S TYPES OR ITS OUTPUT. `EnvironmentVariableTableRow` carries a
 * fingerprint and an instant; there is no slot a value could be merged into.
 */

/**
 * THE ENVIRONMENTS A PROJECT HAS. Restated from `ENVIRONMENT_NAMES` in
 * apps/daemon/src/environment/environment-contracts.ts, because apps/control-room has no import
 * edge to apps/daemon.
 *
 * IT IS A CLOSED ROSTER, NOT A DERIVED ONE, and that was a correction. Enumerating from
 * `/deployments/read` looks more honest but enumerates DEPLOY TARGETS, which is a different axis:
 * a project has these three environments from the moment it exists, and an operator must be able
 * to set `preview` variables BEFORE anything is ever deployed - which is the whole point of the
 * unset count. The store is the authority either way: it refuses ENV_ENVIRONMENT_UNKNOWN @ SCOPE
 * for any name outside its own roster, so a drift here surfaces as that refusal on screen rather
 * than as a silently missing environment. The e2e journey asserts exactly that.
 */
export const ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  "preview", "production", "verify",
]);

export interface EnvironmentVariableTableRow {
  /** The FULL sha256 of the stored value's bytes, or null when the variable is not set. */
  readonly fingerprintSha256: string | null;
  readonly isSet: boolean;
  readonly name: string;
  /** True when the approved contract names it; a set variable it does not name is still shown. */
  readonly required: boolean;
  readonly updatedAt: string | null;
}

/**
 * Required names and set names, merged. UNSET ROWS COME FIRST because they are the ones that
 * make a deploy fail for a reason nobody can see. A set variable the contract does not name is
 * kept rather than hidden - an operator needs to see what is actually in the environment, and an
 * unexpected variable is worth noticing.
 *
 * A read that REFUSED contributes no set names, so every required name reads as unset. That is
 * the honest reading: the screen renders the refusal beside the table, so the count is never
 * presented as a fact about the environment when the environment could not be read.
 */
export function environmentTableRows(
  outcome: EnvironmentVariablesOutcome | null, requiredNames: readonly string[],
): readonly EnvironmentVariableTableRow[] {
  const set = new Map(outcome?.status === "ENVIRONMENT_VARIABLES"
    ? outcome.variables.map((variable) => [variable.name, variable])
    : []);
  const required = new Set(requiredNames);
  const rows = [...new Set([...requiredNames, ...set.keys()])].map(
    (name): EnvironmentVariableTableRow => {
      const variable = set.get(name);
      return {
        fingerprintSha256: variable?.fingerprintSha256 ?? null,
        isSet: variable !== undefined,
        name,
        required: required.has(name),
        updatedAt: variable?.updatedAt ?? null,
      };
    },
  );
  return Object.freeze(rows.sort((left, right) => {
    const rank = Number(left.isSet) - Number(right.isSet);
    return rank !== 0 ? rank : (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  }));
}

/** The count the goal card states, read off the same rows the table renders. */
export function unsetRequiredCount(rows: readonly EnvironmentVariableTableRow[]): number {
  return rows.filter((row) => row.required && !row.isSet).length;
}

/**
 * THE NAMES THE APPROVED CONTRACT REQUIRES, for display.
 *
 * ONLY `deploymentRequirements` CARRIES THE FIELD - `ProductContractV2DeploymentRequirement` is
 * the one requirement subtype with `environmentVariableNames`, and this reads exactly the branch
 * `requiredVariableNames` (apps/daemon/src/environment/environment-required-variables.ts:90)
 * reads. Flattening all six requirement families through `gate1Requirements` would be a wider
 * roster than the daemon's and would count names it will never deliver.
 *
 * THE DAEMON REMAINS THE AUTHORITY. Its copy decides what is DELIVERED to a spawned process and
 * what `.env.example` is pinned against; this one only decides what a screen lists. The sort is
 * the same UTF-16 code-unit order for the same reason - so the two never disagree about ordering
 * when an operator compares them.
 *
 * The name grammar is already enforced upstream: `gate1-contract-shape.ts` admits a revision only
 * when every `environmentVariableNames` member passes its validator, so this does not re-check.
 */
export function requiredEnvironmentNames(
  revision: ProductContractRevisionV2,
): readonly string[] {
  const names: string[] = [];
  for (const requirement of revision.deploymentRequirements) {
    const declared = requirement.environmentVariableNames;
    if (declared === undefined || !Array.isArray(declared)) continue;
    for (const name of declared) {
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return Object.freeze([...new Set(names)].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  ));
}
