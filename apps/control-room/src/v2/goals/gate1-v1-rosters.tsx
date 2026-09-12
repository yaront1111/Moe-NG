import type { JSX } from "react";

import { MIDDOT } from "../glyphs.js";
import type { Gate1PendingViewV1 } from "./gate1-v1-approval.js";
import { FoldedRoster } from "./statement-folds.js";

/**
 * The two statement rosters of a pending V1 revision, folded by identifier family
 * (statement-folds.tsx carries the measured stall and the fold rules).
 *
 * `cr.gate1.<requirements|criteria>.group.<family>` names a family's toggle,
 * `cr.gate1.<requirements|criteria>.openall` the open-all control, and each mounted row
 * keeps `cr.gate1.<requirement|criterion>.<id>`.
 */

interface RosterItem {
  readonly id: string;
  readonly statement: string;
}

function Roster({ itemKey, items, sectionId, title }: {
  readonly itemKey: "criterion" | "requirement";
  readonly items: readonly RosterItem[];
  readonly sectionId: "criteria" | "requirements";
  readonly title: string;
}): JSX.Element {
  return (
    <section className="cr2-approve-block" data-testid={`cr.gate1.${sectionId}`}>
      <h3 className="cr2-approve-heading">{`${title} ${MIDDOT} ${String(items.length)}`}</h3>
      <FoldedRoster
        idOf={(item): string => item.id}
        items={items}
        row={(item): JSX.Element => (
          <li className="cr2-approve-obligation" data-testid={`cr.gate1.${itemKey}.${item.id}`}>
            <span className="cr2-approve-mono">{item.id}</span>
            <span className="cr2-approve-step-body">{item.statement}</span>
          </li>
        )}
        testIdPrefix={`cr.gate1.${sectionId}`}
      />
    </section>
  );
}

/** The rosters and the revision identity; the decision controls live above, in the card. */
export function Gate1PendingRosters({ pending }: {
  readonly pending: Gate1PendingViewV1;
}): JSX.Element {
  return (
    <div className="cr2-approve-body" data-testid="cr.gate1.pending">
      <Roster
        itemKey="requirement"
        items={pending.requirements.map((row) => ({
          id: row.requirementId, statement: row.statement,
        }))}
        sectionId="requirements"
        title="REQUIREMENTS"
      />
      <Roster
        itemKey="criterion"
        items={pending.criteria.map((row) => ({ id: row.criterionId, statement: row.statement }))}
        sectionId="criteria"
        title="ACCEPTANCE CRITERIA"
      />
      <details className="cr2-approve-inspect" data-testid="cr.gate1.inspect">
        <summary className="cr2-approve-inspect-summary">Inspect revision</summary>
        <dl className="cr2-approve-hashes">
          <dt>contractId</dt>
          <dd className="cr2-approve-mono">{pending.contractId}</dd>
          <dt>revisionId</dt>
          <dd className="cr2-approve-mono">{pending.revisionId}</dd>
          <dt>revisionDigest</dt>
          <dd className="cr2-approve-mono">{pending.revisionDigest}</dd>
        </dl>
      </details>
    </div>
  );
}
