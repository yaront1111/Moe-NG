import type { JSX } from "react";

import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import { resourceSections } from "./resources-model.js";
import type { ResourceFact, ResourceReads } from "./resources-model.js";

/**
 * RESOURCES: what this project actually is, one measured fact per row.
 *
 * Every row is always present. A fact the daemon refused shows the refusal's stable
 * code and layer where its value would be, because a row that vanished would read as
 * "this project has no such resource" - a different and false claim from "I could not
 * read it". The same holds for a fact no read serves: it is stated as unserved rather
 * than left off the page.
 *
 * The provider rows carry the credential's SOURCE and never its value; that fence is
 * held in resources-model.ts and this file renders only what the model handed it.
 */

const ROW_CLASS = "cr2-ops-fact";

function FactRow({ fact, sectionId }: {
  readonly fact: ResourceFact; readonly sectionId: string;
}): JSX.Element {
  const id = `${sectionId}.${fact.id}`;
  return (
    <div className={ROW_CLASS} data-state={fact.state.kind} data-testid={`cr.resources.fact.${id}`}>
      <dt className="cr2-ops-fact-label">{fact.label}</dt>
      <dd className="cr2-ops-fact-value">
        {fact.state.kind === "MEASURED" ? (
          <span data-testid={`cr.resources.value.${id}`}>{fact.state.value}</span>
        ) : fact.state.kind === "PENDING" ? (
          <span className="cr2-slot-kicker" data-testid={`cr.resources.pending.${id}`}>Reading...</span>
        ) : (
          <OutcomeNote
            code={fact.state.refusal.code}
            layer={fact.state.refusal.layer}
            said={fact.state.said}
            testId={`cr.resources.refusal.${id}`}
          />
        )}
      </dd>
    </div>
  );
}

export function ResourcesScreen({ reads }: { readonly reads: ResourceReads }): JSX.Element {
  const sections = resourceSections(reads);
  const facts = sections.flatMap((section) => section.facts);
  const readable = facts.filter((row) => row.state.kind === "MEASURED").length;
  const refusedCount = facts.filter((row) => row.state.kind === "REFUSED").length;
  // A row no read serves is REFUSED from the first paint, so "still reading" is measured
  // from the PENDING rows rather than from the absence of refusals.
  const stillReading = facts.some((row) => row.state.kind === "PENDING");
  return (
    <section className="cr2-ops" data-testid="cr.resources.screen">
      <p className="cr2-approve-banner" data-testid="cr.resources.banner">
        {readable === 0 && stillReading
          ? "Reading this project's resources..."
          : readable === 0
            ? `None of this project's resources could be read. ${String(refusedCount)} of ${String(facts.length)} facts state why below.`
            : `${String(readable)} of ${String(facts.length)} facts measured ${MIDDOT} ${String(refusedCount)} could not be read`}
      </p>
      {sections.map((section) => (
        <div className="cr2-ops-card" data-testid={`cr.resources.section.${section.id}`} key={section.id}>
          <p className="cr2-slot-kicker">{section.title}</p>
          <dl className="cr2-ops-facts">
            {section.facts.map((row) => (
              <FactRow fact={row} key={row.id} sectionId={section.id} />
            ))}
          </dl>
        </div>
      ))}
      <p className="cr2-needs-note" data-testid="cr.resources.note">
        Every fact here is read from the daemon, never composed in this tab. The provider row
        states where its credential comes from and never what it is.
      </p>
    </section>
  );
}
