import { useState } from "react";
import type { JSX, KeyboardEvent } from "react";

import { FactRow, Panel, UNKNOWN_FACT_VALUE, isSupplied } from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";

/**
 * Health / doctor console (spec §2.10, §4.14, §8.7; design 957).
 *
 * The daemon reports the health outcome; this surface reports what the daemon said.
 * Nothing here ranks a check, rolls checks up into an overall verdict, compares an
 * engine version against a minimum, or decides whether startup is eligible — those
 * are daemon facts and arrive already decided. These are presentation contracts, not
 * wire DTOs: no response is parsed, no database is opened, and no OS lock is proven
 * here, because a browser cannot prove one.
 */
export const DOCTOR_HEALTH_OUTCOMES = ["HEALTHY", "DEGRADED", "UNKNOWN_TRUTH"] as const;
export type DoctorHealthOutcome = (typeof DOCTOR_HEALTH_OUTCOMES)[number];

/** The only report mode whose §8.7 copy may be shown. Anything else is not that claim. */
export const DOCTOR_OFFLINE_MODE = "OFFLINE_READ_ONLY";

/**
 * An outcome the payload did not supply, or supplied as a token the contract does not
 * define. Deliberately NOT `UNKNOWN_TRUTH`: that is a verdict the daemon reached, and
 * this is the daemon having said nothing usable.
 */
const OUTCOME_UNSUPPLIED = "UNKNOWN";

const OUTCOME_GLYPHS: Readonly<Record<string, string>> = {
  DEGRADED: "▲",
  HEALTHY: "▣",
  UNKNOWN_TRUTH: "◇",
  [OUTCOME_UNSUPPLIED]: "◇",
};

export interface DoctorCheckPresentation {
  /** Every affected record/effect ID the check named, in the supplied order. */
  readonly affected: readonly SuppliedFact[];
  readonly area: SuppliedFact;
  readonly checkId: string;
  readonly evidence: SuppliedFact;
  readonly outcome: string | null;
  readonly severity: SuppliedFact;
}

/** Displayed proof of an offline read; the browser establishes none of it. */
export interface DoctorOfflineReport {
  readonly asOf: SuppliedFact;
  readonly lockProof: SuppliedFact;
  readonly mode: string;
  readonly suggestedOperations: readonly string[];
}

export interface DoctorConsoleProps {
  readonly checks: readonly DoctorCheckPresentation[];
  readonly degraded?: boolean | undefined;
  readonly freshnessLabel?: string | undefined;
  readonly loading?: boolean | undefined;
  readonly offlineReport?: DoctorOfflineReport | undefined;
  readonly onFocusCheck?: ((checkId: string) => void) | undefined;
  readonly onOpenCheck?: ((checkId: string) => void) | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly overall: SuppliedFact;
  readonly overallOutcome: string | null;
}

function suppliedText(fact: SuppliedFact): string {
  return isSupplied(fact) ? fact?.value ?? UNKNOWN_FACT_VALUE : UNKNOWN_FACT_VALUE;
}

function statedOutcome(outcome: string | null): string {
  const outcomes: readonly string[] = DOCTOR_HEALTH_OUTCOMES;
  return outcome !== null && outcomes.includes(outcome) ? outcome : OUTCOME_UNSUPPLIED;
}

/**
 * One health outcome, triple-encoded as text, glyph, and data attribute. It is never
 * computed from the checks below it: an overall HEALTHY beside a failing check is the
 * daemon's claim to answer for, and hiding it would be this surface's dishonesty.
 */
function HealthOutcome(props: {
  readonly outcome: string | null;
  readonly testId: string;
}): JSX.Element {
  const state = statedOutcome(props.outcome);
  return (
    <div data-health={state} data-testid={props.testId}>
      <span aria-hidden="true" data-testid="cr.health.glyph">
        {OUTCOME_GLYPHS[state] ?? "◇"}
      </span>
      <span data-testid="cr.health.outcometext">{state}</span>
    </div>
  );
}

/**
 * An empty affected list reads as UNKNOWN rather than "none": a check that named no
 * record may have found none or may have failed to enumerate, and only the daemon can
 * tell those apart. On a recovery surface the confident reading is the dangerous one.
 */
