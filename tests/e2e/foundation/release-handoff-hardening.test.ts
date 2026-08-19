/**
 * RELEASE-HANDOFF HARDENING — the second incident fixture in the design's exit set (line 1324),
 * driven against the landed release-manifest contract.
 *
 * `release-manifest.test.ts` already exercises each refusal once. What it cannot do, and what
 * this file exists for, is police its own COVERAGE: a ninth refusal code added to the contract
 * tomorrow would leave that file green with nothing exercising the new code. So the sweep here
 * is keyed on the PRODUCTION roster — every code in `RELEASE_MANIFEST_ERROR_CODES` must have a
 * hand-authored case that provokes it, and a code without one fails this file.
 *
 * THE COUNT IS ASSERTED NON-ZERO, and equal to the roster. A sweep that silently produced no
 * cases would otherwise pass while testing nothing (epic rail 6), and that is not a
 * hypothetical failure mode for a table keyed on an imported list.
 *
 * ONE MEASUREMENT WORTH RECORDING RATHER THAN QUIETLY ROUNDING. The plan step describes this
 * contract as carrying NINE refusal codes. The landed contract carries EIGHT
 * (`release-manifest.ts:42-51`), and no ninth exists anywhere in the module. Inventing one to
 * match the prose would be a fabricated refusal; narrowing to "some codes" would retire the
 * completeness claim. The sweep is therefore bound to the roster itself, so it is correct at
 * eight and stays correct — and goes red, naming the gap — the day a ninth lands.
 *
 * Each case perturbs exactly ONE field of an otherwise-valid input, so it is admissible at
 * every earlier check and can only be refused by the rule it targets. Since each case asserts
 * its LITERAL code, a case that tripped an earlier guard would fail rather than pass quietly.
 */

import { describe, expect, it } from "vitest";

import { FOUNDATION_EXIT_SET, RELEASE_REQUIRES_COMMITTED_HANDOFF } from "./journey-spec.js";
import {
  FROZEN_LOCKFILE_COMMAND,
  RELEASE_MANIFEST_ERROR_CODES,
  buildReleaseManifest,
  type ReleaseManifestErrorCode,
  type ReleaseManifestInput,
} from "./release-manifest.js";

const COMMIT = "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678";
const OTHER_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

function validInput(): ReleaseManifestInput {
  return {
    commitSha: COMMIT,
    treeCleanAtStart: true,
    install: { command: FROZEN_LOCKFILE_COMMAND, exitCode: 0 },
    gates: [
      { command: "pnpm typecheck", exitCode: 0, commitSha: COMMIT },
      { command: "pnpm test:e2e", exitCode: 0, commitSha: COMMIT },
    ],
    journeyEvidence: FOUNDATION_EXIT_SET.map((journey, index) => ({
      journey,
      evidenceDigest: String(index + 1).repeat(64).slice(0, 64),
    })),
  };
}

interface HandoffCase {
  readonly code: ReleaseManifestErrorCode;
  readonly input: () => ReleaseManifestInput;
  readonly what: string;
}

