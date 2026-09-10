import { describe, expect, it } from "vitest";

import {
  ALPHA_LANDING, BRAVO_LANDING, CRITERION_ARTIFACT, GOAL_ID, HEAD_SHA, ORPHAN_LANDING, OTHER_SHA,
  PROJECT_ID, RECEIPT_SHA, ancestryOf, dossierInput,
} from "./release-dossier-fixtures.js";
import type { AncestryVerdict, DossierInput } from "./release-dossier-contracts.js";
import { criterionRows, releaseDossierGaps, renderReleaseDossier } from "./release-dossier.js";

/**
 * The golden. It pins EVERY section byte-for-byte, not the presence of a heading:
 * a section-presence assertion stays green while list order drifts, and a released
 * dossier that reorders between renderings cannot be diffed against the last one.
 */
const GOLDEN = [
  "# Release dossier: Ship the release dossier",
  "",
  `- Goal: ${GOAL_ID}`,
  `- Project: ${PROJECT_ID}`,
  `- Re-measured at sha: ${HEAD_SHA}`,
  "- Record: moe-release-dossier/1",
  "",
  "## Acceptance criteria",
  "",
  "| Criterion | Title | Node | Verifier command | Exit | Receipt sha | Landing sha |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  `| crit-alpha | Dossier renders every section | node-alpha | pnpm --filter @moe/daemon test | 0 | ${RECEIPT_SHA} | ${ALPHA_LANDING} |`,
  `| crit-bravo | Dossier is stored durably | node-bravo | pnpm typecheck | 0 | ${RECEIPT_SHA} | ${BRAVO_LANDING} |`,
  "| crit-charlie | Dossier bytes are diffable | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |",
  "",
  "## Unverified evidence",
  "",
  "Every citation below could not be re-measured at this sha. It is listed rather than dropped, because an omitted row and a verified row are indistinguishable to a reader.",
  "",
  "| Criterion | Code | Why |",
  "| --- | --- | --- |",
  "| crit-charlie | CRITERION_UNCOVERED | no verifying node carries this criterion |",
  "",
  "## Review rounds",
  "",
  "| Node | Round | Outcome | Refusal code |",
  "| --- | --- | --- | --- |",
  "| node-alpha | 1 | ACCEPTED | NONE |",
  "| node-bravo | 1 | REFUSED | REVIEW_EVIDENCE_MISSING |",
  "| node-bravo | 2 | ACCEPTED | NONE |",
  "",
  "## Preview decision",
  "",
  "- Decision: dec-preview-1",
  "- Outcome: PREVIEW_PUBLISHED",
  "- Decided at: 2026-09-05T10:00:00.000Z",
  "- URL: https://preview.example/goal-release-1",
  "",
  "## Installed policy",
  "",
  "- Installed policy revision: pol-000000000007",
  "",
].join("\n");

const bytes = (markdown: string): Buffer => Buffer.from(markdown, "utf8");

describe("release dossier golden", () => {
  it("pins every section for a representative goal", () => {
    const { predicate } = ancestryOf();
    expect(renderReleaseDossier(dossierInput(), HEAD_SHA, predicate)).toBe(GOLDEN);
  });

  it("renders the criteria, gaps and review rounds in sorted order, not input order", () => {
    const input = dossierInput();
    // The fixture supplies both lists unsorted; if the generator rendered input order
    // the golden above would already be red, so pin the premise the golden rests on.
    expect(input.criteria.map((criterion) => criterion.criterionId))
      .toStrictEqual(["crit-charlie", "crit-alpha", "crit-bravo"]);
    expect(input.reviewRounds.map((round) => `${round.nodeKey}#${round.round}`))
      .toStrictEqual(["node-bravo#1", "node-alpha#1", "node-bravo#2"]);
    const rendered = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    expect(rendered.indexOf("| crit-alpha ")).toBeLessThan(rendered.indexOf("| crit-bravo "));
    expect(rendered.indexOf("| crit-bravo ")).toBeLessThan(rendered.indexOf("| crit-charlie "));
    expect(rendered.indexOf("| node-alpha | 1 ")).toBeLessThan(rendered.indexOf("| node-bravo | 1 "));
    expect(rendered.indexOf("| node-bravo | 1 ")).toBeLessThan(rendered.indexOf("| node-bravo | 2 "));
  });
});

