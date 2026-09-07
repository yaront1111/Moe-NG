import type { JSX } from "react";

import type { DeploymentsHealthOutcome, EnvironmentHealthView } from "../../live/live-deployments-health.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";

/**
 * THE ENVIRONMENTS SECTION on the Health screen: one card per deployed environment, carrying
 * the state the DAEMON derived from its probe ring, when it last answered, and why it cannot
 * be probed when that is the case.
 *
 * IT DERIVES NOTHING. `data-status` is `outcome.state` copied across, never recomputed from a
 * latency or a probe status this component can see. The daemon owns one probe ring and one
 * opinion about it; a second opinion here is the one an operator would read when the two
 * disagree, and it would be the wrong one.
 *
 * FOUR OUTCOMES ARE DISTINCT AND ALL REAL ON DAY ONE: still reading, nothing deployed, the
 * read refused, and deployed but unprobeable. An operator looking at a blank section cannot
 * tell the first three apart, and an unprobeable environment rendered green is the worst
 * output this surface can produce, so each renders its own words.
 */

const STATE_WORDS: Readonly<Record<EnvironmentHealthView["state"], string>> = Object.freeze({
  DEGRADED: "Degraded",
  DOWN: "Down",
  UP: "Up",
});

const PROBE_WORDS: Readonly<Record<"FAILURE" | "SUCCESS" | "UNPROBEABLE", string>> = Object.freeze({
  FAILURE: "the last probe failed",
  SUCCESS: "the last probe answered",
  UNPROBEABLE: "the last probe could not be attempted",
});

/** One environment and the health read that answered for it; `outcome` is null while reading. */
export interface EnvironmentHealthRow {
  readonly environment: string;
  readonly outcome: DeploymentsHealthOutcome | null;
}

function ago(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
}

/** When the environment last answered a probe, in words, with the raw instant kept beside it. */
function probeWords(view: EnvironmentHealthView, nowMs: number): string {
  const probe = view.lastProbe;
  if (probe === null) return "No probe has been recorded yet.";
  return `${PROBE_WORDS[probe.status]} ${ago(probe.at, nowMs)} ${MIDDOT} ${String(probe.latencyMs)} ms`;
}

/**
 * The card for one environment. `data-status` is the FRAME state verbatim, and the words beside
 * it come from the same value, so a copy revision cannot make the two disagree.
 */
function EnvironmentCard({ nowMs, view }: {
  readonly nowMs: number;
  readonly view: EnvironmentHealthView;
}): JSX.Element {
  const testId = `cr.environments.card.${view.environment}`;
  return (
    <li
      className="cr2-ops-card"
      data-status={view.state}
      data-testid={testId}
      data-unprobeable={view.probeRefusal === null ? undefined : "true"}
      key={view.environment}
    >
      <p className="cr2-slot-kicker" data-testid={`${testId}.name`}>{view.environment}</p>
      <p className="cr2-approve-step-body" data-testid={`${testId}.state`}>
        {`${STATE_WORDS[view.state]} ${MIDDOT} ${probeWords(view, nowMs)}`}
      </p>
      {view.probeRefusal === null ? null : (
        <p className="cr2-approve-mono" data-testid={`${testId}.unprobeable`}>
          {`This environment cannot be probed ${MIDDOT} ${view.probeRefusal.code} @ ${view.probeRefusal.layer}`}
        </p>
      )}
      {view.incident === null ? null : (
        <p className="cr2-needs-note" data-testid={`${testId}.incident`}>
          {`Incident ${String(view.incident.id)} opened ${ago(view.incident.openedAt, nowMs)}`}
        </p>
      )}
      {view.lastError === null ? null : (
        <p className="cr2-approve-mono" data-testid={`${testId}.error`}>{view.lastError.line}</p>
      )}
    </li>
  );
}

/** One row: still reading, refused, or the environment card. Never a blank list item. */
function EnvironmentRow({ nowMs, row }: {
  readonly nowMs: number;
  readonly row: EnvironmentHealthRow;
}): JSX.Element {
  const testId = `cr.environments.card.${row.environment}`;
  if (row.outcome === null) {
    return (
      <li className="cr2-ops-card" data-testid={`${testId}.loading`} key={row.environment}>
        <p className="cr2-slot-kicker">{`Reading ${row.environment}...`}</p>
      </li>
    );
  }
  if (row.outcome.status !== "DEPLOYMENTS_HEALTH") {
    return (
      <li className="cr2-ops-card" data-testid={`${testId}.refused`} key={row.environment}>
        <OutcomeNote
          code={row.outcome.code}
          layer={row.outcome.layer}
          said={readFailedSaid(`health of ${row.environment}`)}
          testId={`cr.environments.refusal.${row.environment}`}
        />
      </li>
    );
  }
  return <EnvironmentCard nowMs={nowMs} view={row.outcome} />;
}

export function EnvironmentsSection({ environments, nowMs, refusal }: {
  /** Null while the deployments read has not answered; empty when nothing is deployed. */
  readonly environments: readonly EnvironmentHealthRow[] | null;
  readonly nowMs: number;
  /**
   * Why the deployed set itself could not be assembled. It outranks every state below: a
   * failed enumeration rendered as an empty list would tell an operator that nothing is
   * deployed, which is the one sentence this surface must never say without knowing it.
   */
  readonly refusal?: { readonly code: string; readonly layer: string } | null | undefined;
}): JSX.Element {
  if (refusal !== null && refusal !== undefined) {
    return (
      <section className="cr2-ops" data-testid="cr.environments.root">
        <OutcomeNote
          code={refusal.code}
          layer={refusal.layer}
          said={readFailedSaid("deployed environments")}
          testId="cr.environments.refusal"
        />
      </section>
    );
  }
  if (environments === null) {
    return (
      <section className="cr2-ops" data-testid="cr.environments.root">
        <p className="cr2-slot-kicker" data-testid="cr.environments.loading">Reading the environments...</p>
      </section>
    );
  }
  if (environments.length === 0) {
    return (
      <section className="cr2-ops" data-testid="cr.environments.root">
        <div className="cr2-goals-empty" data-testid="cr.environments.empty">
          <p className="cr2-goals-empty-title">No environment deployed.</p>
          <p className="cr2-goals-empty-body">
            Deploy an environment from its goal and the daemon starts probing it on a durable
            schedule. Nothing here yet is different from nothing answering.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="cr2-ops" data-testid="cr.environments.root">
      <p className="cr2-slot-kicker" data-testid="cr.environments.kicker">
        {`Environments ${MIDDOT} ${String(environments.length)} deployed`}
      </p>
      <ul className="cr2-needs-list" data-testid="cr.environments.list">
        {environments.map((row) => <EnvironmentRow key={row.environment} nowMs={nowMs} row={row} />)}
      </ul>
    </section>
  );
}
