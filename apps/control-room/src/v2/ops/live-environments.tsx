import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { readBackups } from "../../live/live-backups.js";
import type { BackupsOutcome } from "../../live/live-backups.js";
import { readDeployments } from "../../live/live-deployments.js";
import type { DeploymentsOutcome } from "../../live/live-deployments.js";
import { readDeploymentsHealth } from "../../live/live-deployments-health.js";
import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import { readGoalCatalog } from "../../live/live-goal-catalog.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { EnvironmentsSection } from "./environments-section.js";
import type { EnvironmentHealthRow } from "./environments-section.js";

/**
 * THE ENVIRONMENTS SECTION, ON THE WIRE. The Health screen is project-scoped and holds no goal,
 * but deployments are recorded per goal, so the deployed set is assembled from served reads
 * rather than guessed from a name roster: the goal catalog names the goals, `/deployments/read`
 * names each goal's environments, and only those the daemon reports DEPLOYED are asked for
 * health.
 *
 * WHY NOT ASK ABOUT A FIXED ROSTER. `/deployments/health/read` answers for any environment name,
 * and an environment that was never deployed comes back with an empty probe ring, which the
 * daemon states as DEGRADED. Asking about a roster would therefore paint a brand-new project
 * with several degraded environments that do not exist. Enumerating from the deploy record is
 * what keeps "nothing deployed" distinguishable from "deployed and unwell".
 *
 * A FAILED ENUMERATION IS NEVER AN EMPTY ONE. A catalog that refuses, or a read that throws,
 * yields a REFUSAL carrying a stable code, not a zero-length list. Collapsing the two would
 * make the section say "no environment deployed" about a project it could not read.
 */

const POLL_MS = 15_000;
/** A bound on the fan-out: the catalog is unbounded and each goal costs one deployments read. */
const MAX_GOALS = 12;
const LAYER = "CONTROL_ROOM_ENVIRONMENTS";

/** Why the deployed set could not be assembled, one stable code per cause. */
export const ENVIRONMENTS_CATALOG_CODES = Object.freeze({
  REFUSED: "ENVIRONMENTS_CATALOG_REFUSED",
  UNDELIVERED: "ENVIRONMENTS_CATALOG_UNDELIVERED",
  UNREADABLE: "ENVIRONMENTS_CATALOG_UNREADABLE",
} as const);
export const ENVIRONMENTS_READ_FAILED = "ENVIRONMENTS_READ_FAILED";

type SectionRefusal = { readonly code: string; readonly layer: string };

export const BACKUPS_READ_FAILED = "BACKUPS_READ_FAILED";

export interface LiveEnvironmentsProps {
  readonly headers: Readonly<Record<string, string>>;
  readonly pollMs?: number | undefined;
  /** Injectable for tests; the defaults spend the attached session's own headers. */
  readonly readBackupList?: (() => Promise<BackupsOutcome>) | undefined;
  readonly readCatalog?: (() => Promise<GoalCatalogFrame>) | undefined;
  readonly readDeploys?: ((goalRef: string) => Promise<DeploymentsOutcome>) | undefined;
  readonly readHealth?: ((environment: string) => Promise<DeploymentsHealthOutcome>) | undefined;
}

/** Every environment the daemon reports DEPLOYED, across the goals the catalog names, deduped. */
async function deployedEnvironmentsOf(
  catalog: GoalCatalogFrame, readDeploys: (goalRef: string) => Promise<DeploymentsOutcome>,
): Promise<readonly string[]> {
  const answers = await Promise.all(
    catalog.goals.slice(0, MAX_GOALS).map(async (goal) => readDeploys(goal.goalId)),
  );
  const names = new Set<string>();
  for (const answer of answers) {
    if (answer.status !== "DEPLOYMENTS") continue;
    for (const environment of answer.environments) {
      if (environment.outcome === "DEPLOYED") names.add(environment.environment);
    }
  }
  return [...names].sort();
}

type Assembled =
  | { readonly kind: "ROWS"; readonly rows: readonly EnvironmentHealthRow[] }
  | { readonly kind: "REFUSED"; readonly refusal: SectionRefusal };