describe("release dossier determinism", () => {
  it("produces byte-identical output across two calls on the same input", () => {
    const input = dossierInput();
    const first = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    const second = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    expect(bytes(first).equals(bytes(second))).toBe(true);
    expect(bytes(first).byteLength).toBe(bytes(GOLDEN).byteLength);
  });

  it("does not mutate the caller's lists, so a second render cannot see a re-sorted input", () => {
    const input = dossierInput();
    const criteriaBefore = input.criteria.map((criterion) => criterion.criterionId);
    const roundsBefore = input.reviewRounds.map((round) => `${round.nodeKey}#${round.round}`);
    renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    expect(input.criteria.map((criterion) => criterion.criterionId)).toStrictEqual(criteriaBefore);
    expect(input.reviewRounds.map((round) => `${round.nodeKey}#${round.round}`))
      .toStrictEqual(roundsBefore);
  });
});

describe("release dossier absent evidence", () => {
  it("states in words that there is no preview decision rather than leaving a blank", () => {
    const rendered = renderReleaseDossier(
      dossierInput({ preview: null }), HEAD_SHA, ancestryOf().predicate,
    );
    expect(rendered).toContain("## Preview decision\n\nThere is no preview decision for this goal.");
    expect(rendered).not.toContain("- Decision: dec-preview-1");
  });

  it("lists a criterion with no verifying node as uncovered instead of omitting it", () => {
    const rendered = renderReleaseDossier(dossierInput(), HEAD_SHA, ancestryOf().predicate);
    // The criterion id must appear in the LISTED section: a dropped row and a covered
    // row are indistinguishable to a reader, which is the failure being guarded.
    expect(rendered).toContain(
      "| crit-charlie | CRITERION_UNCOVERED | no verifying node carries this criterion |",
    );
    expect(rendered).toContain("| crit-charlie | Dossier bytes are diffable | UNKNOWN |");
  });

  it("names a criterion whose node is not execution-bearing, with the missing key", () => {
    const input = dossierInput({
      criteria: [{ criterionId: "crit-ghost", nodeKey: "node-ghost", title: "Ghost" }],
    });
    const rendered = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    expect(rendered).toContain("| crit-ghost | CRITERION_UNCOVERED | no verifying node carries this"
      + " criterion (node-ghost is not an execution-bearing node of this goal) |");
  });

  it("states the absence of a policy revision, review rounds and criteria in words", () => {
    const rendered = renderReleaseDossier(
      dossierInput({ criteria: [], policyRevision: null, reviewRounds: [] }),
      HEAD_SHA, ancestryOf().predicate,
    );
    expect(rendered).toContain("The daemon measured no installed policy revision.");
    expect(rendered).toContain("No review rounds are recorded for this goal.");
    expect(rendered).toContain("No approved acceptance criteria are recorded for this goal.");
    expect(rendered).toContain("Every cited commit was re-measured as an ancestor of this sha.");
  });

  it("renders UNKNOWN and a RECEIPT_ABSENT row for a landed node with no verifier receipt", () => {
    const input = dossierInput({
      criteria: [{ criterionId: "crit-alpha", nodeKey: "node-alpha", title: "Alpha" }],
      nodes: [{
        landingSha: ALPHA_LANDING, nodeKey: "node-alpha", receipt: null, sharedAcrossPlans: false,
      }],
    });
    const rendered = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    expect(rendered).toContain(
      `| crit-alpha | Alpha | node-alpha | UNKNOWN | UNKNOWN | UNKNOWN | ${ALPHA_LANDING} |`,
    );
    expect(rendered).toContain(
      "| crit-alpha | RECEIPT_ABSENT | the verifying node recorded no verifier receipt |",
    );
  });

  it("emits BOTH gap rows when a criterion has neither a receipt nor a landing", () => {
    const input = dossierInput({
      criteria: [{ criterionId: "crit-alpha", nodeKey: "node-alpha", title: "Alpha" }],
      nodes: [{
        landingSha: null, nodeKey: "node-alpha", receipt: null, sharedAcrossPlans: false,
      }],
    });
    const rendered = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    expect(rendered).toContain("| crit-alpha | LANDING_ABSENT |");
    expect(rendered).toContain("| crit-alpha | RECEIPT_ABSENT |");
  });
});

