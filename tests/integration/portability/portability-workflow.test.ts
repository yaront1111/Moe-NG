import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSourceCommit } from "./portability-source-commit.js";

const SOURCE_EXPRESSION = "${{ github.event.pull_request.head.sha || github.sha }}";
const OBSERVER_ID = "portability-source";
const OBSERVED_OUTPUT = `\${{ steps.${OBSERVER_ID}.outputs.source_commit }}`;
const MISMATCH = "PORTABILITY_SOURCE_COMMIT_CHECKOUT_MISMATCH@PORTABILITY_EVIDENCE";
const DIRTY = "PORTABILITY_SOURCE_CHECKOUT_DIRTY@PORTABILITY_EVIDENCE";
const SHA_HEAD = "a1f71a43c71cd03367a90baf52d99d814042dbe7";
const SHA_MERGE = "d543f71ea380d46a3f801178b4821c4bc0abe9b7";

function workflowJob(workflow: string, name: string): string {
  const lines = workflow.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`workflow job ${name} is absent`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  [a-z0-9_-]+:$/u.test(line));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function actionLine(job: string, action: string): string {
  const line = job.match(new RegExp(`^      - uses: ${action.replace("/", "\\/")}@\\S+$`, "mu"))?.[0];
  if (line === undefined) throw new Error(`${action} step is absent`);
  return line;
}

const workflow = readFileSync(
  join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "cross-host.yml"),
  "utf8",
);
const portabilityJob = workflowJob(workflow, "portability-evidence");