function AffectedRecords(props: {
  readonly affected: readonly SuppliedFact[];
  readonly checkId: string;
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { affected, checkId, onProvenance } = props;
  if (affected.length === 0) {
    return (
      <FactRow
        fact={null}
        factId={`health.check.${checkId}.affected`}
        label="Affected records"
        onProvenance={onProvenance}
      />
    );
  }
  return (
    <div>
      {affected.map((fact, index) => (
        <div data-affected-record={suppliedText(fact)} key={`${checkId}#${index}`}>
          <FactRow
            fact={fact}
            factId={`health.check.${checkId}.affected.${index}`}
            label={`Affected record ${index + 1}`}
            onProvenance={onProvenance}
          />
        </div>
      ))}
    </div>
  );
}

function CheckRow(props: {
  readonly check: DoctorCheckPresentation;
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { check, onProvenance } = props;
  const { checkId } = check;
  return (
    <li
      data-check-row={checkId}
      data-testid={`cr.health.check.${checkId}`}
      tabIndex={-1}
    >
      <HealthOutcome outcome={check.outcome} testId={`cr.health.outcome.${checkId}`} />
      <FactRow fact={check.area} factId={`health.check.${checkId}.area`}
        label="Area" onProvenance={onProvenance} />
      <FactRow fact={check.severity} factId={`health.check.${checkId}.severity`}
        label="Severity" onProvenance={onProvenance} />
      <FactRow fact={check.evidence} factId={`health.check.${checkId}.evidence`}
        label="Evidence" onProvenance={onProvenance} />
      <AffectedRecords affected={check.affected} checkId={checkId}
        onProvenance={onProvenance} />
    </li>
  );
}

const OFFLINE_PREFIX = "Daemon not running. Doctor opened the database read-only after "
  + "verifying no process holds it. This report reflects disk state as of ";
const OFFLINE_SUFFIX = ". Commands are unavailable in this mode.";

/**
 * The §8.7 offline report. Suggested operations are rendered as text, never as
 * controls: doctor mode holds no affordance, so a button here would be an invented one.
 */
function OfflineReport(props: {
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly report: DoctorOfflineReport;
}): JSX.Element {
  const { onProvenance, report } = props;
  return (
    <Panel heading="Offline doctor report" testId="cr.health.doctor">
      <p data-testid="cr.health.doctor.banner" role="status">
        {`${OFFLINE_PREFIX}${suppliedText(report.asOf)}${OFFLINE_SUFFIX}`}
      </p>
      <FactRow fact={report.asOf} factId="health.doctor.asof"
        label="Report as of" onProvenance={onProvenance} />
      <FactRow fact={report.lockProof} factId="health.doctor.lockproof"
        label="Exclusive-open proof" onProvenance={onProvenance} />
      <ul data-testid="cr.health.doctor.suggestions">
        {report.suggestedOperations.map((operation, index) => (
          <li data-testid={`cr.health.doctor.suggestion.${index}`} key={`${operation}#${index}`}>
            {operation}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function stepIndex(key: string, current: number): number {
  if (key === "j") return current + 1;
  if (key === "k") return current - 1;
  return current;
}

/**
 * The key's own target, only when it is the list or one of its check rows. A key that
 * reaches a truth chip inside a row belongs to the chip: the walk may not swallow it,
 * because cancelling Enter there cancels the chip's own activation and opens whichever
 * check the cursor last rested on instead.
 */
function checkTarget(event: KeyboardEvent<HTMLUListElement>): HTMLElement | null {
  const { target } = event;
  if (!(target instanceof HTMLElement)) return null;
  if (target !== event.currentTarget && !target.hasAttribute("data-check-row")) return null;
  return target;
}

export function DoctorConsole(props: DoctorConsoleProps): JSX.Element {
  const {
    checks, degraded, freshnessLabel, loading, offlineReport, onFocusCheck, onOpenCheck,
    onProvenance, overall, overallOutcome,
  } = props;
  const [focusIndex, setFocusIndex] = useState(-1);

  const handleKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const { key } = event;
    if (key !== "j" && key !== "k" && key !== "Enter") return;
    const target = checkTarget(event);
    if (target === null) return;
    event.preventDefault();
    // A row reached by Tab or by pointer is the check the key is about, whatever the
    // cursor remembered; the cursor stands in only while the list itself holds focus.
    const rowNodes = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-check-row]")];
    const origin = target === event.currentTarget ? focusIndex : rowNodes.indexOf(target);
    const index = Math.min(Math.max(stepIndex(key, origin), 0), checks.length - 1);
    const check = checks[index];
    if (check === undefined) return;
    setFocusIndex(index);
    rowNodes[index]?.focus();
    if (key === "Enter") onOpenCheck?.(check.checkId);
    else onFocusCheck?.(check.checkId);
  };

  return (
    <section aria-label="Health" data-testid="cr.surface.health">
      {degraded === true ? (
        <p data-testid="cr.health.asof" role="status">
          Showing last-known health as of {freshnessLabel ?? UNKNOWN_FACT_VALUE}
        </p>
      ) : null}
      <Panel heading="Daemon health" testId="cr.health.status">
        <HealthOutcome outcome={overallOutcome} testId="cr.health.outcome.overall" />
        <FactRow fact={overall} factId="health.overall" label="Overall health"
          onProvenance={onProvenance} />
      </Panel>
      {loading === true ? (
        <div data-testid="cr.health.loading">
          {[0, 1, 2].map((slot) => (
            <div data-testid="cr.health.skeleton" key={slot} />
          ))}
        </div>
      ) : (
        <ul data-testid="cr.health.checks" onKeyDown={handleKey} tabIndex={0}>
          {checks.map((check, index) => (
            <CheckRow check={check} key={`${check.checkId}#${index}`}
              onProvenance={onProvenance} />
          ))}
        </ul>
      )}
      {offlineReport !== undefined && offlineReport.mode === DOCTOR_OFFLINE_MODE ? (
        <OfflineReport onProvenance={onProvenance} report={offlineReport} />
      ) : null}
    </section>
  );
}
