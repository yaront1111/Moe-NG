import { useState } from "react";
import type { JSX, KeyboardEvent } from "react";

import {
  FactRow, Panel, UNKNOWN_FACT_VALUE, isSupplied, readIdentity,
} from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { RecoveryActions } from "./recovery-actions.js";
import type {
  RecoveryActionPresentation,
  RecoveryAuthorityMode,
  RecoveryConfirmationHandler,
} from "./recovery-actions.js";

/**
 * The reconciliation inventory (spec §2.10, §4.14, §8.7; design 1049).
 *
 * A quarantined record is shown, never skipped, and everything derived from it stays
 * visibly UNKNOWN. The choices under a row are whatever the daemon returned for that
 * record — this module knows of no legal set of repairs, so it can neither offer a
 * fourth one nor promise the classic three when the daemon returned fewer. The
 * narrative is copy; only `RecoveryActions` can mutate anything.
 */
export interface ReconciliationRowPresentation {
  readonly actions: readonly RecoveryActionPresentation[];
  /** Every affected record/effect ID the case named, in the supplied order. */
  readonly affected: readonly SuppliedFact[];
  readonly caseType: SuppliedFact;
  /** What the quarantine costs downstream; supplied, not deduced from the finding. */
  readonly derived: SuppliedFact;
  readonly disposition: SuppliedFact;
  readonly evidence: SuppliedFact;
  readonly finding: SuppliedFact;
  readonly quarantined: SuppliedFact;
  readonly recordId: string;
  readonly schedulability: SuppliedFact;
}

export interface ReconciliationInventoryProps {
  readonly authorityMode: RecoveryAuthorityMode;
  /** What this listing could and could not see; an absent limitation is UNKNOWN. */
  readonly coverageLimitation: SuppliedFact;
  readonly disabledCopy?: string | undefined;
  readonly onFocusRow?: ((recordId: string) => void) | undefined;
  readonly onOpenRow?: ((recordId: string) => void) | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly onRequestConfirmation?: RecoveryConfirmationHandler | undefined;
  readonly rows: readonly ReconciliationRowPresentation[];
}

/** §8.7 canonical copy. Only the record and the finding are substituted. */
const NARRATIVE_TAIL = ". It is quarantined — it cannot be scheduled and everything "
  + "derived from it shows UNKNOWN.";

/**
 * An empty listing is a listing, not a clean bill of health: the daemon may have
 * enumerated nothing or may have been unable to enumerate, so the copy refuses to
 * settle that question and the coverage limitation stays on screen either way.
 */
const EMPTY_COPY = "No reconciliation cases were supplied. An empty list is not proof "
  + "that none exist.";

function suppliedText(fact: SuppliedFact): string {
  return isSupplied(fact) ? fact?.value ?? UNKNOWN_FACT_VALUE : UNKNOWN_FACT_VALUE;
}

type RowFactSpec = readonly [
  suffix: string, label: string, pick: (row: ReconciliationRowPresentation) => SuppliedFact,
];

const ROW_FACTS: readonly RowFactSpec[] = [
  ["casetype", "Case type", (row) => row.caseType],
  ["finding", "Finding", (row) => row.finding],
  ["disposition", "Disposition", (row) => row.disposition],
  ["quarantined", "Quarantine", (row) => row.quarantined],
  ["schedulability", "Schedulability", (row) => row.schedulability],
  ["derived", "Derived state", (row) => row.derived],
  ["evidence", "Evidence", (row) => row.evidence],
];

function AffectedRecords(props: {
  readonly affected: readonly SuppliedFact[];
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly recordId: string;
}): JSX.Element {
  const { affected, onProvenance, recordId } = props;
  if (affected.length === 0) {
    return (
      <FactRow fact={null} factId={`reconciliation.${recordId}.affected`}
        label="Affected records" onProvenance={onProvenance} />
    );
  }
  return (
    <div>
      {affected.map((fact, index) => (
        <div data-affected-record={suppliedText(fact)} key={`${recordId}#${index}`}>
          <FactRow fact={fact} factId={`reconciliation.${recordId}.affected.${index}`}
            label={`Affected record ${index + 1}`} onProvenance={onProvenance} />
        </div>
      ))}
    </div>
  );
}