describe("release dossier re-measurement", () => {
  it("renders UNKNOWN and LISTS the criterion when its landing is not an ancestor", () => {
    const input = dossierInput({
      criteria: [{ criterionId: "crit-orphan", nodeKey: "node-orphan", title: "Orphaned landing" }],
      nodes: [{
        landingSha: ORPHAN_LANDING,
        nodeKey: "node-orphan",
        receipt: {
          command: "pnpm test", exitCode: 0, receiptId: "f".repeat(64), sha: RECEIPT_SHA,
        },
        sharedAcrossPlans: false,
      }],
    });
    const rendered = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    // The CRITERION ID must appear in the listed section. A test that only checked
    // "UNKNOWN appears somewhere" would pass on a dossier that DROPPED this row and
    // printed UNKNOWN in an unrelated cell — the exact failure being guarded.
    expect(rendered).toContain(`| crit-orphan | LANDING_NOT_ANCESTOR | the cited landing commit is`
      + ` not an ancestor of this sha (${ORPHAN_LANDING}) |`);
    // ...and the landing CELL is UNKNOWN, not the unverified sha presented as evidence.
    expect(rendered).toContain(
      "| crit-orphan | Orphaned landing | node-orphan | pnpm test | 0 | " + RECEIPT_SHA + " | UNKNOWN |",
    );
    expect(rendered).not.toContain(`| ${ORPHAN_LANDING} |`);
  });

  it("differs on the sha column for the same goal at two different shas", () => {
    const input = dossierInput();
    const atHead = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    const atOther = renderReleaseDossier(input, OTHER_SHA, ancestryOf().predicate);
    // This is what catches a generator that ACCEPTS a sha and ignores it, which would
    // otherwise pass every single-sha assertion in this file.
    expect(bytes(atHead).equals(bytes(atOther))).toBe(false);
    expect(atHead).toContain(`- Re-measured at sha: ${HEAD_SHA}`);
    expect(atHead).not.toContain(OTHER_SHA);
    expect(atOther).toContain(`- Re-measured at sha: ${OTHER_SHA}`);
    expect(atOther).not.toContain(HEAD_SHA);
  });

  it("re-measures the same landing differently at two shas, as the real edge does", () => {
    // The production predicate closes over the sha (`git merge-base --is-ancestor
    // <landing> <sha>`), so the SAME landing is an ancestor at one sha and not at the
    // other. The evidence column must follow the sha, not the ledger.
    const input = dossierInput({
      criteria: [{ criterionId: "crit-alpha", nodeKey: "node-alpha", title: "Alpha" }],
    });
    const atHead = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    const atOther = renderReleaseDossier(
      input, OTHER_SHA, ancestryOf({ [ALPHA_LANDING]: "NOT_ANCESTOR" }).predicate,
    );
    expect(atHead).toContain(`| ${ALPHA_LANDING} |`);
    expect(atOther).not.toContain(`| ${ALPHA_LANDING} |`);
    expect(atHead).toContain("Every cited commit was re-measured as an ancestor of this sha.");
    expect(atOther).toContain("| crit-alpha | LANDING_NOT_ANCESTOR |");
  });

  it("consults the ancestry predicate once per CITED COMMIT, not once per criterion", () => {
    const input = dossierInput({
      criteria: [
        { criterionId: "crit-one", nodeKey: "node-alpha", title: "One" },
        { criterionId: "crit-two", nodeKey: "node-alpha", title: "Two" },
        { criterionId: "crit-three", nodeKey: "node-bravo", title: "Three" },
      ],
    });
    const { calls, predicate } = ancestryOf();
    renderReleaseDossier(input, HEAD_SHA, predicate);
    // Three criteria, THREE distinct cited commits — two landings and the one receipt sha both
    // nodes share. Without memoization crit-two would ask again for a commit already decided, so
    // the count is what proves the cache, and the list is what proves the receipt sha is cited AT
    // ALL: before it went through the predicate this array held only the two landings.
    expect(calls).toStrictEqual([ALPHA_LANDING, RECEIPT_SHA, BRAVO_LANDING]);
  });

  it("renders UNKNOWN rather than throwing when the ancestry port itself fails", () => {
    const input = dossierInput({
      criteria: [{ criterionId: "crit-alpha", nodeKey: "node-alpha", title: "Alpha" }],
    });
    let consulted = 0;
    const unreachable = (): never => {
      consulted += 1;
      throw new Error("fatal: not a git repository");
    };
    const rendered = renderReleaseDossier(input, HEAD_SHA, unreachable);
    // A git that refuses to answer is UNMEASURABLE — a distinct code from
    // NOT_ANCESTOR, because "could not check" is not "checked and absent".
    expect(rendered).toContain(`| crit-alpha | LANDING_UNMEASURABLE | git could not decide whether`
      + ` the cited landing commit is an ancestor of this sha (${ALPHA_LANDING}) |`);
    expect(rendered).not.toContain("| crit-alpha | LANDING_NOT_ANCESTOR |");
    // The RECEIPT sha is measured by the same predicate and gets the same treatment, with its own
    // code: one unreachable git leaves BOTH citations unmeasurable rather than only the landing.
    expect(rendered).toContain(`| crit-alpha | RECEIPT_UNMEASURABLE | git could not decide whether`
      + ` the verifier receipt's measured source commit is an ancestor of this sha`
      + ` (${RECEIPT_SHA}) |`);
    expect(rendered).not.toContain("| crit-alpha | RECEIPT_NOT_ANCESTOR |");
    // And so does the criterion CHECK's artifact: an unreachable git leaves all THREE citations
    // unmeasurable, so none of them can quietly read as verified.
    expect(rendered).toContain(`| crit-alpha | CRITERION_NOT_VERIFIED_AT_SHA | no passed criterion`
      + ` check binds this criterion to a commit this sha contains (${CRITERION_ARTIFACT}) |`);
    // Three distinct cited commits, one criterion: the landing, the receipt sha and the artifact
    // the approved criterion check passed at.
    expect(consulted).toBe(3);
  });

  it("caches an UNMEASURABLE verdict too, so a failing git is not re-run per criterion", () => {
    const input = dossierInput({
      criteria: [
        { criterionId: "crit-one", nodeKey: "node-alpha", title: "One" },
        { criterionId: "crit-two", nodeKey: "node-alpha", title: "Two" },
      ],
    });
    let consulted = 0;
    const rendered = renderReleaseDossier(input, HEAD_SHA, () => {
      consulted += 1;
      throw new Error("fatal: not a git repository");
    });
    // TWO criteria over ONE node cite two distinct commits — its landing and its receipt sha — so
    // an uncached predicate would be asked four times. The cache is what makes it two.
    expect(consulted).toBe(2);
    expect(rendered).toContain("| crit-one | LANDING_UNMEASURABLE |");
    expect(rendered).toContain("| crit-two | LANDING_UNMEASURABLE |");
    expect(rendered).toContain("| crit-one | RECEIPT_UNMEASURABLE |");
    expect(rendered).toContain("| crit-two | RECEIPT_UNMEASURABLE |");
  });
});

