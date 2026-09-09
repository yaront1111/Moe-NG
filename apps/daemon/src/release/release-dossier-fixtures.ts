import type {
  AncestryPredicate, AncestryVerdict, DossierInput,
} from "./release-dossier-contracts.js";

/**
 * Fixture ledger facts for the release dossier tests. The generator is pure, so a
 * fixture is just data — no store, no repository, no clock.
 *
 * The criteria and review rounds are deliberately supplied OUT OF SORTED ORDER so a
 * generator that rendered them in input order would fail the golden rather than pass
 * it by accident.
 */

export const PROJECT_ID = "proj-release-dossier";
export const GOAL_ID = "goal-release-1";

/** A 40-hex git object id built from one byte, so shas are readable in a diff. */
export function sha40(byte: string): string {
  return byte.repeat(20);
}

/** A 64-hex content id, the shape receipt ids take. */
export function hex64(byte: string): string {
  return byte.repeat(32);
}

export const HEAD_SHA = sha40("11");
export const OTHER_SHA = sha40("22");
export const ALPHA_LANDING = sha40("aa");
export const BRAVO_LANDING = sha40("bb");
export const ORPHAN_LANDING = sha40("cc");
export const RECEIPT_SHA = sha40("dd");

/** Every landing an `ancestryOf` fixture answers ANCESTOR for, unless overridden. */
const ANCESTORS: ReadonlySet<string> = new Set([ALPHA_LANDING, BRAVO_LANDING]);

/**
 * A predicate over a fixed verdict table, plus a call log so a test can assert the
 * predicate was consulted ONCE PER CITED COMMIT rather than once per criterion.
 */
export function ancestryOf(
  overrides: Readonly<Record<string, AncestryVerdict>> = {},
): { readonly calls: string[]; readonly predicate: AncestryPredicate } {
  const calls: string[] = [];
  const predicate: AncestryPredicate = (commitSha) => {
    calls.push(commitSha);
    return overrides[commitSha] ?? (ANCESTORS.has(commitSha) ? "ANCESTOR" : "NOT_ANCESTOR");
  };
  return { calls, predicate };
}

/**
 * A representative goal: two criteria whose evidence is complete and re-measurable,
 * and one carried by no node at all. Sorted order is crit-alpha, crit-bravo,
 * crit-charlie; the array below is not in that order on purpose.
 */
export function dossierInput(overrides: Partial<DossierInput> = {}): DossierInput {
  return {
    criteria: [
      { criterionId: "crit-charlie", nodeKey: null, title: "Dossier bytes are diffable" },
      { criterionId: "crit-alpha", nodeKey: "node-alpha", title: "Dossier renders every section" },
      { criterionId: "crit-bravo", nodeKey: "node-bravo", title: "Dossier is stored durably" },
    ],
    goalId: GOAL_ID,
    goalTitle: "Ship the release dossier",
    nodes: [
      {
        landingSha: ALPHA_LANDING,
        nodeKey: "node-alpha",
        receipt: {
          command: "pnpm --filter @moe/daemon test",
          exitCode: 0,
          receiptId: hex64("ab"),
          sha: RECEIPT_SHA,
        },
        sharedAcrossPlans: false,
      },
      {
        landingSha: BRAVO_LANDING,
        nodeKey: "node-bravo",
        receipt: {
          command: "pnpm typecheck", exitCode: 0, receiptId: hex64("cd"), sha: RECEIPT_SHA,
        },
        sharedAcrossPlans: false,
      },
    ],
    policyRevision: "pol-000000000007",
    preview: {
      decidedAt: "2026-09-05T10:00:00.000Z",
      decisionId: "dec-preview-1",
      outcome: "PREVIEW_PUBLISHED",
      url: "https://preview.example/goal-release-1",
    },
    projectId: PROJECT_ID,
    reviewRounds: [
      { nodeKey: "node-bravo", outcome: "REFUSED", refusalCode: "REVIEW_EVIDENCE_MISSING", round: 1 },
      { nodeKey: "node-alpha", outcome: "ACCEPTED", refusalCode: null, round: 1 },
      { nodeKey: "node-bravo", outcome: "ACCEPTED", refusalCode: null, round: 2 },
    ],
    ...overrides,
  };
}