function ReconciliationRow(props: {
  readonly authorityMode: RecoveryAuthorityMode;
  readonly disabledCopy?: string | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly onRequestConfirmation?: RecoveryConfirmationHandler | undefined;
  readonly row: ReconciliationRowPresentation;
}): JSX.Element {
  const { authorityMode, disabledCopy, onProvenance, onRequestConfirmation, row } = props;
  const { recordId } = row;
  return (
    <li
      data-reconciliation-row={recordId}
      data-testid={`cr.health.reconciliation.row.${recordId}`}
      tabIndex={-1}
    >
      <p data-testid={`cr.health.reconciliation.narrative.${recordId}`}>
        {`${readIdentity(recordId)} failed integrity checks during import: `}
        {suppliedText(row.finding)}
        {NARRATIVE_TAIL}
      </p>
      {ROW_FACTS.map(([suffix, label, pick]) => (
        <FactRow fact={pick(row)} factId={`reconciliation.${recordId}.${suffix}`}
          key={suffix} label={label} onProvenance={onProvenance} />
      ))}
      <AffectedRecords affected={row.affected} onProvenance={onProvenance}
        recordId={recordId} />
      <p data-testid={`cr.health.reconciliation.choose.${recordId}`}>Choose:</p>
      <RecoveryActions
        authorityMode={authorityMode}
        disabledCopy={disabledCopy}
        onRequestConfirmation={onRequestConfirmation}
        presentations={row.actions}
        testId={`cr.recovery.reconciliation.${recordId}`}
      />
    </li>
  );
}

function stepIndex(key: string, current: number): number {
  if (key === "j") return current + 1;
  if (key === "k") return current - 1;
  return current;
}

/**
 * The key's own target, only when it is the list or one of its rows. A key that reaches
 * a chip or a `RecoveryActions` button inside a row belongs to that control: the walk
 * may not swallow it, because cancelling Enter on the button is the one way to keep a
 * decision from ever reaching `onRequestConfirmation`, while opening whichever row the
 * cursor last rested on instead.
 */
function rowTarget(event: KeyboardEvent<HTMLUListElement>): HTMLElement | null {
  const { target } = event;
  if (!(target instanceof HTMLElement)) return null;
  if (target !== event.currentTarget && !target.hasAttribute("data-reconciliation-row")) {
    return null;
  }
  return target;
}

export function ReconciliationInventory(props: ReconciliationInventoryProps): JSX.Element {
  const {
    authorityMode, coverageLimitation, disabledCopy, onFocusRow, onOpenRow, onProvenance,
    onRequestConfirmation, rows,
  } = props;
  const [focusIndex, setFocusIndex] = useState(-1);

  const handleKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const { key } = event;
    if (key !== "j" && key !== "k" && key !== "Enter") return;
    const target = rowTarget(event);
    if (target === null) return;
    event.preventDefault();
    // A row reached by Tab or by pointer is the row the key is about, whatever the
    // cursor remembered; the cursor stands in only while the list itself holds focus.
    const rowNodes = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("[data-reconciliation-row]"),
    ];
    const origin = target === event.currentTarget ? focusIndex : rowNodes.indexOf(target);
    const index = Math.min(Math.max(stepIndex(key, origin), 0), rows.length - 1);
    const row = rows[index];
    if (row === undefined) return;
    setFocusIndex(index);
    rowNodes[index]?.focus();
    if (key === "Enter") onOpenRow?.(row.recordId);
    else onFocusRow?.(row.recordId);
  };

  return (
    <Panel heading="NEEDS_RECONCILIATION" testId="cr.health.reconciliation">
      <FactRow fact={coverageLimitation} factId="reconciliation.coverage"
        label="Inventory coverage" onProvenance={onProvenance} />
      {rows.length === 0 ? (
        <p data-testid="cr.health.reconciliation.empty">{EMPTY_COPY}</p>
      ) : (
        <ul data-testid="cr.health.reconciliation.list" onKeyDown={handleKey} tabIndex={0}>
          {rows.map((row, index) => (
            <ReconciliationRow
              authorityMode={authorityMode}
              disabledCopy={disabledCopy}
              key={`${row.recordId}#${index}`}
              onProvenance={onProvenance}
              onRequestConfirmation={onRequestConfirmation}
              row={row}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