/**
 * THE TWO CITATIONS THAT USED TO READ AS CLEAN.
 *
 * A present verifier receipt sha produced ZERO gaps and was never put through the ancestry
 * predicate, and no criterion CHECK was consulted at all. So a dossier could print "Every cited
 * commit was re-measured as an ancestor of this sha" over a verifier run taken on a foreign tree,
 * for a goal whose approved criteria had never been checked. `goal.close` already refused such a
 * goal with GOAL_CLOSE_CRITERIA_UNVERIFIED; release, the irreversible gate, did not.
 *
 * Every arm asserts the CODE, and each uses a ONE-CRITERION covered fixture so nothing else in
 * the pipeline can be the source of the gap being measured.
 */
describe("release dossier binds evidence to the released tree", () => {
  const covered = (overrides: Partial<DossierInput> = {}): DossierInput => dossierInput({
    criteria: [{ criterionId: "crit-alpha", nodeKey: "node-alpha", title: "Alpha" }],
    ...overrides,
  });
  const gapsOf = (
    input: DossierInput, verdicts: Readonly<Record<string, AncestryVerdict>> = {},
  ): readonly { readonly code: string; readonly criterionId: string }[] =>
    releaseDossierGaps(input, HEAD_SHA, ancestryOf(verdicts).predicate)
      .map((gap) => ({ code: gap.code, criterionId: gap.criterionId }));

  it("gaps a verifier receipt taken on a tree the released sha does not contain", () => {
    const input = covered();
    // THE FILING'S PROBE, and it returned gaps=0 before this row: `ancestry` was never reached
    // for a present receipt sha.
    expect(gapsOf(input, { [RECEIPT_SHA]: "NOT_ANCESTOR" }))
      .toEqual([{ code: "RECEIPT_NOT_ANCESTOR", criterionId: "crit-alpha" }]);
    // The ROW names the NODE whose receipt is unusable, and still shows the sha it cited, which
    // is what an operator needs in order to go and look at it.
    const rows = criterionRows(input, ancestryOf({ [RECEIPT_SHA]: "NOT_ANCESTOR" }).predicate);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeKey: "node-alpha", receiptSha: RECEIPT_SHA });
    expect(rows[0]?.gaps.map((gap) => gap.code)).toEqual(["RECEIPT_NOT_ANCESTOR"]);
    expect(rows[0]?.gaps[0]?.detail).toContain(RECEIPT_SHA);
    // THE MIRROR. An ancestor receipt sha lists nothing, so the new check is not a blanket that
    // gaps every receipt it is shown.
    expect(gapsOf(input)).toEqual([]);
  });

  it("keeps a receipt git could not decide apart from one git decided against", () => {
    expect(gapsOf(covered(), { [RECEIPT_SHA]: "UNMEASURABLE" }))
      .toEqual([{ code: "RECEIPT_UNMEASURABLE", criterionId: "crit-alpha" }]);
    expect(gapsOf(covered(), { [RECEIPT_SHA]: "NOT_ANCESTOR" }))
      .toEqual([{ code: "RECEIPT_NOT_ANCESTOR", criterionId: "crit-alpha" }]);
  });

  it("gaps an approved criterion with no passed criterion check, and lists none when it has one", () => {
    // Every OTHER citation in this fixture is clean, so the new code is the only thing that can
    // gap here — the arm cannot pass on someone else's refusal.
    expect(gapsOf(covered({ criterionReceipts: [] })))
      .toEqual([{ code: "CRITERION_NOT_VERIFIED_AT_SHA", criterionId: "crit-alpha" }]);
    // A check that passed for a DIFFERENT criterion is not evidence for this one.
    expect(gapsOf(covered({
      criterionReceipts: [{ artifactSha: CRITERION_ARTIFACT, criterionId: "crit-bravo" }],
    }))).toEqual([{ code: "CRITERION_NOT_VERIFIED_AT_SHA", criterionId: "crit-alpha" }]);
    // THE OTHER DIRECTION: a criterion whose check passed at an artifact this sha contains lists
    // nothing at all.
    expect(gapsOf(covered())).toEqual([]);
  });

  it("gaps a criterion check that passed on a tree the released sha does not contain", () => {
    // PASSED is not enough. The check has to have passed at THIS tree, which is the same standard
    // the landing commit and the verifier receipt are held to.
    expect(gapsOf(covered(), { [CRITERION_ARTIFACT]: "NOT_ANCESTOR" }))
      .toEqual([{ code: "CRITERION_NOT_VERIFIED_AT_SHA", criterionId: "crit-alpha" }]);
    expect(gapsOf(covered(), { [CRITERION_ARTIFACT]: "UNMEASURABLE" }))
      .toEqual([{ code: "CRITERION_NOT_VERIFIED_AT_SHA", criterionId: "crit-alpha" }]);
  });

  it("decides PER CRITERION: one verified criterion does not cover the goal's others", () => {
    const input = dossierInput({
      criteria: [
        { criterionId: "crit-alpha", nodeKey: "node-alpha", title: "Alpha" },
        { criterionId: "crit-bravo", nodeKey: "node-bravo", title: "Bravo" },
      ],
      criterionReceipts: [{ artifactSha: CRITERION_ARTIFACT, criterionId: "crit-alpha" }],
    });
    // A per-GOAL check would report either both clean or both gapped; the difference is the point.
    expect(gapsOf(input))
      .toEqual([{ code: "CRITERION_NOT_VERIFIED_AT_SHA", criterionId: "crit-bravo" }]);
  });

  it("says in the document that the criterion was not verified, rather than dropping the row", () => {
    const rendered = renderReleaseDossier(
      covered({ criterionReceipts: [] }), HEAD_SHA, ancestryOf().predicate,
    );
    expect(rendered).toContain("| crit-alpha | CRITERION_NOT_VERIFIED_AT_SHA | no passed criterion"
      + " check binds this criterion to a commit this sha contains |");
    expect(rendered).not.toContain("Every cited commit was re-measured as an ancestor of this sha.");
  });
});