async function assemble(readers: {
  readonly catalog: () => Promise<GoalCatalogFrame>;
  readonly deploys: (goalRef: string) => Promise<DeploymentsOutcome>;
  readonly health: (environment: string) => Promise<DeploymentsHealthOutcome>;
}): Promise<Assembled> {
  const catalog = await readers.catalog();
  // The catalog's own non-GOALS outcomes each get their own code, so an operator can tell a
  // refusal from an undelivered page from an unreadable frame without opening a console.
  if (catalog.outcome !== "GOALS") {
    return { kind: "REFUSED", refusal: { code: ENVIRONMENTS_CATALOG_CODES[catalog.outcome], layer: LAYER } };
  }
  const environments = await deployedEnvironmentsOf(catalog, readers.deploys);
  const rows = await Promise.all(environments.map(
    async (environment): Promise<EnvironmentHealthRow> => ({
      environment, outcome: await readers.health(environment),
    }),
  ));
  return { kind: "ROWS", rows };
}

export function LiveEnvironments({
  headers, pollMs, readBackupList, readCatalog, readDeploys, readHealth,
}: LiveEnvironmentsProps): JSX.Element {
  const [rows, setRows] = useState<readonly EnvironmentHealthRow[] | null>(null);
  const [refusal, setRefusal] = useState<SectionRefusal | null>(null);
  const [backups, setBackups] = useState<BackupsOutcome | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [readers] = useState(() => ({
    backups: readBackupList ?? ((): Promise<BackupsOutcome> => readBackups(headers)),
    catalog: readCatalog ?? ((): Promise<GoalCatalogFrame> => readGoalCatalog({ headers })),
    deploys: readDeploys ?? ((goalRef: string): Promise<DeploymentsOutcome> => readDeployments(headers, goalRef)),
    health: readHealth
      ?? ((environment: string): Promise<DeploymentsHealthOutcome> => readDeploymentsHealth(headers, environment)),
  }));
  const generation = useRef(0);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    let inFlight = false;
    const settle = (next: Assembled): void => {
      if (generation.current !== run) return;
      setRefusal(next.kind === "REFUSED" ? next.refusal : null);
      if (next.kind === "ROWS") setRows(next.rows);
      setNowMs(Date.now());
    };
    // THE BACKUPS READ IS INDEPENDENT of the deployed-set enumeration, and settles on its own.
    // Folding them together would let a catalog refusal blank a backups list the daemon answered
    // perfectly well - and, far worse in the other direction, let a backups refusal be reported
    // as though the environments themselves could not be read.
    //
    // IT ALSO CARRIES ITS OWN IN-FLIGHT GATE rather than sharing the one below. `inFlight` is
    // released when the ENUMERATION settles, so a backups read slower than the enumeration would
    // otherwise have a second one started beside it, and whichever resolved LAST would win -
    // which on this surface means an older restore-proof state overwriting a newer one. Only one
    // backups read is ever outstanding.
    let backupsInFlight = false;
    const settleBackups = (next: BackupsOutcome): void => {
      backupsInFlight = false;
      if (generation.current !== run) return;
      setBackups(next);
    };
    const tick = (): void => {
      // A thrown read is a FAILED read, never an empty one - here as much as below. An empty
      // list would tell an operator this project has no backups, which is the one sentence a
      // surface about restore-proof must never say without knowing it.
      if (!backupsInFlight) {
        backupsInFlight = true;
        void readers.backups().then(settleBackups, (): void => {
          settleBackups({ code: BACKUPS_READ_FAILED, layer: LAYER, status: "ERROR" });
        });
      }
      if (inFlight) return;
      inFlight = true;
      void assemble(readers).then(settle, (): void => {
        settle({ kind: "REFUSED", refusal: { code: ENVIRONMENTS_READ_FAILED, layer: LAYER } });
      }).finally((): void => { inFlight = false; });
    };
    tick();
    const timer = setInterval(tick, pollMs ?? POLL_MS);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [pollMs, readers]);
  return <EnvironmentsSection backups={backups} environments={rows} nowMs={nowMs} refusal={refusal} />;
}
