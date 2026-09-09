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
import type { EnvironmentHealthRow, EnvironmentsGap } from "./environments-section.js";

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
/**
 * How many goal reads are in flight at once. The catalog is DRAINED IN FULL - `readGoalCatalog`
 * already pages to exhaustion and refuses `GOAL_CATALOG_DRAIN_BOUND_EXCEEDED` rather than
 * truncating - so the fan-out is PACED in batches instead of bounded by dropping goals. Dropping
 * them silently excluded every goal past the bound, and a project whose only deployment sat on a
 * later goal read as "No environment deployed": a false empty, the one sentence this surface must
 * never say without knowing it.
 */
const GOAL_READ_BATCH = 12;
const LAYER = "CONTROL_ROOM_ENVIRONMENTS";

/** Why the deployed set could not be assembled, one stable code per cause. */
export const ENVIRONMENTS_CATALOG_CODES = Object.freeze({
  REFUSED: "ENVIRONMENTS_CATALOG_REFUSED",
  UNDELIVERED: "ENVIRONMENTS_CATALOG_UNDELIVERED",
  UNREADABLE: "ENVIRONMENTS_CATALOG_UNREADABLE",
} as const);
export const ENVIRONMENTS_READ_FAILED = "ENVIRONMENTS_READ_FAILED";
/** One goal read threw. Counted as a failed goal, never allowed to reject the whole sweep. */
export const DEPLOYMENTS_READ_FAILED = "ENVIRONMENTS_DEPLOYMENTS_READ_FAILED";

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

/**
 * What the goal sweep found, AND what it could not read. A goal read RESOLVES its failures - the
 * outer catch below never sees them - so an enumeration that dropped them would report the goals
 * it happened to read as though they were all of them.
 */
interface Enumeration {
  readonly environments: readonly string[];
  /** The first failure verbatim, so the code AND the layer that refused both stay visible. */
  readonly failure: SectionRefusal | null;
  readonly goalsFailed: number;
  /** EVERY goal the catalog named, read or not - the denominator the gap note is stated against. */
  readonly goalsTotal: number;
}

/** Runs `of` over every item, GOAL_READ_BATCH at a time. Nothing is dropped and nothing fans out
 *  unbounded: both halves of this surface open one read per row and both are paced through here. */
async function inBatches<In, Out>(
  items: readonly In[], of: (item: In) => Promise<Out>,
): Promise<readonly Out[]> {
  const out: Out[] = [];
  for (let start = 0; start < items.length; start += GOAL_READ_BATCH) {
    out.push(...await Promise.all(items.slice(start, start + GOAL_READ_BATCH).map(of)));
  }
  return out;
}

/** Every environment the daemon reports DEPLOYED, across EVERY goal the catalog names, deduped. */
async function deployedEnvironmentsOf(
  catalog: GoalCatalogFrame, readDeploys: (goalRef: string) => Promise<DeploymentsOutcome>,
): Promise<Enumeration> {
  const names = new Set<string>();
  let failure: SectionRefusal | null = null;
  let goalsFailed = 0;
  // A goal read that THROWS is counted like one that refused, rather than rejecting the batch and
  // blanking a surface that could still have shown the goals that did answer beside the gap. The
  // code is this client own here because a throw carries none of the daemon vocabulary.
  const answers = await inBatches(catalog.goals, async (goal) =>
    readDeploys(goal.goalId).catch((): DeploymentsOutcome =>
      ({ code: DEPLOYMENTS_READ_FAILED, layer: LAYER, status: "ERROR" })));
  for (const answer of answers) {
    if (answer.status !== "DEPLOYMENTS") {
      goalsFailed += 1;
      failure ??= { code: answer.code, layer: answer.layer };
      continue;
    }
    for (const environment of answer.environments) {
      if (environment.outcome === "DEPLOYED") names.add(environment.environment);
    }
  }
  return { environments: [...names].sort(), failure, goalsFailed, goalsTotal: catalog.goals.length };
}

type Assembled =
  | {
    readonly kind: "ROWS";
    readonly gap: EnvironmentsGap | null;
    readonly rows: readonly EnvironmentHealthRow[];
  }
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
  const found = await deployedEnvironmentsOf(catalog, readers.deploys);
  // EVERY goal read failed: nothing at all is known about what is deployed, so the section
  // refuses in the FAILING READ's own vocabulary rather than rendering an empty list. The code
  // and layer travel verbatim - which layer refused is the first thing an operator needs.
  if (found.failure !== null && found.goalsFailed === found.goalsTotal) {
    return { kind: "REFUSED", refusal: found.failure };
  }
  const rows = await inBatches(found.environments,
    async (environment): Promise<EnvironmentHealthRow> => ({
      environment, outcome: await readers.health(environment),
    }));
  // SOME goals answered and some did not. The rows that WERE read still render - hiding them
  // would be its own false report - but they are stated as INCOMPLETE beside the refusing code,
  // because a partial list rendered as a whole one is how an operator concludes an environment
  // they cannot see is not deployed.
  const gap = found.failure === null
    ? null
    : {
      code: found.failure.code, goalsFailed: found.goalsFailed,
      goalsTotal: found.goalsTotal, layer: found.failure.layer,
    };
  return { gap, kind: "ROWS", rows };
}

export function LiveEnvironments({
  headers, pollMs, readBackupList, readCatalog, readDeploys, readHealth,
}: LiveEnvironmentsProps): JSX.Element {
  const [rows, setRows] = useState<readonly EnvironmentHealthRow[] | null>(null);
  const [gap, setGap] = useState<EnvironmentsGap | null>(null);
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
      setGap(next.kind === "ROWS" ? next.gap : null);
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
  return (
    <EnvironmentsSection
      backups={backups}
      environments={rows}
      incomplete={gap}
      nowMs={nowMs}
      refusal={refusal}
    />
  );
}
