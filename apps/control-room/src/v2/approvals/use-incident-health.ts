import { useEffect, useState } from "react";

import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import type { DeploymentsOutcome } from "../../live/live-deployments.js";

/**
 * ONE HEALTH READ PER DEPLOYED ENVIRONMENT, for the incident items in the Needs-you queue.
 *
 * THE ENVIRONMENT SET COMES FROM THE DEPLOY RECORD, NOT FROM A NAME ROSTER, and that choice is
 * the same one `live-environments.tsx` records for the Health screen: `/deployments/health/read`
 * answers for ANY name, and an environment that was never deployed comes back with an empty
 * probe ring, which the daemon states as DEGRADED. Asking about a roster would paint a brand-new
 * project with environments that do not exist. The queue already polls `/deployments/read` per
 * goal for its DEPLOY items, so the deployed set is read off THAT answer - the same authority,
 * already in flight, with no second enumeration to drift.
 *
 * ONLY ENVIRONMENTS THE DAEMON REPORTS DEPLOYED are asked. A REFUSED or never-attempted row is
 * not a running environment and cannot be in an outage.
 *
 * A FAILED READ LEAVES THAT ENVIRONMENT ABSENT rather than storing a value, which is the rule
 * `useGoalReads` already states: an absent environment yields no incident item, and a guessed
 * one would put an outage on the screen that no daemon ever reported.
 */

export const INCIDENT_HEALTH_POLL_MS = 15_000;

/** Every environment the deploy reads report DEPLOYED, deduplicated and in a stable order. */
export function deployedEnvironmentsOf(
  deployments: ReadonlyMap<string, DeploymentsOutcome>,
): readonly string[] {
  const names = new Set<string>();
  for (const outcome of deployments.values()) {
    if (outcome.status !== "DEPLOYMENTS") continue;
    for (const row of outcome.environments) {
      if (row.outcome === "DEPLOYED") names.add(row.environment);
    }
  }
  return Object.freeze([...names].sort((left, right) => left.localeCompare(right)));
}

export function useIncidentHealth(
  environments: readonly string[],
  read: ((environment: string) => Promise<DeploymentsHealthOutcome>) | undefined,
  intervalMs: number = INCIDENT_HEALTH_POLL_MS,
): ReadonlyMap<string, DeploymentsHealthOutcome> {
  const [answers, setAnswers] = useState<ReadonlyMap<string, DeploymentsHealthOutcome>>(new Map());
  // Joined on purpose: this is the effect's dependency, and an array identity would re-arm the
  // interval on every render.
  const key = environments.join("\n");
  useEffect(() => {
    if (read === undefined || key === "") return undefined;
    let live = true;
    const names = key.split("\n");
    const tick = (): void => {
      void Promise.all(names.map(async (environment) => {
        try { return [environment, await read(environment)] as const; } catch { return null; }
      })).then((rows) => {
        if (!live) return;
        setAnswers(new Map(rows.flatMap((row) => (row === null ? [] : [row]))));
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return (): void => { live = false; clearInterval(timer); };
  }, [intervalMs, key, read]);
  return answers;
}
