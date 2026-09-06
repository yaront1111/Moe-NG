import { useState } from "react";
import type { JSX } from "react";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { writeFailedSaid } from "../outcome-words.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import type { DeployPort } from "./deploy-port.js";

/**
 * THE DEPLOYMENTS CARD on an opened goal: one row per environment, each stating where that
 * environment deploys to, what is running there now, and one arm-then-confirm control.
 *
 * PREVIEW AND PRODUCTION SIT ON THE SAME SURFACE, and that is the whole risk this file is
 * written around. The publish card holds a BOOLEAN armed flag, which is safe there because it
 * has exactly one target; here a boolean would mean that arming preview and then clicking
 * production dispatches PRODUCTION IMMEDIATELY, with no confirm, off a button the operator has
 * never confirmed. So the armed state is KEYED BY ENVIRONMENT: a click on a row that is not the
 * armed one RE-ARMS that row, and only a click on the row that is already armed dispatches.
 *
 * THE CONFIRM NAMES THE ENVIRONMENT, in the button the operator presses, so a production
 * confirm cannot read like a preview one. For production it also states the goal's RELEASE
 * standing before the click, cited when a decision exists and stated plainly when none does:
 * the deploy effect records that either way, and an operator should read it before deciding
 * rather than discover it in a receipt afterwards.
 *
 * NOTHING IS REMEMBERED IN THIS BROWSER, and its test pins that by reading this file's own
 * source for the two web-storage APIs by name. An armed row is per-mount state, so a reload
 * disarms rather than leaving a production deploy one click away.
 * With no offer the card renders NOTHING AT ALL, never a disabled button.
 */

export const DEPLOY_TESTID_ROOT = "cr.deploy.root" as const;

/** What one environment is, as the daemon's receipts state it. The read that fills this lands
 *  with the Runs work on the parent row; the card renders what it is handed and infers nothing. */
export interface DeploymentEnvironmentView {
  /** The last deploy's own code when it refused; null when it deployed or never ran. */
  readonly code: string | null;
  /** The environment name the deploy carries: the safety-critical field. */
  readonly environment: string;
  /** docker's last stderr line for a build failure, so a failure is diagnosable here. */
  readonly detail: string | null;
  readonly outcome: "DEPLOYED" | "REFUSED" | null;
  /** The release decision the last deploy cited, when it cited one. */
  readonly releaseDecision: string | null;
  readonly sha: string | null;
  /** Where this environment deploys to, as `deployment.set_target` bound it. */
  readonly target: string | null;
  readonly time: string | null;
  readonly url: string | null;
}

export interface GoalDeploymentsProps {
  readonly environments: readonly DeploymentEnvironmentView[];
  readonly frame: SurfaceFrame | null;
  readonly goalId: string;
  readonly port: DeployPort | null;
  /** The release decision on the goal NOW, as the daemon stated it; null when it carries none. */
  readonly releaseDecision?: string | null | undefined;
  /** The landed sha a deploy would build. Absent means nothing is landed to deploy. */
  readonly sha?: string | null | undefined;
}

export const PRODUCTION = "production" as const;

/** What a host screen hands the card. Declared here rather than in the host so mounting it
 *  costs the host the composition and nothing else. */
export interface BoardDeploying {
  readonly environments: readonly DeploymentEnvironmentView[];
  readonly port: DeployPort | null;
  readonly releaseDecision?: string | null | undefined;
}

/** The daemon's deployment.deploy offer for this goal, from the surface it stated. */
export function deployOffer(
  frame: SurfaceFrame | null, goalId: string,
): Record<string, unknown> | null {
  if (frame === null || frame.outcome !== "SURFACE") return null;
  const offer = frame.offers.find((row) =>
    row["commandKind"] === "deployment.deploy"
    && row["targetAggregateId"] === `deploy:${goalId}`);
  return offer ?? null;
}

/** What the last deploy did to this environment, in a person's words. */
export function deploymentLine(view: DeploymentEnvironmentView): string {
  if (view.outcome === null) return "Never deployed.";
  if (view.outcome === "DEPLOYED") {
    return `Running ${(view.sha ?? "").slice(0, 10)} since ${view.time ?? "an unknown time"}`;
  }
  return `Last deploy refused ${MIDDOT} ${view.code ?? "REFUSED"}`;
}

/** Where the environment deploys to, or the absence stated as an absence. */
export function targetLine(view: DeploymentEnvironmentView): string {
  return view.target === null
    ? "No target is bound for this environment yet."
    : `Deploys to ${view.target}`;
}

/**
 * The release standing an operator reads BEFORE a production deploy. Two explicit strings, never
 * a fragment that renders empty: the absence is the load-bearing case, and a blank line would
 * read as "not applicable" rather than "nobody has decided".
 */
export function releaseLine(releaseDecision: string | null | undefined): string {
  return releaseDecision === null || releaseDecision === undefined || releaseDecision === ""
    ? "No release decision on this goal. The deploy records that it had none."
    : `Cites release decision ${releaseDecision}.`;
}

/** The four deploy refusals as operator words, verbatim code kept for the details line. */
const REFUSAL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  DEPLOY_BUILD_FAILED: "The build failed, so nothing was replaced.",
  DEPLOY_DOCKER_UNAVAILABLE: "Docker did not answer on the host this environment deploys to.",
  DEPLOY_HEALTH_TIMEOUT:
    "The new container never reported healthy, so the old one is still serving.",
  DEPLOY_TARGET_MISSING: "No target is bound for this environment, so there is nowhere to deploy.",
});

