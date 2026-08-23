import { createHash } from "node:crypto";

import {
  type PreFreezeAuditRefusal, preFreezeAuditRefusal,
} from "./pre-freeze-audit-vocabulary.js";
import type { FrozenReferenceFamily } from "./pre-freeze-audit-rosters.js";

/**
 * THE PINNED-BYTES GATE, AND THE TOKEN PRIMITIVES EVERY AUDIT CHECK READS THROUGH IT.
 *
 * NOTHING IS PARSED BEFORE ITS DIGEST IS VERIFIED. `readPinnedSource` hashes the bytes it
 * was handed and refuses SPEC_BYTES_UNPINNED unless they equal the caller's pin. Every
 * other export in this file takes a `PinnedSource`, which only that function can mint, so
 * there is no path through this module that parses unverified bytes.
 *
 * THAT IS ALSO WHY THE PIN IS A PARAMETER RATHER THAN A BAKED-IN CONSTANT. A production
 * caller passes `PINNED_BENCHMARK_SPEC_SHA256` and no substitute document can satisfy it,
 * because nothing hashes to that digest except those bytes. A test may open a small
 * synthetic document by handing in ITS OWN true digest — which admits a document without
 * ever weakening the production pin, since the synthetic bytes still are what they claim.
 * Baking the pin in would have forced tests to reach for a mock of this module instead,
 * and a mocked hash gate is a disabled hash gate.
 *
 * NO PATH IS RESOLVED HERE. The pinned documents live outside the repository under epic
 * rail 1; a production module hard-coding one host's absolute layout would be untestable
 * and unportable. `pre-freeze-pinned-documents.ts` is the thin caller that reads them.
 *
 * RAW BYTES, NEVER NORMALISED. The two pinned documents do not even agree on line endings
 * — the benchmark spec is CRLF, the rebuild design is LF — so a normalising pass before
 * hashing would change one digest and shift every line number this module reports.
 */

/** Benchmark spec, Revision 4, 523 lines. Confirming this is NOT ratifying the revision. */
export const PINNED_BENCHMARK_SPEC_SHA256 =
  "a62b90436cc0b911fb28526af7b7e0f2d1370f6f93db91c26077f6e2956a589c";

/** Rebuild design. Equals epic rail 1's pin, which is what makes it a legitimate anchor. */
export const PINNED_REBUILD_DESIGN_SHA256 =
  "1d9d1ec97d3f07247fbbc088045e0ba2fd6da8307f10a9026c55106419383191";

/**
 * The brand that makes "nothing parses unpinned bytes" a TYPE guarantee rather than a
 * convention. Without it `PinnedSource` is structural, so any `{lines, sha256, text}`
 * literal satisfies every parser in this package and the hash gate becomes advisory. The
 * symbol is exported only because a type alias cannot reference a private name; importing
 * it to hand-forge a source would be a deliberate act, not an accident.
 */
export const PINNED_SOURCE_BRAND: unique symbol = Symbol("moe/pre-freeze-pinned-source");

/** A document whose digest has been verified. `lines[i]` is physical line `i + 1`. */
export type PinnedSource = {
  readonly [PINNED_SOURCE_BRAND]: true;
  readonly lines: readonly string[];
  readonly sha256: string;
  readonly text: string;
};

export type LocatedToken = { readonly line: number; readonly text: string };

export const isPinnedSource = (
  value: PinnedSource | PreFreezeAuditRefusal,
): value is PinnedSource => PINNED_SOURCE_BRAND in value;

export const readPinnedSource = (
  bytes: Uint8Array,
  expectedSha256: string,
): PinnedSource | PreFreezeAuditRefusal => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256.toLowerCase()) {
    return preFreezeAuditRefusal("SPEC_BYTES_UNPINNED", 0, sha256);
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  return Object.freeze({
    [PINNED_SOURCE_BRAND]: true as const,
    lines: Object.freeze(text.split(/\r?\n/)),
    sha256,
    text,
  });
};

/**
 * RANGE EXPANSION — the single easiest thing in this audit to get silently wrong.
 *
 * The benchmark writes `CORE-I1…CORE-I22` as a RANGE and never as 22 uses: measured, only
 * `CORE-I1` and `CORE-I22` appear as literal tokens anywhere in it. A collector that read
 * literals only would hand a "bidirectional" sweep a two-element set, which iterates,
 * generates cases, and passes while proving nothing about the other twenty.
 *
 * Returns null rather than a short set when the endpoints are not a range, so a caller
 * cannot mistake a malformed expression for a small one.
 *
 * THE SPAN IS BOUNDED. Endpoints are read out of a document, so `CORE-I1..999999999` is
 * one typo away from allocating a billion strings. The real families are 22 and 14 members
 * and the cap is three orders of magnitude above that, so no honest range reaches it —
 * while an absurd one is refused rather than exhausting memory. An over-cap range is
 * treated exactly like a malformed one, and the family cardinality check then reports the
 * resulting shortfall.
 */
export const EXPANDED_RANGE_SPAN_CAP = 4096;

export const expandFamilyRange = (
  family: FrozenReferenceFamily,
  low: number,
  high: number,
): readonly string[] | null => {
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high < low) return null;
  if (high - low + 1 > EXPANDED_RANGE_SPAN_CAP) return null;
  return Object.freeze(
    Array.from({ length: high - low + 1 }, (_unused, index) => `${family}${low + index}`),
  );
};

