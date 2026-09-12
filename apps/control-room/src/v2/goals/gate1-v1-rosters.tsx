import { useId, useState } from "react";
import type { JSX } from "react";

import { MIDDOT } from "../glyphs.js";
import type { Gate1PendingViewV1 } from "./gate1-v1-approval.js";

/**
 * The two statement rosters of a pending V1 revision, folded by identifier family.
 *
 * MEASURED 2026-09-13 on a live PRD (128 requirements + 150 acceptance criteria,
 * ~111 KB of statement text): the flat roster mounted all 278 bordered rows in one
 * synchronous pass and the tab stopped answering for 20-30 s (a CDP screenshot timed
 * out at 30 s). A closed family mounts its name and count only; its rows enter the
 * tree when the reviewer opens it, so the first paint scales with the number of
 * FAMILIES (REQ-AI, REQ-CON, ..., CRT-*), not with the number of statements.
 */

interface RosterItem {
  readonly id: string;
  readonly statement: string;
}

interface RosterFamily {
  readonly family: string;
  readonly items: readonly RosterItem[];
}

/**
 * The family of an identifier is everything before its last `-` segment:
 * `REQ-AI-001` -> `REQ-AI`, `crit-sso-1` -> `crit-sso`, `req-1` -> `req`. An identifier
 * without a `-` past its first character is its own family.
 */
export function familyOf(id: string): string {
  const cut = id.lastIndexOf("-");
  return cut <= 0 ? id : id.slice(0, cut);
}

/** Families in first-appearance order; rows keep the revision's order inside each. */
function byFamily(items: readonly RosterItem[]): readonly RosterFamily[] {
  const families = new Map<string, RosterItem[]>();
  for (const item of items) {
    const family = familyOf(item.id);
    const rows = families.get(family);
    if (rows === undefined) families.set(family, [item]);
    else rows.push(item);
  }
  return [...families].map(([family, rows]) => ({ family, items: rows }));
}

function Family({ family, itemKey, items, sectionId }: {
  readonly family: string;
  readonly itemKey: "criterion" | "requirement";
  readonly items: readonly RosterItem[];
  readonly sectionId: "criteria" | "requirements";
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <li className="cr2-approve-group">
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        className="cr2-approve-group-toggle"
        data-testid={`cr.gate1.${sectionId}.group.${family}`}
        onClick={(): void => { setOpen((previous) => !previous); }}
        type="button"
      >
        <span className="cr2-approve-group-name">{family}</span>
        <span className="cr2-approve-group-count">{`${MIDDOT} ${items.length}`}</span>
      </button>
      {open ? (
        <ul className="cr2-approve-obligations" id={listId}>
          {items.map((item) => (
            <li
              className="cr2-approve-obligation"
              data-testid={`cr.gate1.${itemKey}.${item.id}`}
              key={item.id}
            >
              <span className="cr2-approve-mono">{item.id}</span>
              <span className="cr2-approve-step-body">{item.statement}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Roster({ itemKey, items, sectionId, title }: {
  readonly itemKey: "criterion" | "requirement";
  readonly items: readonly RosterItem[];
  readonly sectionId: "criteria" | "requirements";
  readonly title: string;
}): JSX.Element {
  return (
    <section className="cr2-approve-block" data-testid={`cr.gate1.${sectionId}`}>
      <h3 className="cr2-approve-heading">{`${title} ${MIDDOT} ${items.length}`}</h3>
      <ul className="cr2-approve-groups">
        {byFamily(items).map((row) => (
          <Family
            family={row.family}
            itemKey={itemKey}
            items={row.items}
            key={row.family}
            sectionId={sectionId}
          />
        ))}
      </ul>
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
