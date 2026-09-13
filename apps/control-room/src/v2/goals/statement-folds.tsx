import { Fragment, useId, useState } from "react";
import type { JSX } from "react";

import { MIDDOT } from "../glyphs.js";

/**
 * STATEMENT ROSTERS THAT MOUNT BY GROUP, NOT BY STATEMENT.
 *
 * MEASURED 2026-09-13 on a live PRD (128 requirements + 150 acceptance criteria, ~111 KB
 * of statement text): opening the goal board stopped the tab for 20-30 s (a CDP screenshot
 * timed out at 30 s). That one paint mounted at least THREE flat copies of the 278 bordered
 * rows in one synchronous pass - the V1 Gate 1 card (gate1-v1-rosters.tsx), the coverage
 * dossier right under it (contract-dossier.tsx) and PRD coverage inside the closed
 * "Everything else" fold (prd-coverage.tsx; React mounts a closed <details>' children).
 * The share of the stall each copy carried was NOT measured separately: the per-roster
 * attribution is inferred from the DOM each one built, and the board has not been re-timed
 * since the folds landed. The V2 Gate 1 dossier (gate1-contract-dossier.tsx) would mount a
 * fourth copy after cutover.activate. All four fold through this one component, so the
 * first paint of each scales with the number of GROUPS, never with the statements.
 *
 * - Up to FLAT_LIMIT rows render flat: a one-statement roster (the e2e fixtures' `req-1`)
 *   is read without a click, and a roster of singletons is not a toggle per statement.
 * - Past that, rows group by identifier family (`REQ-AI-001` -> `REQ-AI`). A family larger
 *   than CHUNK_SIZE splits into runs named by their first and last id, so ONE click never
 *   mounts more than a run; when every family holds one row (ids with no shared prefix)
 *   the whole roster is one such family and folds into runs the same way.
 * - LIMIT: only a roster whose families are ALL singletons falls back to runs. A mixed
 *   roster - named families beside dash-less or one-off ids - keeps one toggle per singleton
 *   family, so 40 `REQ-AI-*` rows beside 30 bare ids show two family toggles and 30 more.
 *   Whether real PRDs mix the two shapes has not been observed; "Open all" covers it.
 * - Every group is closed by default and mounts its rows only while open; "Open all"
 *   opens (and then closes) every group at once.
 */

export const FLAT_LIMIT = 20;
export const CHUNK_SIZE = 25;
const ELLIPSIS = "…";

/**
 * The family of an identifier is everything before its last `-` segment:
 * `REQ-AI-001` -> `REQ-AI`, `crit-sso-1` -> `crit-sso`, `req-1` -> `req`. An identifier
 * without a `-` past its first character is its own family.
 */
export function familyOf(id: string): string {
  const cut = id.lastIndexOf("-");
  return cut <= 0 ? id : id.slice(0, cut);
}

export interface FoldGroup<T> {
  readonly items: readonly T[];
  /** Names the toggle: `<prefix>.group.<key>`; the family, or a run's first id. */
  readonly key: string;
  /** What the toggle shows: the family, or `first ... last` for a run. */
  readonly label: string;
}

function runsOf<T>(
  rows: readonly T[], idOf: (item: T) => string, family: string | null,
): readonly FoldGroup<T>[] {
  if (family !== null && rows.length <= CHUNK_SIZE) {
    return [{ items: rows, key: family, label: family }];
  }
  const runs: FoldGroup<T>[] = [];
  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const run = rows.slice(start, start + CHUNK_SIZE);
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) break;
    runs.push({
      items: run, key: idOf(first), label: `${idOf(first)} ${ELLIPSIS} ${idOf(last)}`,
    });
  }
  return runs;
}

/** The groups of a roster in first-appearance order, or null when it renders flat. */
export function foldGroups<T>(
  items: readonly T[], idOf: (item: T) => string,
): readonly FoldGroup<T>[] | null {
  if (items.length <= FLAT_LIMIT) return null;
  const families = new Map<string, T[]>();
  for (const item of items) {
    const family = familyOf(idOf(item));
    const rows = families.get(family);
    if (rows === undefined) families.set(family, [item]);
    else rows.push(item);
  }
  // Every family a singleton: the fold by id buys nothing, so the roster is one family.
  if (families.size === items.length) return runsOf(items, idOf, null);
  return [...families].flatMap(([family, rows]) => runsOf(rows, idOf, family));
}

export interface FoldedRosterProps<T> {
  readonly idOf: (item: T) => string;
  readonly items: readonly T[];
  /** Renders one `<li>` for an item; the fold keys it by `idOf`. */
  readonly row: (item: T) => JSX.Element;
  /** `<prefix>.group.<key>` names each toggle, `<prefix>.openall` the open-all control. */
  readonly testIdPrefix: string;
}

export function FoldedRoster<T>(
  { idOf, items, row, testIdPrefix }: FoldedRosterProps<T>,
): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const listId = useId();
  const groups = foldGroups(items, idOf);
  const rows = (list: readonly T[]): JSX.Element[] =>
    list.map((item) => <Fragment key={idOf(item)}>{row(item)}</Fragment>);
  if (groups === null) return <ul className="cr2-approve-obligations">{rows(items)}</ul>;
  const allOpen = groups.every((group) => open.has(group.key));
  return (
    <>
      <p className="cr2-approve-fold-bar">
        <button
          className="cr2-approve-openall"
          data-testid={`${testIdPrefix}.openall`}
          onClick={(): void => {
            setOpen(allOpen ? new Set() : new Set(groups.map((group) => group.key)));
          }}
          type="button"
        >
          {allOpen ? "Close all" : "Open all"}
        </button>
      </p>
      <ul className="cr2-approve-groups">
        {groups.map((group, index) => {
          const isOpen = open.has(group.key);
          const id = `${listId}-${String(index)}`;
          return (
            <li className="cr2-approve-group" key={group.key}>
              <button
                aria-controls={isOpen ? id : undefined}
                aria-expanded={isOpen}
                className="cr2-approve-group-toggle"
                data-testid={`${testIdPrefix}.group.${group.key}`}
                onClick={(): void => {
                  setOpen((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  });
                }}
                type="button"
              >
                <span className="cr2-approve-group-name">{group.label}</span>
                <span className="cr2-approve-group-count">{`${MIDDOT} ${String(group.items.length)}`}</span>
              </button>
              {isOpen ? (
                <ul className="cr2-approve-obligations" id={id}>{rows(group.items)}</ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
