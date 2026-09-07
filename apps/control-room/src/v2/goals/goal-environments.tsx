import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { EnvironmentVariablesOutcome } from "../../live/live-environment-variables.js";
import type { LiveSetup } from "../../live/live-config.js";
import { LiveEnvironmentVariables } from "../ops/live-environment-variables.js";
import {
  ENVIRONMENT_NAMES, environmentTableRows, requiredEnvironmentNames, unsetRequiredCount,
} from "../ops/environment-variables-model.js";
import { readPendingContract } from "./gate1-approval.js";
import { GOAL_SECTION_IDS } from "./goal-status-strip.js";

/**
 * THE ENVIRONMENTS SECTION OF A GOAL: the unset-count card that stops a deploy failing for a
 * reason nobody can see, and beneath it the screen where an operator fixes it.
 *
 * WHY THIS IS GOAL-SCOPED AND NOT ON HEALTH. The required names come from the APPROVED CONTRACT,
 * and a contract belongs to a goal. The project-scoped Health screen has no contract to read, so
 * a copy there could only ever say "set" or "not set" without knowing what is REQUIRED - which
 * is the entire content of the card.
 *
 * EVERY ENVIRONMENT THE PROJECT HAS IS LISTED, from the store's own closed roster
 * (`ENVIRONMENT_NAMES`) rather than from `/deployments/read`, which enumerates DEPLOY TARGETS - a
 * different axis. An operator must be able to set `preview` variables BEFORE anything is ever
 * deployed; that is the whole point of the unset count, and a deploy-derived list would show
 * nothing on exactly the projects that need it most.
 *
 * NO VALUE PASSES THROUGH THIS MODULE. It reads names and counts. The card renders neither a
 * value nor a fingerprint - a fingerprint on a summary card is the thing an operator would most
 * plausibly mistake for a truncated secret.
 */

const POLL_MS = 15_000;

export interface GoalEnvironmentsProps {
  readonly goalId: string;
  /** Injectable for tests; the defaults spend the attached session's own headers. */
  readonly readContract?: ((goalId: string) => Promise<ContractAnswer>) | undefined;
  readonly readVariables?: ((environment: string) => Promise<EnvironmentVariablesOutcome>) | undefined;
  readonly setup: LiveSetup;
}

type ContractAnswer = Awaited<ReturnType<typeof readPendingContract>>;

/**
 * THE ONLY READ THIS SECTION MAKES: the approved contract, for the required names. The variable
 * TABLES are not read here - each `LiveEnvironmentVariables` below reads its own environment once
 * and reports the answer back through `onOutcome`, so there is exactly ONE read per environment.
 * A second read here would be a second answer, and the card and the table it links to could then
 * state different counts for the same environment.
 *
 * A CONTRACT THAT IS NOT READABLE YIELDS NO REQUIRED NAMES, and the card is then ABSENT rather
 * than showing zero. Zero required is a fact about a contract that names none; an unread contract
 * is not that fact, and a card saying "0 unset" over one is the quiet green that gets believed.
 */
async function readRequiredNames(
  goalId: string, read: (goalId: string) => Promise<ContractAnswer>,
): Promise<readonly string[]> {
  const contract = await read(goalId);
  return contract.status === "CURRENT" || contract.status === "PENDING"
    ? requiredEnvironmentNames(contract.revision)
    : [];
}

/**
 * "N required variables unset for <environment>", with a link to the screen below.
 *
 * ABSENT WHEN NOTHING IS REQUIRED - absent, not a zero badge. A card that renders "0 unset" for
 * every environment on every goal is noise an operator learns to skip, and the one time it says
 * 2 they will skip it too.
 *
 * IT NAMES THE ENVIRONMENT. "2 unset for preview" and "2 unset for production" are different
 * facts, and a card that omits which one it means invites the operator to fix the wrong one.
 */
function UnsetCard({ count, environment }: {
  readonly count: number; readonly environment: string;
}): JSX.Element {
  return (
    <p data-count={String(count)} data-testid={`cr.env-vars.unset-card.${environment}`}>
      <a href={`#${GOAL_SECTION_IDS.environments}`}>
        {`${String(count)} required variables unset for ${environment}`}
      </a>
    </p>
  );
}

export function LiveGoalEnvironments({
  goalId, readContract, readVariables, setup,
}: GoalEnvironmentsProps): JSX.Element {
  const [requiredNames, setRequiredNames] = useState<readonly string[]>([]);
  const [tables, setTables] = useState<Readonly<Record<string, EnvironmentVariablesOutcome>>>({});
  const [readers] = useState(() => ({
    /**
     * GATED ON THE PLANE, and that is a correctness fence rather than a precaution.
     * `readPendingContract` reads `/v2/product-contract/pending/read`, and a V1-plane session
     * must never touch a `/v2/...` route - cordum-app.tsx picks its Gate 1 card the same way,
     * and cordum-app.test.tsx asserts the exclusivity in both directions.
     *
     * `expectedProjectId` is the bootstrap authority the read pins against; it is null only on
     * the legacy build-time dev path, where there is no project to pin to. Either gate answers
     * NONE, which yields no required names and therefore NO CARD - the same honest degrade as an
     * unreadable contract, and never a zero badge over a contract nobody read.
     */
    contract: readContract ?? ((ref: string): Promise<ContractAnswer> => (
      setup.projectId === null || setup.commandAuthorityPlane !== "V2"
        ? Promise.resolve({ status: "NONE" as const })
        : readPendingContract(setup.headers, ref, setup.projectId))),
  }));
  const generation = useRef(0);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    const tick = (): void => {
      void readRequiredNames(goalId, readers.contract).then((next) => {
        if (generation.current === run) setRequiredNames(next);
      }, () => {
        // A failed read leaves the section as it was rather than claiming nothing is required.
      });
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [goalId, readers]);
  const onOutcome = useCallback(
    (environment: string, outcome: EnvironmentVariablesOutcome): void => {
      setTables((previous) => (previous[environment] === outcome
        ? previous : { ...previous, [environment]: outcome }));
    }, []);
  // Only when a caller injected one (tests). Undefined otherwise, so each screen keeps its own
  // default read against the attached session's headers.
  const readVariablesFor = useCallback(
    (environment: string): (() => Promise<EnvironmentVariablesOutcome>) | undefined => (
      readVariables === undefined ? undefined : () => readVariables(environment)),
    [readVariables]);
  return (
    <div id={GOAL_SECTION_IDS.environments}>
      {requiredNames.length > 0 && ENVIRONMENT_NAMES.map((environment) => (
        <UnsetCard
          count={unsetRequiredCount(environmentTableRows(tables[environment] ?? null, requiredNames))}
          environment={environment} key={environment}
        />
      ))}
      {ENVIRONMENT_NAMES.map((environment) => (
        <LiveEnvironmentVariables
          environment={environment} headers={setup.headers} key={environment}
          onOutcome={onOutcome} read={readVariablesFor(environment)}
          requiredNames={requiredNames} setup={setup}
        />
      ))}
    </div>
  );
}