export function refusalWords(code: string): string {
  return REFUSAL_WORDS[code] ?? code;
}

function environmentTestId(environment: string, part: string): string {
  return `cr.deploy.${environment}.${part}`;
}

export function GoalDeployments({
  environments, frame, goalId, port, releaseDecision, sha,
}: GoalDeploymentsProps): JSX.Element | null {
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ readonly environment: string; readonly outcome: OfferOutcome } | null>(null);
  const offer = deployOffer(frame, goalId);
  // No offer means the daemon is not offering this decision at all: the card is not a thing on
  // this screen, rather than a control that cannot be used.
  if (offer === null) return null;
  const landed = typeof sha === "string" && sha !== "";
  const decide = (environment: string): void => {
    if (port === null || !landed) return;
    setArmed(null);
    setBusy(environment);
    setAnswer(null);
    void port.submit(offer, environment, sha ?? "").then((outcome) => {
      setAnswer({ environment, outcome });
      setBusy(null);
    }, () => {
      setAnswer({
        environment,
        outcome: { code: "DEPLOY_DISPATCH_FAILED", layer: "CONTROL_ROOM_DEPLOY", ok: false },
      });
      setBusy(null);
    });
  };
  return (
    <section className="cr2-ops-panel" data-testid={DEPLOY_TESTID_ROOT}>
      <h3 className="cr2-approve-heading">{`DEPLOY ${MIDDOT} YOUR DECISION`}</h3>
      {landed ? null : (
        <p className="cr2-needs-detail" data-testid="cr.deploy.unlanded">Nothing is landed to deploy yet.</p>
      )}
      <ul className="cr2-approve-obligations" data-testid="cr.deploy.environments">
        {environments.map((view) => {
          const isArmed = armed === view.environment;
          const isBusy = busy === view.environment;
          const deployable = port !== null && landed && busy === null;
          return (
            <li
              className="cr2-coverage-section"
              data-testid={environmentTestId(view.environment, "row")}
              key={view.environment}
            >
              <span className="cr2-approve-step-body">{view.environment}</span>
              <p className="cr2-slot-kicker" data-testid={environmentTestId(view.environment, "target")}>{targetLine(view)}</p>
              <p className="cr2-needs-detail" data-testid={environmentTestId(view.environment, "state")}>{deploymentLine(view)}</p>
              {view.url === null ? null : (
                <a className="cr2-link" data-testid={environmentTestId(view.environment, "url")} href={view.url} rel="noreferrer" target="_blank">{view.url}</a>
              )}
              {view.outcome !== "REFUSED" || view.code === null ? null : (
                <p className="cr2-needs-detail" data-testid={environmentTestId(view.environment, "refusal")}>
                  {`${refusalWords(view.code)}${view.detail === null ? "" : ` ${MIDDOT} ${view.detail}`}`}
                </p>
              )}
              {view.code !== "DEPLOY_TARGET_MISSING" ? null : (
                // NAMES THE PREREQUISITE, THE COMMAND THAT BINDS IT, AND THE HONEST LIMIT: no
                // set_target affordance is offered, so a control here would have none to spend.
                <p className="cr2-slot-kicker" data-testid={environmentTestId(view.environment, "settarget")}>
                  {`Bind a target for ${view.environment} first, with deployment.set_target.`
                    + " This screen cannot bind one yet, so it has to be bound outside the"
                    + " browser before a deploy here can go through."}
                </p>
              )}
              {!isArmed || view.environment !== PRODUCTION ? null : (
                <p className="cr2-approve-mono" data-testid={environmentTestId(view.environment, "release")}>
                  {releaseLine(releaseDecision)}
                </p>
              )}
              <ActionButton
                ariaLabel={`Deploy this goal to ${view.environment}`}
                // Disabled WHILE THIS ROW IS IN FLIGHT too. Left enabled, a second click would
                // re-arm the row under the operator and the click after that would dispatch a
                // SECOND deploy of the same environment.
                disabled={!deployable}
                onClick={(): void => {
                  // KEYED BY ENVIRONMENT, never a boolean: a click on a row that is not the
                  // armed one RE-ARMS that row. Only a click on the armed row dispatches, so
                  // arming preview can never fire production.
                  if (!isArmed) { setArmed(view.environment); return; }
                  decide(view.environment);
                }}
                testId={environmentTestId(view.environment, "button")}
              >
                {isBusy ? "Recording your decision..."
                  : isArmed ? `Confirm: deploy to ${view.environment}`
                    : `Deploy to ${view.environment}`}
              </ActionButton>
              {isArmed && !isBusy ? (
                <ActionButton
                  onClick={(): void => setArmed(null)}
                  testId={environmentTestId(view.environment, "cancel")}
                  variant="secondary"
                >
                  Do not deploy
                </ActionButton>
              ) : null}
            </li>
          );
        })}
      </ul>
      {answer === null ? null : answer.outcome.ok ? (
        <p aria-live="polite" className="cr2-needs-note" data-testid="cr.deploy.answer" role="status">
          {`Recorded for ${answer.environment}. The daemon builds and replaces the container;`
            + " the receipt says what it did."}
        </p>
      ) : (
        <OutcomeNote
          code={answer.outcome.code}
          layer={answer.outcome.layer}
          // NAMES THE ENVIRONMENT: one note serves both rows, and an operator reading "that did
          // not go through" beside two environments cannot tell which one refused.
          said={`${writeFailedSaid()} (${answer.environment})`}
          testId="cr.deploy.answer"
        />
      )}
    </section>
  );
}