/**
 * A node key can be carried by MORE THAN ONE activated plan, and runs-read.ts:115
 * records that such nodes' review ledgers are SHARED. So a receipt found under a
 * shared key may have been produced under a DIFFERENT plan.
 *
 * DECISION: render it UNKNOWN with the reason and LIST it, never attribute it. That
 * matches what the read model already does — runs-read.ts:150 answers
 * `UNATTRIBUTABLE` for exactly this case — and silently attributing it is the one way
 * this dossier could carry a true-looking claim that is false.
 */
describe("release dossier shared node keys", () => {
  const sharedInput = (): ReturnType<typeof dossierInput> => dossierInput({
    criteria: [{ criterionId: "crit-shared", nodeKey: "node-shared", title: "Shared" }],
    nodes: [{
      landingSha: ALPHA_LANDING,
      nodeKey: "node-shared",
      receipt: {
        command: "pnpm test", exitCode: 0, receiptId: "e".repeat(64), sha: RECEIPT_SHA,
      },
      sharedAcrossPlans: true,
    }],
  });

  it("refuses to attribute a shared node's receipt, and says why", () => {
    const rendered = renderReleaseDossier(sharedInput(), HEAD_SHA, ancestryOf().predicate);
    expect(rendered).toContain("| crit-shared | RECEIPT_SHARED_NODE | the verifying node key is"
      + " carried by more than one activated plan, so its review ledger is shared and its"
      + " evidence cannot be attributed to this goal |");
  });

  it("cites neither the command, the receipt sha nor the landing of a shared node", () => {
    const rendered = renderReleaseDossier(sharedInput(), HEAD_SHA, ancestryOf().predicate);
    // The node KEY is still shown so the reader can go look; the evidence is not.
    expect(rendered).toContain(
      "| crit-shared | Shared | node-shared | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |",
    );
    expect(rendered).not.toContain("pnpm test");
    expect(rendered).not.toContain(RECEIPT_SHA);
    expect(rendered).not.toContain(ALPHA_LANDING);
  });

  it("does not consult git for a shared node, since nothing about it would be cited", () => {
    const { calls } = ancestryOf();
    const probe = ancestryOf();
    renderReleaseDossier(sharedInput(), HEAD_SHA, probe.predicate);
    expect(probe.calls).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
  });

  it("attributes the SAME node normally once it is no longer shared", () => {
    // The control: without this arm, the assertions above would still pass if the
    // generator rendered UNKNOWN for every node regardless of the shared flag.
    const input = dossierInput({
      ...sharedInput(),
      nodes: sharedInput().nodes.map((node) => ({ ...node, sharedAcrossPlans: false })),
    });
    const rendered = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    expect(rendered).toContain(
      `| crit-shared | Shared | node-shared | pnpm test | 0 | ${RECEIPT_SHA} | ${ALPHA_LANDING} |`,
    );
    expect(rendered).not.toContain("RECEIPT_SHARED_NODE");
  });
});

