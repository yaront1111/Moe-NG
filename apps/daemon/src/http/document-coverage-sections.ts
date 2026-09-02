/**
 * ADVISORY section map for a PRD: which of the document's own headings the approved
 * requirements cite, and how many of the criteria under those requirements are
 * VERIFIED. "Cites" means the statement carries a `§<number>` reference whose number
 * is the heading's number or a descendant of it (`§11.1` counts for `11` and `11.1`).
 *
 * This is derived from prose, so it is advisory by construction: a requirement that
 * covers a section without naming it stays invisible here, and a heading with no
 * number can never be cited. The caller marks the whole map `advisoryOnly: true`; it
 * grants nothing and no command reads it.
 */

export interface SectionCoverage {
  /** Requirements whose statements cite this section (directly or a subsection). */
  readonly cited: number;
  readonly heading: string;
  /** The heading's leading number ("11", "11.1"), or null when the heading has none. */
  readonly number: string | null;
  /** VERIFIED criteria whose requirement or own statement cites this section. */
  readonly verified: number;
}

export interface SectionCoverageCriterion {
  readonly statement: string;
  readonly status: string;
}

export interface SectionCoverageRequirement {
  readonly criteria: readonly SectionCoverageCriterion[];
  readonly statement: string;
}

/** Headings beyond this count are not mapped; a PRD is bounded at ingest anyway. */
export const MAX_SECTION_HEADINGS = 512;

const HEADING = /^#{1,6}\s+(.+?)\s*$/u;
const HEADING_NUMBER = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/u;
const CITATION = /§\s*(\d+(?:\.\d+)*)/gu;
const FENCE = /^\s*(```|~~~)/u;

interface Heading {
  readonly heading: string;
  readonly number: string | null;
}

/** Numbered and unnumbered headings in document order, outside fenced code. */
export function documentHeadings(text: string): readonly Heading[] {
  const headings: Heading[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/u)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = HEADING.exec(line);
    if (match === null) continue;
    const heading = match[1] as string;
    const number = HEADING_NUMBER.exec(heading)?.[1] ?? null;
    headings.push(Object.freeze({ heading, number }));
    if (headings.length >= MAX_SECTION_HEADINGS) break;
  }
  return Object.freeze(headings);
}

/** Every `§` number a statement names, deduplicated. */
export function citedSections(statement: string): ReadonlySet<string> {
  const cited = new Set<string>();
  for (const match of statement.matchAll(CITATION)) cited.add(match[1] as string);
  return cited;
}

function cites(citations: ReadonlySet<string>, sectionNumber: string): boolean {
  for (const citation of citations) {
    if (citation === sectionNumber || citation.startsWith(`${sectionNumber}.`)) return true;
  }
  return false;
}

export function sectionCoverage(
  text: string,
  requirements: readonly SectionCoverageRequirement[],
): readonly SectionCoverage[] {
  const headings = documentHeadings(text);
  const requirementCitations = requirements.map((requirement) => citedSections(requirement.statement));
  const verifiedCitations = requirements.flatMap((requirement, index) =>
    requirement.criteria
      .filter((criterion) => criterion.status === "VERIFIED")
      .map((criterion) => new Set([
        ...(requirementCitations[index] ?? new Set<string>()),
        ...citedSections(criterion.statement),
      ])));
  return Object.freeze(headings.map((entry) => {
    if (entry.number === null) {
      return Object.freeze({ cited: 0, heading: entry.heading, number: null, verified: 0 });
    }
    const number = entry.number;
    return Object.freeze({
      cited: requirementCitations.filter((citations) => cites(citations, number)).length,
      heading: entry.heading,
      number,
      verified: verifiedCitations.filter((citations) => cites(citations, number)).length,
    });
  }));
}