const WORKFLOW_CASES = Object.freeze([
  ["shares one intended SHA between declaration and checkout", (job: string): void => {
    expect(occurrences(job, SOURCE_EXPRESSION)).toBe(2);
    expect(job).toContain(`MOE_PORTABILITY_SOURCE_COMMIT: ${SOURCE_EXPRESSION}`);
    expect(job).toContain('MOE_PORTABILITY_EVIDENCE_MODE: "1"');
    const checkoutLine = actionLine(job, "actions/checkout");
    expect(job).toContain([
      checkoutLine,
      "        with:",
      `          ref: ${SOURCE_EXPRESSION}`,
    ].join("\n"));
  }],
  ["observes and compares clean HEAD immediately after checkout", (job: string): void => {
    const checkoutLine = actionLine(job, "actions/checkout");
    const checkout = job.indexOf(checkoutLine);
    const observer = job.indexOf(`        id: ${OBSERVER_ID}`);
    const hostFacts = job.indexOf("      - name: Record host facts");
    const firstGate = job.indexOf("      - name: Integration gate (vitest)");
    expect([checkout, observer, hostFacts, firstGate].every((index) => index >= 0)).toBe(true);
    expect(checkout).toBeLessThan(observer);
    expect(job.slice(checkout, observer)).toBe([
      checkoutLine,
      "        with:",
      `          ref: ${SOURCE_EXPRESSION}`,
      "",
      "      - name: Verify portability source checkout",
      "",
    ].join("\n"));
    expect(observer).toBeLessThan(hostFacts);
    expect(observer).toBeLessThan(firstGate);
    const observerStep = job.slice(observer, hostFacts);
    expect(observerStep).toContain(
      'actual_checkout_commit="$(portability_git rev-parse --verify HEAD)"',
    );
    expect(observerStep).toContain(
      'if [ "${actual_checkout_commit}" != "${MOE_PORTABILITY_SOURCE_COMMIT}" ]; then',
    );
    expect(observerStep).toContain(
      `::error title=portability-evidence::${MISMATCH}: checkout \${actual_checkout_commit} ` +
      "does not match declared ${MOE_PORTABILITY_SOURCE_COMMIT}",
    );
    expect(observerStep).toContain('git_executable="$(command -v git)"');
    const dirtyCommand =
      "portability_git --no-pager diff --no-ext-diff --quiet --ignore-submodules=none --";
    expect(observerStep).toContain(dirtyCommand);
    expect(observerStep).toContain(
      "portability_git --no-pager diff --cached --no-ext-diff --quiet --ignore-submodules=none --",
    );
    expect(observerStep).toContain(`::error title=portability-evidence::${DIRTY}`);
    expect(observerStep).toContain('ls-files -v -z -- > "${index_flags_file}"');
    expect(observerStep).toContain("while IFS= read -r -d '' index_entry; do");
    expect(observerStep).toContain('"H "*) ;;');
    expect(observerStep).toContain(
      'confirmed_checkout_commit="$(portability_git rev-parse --verify HEAD)"',
    );
    expect(observerStep).toContain(
      'if [ "${confirmed_checkout_commit}" != "${actual_checkout_commit}" ]; then',
    );
    const comparison = observerStep.indexOf('if [ "${actual_checkout_commit}" !=');
    const dirtyCheck = observerStep.indexOf(dirtyCommand);
    const confirmedHead = observerStep.indexOf("confirmed_checkout_commit=");
    const environmentExport = observerStep.indexOf(
      'echo "MOE_PORTABILITY_SOURCE_COMMIT=${actual_checkout_commit}"',
    );
    expect(observerStep.slice(comparison, dirtyCheck)).toContain("            exit 1");
    expect(observerStep.slice(dirtyCheck, environmentExport)).toContain("            exit 1");
    expect(dirtyCheck).toBeLessThan(confirmedHead);
    expect(confirmedHead).toBeLessThan(environmentExport);
  }],
  ["exports the observed SHA as environment and step output", (job: string): void => {
    expect(job).toContain(
      'echo "MOE_PORTABILITY_SOURCE_COMMIT=${actual_checkout_commit}" >> "${GITHUB_ENV}"',
    );
    expect(job).toContain('echo "source_commit=${actual_checkout_commit}" >> "${GITHUB_OUTPUT}"');
    expect(job).toContain('echo "git_executable=${git_executable}" >> "${GITHUB_OUTPUT}"');
    expect(occurrences(
      job,
      `MOE_PORTABILITY_GIT_EXECUTABLE: \${{ steps.${OBSERVER_ID}.outputs.git_executable }}`,
    )).toBe(2);
  }],
  ["rechecks HEAD and tracked bytes after every evidence gate", (job: string): void => {
    const finalCheck = job.indexOf("      - name: Reverify portability source checkout");
    const upload = job.indexOf(actionLine(job, "actions/upload-artifact"));
    expect(finalCheck).toBeGreaterThan(0);
    expect(finalCheck).toBeLessThan(upload);
    const finalStep = job.slice(finalCheck, upload);
    expect(finalStep).toContain("        if: always()");
    expect(finalStep).toContain(`EXPECTED_PORTABILITY_SOURCE_COMMIT: ${OBSERVED_OUTPUT}`);
    expect(finalStep).toContain(
      'actual_checkout_commit="$(portability_git rev-parse --verify HEAD)"',
    );
    expect(finalStep).toContain(
      'if [ "${actual_checkout_commit}" != "${EXPECTED_PORTABILITY_SOURCE_COMMIT}" ]; then',
    );
    expect(finalStep).toContain(`::error title=portability-evidence::${MISMATCH}`);
    expect(finalStep).toContain(`::error title=portability-evidence::${DIRTY}`);
    expect(finalStep).toContain('ls-files -v -z -- > "${index_flags_file}"');
    expect(finalStep).toContain("while IFS= read -r -d '' index_entry; do");
    expect(finalStep).toContain('"H "*) ;;');
    expect(finalStep).toContain(
      'confirmed_checkout_commit="$(portability_git rev-parse --verify HEAD)"',
    );
    expect(finalStep).toContain(
      'if [ "${confirmed_checkout_commit}" != "${actual_checkout_commit}" ]; then',
    );
    const dirtyCommand =
      "portability_git --no-pager diff --no-ext-diff --quiet --ignore-submodules=none --";
    expect(finalStep).toContain(dirtyCommand);
    expect(finalStep).toContain(
      "portability_git --no-pager diff --cached --no-ext-diff --quiet --ignore-submodules=none --",
    );
    const comparison = finalStep.indexOf(
      'if [ "${actual_checkout_commit}" != "${EXPECTED_PORTABILITY_SOURCE_COMMIT}" ]; then',
    );
    const dirtyCheck = finalStep.indexOf(dirtyCommand);
    const confirmedHead = finalStep.indexOf("confirmed_checkout_commit=");
    expect(finalStep.slice(comparison, dirtyCheck)).toContain("            exit 1");
    expect(finalStep.slice(dirtyCheck)).toContain("            exit 1");
    expect(dirtyCheck).toBeLessThan(confirmedHead);
  }],
  ["reconstructs the stable HEAD tree through disposable indexes", (job: string): void => {
    const observerStart = job.indexOf(`        id: ${OBSERVER_ID}`);
    const observerEnd = job.indexOf("      - name: Record host facts");
    const finalStart = job.indexOf("      - name: Reverify portability source checkout");
    const finalEnd = job.indexOf(actionLine(job, "actions/upload-artifact"));
    const steps = [
      job.slice(observerStart, observerEnd),
      job.slice(finalStart, finalEnd),
    ];
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(occurrences(step, "verify_index_flags()")).toBe(1);
      expect(occurrences(step, "verify_index_flags || index_flag_status=$?")).toBe(1);
      expect(occurrences(step, "verify_worktree_tree()")).toBe(1);
      expect(occurrences(
        step, 'verify_worktree_tree "${actual_checkout_commit}" || tree_status=$?',
      )).toBe(1);
      expect(step).toContain(
        'init --bare --quiet --template="${tree_scratch}/template" "${tree_scratch}/git"',
      );
      expect(step).toContain('GIT_DIR="${tree_scratch}/git"');
      expect(step).toContain('GIT_WORK_TREE="${GITHUB_WORKSPACE}"');
      expect(step).toContain('GIT_INDEX_FILE="${tree_scratch}/index"');
      expect(step).toContain('GIT_OBJECT_DIRECTORY="${tree_scratch}/git/objects"');
      expect(step).toContain("GIT_ALTERNATE_OBJECT_DIRECTORIES");
      expect(step).toContain('read-tree --no-sparse-checkout "${observed_commit}^{tree}"');
      expect(step).toContain("add --update -- .");
      expect(step).toContain("write-tree");
      expect(step).toContain("PORTABILITY_SOURCE_CHECKOUT_DIRTY@PORTABILITY_EVIDENCE");
      expect(step).toContain("PORTABILITY_SOURCE_CHECKOUT_OBSERVATION_FAILED@PORTABILITY_EVIDENCE");
      const indexDefinition = step.indexOf("verify_index_flags()");
      const indexCall = step.indexOf("verify_index_flags || index_flag_status=$?");
      const treeDefinition = step.indexOf("verify_worktree_tree()");
      const treeCall = step.indexOf(
        'verify_worktree_tree "${actual_checkout_commit}" || tree_status=$?',
      );
      const confirmedHead = step.indexOf("confirmed_checkout_commit=");
      expect(indexDefinition).toBeLessThan(indexCall);
      expect(indexCall).toBeLessThan(treeCall);
      expect(treeDefinition).toBeLessThan(treeCall);
      expect(treeCall).toBeLessThan(confirmedHead);
      expect(step.slice(indexCall, treeCall)).toContain("index_flag_status");
      expect(step.slice(indexCall, treeCall)).toContain("exit 1");
      expect(step.slice(treeCall, confirmedHead)).toContain('if [ "${tree_status}" -eq 1 ]');
      expect(step.slice(treeCall, confirmedHead)).toContain('if [ "${tree_status}" -ne 0 ]');
      expect(step.slice(treeCall, confirmedHead)).toContain("exit 1");
    }
    expect(occurrences(job, "GIT_*) unset \"${environment_name}\" ;;" )).toBe(2);
    expect(occurrences(job, 'GIT_CONFIG_GLOBAL="/dev/null"')).toBe(2);
    expect(occurrences(job, 'GIT_CONFIG_NOSYSTEM="1"')).toBe(2);
  }],
  ["proves every source-binding contract executed", (job: string): void => {
    const required = [
      '"portability-historical-receipt.test.ts"',
      '"portability-source-commit.test.ts"',
      '"portability-workflow.test.ts"',
    ];
    for (const testFile of required) expect(job).toContain(testFile);
  }],
  ["attributes the artifact to the observed checkout output", (job: string): void => {
    expect(job).toContain(`name: portability-evidence-\${{ matrix.os }}-${OBSERVED_OUTPUT}`);
    expect(job).not.toContain(
      `name: portability-evidence-\${{ matrix.os }}-${SOURCE_EXPRESSION}`,
    );
  }],
] as const);

describe("the portability-evidence workflow checkout contract", () => {
  it("runs a nonzero workflow contract roster against only the portability job", () => {
    expect(WORKFLOW_CASES).toHaveLength(7);
    expect(WORKFLOW_CASES.length).toBeGreaterThan(0);
    expect(portabilityJob.startsWith("  portability-evidence:\n")).toBe(true);
  });

  it.each(WORKFLOW_CASES)("%s", (_label, assertion) => {
    assertion(portabilityJob);
  });

  it("routes a synthetic merge mismatch through the production resolver", () => {
    expect(resolveSourceCommit({
      actualCheckoutCommit: SHA_MERGE,
      declaredCommit: SHA_HEAD,
    })).toEqual({
      code: "PORTABILITY_SOURCE_COMMIT_CHECKOUT_MISMATCH",
      layer: "PORTABILITY_EVIDENCE",
      ok: false,
    });
  });
});