describe("release dossier untrusted ledger text", () => {
  it("cannot be made to grow a forged section from a goal title", () => {
    const rendered = renderReleaseDossier(
      dossierInput({
        criteria: [],
        goalTitle: "Real goal\n\n## Acceptance criteria\n\nEvery cited commit was re-measured as"
          + " an ancestor of this sha.",
      }),
      HEAD_SHA, ancestryOf().predicate,
    );
    // A markdown heading must START a line, so the invariant is on LINES, not on the
    // substring: the title's newlines are collapsed, leaving the forged text inert in
    // the middle of the header line where it cannot inject a section into a document
    // a human reads to decide whether to ship.
    const lines = rendered.split("\n");
    expect(lines.filter((line) => line === "## Acceptance criteria")).toHaveLength(1);
    expect(lines[0]).toBe("# Release dossier: Real goal ## Acceptance criteria Every cited commit"
      + " was re-measured as an ancestor of this sha.");
  });

  it("escapes a pipe in a verifier command instead of forging a table column", () => {
    const input = dossierInput({
      criteria: [{ criterionId: "crit-pipe", nodeKey: "node-pipe", title: "Pipe" }],
      nodes: [{
        landingSha: ALPHA_LANDING,
        nodeKey: "node-pipe",
        receipt: {
          command: "pnpm test | tee out.txt", exitCode: 0, receiptId: "a".repeat(64), sha: RECEIPT_SHA,
        },
        sharedAcrossPlans: false,
      }],
    });
    const rendered = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
    // The pipe is escaped, so it stays INSIDE the command cell instead of splitting the
    // row into forged columns.
    expect(rendered).toContain("| pnpm test \\| tee out.txt | 0 |");
    const commandRow = rendered.split("\n").find((line) => line.startsWith("| crit-pipe |"));
    expect(commandRow?.split(/(?<!\\)\|/u)).toHaveLength(9);
  });

  it("keeps a multi-line criterion title on one table row", () => {
    const rendered = renderReleaseDossier(
      dossierInput({ criteria: [{ criterionId: "crit-nl", nodeKey: null, title: "Line\r\nTwo" }] }),
      HEAD_SHA, ancestryOf().predicate,
    );
    expect(rendered).toContain("| crit-nl | Line Two | UNKNOWN |");
  });
});