/** Hand-authored, one per refusal the contract can raise. */
const CASES: readonly HandoffCase[] = Object.freeze([
  {
    code: "RELEASE_MANIFEST_COMMIT_INVALID",
    input: () => ({ ...validInput(), commitSha: "HEAD" }),
    what: "a branch name where a commit identity belongs",
  },
  {
    code: "RELEASE_MANIFEST_DIRTY_TREE",
    input: () => ({ ...validInput(), treeCleanAtStart: false }),
    what: "a run started from a dirty working tree",
  },
  {
    code: "RELEASE_MANIFEST_INSTALL_NOT_FROZEN",
    input: () => ({
      ...validInput(), install: { command: "pnpm install --no-frozen-lockfile", exitCode: 0 },
    }),
    what: "an install that did not come from the lockfile",
  },
  {
    code: "RELEASE_MANIFEST_INSTALL_FAILED",
    input: () => ({
      ...validInput(), install: { command: FROZEN_LOCKFILE_COMMAND, exitCode: 137 },
    }),
    what: "a frozen install that exited non-zero",
  },
  {
    code: "RELEASE_MANIFEST_GATE_EMPTY",
    input: () => ({ ...validInput(), gates: [] }),
    what: "a release claim resting on no gate at all",
  },
  {
    code: "RELEASE_MANIFEST_COMMIT_MISMATCH",
    input: () => ({
      ...validInput(),
      gates: [
        { command: "pnpm typecheck", exitCode: 0, commitSha: COMMIT },
        { command: "pnpm test:e2e", exitCode: 0, commitSha: OTHER_COMMIT },
      ],
    }),
    what: "gates run at two different commits",
  },
  {
    code: "RELEASE_MANIFEST_GATE_RED",
    input: () => ({
      ...validInput(),
      gates: [{ command: "pnpm test:e2e", exitCode: 1, commitSha: COMMIT }],
    }),
    what: "a red gate reported inside a release claim",
  },
  {
    code: "RELEASE_MANIFEST_EVIDENCE_INCOMPLETE",
    input: () => ({ ...validInput(), journeyEvidence: [] }),
    what: "a manifest carrying evidence for no journey",
  },
]);

function refusalOf(input: ReleaseManifestInput): string {
  const result = buildReleaseManifest(input);
  return result.ok ? "ACCEPTED" : result.code;
}

describe("release-handoff hardening: every refusal the contract can raise is exercised", () => {
  it("generates a non-empty case set that covers the production roster exactly", () => {
    expect(CASES.length).toBeGreaterThan(0);
    expect(RELEASE_MANIFEST_ERROR_CODES.length).toBeGreaterThan(0);
    // Set equality against the PRODUCTION roster, in both directions: a code with no case and
    // a case naming a code the contract cannot raise are both defects, and `toContain` over
    // the roster would catch neither.
    expect([...CASES.map((entry) => entry.code)].sort())
      .toEqual([...RELEASE_MANIFEST_ERROR_CODES].sort());
    expect(new Set(CASES.map((entry) => entry.code)).size).toBe(CASES.length);
  });

  it("accepts the unperturbed input, so every refusal below is caused by its own case", () => {
    const result = buildReleaseManifest(validInput());
    expect(result.ok).toBe(true);
    expect(refusalOf(validInput())).toBe("ACCEPTED");
  });

  it.each(CASES.map((entry) => [entry.code, entry] as const))(
    "refuses %s",
    (code, handoff) => {
      expect({ code: refusalOf(handoff.input()), what: handoff.what })
        .toEqual({ code, what: handoff.what });
    },
  );

  /**
   * The contract's documented refusal ORDER, asserted rather than trusted: with every rule
   * broken at once the reported code is the FIRST one, so a manifest never reports a later
   * problem while an earlier and more fundamental one goes unnamed.
   */
  it("reports the first broken rule when several are broken at once", () => {
    expect(refusalOf({
      commitSha: "HEAD",
      treeCleanAtStart: false,
      install: { command: "pnpm install", exitCode: 1 },
      gates: [],
      journeyEvidence: [],
    })).toBe("RELEASE_MANIFEST_COMMIT_INVALID");
  });

  /**
   * Design line 337 — `RELEASED` requires a COMMITTED safe-release handoff, and the honest
   * answer without one is never a silent success. Bound to a PRODUCTION refusal rather than
   * to the spec constant alone: drop the release-handoff journey's evidence and the manifest
   * refuses to build, so no release claim can be assembled that omits the handoff.
   */
  it("cannot build a release claim with the handoff journey's evidence missing", () => {
    expect(RELEASE_REQUIRES_COMMITTED_HANDOFF).toBe(true);
    const withoutHandoff = validInput().journeyEvidence
      .filter((entry) => entry.journey !== "release-handoff");
    expect(withoutHandoff).toHaveLength(FOUNDATION_EXIT_SET.length - 1);
    expect(refusalOf({ ...validInput(), journeyEvidence: withoutHandoff }))
      .toBe("RELEASE_MANIFEST_EVIDENCE_INCOMPLETE");
  });
});