/**
 * FIVE SPELLINGS, BECAUSE THE DOCUMENT USES THREE AND A NEIGHBOUR IS ONE KEYSTROKE AWAY.
 * Measured in the pinned spec: U+2026 HORIZONTAL ELLIPSIS (spec:64, :85), U+2013 EN DASH
 * (spec:143, :195, :200, :469), ASCII `..` (spec:407, :428) and the brace form
 * `CORE-I{1..22}` (spec:440). U+2014 EM DASH is accepted too — it is the document's most
 * common dash and a revision that reached for it would otherwise silently under-count.
 */
const RANGE_SEPARATOR = "(?:\\u2026|\\u2013|\\u2014|\\.\\.\\.?)";

const familyPattern = (family: FrozenReferenceFamily): string =>
  family.replace("-", "\\-");

const rangeMatchers = (family: FrozenReferenceFamily): readonly RegExp[] => {
  const f = familyPattern(family);
  return [
    new RegExp(`${f}(\\d+)\`?\\s*${RANGE_SEPARATOR}\\s*\`?(?:${f})?(\\d+)`, "g"),
    new RegExp(`${f}\\{(\\d+)\\.\\.(\\d+)\\}`, "g"),
  ];
};

/**
 * Every USE of a family token, with its exact line. Ranges are expanded to their full
 * member set; literal tokens are collected too, so an endpoint that is also written
 * literally is not lost. Callers reduce to a set — duplicates here are real occurrences.
 */
export const collectFamilyUses = (
  source: PinnedSource,
  family: FrozenReferenceFamily,
): readonly LocatedToken[] => {
  const literal = new RegExp(`${familyPattern(family)}\\d+`, "g");
  const matchers = rangeMatchers(family);
  const found: LocatedToken[] = [];
  source.lines.forEach((text, index) => {
    const line = index + 1;
    for (const matcher of matchers) {
      for (const match of text.matchAll(matcher)) {
        const members = expandFamilyRange(family, Number(match[1]), Number(match[2]));
        for (const member of members ?? []) found.push({ line, text: member });
      }
    }
    for (const match of text.matchAll(literal)) found.push({ line, text: match[0] });
  });
  return Object.freeze(found);
};

/**
 * DEFINITION anchors, which are a different thing from uses and must never be collected by
 * the same scan. Both pinned documents declare a family member as a list item whose first
 * bold run opens with the token: `- **BENCH-S1 — small causal bug…**` in the benchmark,
 * `1. **CORE-I1 Claim uniqueness:**` in the design. A mention anywhere else is a use.
 */
export const collectFamilyDefinitions = (
  source: PinnedSource,
  family: FrozenReferenceFamily,
): readonly LocatedToken[] => {
  const anchor = new RegExp(`^\\s*(?:\\d+\\.|[-*])\\s+\\*\\*(${familyPattern(family)}\\d+)\\s`);
  const found: LocatedToken[] = [];
  source.lines.forEach((text, index) => {
    const match = anchor.exec(text);
    if (match) found.push({ line: index + 1, text: match[1] as string });
  });
  return Object.freeze(found);
};

/**
 * TOKENISE PERMISSIVELY, VALIDATE AGAINST THE TRANSCRIBED ROSTER. A pattern narrowed to
 * the twenty known IDs would make an INVENTED gate — `G-L9` — invisible rather than
 * unresolved, and a roster check cannot refuse what the tokeniser never emitted. Matching
 * the shape and letting the audit reject non-members is what keeps that arm alive.
 */
const GATE_ID = /G-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;

export const collectGateIdUses = (source: PinnedSource): readonly LocatedToken[] => {
  const found: LocatedToken[] = [];
  source.lines.forEach((text, index) => {
    for (const match of text.matchAll(GATE_ID)) found.push({ line: index + 1, text: match[0] });
  });
  return Object.freeze(found);
};

/**
 * BARE `S{n}` / `I{n}` TOKENS, which spec:62 forbids "anywhere" because the same bare
 * number names a different artifact in the CORE and BENCH namespaces.
 *
 * The lookbehind is what keeps this honest in both directions. Without it every
 * `CORE-S3` and `BENCH-S3` would be reported as bare, and the audit would refuse the very
 * document it certifies. With it, `S{1..14}` — the notation spec:62 uses to STATE the
 * prohibition — is also correctly ignored, because no digit follows the letter.
 */
const BARE_SCENARIO_TOKEN = /(?<![A-Za-z0-9_-])([SI])(\d{1,3})(?![A-Za-z0-9_-])/g;

export const collectBareScenarioTokens = (source: PinnedSource): readonly LocatedToken[] => {
  const found: LocatedToken[] = [];
  source.lines.forEach((text, index) => {
    for (const match of text.matchAll(BARE_SCENARIO_TOKEN)) {
      found.push({ line: index + 1, text: match[0] });
    }
  });
  return Object.freeze(found);
};

const SECTION_POINTER = /\bSection (\d+(?:\.\d+)*)/g;
const NUMBERED_HEADING = /^#{2,6}\s+(\d+(?:\.\d+)*)\.?\s+\S/;

export const collectSectionPointers = (source: PinnedSource): readonly LocatedToken[] => {
  const found: LocatedToken[] = [];
  source.lines.forEach((text, index) => {
    for (const match of text.matchAll(SECTION_POINTER)) {
      found.push({ line: index + 1, text: match[1] as string });
    }
  });
  return Object.freeze(found);
};

export const collectHeadingNumbers = (source: PinnedSource): readonly LocatedToken[] => {
  const found: LocatedToken[] = [];
  source.lines.forEach((text, index) => {
    const match = NUMBERED_HEADING.exec(text);
    if (match) found.push({ line: index + 1, text: match[1] as string });
  });
  return Object.freeze(found);
};
