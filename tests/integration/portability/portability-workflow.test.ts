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

function workflowStep(job: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = job.indexOf(marker);
  if (start < 0) throw new Error(`workflow step ${name} is absent`);
  const next = job.indexOf("\n      - ", start + marker.length);
  return job.slice(start, next < 0 ? job.length : next);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// A pinned `uses:` line now carries a trailing ` # vX.Y.Z` provenance comment.
// The 40-hex requirement is kept explicit here rather than relaxed to `\S+`, so
// this helper still refuses a mutable tag outright.
function actionLine(job: string, action: string): string {
  const line = job.match(new RegExp(
    `^      - uses: ${action.replace("/", "\\/")}@[0-9a-f]{40}(?: # v\\d+\\.\\d+\\.\\d+)?$`,
    "mu",
  ))?.[0];
  if (line === undefined) throw new Error(`${action} step is absent`);
  return line;
}

// The contiguous `  # ...` comment block immediately above a job header. The
// workflow documents its own boundaries there, so a boundary claim is graded
// against the bytes a reader of the workflow actually sees.
function jobHeaderComment(workflow: string, name: string): string {
  const lines = workflow.replaceAll("\r\n", "\n").split("\n");
  const header = lines.findIndex((line) => line === `  ${name}:`);
  if (header < 0) throw new Error(`workflow job ${name} is absent`);
  let start = header;
  while (start > 0 && lines[start - 1]?.startsWith("  #") === true) start -= 1;
  return lines.slice(start, header).join("\n");
}

const workflow = readFileSync(
  join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "cross-host.yml"),
  "utf8",
);
const portabilityJob = workflowJob(workflow, "portability-evidence");
const gateJob = workflowJob(workflow, "gate");
const windowsJob = workflowJob(workflow, "gate-windows");
const portabilityHeader = jobHeaderComment(workflow, "portability-evidence");
const rootVitestConfig = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "vitest.config.ts"),
  "utf8",
);

// The exhaustive `with:` block of a hardened checkout. Every job states its ref
// explicitly (see the merge-gate ruling below) and none of them leaves the
// job's GITHUB_TOKEN written into .git/config for later steps to reuse.
function checkoutWith(ref: string): readonly string[] {
  return ["        with:", `          ref: ${ref}`, "          persist-credentials: false"];
}

const ACTION_PINS = Object.freeze({
  "actions/checkout": "11d5960a326750d5838078e36cf38b85af677262",
  "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
  "pnpm/action-setup": "b906affcce14559ad1aafd4ab0e942779e9f58b1",
});

const WORKFLOW_CASES = Object.freeze([
  ["shares one intended SHA between declaration and checkout", (job: string): void => {
    expect(occurrences(job, SOURCE_EXPRESSION)).toBe(2);
    expect(job).toContain(`MOE_PORTABILITY_SOURCE_COMMIT: ${SOURCE_EXPRESSION}`);
    expect(job).toContain('MOE_PORTABILITY_EVIDENCE_MODE: "1"');
    const checkoutLine = actionLine(job, "actions/checkout");
    expect(job).toContain([checkoutLine, ...checkoutWith(SOURCE_EXPRESSION)].join("\n"));
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
      ...checkoutWith(SOURCE_EXPRESSION),
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

describe("the cross-host workflow execution contract", () => {
  it("grants read-only repository contents by default", () => {
    const permissions = workflow.indexOf("permissions:\n  contents: read");
    expect(permissions).toBeGreaterThan(0);
    expect(permissions).toBeLessThan(workflow.indexOf("jobs:\n"));
    expect(workflow).not.toMatch(
      /^\s*(?:permissions\s*:\s*["']?write-all["']?|["']?[a-z][a-z0-9-]*["']?\s*:\s*["']?write["']?)\s*(?:#.*)?$/mu,
    );
    expect(workflow).not.toMatch(
      /^\s*permissions\s*:\s*\{[^\r\n}]*:\s*["']?write["']?(?:\s*[,}])/mu,
    );
  });

  it("pins every third-party action to its reviewed full commit", () => {
    const actionUses = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s+([^@\s]+)@([^\s#]+)/gmu)];
    expect(actionUses.length).toBeGreaterThan(0);
    for (const match of actionUses) {
      const action = match[1];
      const revision = match[2];
      expect(Object.hasOwn(ACTION_PINS, action ?? ""), `unreviewed action ${action}`).toBe(true);
      expect(revision).toBe(ACTION_PINS[action as keyof typeof ACTION_PINS]);
      expect(revision).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  it("runs daemon, control-room, and security lanes on Linux and macOS with nonzero counts", () => {
    const lanes = [
      ["security", "pnpm test:security", "vitest-security-posix.log"],
      ["daemon app", "pnpm --filter @moe/daemon test", "vitest-daemon-posix.log"],
      ["control-room app", "pnpm --filter @moe/control-room test", "vitest-control-room-posix.log"],
    ] as const;
    expect(gateJob).toContain("os: [ubuntu-latest, macos-latest]");
    for (const [name, command, log] of lanes) {
      const step = workflowStep(gateJob, `Test (${name})`);
      expect(step).toContain("        if: always()");
      expect(step).toContain("          set -o pipefail");
      expect(step).toContain("          set +e");
      expect(step).toContain(`          ${command} 2>&1 | tee ${log}`);
      expect(step).toContain("          status=${PIPESTATUS[0]}");
      expect(step).toContain("          set -e");
      expect(step).toContain('          if [ "${status}" -ne 0 ]; then exit "${status}"; fi');
      expect(step).toContain(
        `          if ! grep -Eq '^ *Test Files +[1-9][0-9]* passed' ${log}; then exit 1; fi`,
      );
      expect(step).toContain(
        `          if ! grep -Eq '^ *Tests +[1-9][0-9]* passed' ${log}; then exit 1; fi`,
      );
      expect(step).not.toContain("continue-on-error");
    }
  });
});

// CROSS-HOST HARDENING CONTRACT — task-24e066557f6747298c9307269d828225.
//
// MERGE-GATE RULING (architect, recorded verbatim so the reason survives the
// commit): gate, gate-windows, host-evidence and cross-host-aggregate are MERGE
// GATES — they test the commit GitHub would land, `github.sha`, which is the
// ephemeral merge commit on a pull_request run and the pushed commit otherwise
// — while portability-evidence binds EVIDENCE to the PR head per P1.9, because
// a merge sha exists nowhere in history and evidence must name a commit that
// does. "Explicit" therefore means every checkout STATES which of the two it
// uses and why; it does NOT mean they all use the same one.
const ACTION_VERSIONS = Object.freeze({
  "actions/checkout": "v4.4.0",
  "actions/download-artifact": "v4.3.0",
  "actions/setup-node": "v4.4.0",
  "actions/upload-artifact": "v4.6.2",
  "pnpm/action-setup": "v4.3.0",
});

// `git ls-remote --tags` at implementation time resolved each pinned commit to
// exactly the tag commented beside it; pnpm/action-setup's tag is ANNOTATED, so
// v4.3.0 here is the PEELED `v4.3.0^{}` commit and never the tag object.
const PINNED_USES_COUNT = 20;
const CROSS_HOST_JOBS = Object.freeze([
  "cross-host-aggregate",
  "gate",
  "gate-windows",
  "host-evidence",
  "portability-evidence",
]);
const MERGE_GATE_REF = "${{ github.sha }}";
const PR_HEAD_JOB = "portability-evidence";

// Gate commands portability-evidence executes, parsed from its own `run:`
// blocks rather than transcribed, so a command added there cannot silently
// escape the Windows-mirror requirement below.
const PORTABILITY_GATE_COMMAND =
  /^ +(pnpm (?:typecheck:packaging|typecheck:import|test:migration|exec vitest run tests\/integration)|node --test tests\/integration\/release-supply-chain\.test\.mjs)(?= |$)/gmu;

// The single command gate-windows covers by SUPERSET instead of by literal
// repetition. Both halves of that claim are asserted against real bytes: the
// Windows root step must run the superset command, and the root Vitest include
// must actually cover tests/**. This roster may not carry a dead excuse — every
// key must still be a command portability-evidence runs.
const SUPERSET_ON_WINDOWS = Object.freeze({
  "pnpm exec vitest run tests/integration": "pnpm test",
});

const WINDOWS_RELEASE_LANES = Object.freeze([
  {
    command: "pnpm typecheck:packaging",
    counted: false,
    log: "tsc-packaging-windows.log",
    name: "Typecheck (packaging)",
  },
  {
    command: "pnpm typecheck:import",
    counted: false,
    log: "tsc-import-windows.log",
    name: "Typecheck (import)",
  },
  {
    command: "pnpm test:migration",
    counted: true,
    log: "vitest-migration-windows.log",
    name: "Test (migration)",
  },
]);

describe("the cross-host hardening contract", () => {
  it("comments every pinned action with the version its commit resolves to", () => {
    const usesLines = workflow
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => line.includes("uses:"));
    expect(usesLines).toHaveLength(PINNED_USES_COUNT);
    const observed = new Set<string>();
    for (const line of usesLines) {
      const parsed = /^\s+(?:- )?uses: ([^@\s]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/u.exec(line);
      expect(parsed, `not a commented full-commit pin: ${line}`).not.toBeNull();
      const action = parsed?.[1] ?? "";
      const revision = parsed?.[2] ?? "";
      const version = parsed?.[3] ?? "";
      expect(Object.hasOwn(ACTION_PINS, action), `unreviewed action ${action}`).toBe(true);
      expect(revision, `${action} pin moved`).toBe(ACTION_PINS[action as keyof typeof ACTION_PINS]);
      expect(
        version,
        `${action}@${revision} is commented ${version}, which is not the tag it resolves to`,
      ).toBe(ACTION_VERSIONS[action as keyof typeof ACTION_VERSIONS]);
      observed.add(action);
    }
    expect([...observed].sort()).toEqual(Object.keys(ACTION_VERSIONS).sort());
  });

  it("declares least-privilege permissions on every job, not only on the workflow", () => {
    const normalized = workflow.replaceAll("\r\n", "\n");
    const jobsAt = normalized.indexOf("\njobs:\n");
    expect(jobsAt).toBeGreaterThan(0);
    const served = [...normalized.slice(jobsAt).matchAll(/^  ([a-z0-9-]+):$/gmu)]
      .map((match) => match[1] ?? "");
    expect(served.length).toBeGreaterThan(0);
    expect(served.slice().sort()).toEqual(CROSS_HOST_JOBS.slice().sort());
    for (const name of CROSS_HOST_JOBS) {
      const job = workflowJob(workflow, name);
      const declared = /\n    permissions:\n((?:      [^\n]+\n)+)/u.exec(job);
      expect(declared, `${name} inherits permissions instead of declaring them`).not.toBeNull();
      expect(declared?.[1], `${name} grants more than contents: read`)
        .toBe("      contents: read\n");
    }
  });

  it("checks out an explicit ref with credentials disabled in every job", () => {
    expect(occurrences(workflow, "actions/checkout@")).toBe(CROSS_HOST_JOBS.length);
    const refs = new Map<string, string>();
    for (const name of CROSS_HOST_JOBS) {
      const job = workflowJob(workflow, name);
      const checkout =
        /^      - uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+\n        with:\n((?:          [^\n]+\n)+)/mu
          .exec(job);
      expect(checkout, `${name} has no commented checkout carrying a with: block`).not.toBeNull();
      const withBlock = checkout?.[1] ?? "";
      expect(withBlock, `${name} leaves the job token persisted in .git/config`)
        .toContain("          persist-credentials: false\n");
      const ref = /^          ref: (.+)$/mu.exec(withBlock);
      expect(ref, `${name} states no explicit checkout ref`).not.toBeNull();
      refs.set(name, ref?.[1] ?? "");
    }
    expect(refs.size).toBe(CROSS_HOST_JOBS.length);
    const prHead = [...refs].filter(([, ref]) => ref === SOURCE_EXPRESSION).map(([job]) => job);
    expect(prHead, "exactly one job may bind evidence to the PR head").toEqual([PR_HEAD_JOB]);
    const mergeGates = [...refs].filter(([, ref]) => ref === MERGE_GATE_REF).map(([job]) => job);
    expect(mergeGates.slice().sort())
      .toEqual(CROSS_HOST_JOBS.filter((job) => job !== PR_HEAD_JOB).slice().sort());
  });

  it("proves the Unix root lane executed instead of trusting its exit code", () => {
    const step = workflowStep(gateJob, "Test");
    const log = "vitest-root-posix.log";
    expect(step).toContain("          set -o pipefail");
    expect(step).toContain("          set +e");
    expect(step).toContain(`          pnpm test 2>&1 | tee ${log}`);
    expect(step).toContain("          status=${PIPESTATUS[0]}");
    expect(step).toContain("          set -e");
    expect(step).toContain('          if [ "${status}" -ne 0 ]; then exit "${status}"; fi');
    expect(step).toContain(
      `          if ! grep -Eq '^ *Test Files +[1-9][0-9]* passed' ${log}; then exit 1; fi`,
    );
    expect(step).toContain(
      `          if ! grep -Eq '^ *Tests +[1-9][0-9]* passed' ${log}; then exit 1; fi`,
    );
    expect(step).not.toContain("continue-on-error");
    // tsc emits no count line, so the typecheck lane is graded on its captured
    // exit status only - asserted here so "no count grep" stays a decision.
    const typecheck = workflowStep(gateJob, "Typecheck");
    expect(typecheck).toContain("          pnpm typecheck 2>&1 | tee tsc-root-posix.log");
    expect(typecheck).toContain("          status=${PIPESTATUS[0]}");
    expect(typecheck).toContain('          if [ "${status}" -ne 0 ]; then exit "${status}"; fi');
    expect(typecheck).not.toContain("Test Files");
  });

  it("runs the release-relevant packaging, import and migration lanes on Windows", () => {
    expect(WINDOWS_RELEASE_LANES.length).toBeGreaterThan(0);
    expect(windowsJob).toContain("        id: install");
    expect(windowsJob).not.toContain("shell: bash");
    for (const lane of WINDOWS_RELEASE_LANES) {
      const step = workflowStep(windowsJob, lane.name);
      expect(step)
        .toContain("        if: ${{ always() && steps.install.conclusion == 'success' }}");
      expect(step).toContain("          $ErrorActionPreference = 'Continue'");
      expect(step).toContain("          $PSNativeCommandUseErrorActionPreference = $false");
      expect(step).toContain(`          ${lane.command} 2>&1 | Tee-Object -FilePath ${lane.log}`);
      expect(step).toContain("          $status = $LASTEXITCODE");
      expect(step).toContain("          if ($status -ne 0) {");
      expect(step).toContain("            exit 1");
      expect(step).not.toContain("continue-on-error");
      const counts = [
        `          if (-not (Select-String -Path ${lane.log} ` +
        "-Pattern '^\\s*Test Files\\s+[1-9][0-9]* passed' -Quiet)) {",
        `          if (-not (Select-String -Path ${lane.log} ` +
        "-Pattern '^\\s*Tests\\s+[1-9][0-9]* passed' -Quiet)) {",
      ];
      for (const count of counts) {
        if (lane.counted) expect(step, `${lane.name} banks an unexecuted lane`).toContain(count);
        else expect(step).not.toContain(count);
      }
    }
  });

  it("mirrors every portability-evidence gate command onto the Windows host", () => {
    const parsed = [...portabilityJob.matchAll(PORTABILITY_GATE_COMMAND)]
      .map((match) => match[1] ?? "");
    const commands = [...new Set(parsed)].sort();
    expect(commands.length, "parsed no gate command out of portability-evidence")
      .toBeGreaterThan(0);
    expect(commands).toEqual([
      "node --test tests/integration/release-supply-chain.test.mjs",
      "pnpm exec vitest run tests/integration",
      "pnpm test:migration",
      "pnpm typecheck:import",
      "pnpm typecheck:packaging",
    ]);
    for (const key of Object.keys(SUPERSET_ON_WINDOWS)) {
      expect(commands, `${key} is a dead superset excuse`).toContain(key);
    }
    for (const command of commands) {
      if (windowsJob.includes(command)) continue;
      const superset = SUPERSET_ON_WINDOWS[command as keyof typeof SUPERSET_ON_WINDOWS];
      expect(superset, `gate-windows neither runs nor supersets: ${command}`).toBeDefined();
      expect(windowsJob, `gate-windows does not run the claimed superset ${superset}`)
        .toContain(`          ${superset} 2>&1 | Tee-Object`);
      expect(rootVitestConfig, "the superset claim rests on the root include covering tests/**")
        .toContain('"tests/**/*.test.ts"');
    }
  });

  it("documents the POSIX-only evidence-attribution exclusion in the workflow itself", () => {
    expect(portabilityHeader.length).toBeGreaterThan(0);
    expect(portabilityHeader).toContain("EVIDENCE ATTRIBUTION IS POSIX-ONLY");
    expect(portabilityHeader).toContain("gate-windows");
    expect(portabilityHeader).toContain("mirrors every portability-evidence gate command");
    expect(portabilityJob).toContain("os: [ubuntu-latest, macos-latest]");
  });
});
