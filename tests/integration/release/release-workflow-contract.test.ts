import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CALLER_PATH = join(ROOT, ".github", "workflows", "windows-release-candidate.yml");
const REUSABLE_PATH = join(ROOT, ".github", "workflows", "reusable-windows-release.yml");
const BUILD_PATH = join(ROOT, ".github", "workflows", "reusable-windows-candidate-build.yml");
const ADMIT_PATH = join(ROOT, ".github", "workflows", "reusable-windows-candidate-admit.yml");
const VERIFY_PATH = join(ROOT, ".github", "workflows", "reusable-windows-candidate-verify.yml");
const CROSS_HOST_PATH = join(ROOT, ".github", "workflows", "cross-host.yml");
const PUBLISH_PATH = join(ROOT, ".github", "workflows", "publish-windows-release.yml");
const PUBLICATION_AUTHORIZE_PATH = join(
  ROOT, ".github", "workflows", "reusable-windows-publication-authorize.yml",
);
const PUBLICATION_VERIFY_PATH = join(
  ROOT, ".github", "workflows", "reusable-windows-publication-verify.yml",
);
const PACKAGE_PATH = join(ROOT, "package.json");
const NODE_AUTHENTICATOR_PATH = join(ROOT, "tools", "packaging", "authenticate-node.ps1");
const AUTHENTICATED_PACK =
  "authenticate-node.ps1 -Entry tools/packaging/pack-windows-main.ts";
const AUTHENTICATED_EVIDENCE =
  "authenticate-node.ps1 -Entry scripts/release/supply-chain.mjs -NodeArguments '--head'";

const readIfPresent = (path: string): string =>
  existsSync(path) ? readFileSync(path, "utf8").replaceAll("\r\n", "\n") : "";

const caller = readIfPresent(CALLER_PATH);
const reusable = readIfPresent(REUSABLE_PATH);
const buildWorkflow = readIfPresent(BUILD_PATH);
const admitWorkflow = readIfPresent(ADMIT_PATH);
const verifyWorkflow = readIfPresent(VERIFY_PATH);
const crossHost = readIfPresent(CROSS_HOST_PATH);
const publishWorkflow = readIfPresent(PUBLISH_PATH);
const publicationAuthorizeWorkflow = readIfPresent(PUBLICATION_AUTHORIZE_PATH);
const publicationVerifyWorkflow = readIfPresent(PUBLICATION_VERIFY_PATH);
const nodeAuthenticator = readIfPresent(NODE_AUTHENTICATOR_PATH);
const candidateWorkflows = [caller, reusable, buildWorkflow, admitWorkflow, verifyWorkflow];
const candidateSource = candidateWorkflows.join("\n");
const workflowSources = Object.freeze([
  { file: "cross-host.yml", source: crossHost },
  { file: "publish-windows-release.yml", source: publishWorkflow },
  { file: "windows-release-candidate.yml", source: caller },
  { file: "reusable-windows-release.yml", source: reusable },
  { file: "reusable-windows-candidate-build.yml", source: buildWorkflow },
  { file: "reusable-windows-candidate-admit.yml", source: admitWorkflow },
  { file: "reusable-windows-candidate-verify.yml", source: verifyWorkflow },
  { file: "reusable-windows-publication-authorize.yml", source: publicationAuthorizeWorkflow },
  { file: "reusable-windows-publication-verify.yml", source: publicationVerifyWorkflow },
]);
const packageScripts = (JSON.parse(readIfPresent(PACKAGE_PATH)) as {
  readonly scripts: Readonly<Record<string, string>>;
}).scripts;

const ACTION_PINS = Object.freeze({
  "actions/attest": { sha: "1e69f48acb82d1966a394da916b4c1698aa569d6", version: "v4.2.2" },
  "actions/checkout": { sha: "11d5960a326750d5838078e36cf38b85af677262", version: "v4.4.0" },
  "actions/download-artifact": { sha: "d3f86a106a0bac45b974a628896c90dbdf5c8093", version: "v4.3.0" },
  "actions/setup-node": { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", version: "v4.4.0" },
  "actions/upload-artifact": { sha: "ea165f8d65b6e75b540449e92b4886f43607fa02", version: "v4.6.2" },
  "pnpm/action-setup": { sha: "b906affcce14559ad1aafd4ab0e942779e9f58b1", version: "v4.3.0" },
});

const EXPECTED_ACTION_ROSTER: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "cross-host.yml": [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  ],
  "publish-windows-release.yml": [
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ],
  "windows-release-candidate.yml": [],
  "reusable-windows-release.yml": [
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ],
  "reusable-windows-candidate-build.yml": [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  ],
  "reusable-windows-candidate-admit.yml": [
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ],
  "reusable-windows-candidate-verify.yml": [
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ],
  "reusable-windows-publication-authorize.yml": [
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  ],
  "reusable-windows-publication-verify.yml": [
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  ],
});

interface ActionUse {
  readonly action: string;
  readonly file: string;
  readonly line: number;
  readonly revision: string;
  readonly version?: string;
}

const STRICT_ACTION_USE = /^\s+(?:-\s+)?uses:\s+([^@.][^@\s]*)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/u;
const PERMISSIVE_ACTION_USE = /^\s+(?:-\s+)?uses:\s+([^@.][^@\s]*)@(\S+)/u;

function scanActionUses(pattern: RegExp): readonly ActionUse[] {
  return workflowSources.flatMap(({ file, source }) => source.split("\n").flatMap((line, index) => {
    const match = pattern.exec(line);
    if (!match) return [];
    return [{
      action: match[1] ?? "", file, line: index + 1,
      revision: match[2] ?? "", ...(match[3] ? { version: match[3] } : {}),
    }];
  }));
}

function observedActionRoster(): Readonly<Record<string, readonly string[]>> {
  const uses = scanActionUses(PERMISSIVE_ACTION_USE);
  return Object.fromEntries(workflowSources.map(({ file }) => [
    file,
    uses.filter((entry) => entry.file === file)
      .map((entry) => `${entry.action}@${entry.revision}`).sort(),
  ]));
}

interface WorkflowJob {
  readonly block: string;
  readonly key: string;
}

function workflowJobs(): readonly WorkflowJob[] {
  return workflowSources.flatMap(({ file, source }) => {
    const lines = source.split("\n");
    const jobsStart = lines.findIndex((line) => line === "jobs:");
    if (jobsStart < 0) return [];
    const starts = lines.slice(jobsStart + 1)
      .map((line, index) => ({ index: jobsStart + 1 + index, match: /^  ([a-z0-9_-]+):$/u.exec(line) }))
      .filter((entry) => entry.match !== null);
    return starts.map((entry, index) => ({
      block: lines.slice(entry.index, starts[index + 1]?.index ?? lines.length).join("\n"),
      key: `${file}:${entry.match?.[1] ?? ""}`,
    }));
  });
}

function checkoutBlocks(): readonly { readonly block: string; readonly location: string }[] {
  return workflowSources.flatMap(({ file, source }) => {
    const lines = source.split("\n");
    return lines.flatMap((line, index) => {
      if (!/uses:\s+actions\/checkout@/u.test(line)) return [];
      const indent = line.search(/\S/u);
      let end = index + 1;
      while (end < lines.length && !new RegExp(`^\\s{${indent}}-\\s+`, "u").test(lines[end] ?? "")) end += 1;
      return [{ block: lines.slice(index, end).join("\n"), location: `${file}:${index + 1}` }];
    });
  });
}

function job(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return "";
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  [a-z0-9_-]+:$/u.test(line));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("Windows release workflow files", () => {
  it("defines focused manual, build, admission, signer, and verifier workflows", () => {
    expect(caller.startsWith("name: windows-release-candidate\n")).toBe(true);
    expect(reusable.startsWith("name: reusable-windows-release\n")).toBe(true);
    expect(buildWorkflow.startsWith("name: reusable-windows-candidate-build\n")).toBe(true);
    expect(admitWorkflow.startsWith("name: reusable-windows-candidate-admit\n")).toBe(true);
    expect(verifyWorkflow.startsWith("name: reusable-windows-candidate-verify\n")).toBe(true);
    expect(crossHost).toContain("  workflow_call:");
    for (const workflow of candidateWorkflows) {
      expect(workflow.split("\n").length).toBeLessThanOrEqual(400);
    }
  });

  it("requires every third-party action to carry a 40-hex pin and version comment", () => {
    const permissiveUses = scanActionUses(PERMISSIVE_ACTION_USE);
    const strictUses = scanActionUses(STRICT_ACTION_USE);
    const strictLocations = new Set(strictUses.map((entry) => `${entry.file}:${entry.line}`));
    const unguarded = permissiveUses
      .filter((entry) => !strictLocations.has(`${entry.file}:${entry.line}`))
      .map((entry) => `${entry.file}:${entry.line} ${entry.action}@${entry.revision}`);
    expect(permissiveUses).toHaveLength(36);
    expect(unguarded, "third-party uses without an exact reviewed pin comment").toEqual([]);
    expect(strictUses).toHaveLength(permissiveUses.length);
  });

  it("matches every action pin and comment to the reviewed provenance table", () => {
    const actionUses = scanActionUses(STRICT_ACTION_USE);
    const expectedCounts = Object.freeze({
      "actions/attest": 2,
      "actions/checkout": 6,
      "actions/download-artifact": 8,
      "actions/setup-node": 6,
      "actions/upload-artifact": 8,
      "pnpm/action-setup": 6,
    });
    const observedCounts = Object.fromEntries(Object.keys(expectedCounts).map((action) => [
      action, actionUses.filter((entry) => entry.action === action).length,
    ]));
    expect(actionUses).toHaveLength(36);
    expect(observedCounts).toEqual(expectedCounts);
    expect(candidateSource).not.toContain("digest-mismatch:");
    for (const entry of actionUses) {
      expect(Object.hasOwn(ACTION_PINS, entry.action), `unreviewed action ${entry.action}`).toBe(true);
      const reviewed = ACTION_PINS[entry.action as keyof typeof ACTION_PINS];
      expect(entry.revision, `${entry.file}:${entry.line} SHA`).toBe(reviewed.sha);
      expect(entry.version, `${entry.file}:${entry.line} version`).toBe(reviewed.version);
    }
  });

  it("keeps the exact per-file action roster in both directions", () => {
    const observed = observedActionRoster();
    expect(Object.keys(observed).sort()).toEqual(Object.keys(EXPECTED_ACTION_ROSTER).sort());
    expect(observed).toEqual(EXPECTED_ACTION_ROSTER);
    expect(Object.values(observed).flat()).toHaveLength(36);
    expect(observed["cross-host.yml"]).toHaveLength(20);
    expect(Object.entries(observed).filter(([file]) => file !== "cross-host.yml")
      .flatMap(([, refs]) => refs)).toHaveLength(16);
  });

  it("keeps every checkout credentialless and explicitly referenced", () => {
    const checkouts = checkoutBlocks();
    expect(checkouts).toHaveLength(6);
    for (const checkout of checkouts) {
      expect(checkout.block, checkout.location).toMatch(/^\s+with:\s*$[\s\S]*^\s+persist-credentials: false$/mu);
      expect(checkout.block, checkout.location).toMatch(/^\s+ref:\s+.+$/mu);
    }
  });

  it("declares job permissions and limits writes to the reviewed job roster", () => {
    const jobs = workflowJobs();
    const missing = jobs.filter(({ block }) => !/^    permissions:(?: \{\})?$/mu.test(block))
      .map(({ key }) => key);
    const writers = jobs.filter(({ block }) => /^      [a-z0-9-]+: write$/mu.test(block))
      .map(({ key }) => key).sort();
    expect(jobs).toHaveLength(22);
    expect(missing, "jobs missing an explicit permissions block").toEqual([]);
    expect(writers).toEqual([
      "publish-windows-release.yml:publish",
      "reusable-windows-release.yml:attest-candidate",
      "windows-release-candidate.yml:attest-candidate",
    ]);
  });

  it("keeps every reusable-workflow dependency local to the workflow that declares it", () => {
    for (const workflow of [buildWorkflow, admitWorkflow, reusable, verifyWorkflow]) {
      const jobs = new Set([...workflow.matchAll(/^  ([a-z0-9_-]+):$/gmu)]
        .map((match) => match[1] ?? ""));
      const dependencies = [...workflow.matchAll(/^    needs:\s+([a-z0-9_-]+)$/gmu)]
        .map((match) => match[1] ?? "");
      for (const dependency of dependencies) expect(jobs.has(dependency)).toBe(true);
    }
  });
});

describe("protected branch release authority coverage", () => {
  const posixGate = job(crossHost, "gate");
  const windowsGate = job(crossHost, "gate-windows");
  const releaseTests = [
    "tests/integration/release-supply-chain.test.mjs",
    "tests/integration/release/windows-pack-observation.test.mjs",
    "tests/integration/release/verify-windows-release.test.mjs",
  ];
  const releaseCommand = `node --test ${releaseTests.join(" ")}`;

  it.each([
    ["POSIX", posixGate],
    ["Windows", windowsGate],
  ])("runs the standalone release authority contracts on %s", (_host, gate) => {
    expect(gate).toContain("      - name: Release authority contracts");
    expect(gate).toContain("pnpm typecheck:release");
    expect(gate).toContain(releaseCommand);
    expect(gate).toContain("pass [1-9][0-9]*");
    expect(gate).toContain("fail [1-9][0-9]*");
  });

  it("keeps release coverage reachable after an earlier test failure", () => {
    expect(posixGate).toContain("        if: always()");
    expect(windowsGate).toContain(
      "        if: ${{ always() && steps.install.conclusion == 'success' }}",
    );
  });

  it("keeps every release authority reader and hostile suite in local gates", () => {
    expect(packageScripts["release:observe-windows-pack"])
      .toBe("node scripts/release/windows-pack-observation.mjs");
    for (const module of [
      "scripts/release/windows-pack-observation-contract.mjs",
      "scripts/release/windows-pack-observation-output.mjs",
      "scripts/release/windows-pack-observation.mjs",
      "scripts/release/verify-windows-release.mjs",
    ]) {
      expect(packageScripts["typecheck:release"]).toContain(module);
    }
    for (const test of releaseTests.slice(1)) {
      expect(packageScripts["test:integration"]).toContain(test);
    }
  });
});

describe("manual release authority", () => {
  const authorize = job(caller, "authorize-subject");
  const requiredGates = job(caller, "required-gates");
  const build = job(caller, "build-candidate");
  const admit = job(caller, "admit-candidate");
  const attest = job(caller, "attest-candidate");
  const verify = job(caller, "verify-candidate");

  it("accepts only an explicit SHA confirmation for the exact protected main commit", () => {
    expect(caller).toContain("  workflow_dispatch:");
    expect(caller).toContain("      source_sha:");
    expect(caller).toContain("        required: true");
    expect(authorize).toContain("CONFIRMED_SOURCE_SHA: ${{ inputs.source_sha }}");
    expect(authorize).toContain("OBSERVED_SOURCE_SHA: ${{ github.sha }}");
    expect(authorize).toContain("OBSERVED_SOURCE_REF: ${{ github.ref }}");
    expect(authorize).toContain("OBSERVED_REF_PROTECTED: ${{ github.ref_protected }}");
    expect(authorize).toContain("refs/heads/main");
    expect(authorize).toContain("WINDOWS_RELEASE_SOURCE_MISMATCH@WINDOWS_RELEASE_AUTHORITY");
    expect(authorize).toContain("WINDOWS_RELEASE_REF_UNPROTECTED@WINDOWS_RELEASE_AUTHORITY");
    expect(authorize).not.toContain("actions/checkout");
  });

  it("keeps every candidate stage in one exact dependency chain", () => {
    expect(requiredGates).toContain("    needs: authorize-subject");
    expect(requiredGates).toContain("    uses: ./.github/workflows/cross-host.yml");
    expect(build).toContain("    needs: required-gates");
    expect(build).toContain("    uses: ./.github/workflows/reusable-windows-candidate-build.yml");
    expect(admit).toContain("    needs: build-candidate");
    expect(admit).toContain("    uses: ./.github/workflows/reusable-windows-candidate-admit.yml");
    expect(admit).toContain("      artifact_id: ${{ needs.build-candidate.outputs.artifact_id }}");
    expect(attest).toContain("    needs: admit-candidate");
    expect(attest).toContain("    uses: ./.github/workflows/reusable-windows-release.yml");
    for (const binding of [
      "artifact_id", "evidence_length", "evidence_sha256", "receipt_length",
      "receipt_sha256", "zip_length", "zip_sha256",
    ]) {
      expect(attest).toContain(
        `      ${binding}: ` + "${{ needs.admit-candidate.outputs." + binding + " }}",
      );
    }
    expect(verify).toContain("    needs: attest-candidate");
    expect(verify).toContain("    uses: ./.github/workflows/reusable-windows-candidate-verify.yml");
    expect(verify).toContain("      artifact_id: ${{ needs.attest-candidate.outputs.artifact_id }}");
    for (const stage of [build, admit, attest, verify]) {
      expect(stage).toContain("      source_sha: ${{ inputs.source_sha }}");
    }
  });

  it("exports every immutable handoff under the exact consumer key", () => {
    expect(buildWorkflow).toContain(
      "artifact_id: ${{ steps.transfer.outputs['artifact-id'] }}",
    );
    expect(buildWorkflow).toContain("value: ${{ jobs.build-candidate.outputs.artifact_id }}");
    for (const output of [
      "artifact_id", "evidence_length", "evidence_sha256", "receipt_length",
      "receipt_sha256", "zip_length", "zip_sha256",
    ]) {
      expect(admitWorkflow).toContain(`${output}:`);
      expect(admitWorkflow).toContain(
        "value: ${{ jobs.admit-candidate.outputs." + output + " }}",
      );
    }
    expect(admitWorkflow).toContain(
      "artifact_id: ${{ steps.transfer.outputs['artifact-id'] }}",
    );
    expect(reusable).toContain(
      "artifact_id: ${{ steps.publish.outputs['artifact-id'] }}",
    );
    expect(reusable).toContain("value: ${{ jobs.attest-candidate.outputs.artifact_id }}");
    expect(verifyWorkflow).toContain(
      "artifact_id: ${{ steps.publish.outputs['artifact-id'] }}",
    );
    expect(verifyWorkflow).toContain("value: ${{ jobs.verify-candidate.outputs.artifact_id }}");
    for (const [output, actionOutput] of [
      ["artifact_digest", "artifact-digest"], ["artifact_url", "artifact-url"],
    ]) {
      expect(reusable).toContain(
        `${output}: ` + "${{ steps.publish.outputs['" + actionOutput + "'] }}",
      );
      expect(reusable).toContain(
        "value: ${{ jobs.attest-candidate.outputs." + output + " }}",
      );
      expect(verifyWorkflow).toContain(
        `${output}: ` + "${{ steps.publish.outputs['" + actionOutput + "'] }}",
      );
      expect(verifyWorkflow).toContain(
        "value: ${{ jobs.verify-candidate.outputs." + output + " }}",
      );
    }
    for (const [output, actionOutput] of [
      ["attestation_id", "attestation-id"], ["attestation_url", "attestation-url"],
    ]) {
      expect(reusable).toContain(
        `${output}: ` + "${{ steps.attest.outputs['" + actionOutput + "'] }}",
      );
      expect(reusable).toContain(
        "value: ${{ jobs.attest-candidate.outputs." + output + " }}",
      );
    }
  });

  it("grants signing permissions only to the signer call", () => {
    expect(caller).toContain("permissions:\n  contents: read");
    expect(authorize).toContain("    permissions: {}");
    expect(attest).toContain("      artifact-metadata: write");
    expect(attest).toContain("      attestations: write");
    expect(attest).toContain("      id-token: write");
    for (const unprivileged of [authorize, requiredGates, build, admit, verify]) {
      expect(unprivileged).not.toContain("artifact-metadata: write");
      expect(unprivileged).not.toContain("attestations: write");
      expect(unprivileged).not.toContain("id-token: write");
    }
    expect(caller).not.toContain("contents: write");
    expect(caller).not.toContain("secrets: inherit");
  });
});

describe("reusable Windows release boundary", () => {
  const authorizeCaller = job(reusable, "authorize-caller");
  const requiredGates = job(caller, "required-gates");
  const build = job(buildWorkflow, "build-candidate");
  const admit = job(admitWorkflow, "admit-candidate");
  const attest = job(reusable, "attest-candidate");
  const verify = job(verifyWorkflow, "verify-candidate");

  it("admits only the exact protected-main manual caller before any required gate", () => {
    expect(authorizeCaller).toContain("    permissions: {}");
    expect(authorizeCaller).toContain("CONFIRMED_SOURCE_SHA: ${{ inputs.source_sha }}");
    expect(authorizeCaller).toContain("OBSERVED_CALLER_WORKFLOW_REF: ${{ github.workflow_ref }}");
    expect(authorizeCaller).toContain("OBSERVED_EVENT_NAME: ${{ github.event_name }}");
    expect(authorizeCaller).toContain("OBSERVED_REF_PROTECTED: ${{ github.ref_protected }}");
    expect(authorizeCaller).toContain("OBSERVED_REPOSITORY: ${{ github.repository }}");
    expect(authorizeCaller).toContain("OBSERVED_SOURCE_REF: ${{ github.ref }}");
    expect(authorizeCaller).toContain("OBSERVED_SOURCE_SHA: ${{ github.sha }}");
    expect(authorizeCaller).toContain(
      "yaront1111/Moe-NG/.github/workflows/windows-release-candidate.yml@refs/heads/main",
    );
    expect(authorizeCaller).toContain("yaront1111/Moe-NG");
    expect(authorizeCaller).toContain("refs/heads/main");
    expect(authorizeCaller).toContain("workflow_dispatch");
    expect(authorizeCaller).toContain("WINDOWS_RELEASE_INPUT_INVALID@WINDOWS_RELEASE_AUTHORITY");
    expect(authorizeCaller).toContain("WINDOWS_RELEASE_REF_UNPROTECTED@WINDOWS_RELEASE_AUTHORITY");
    expect(authorizeCaller).toContain("WINDOWS_RELEASE_SOURCE_MISMATCH@WINDOWS_RELEASE_AUTHORITY");
    expect(authorizeCaller).toContain("WINDOWS_RELEASE_SIGNER_MISMATCH@WINDOWS_RELEASE_AUTHORITY");
    expect(authorizeCaller).not.toContain("actions/checkout");
    expect(attest).toContain("    needs: authorize-caller");
  });

  it("owns the exact-subject required gate dependency for every caller", () => {
    expect(requiredGates).toContain("    uses: ./.github/workflows/cross-host.yml");
    expect(requiredGates).toContain("    permissions:\n      contents: read");
  });

  it("builds on a bounded unprivileged Windows runner from the exact checkout", () => {
    expect(reusable).toContain("  workflow_call:");
    expect(build).toContain("    runs-on: windows-2025");
    expect(build).not.toContain("    needs: required-gates");
    expect(build).toContain("    timeout-minutes: 180");
    expect(build).toContain("    permissions:\n      contents: read");
    expect(build).not.toContain("id-token: write");
    expect(build).not.toContain("attestations: write");
    expect(build).toContain("          ref: ${{ github.sha }}");
    expect(build).toContain("          persist-credentials: false");
    expect(build).toContain("OBSERVED_REF_PROTECTED: ${{ github.ref_protected }}");
    expect(build).toContain("WINDOWS_RELEASE_SOURCE_MISMATCH@WINDOWS_RELEASE_AUTHORITY");
    expect(build).toContain("WINDOWS_RELEASE_REF_UNPROTECTED@WINDOWS_RELEASE_AUTHORITY");
    expect(build).toContain("      - name: Authorize GitHub-hosted build runner");
    expect(build).toContain("OBSERVED_RUNNER_ENVIRONMENT: ${{ runner.environment }}");
    expect(build).toContain("github-hosted");
    expect(build.indexOf("Authorize GitHub-hosted build runner")).toBeLessThan(
      build.indexOf("actions/checkout@"),
    );
    expect(count(candidateSource, "actions/checkout@")).toBe(1);
  });

  it("pins and verifies the exact Rust toolchain before native compilation", () => {
    const rustInstall = "rustup toolchain install 1.96.0 --profile minimal";
    const rustDefault = "rustup default 1.96.0";
    const nativeBuild = "cargo build --locked --release";
    expect(build).toContain("      - name: Pin the Windows Rust toolchain");
    expect(build).toContain(rustInstall);
    expect(build).toContain(rustDefault);
    expect(build).toContain("rustc --version");
    expect(build).toContain("cargo --version");
    expect(build).toContain("rustc 1.96.0 (ac68faa20 2026-05-25)");
    expect(build).toContain("cargo 1.96.0 (30a34c682 2026-05-25)");
    expect(build).toContain("WINDOWS_RELEASE_VERSION_MISMATCH@WINDOWS_RELEASE_AUTHORITY");
    expect(build.indexOf(rustInstall)).toBeLessThan(build.indexOf(nativeBuild));
    expect(build.indexOf(rustDefault)).toBeLessThan(build.indexOf(nativeBuild));
  });

  describe("task-bf2b2aac authenticated Node entrypoints", () => {
    const authenticatedEntries = [AUTHENTICATED_PACK, AUTHENTICATED_EVIDENCE];

    it("runs ZIP production through the authenticated Node entrypoint", () => {
      expect(build).toContain(authenticatedEntries[0]);
      expect(build).not.toContain("run: pnpm pack:windows");
    });

    it("runs release evidence through the authenticated Node entrypoint", () => {
      expect(build).toContain(authenticatedEntries[1]);
      expect(build).not.toContain("pnpm release:evidence");
    });

    it("binds both entries to the tracked Node SHA-256 pin", () => {
      expect(authenticatedEntries.length).toBeGreaterThan(0);
      for (const entry of authenticatedEntries) expect(build).toContain(entry);
      expect(count(build, "authenticate-node.ps1 -Entry")).toBe(authenticatedEntries.length);
      expect(nodeAuthenticator).toContain("Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256");
      expect(nodeAuthenticator).toContain("$pins.nodeSha256");
      expect(nodeAuthenticator).toContain("WINDOWS_RELEASE_NODE_DIGEST_MISMATCH");
      expect(nodeAuthenticator).toContain("WINDOWS_RELEASE_AUTHORITY");
    });

    // Deliberately disjoint from the SHA-256 arm above: deleting either comparison must red
    // its own arm and leave the other green, so neither fence can answer for the other.
    it("binds both entries to the tracked Node version pin", () => {
      expect(nodeAuthenticator).toContain("& $nodeExecutable '--version'");
      expect(nodeAuthenticator).toContain("$pins.nodeVersion,\n      [StringComparison]::Ordinal)");
      expect(nodeAuthenticator).toContain("WINDOWS_RELEASE_VERSION_MISMATCH");
      expect(nodeAuthenticator).not.toMatch(/nodeVersion\s*,\s*\[StringComparison\]::OrdinalIgnoreCase/u);
    });
  });

  it("runs every remaining release gate before packaging and smoke", () => {
    const commands = [
      "pnpm verify:foundation", "pnpm verify:store", "pnpm test:integration",
      "pnpm test:fault", "pnpm test:migration", "pnpm test:property", "pnpm test:e2e",
      "pnpm test:e2e:browser", "pnpm typecheck:release", AUTHENTICATED_EVIDENCE,
      AUTHENTICATED_PACK, "smoke-windows-artifact.ps1 -Zip dist/moe-windows.zip",
    ];
    for (const command of commands) expect(build).toContain(command);
    expect(build.indexOf(AUTHENTICATED_EVIDENCE)).toBeLessThan(build.indexOf(AUTHENTICATED_PACK));
    expect(build.indexOf(AUTHENTICATED_PACK)).toBeLessThan(
      build.indexOf("smoke-windows-artifact.ps1 -Zip dist/moe-windows.zip"),
    );
    expect(count(build, "Test Files\\s+[1-9][0-9]* passed")).toBeGreaterThanOrEqual(7);
    expect(count(build, "Tests\\s+[1-9][0-9]* passed")).toBeGreaterThanOrEqual(7);
  });

  it("creates the detached observation with the fixed ordered CLI", () => {
    expect(build).toContain([
      "node scripts/release/windows-pack-observation.mjs create",
      "--artifact dist/moe-windows.zip",
      "--source-sha $env:GITHUB_SHA",
      "--release-evidence $env:RELEASE_EVIDENCE_PATH",
      "--runner-image-os $env:ImageOS",
      "--runner-image-version $env:ImageVersion",
      "--runner-arch $env:RUNNER_ARCH",
      "--output dist/moe-windows.zip.provenance.json",
    ].join(" "));
    expect(build).toContain("windows-release-observed-${{ github.sha }}");
    expect(build).toContain("$record.evidencePath -isnot [string]");
    expect(build).toContain("$evidence.source.sourceSha -cne $env:GITHUB_SHA");
    expect(build).toContain("$evidence.publicationAuthorized -ne $false");
    expect(build).toContain("$evidence.releaseVerdict -cne 'UNKNOWN'");
    expect(build).toContain("dist/moe-windows.zip.release-evidence.json");
    expect(build).toContain([
      "            dist/moe-windows.zip",
      "            dist/moe-windows.zip.provenance.json",
      "            dist/moe-windows.zip.release-evidence.json",
    ].join("\n"));
  });

  it("uses a fresh protected signer with no checkout or repository execution", () => {
    expect(attest).toContain("    needs: authorize-caller");
    expect(attest).toContain("    runs-on: windows-2025");
    expect(attest).not.toContain("    environment:");
    expect(attest).toContain("      artifact-metadata: write");
    expect(attest).toContain("      attestations: write");
    expect(attest).toContain("      contents: read");
    expect(attest).toContain("      id-token: write");
    expect(attest).not.toContain("actions/checkout");
    expect(attest).not.toMatch(/\b(?:node|pnpm|npm|npx|cargo|git)\s+/u);
    expect(attest).not.toContain("Expand-Archive");
    expect(attest).not.toContain("contents: write");
  });

  it("validates canonical candidate authority before signing and binds the admitted bytes again", () => {
    const validation = "      - name: Independently validate observed candidate bytes";
    const admission = "      - name: Transfer the admitted candidate by exact artifact ID";
    const binding = "      - name: Rebind admitted bytes before signing";
    const attestation = "      - name: Generate GitHub build-provenance attestation";
    const reobservation = "      - name: Re-observe attested candidate bytes";
    const upload = "      - name: Transfer the signed candidate by exact artifact ID";
    expect(admit).toContain(validation);
    expect(admit).toContain("MAX_ZIP_BYTES: 536870912");
    expect(admit).toContain("MAX_RECEIPT_BYTES: 65536");
    expect(admit).toContain("MAX_EVIDENCE_BYTES: 16777216");
    expect(attest).toContain("OBSERVED_RUNNER_ENVIRONMENT: ${{ runner.environment }}");
    expect(attest).toContain("github-hosted");
    expect(admit).toContain("moe-pack-observation/1");
    expect(admit).toContain("LOCAL_OBSERVED");
    expect(admit).toContain("publicationAuthorized");
    expect(admit).toContain("releaseVerdict");
    expect(admit).toContain("releaseEvidenceDigest");
    expect(admit).toContain("receiptDigest");
    for (const workflow of [admit, attest, verify]) {
      expect(workflow).toContain("[IO.FileStream]::new");
      expect(workflow).not.toContain("[IO.File]::ReadAllText");
      expect(workflow).not.toContain("Get-FileHash");
    }
    expect(admit).toContain("$receipt.publicationAuthorized -isnot [bool]");
    expect(admit).toContain("$receipt.artifact.byteLength -isnot [long]");
    expect(admit).toContain("$receipt.artifact.byteLength -le 0");
    expect(admit).toContain("$receiptStringFields");
    expect(admit).toContain("$evidenceSourceStringFields");
    expect(admit).toContain(admission);
    expect(attest).toContain(binding);
    expect(attest).toContain(reobservation);
    expect(attest.indexOf(binding)).toBeLessThan(attest.indexOf(attestation));
    expect(attest.indexOf(attestation)).toBeLessThan(attest.indexOf(reobservation));
    expect(attest.indexOf(reobservation)).toBeLessThan(attest.indexOf(upload));
  });

  it("attests and then offline-verifies all three exact subjects before final upload", () => {
    expect(attest).toContain("          subject-path: |");
    expect(attest).toContain([
      "            candidate/moe-windows.zip",
      "            candidate/moe-windows.zip.provenance.json",
      "            candidate/moe-windows.zip.release-evidence.json",
    ].join("\n"));
    expect(verify).toContain("candidate/moe-windows.zip.attestation.json");
    expect(verify).toContain("MAX_ATTESTATION_BYTES: 16777216");
    expect(verify).toContain(
      "$candidateBundle = 'candidate/moe-windows.zip.attestation.json'",
    );
    expect(attest).toContain(
      "[IO.File]::Copy($env:ATTESTATION_BUNDLE, $candidateBundle, $false)",
    );
    expect(verify).toContain("'--bundle', $candidateBundle");
    expect(verify).toContain("CANDIDATE_$($subject.Prefix)_SHA256");
    expect(verify).toContain("Prefix = 'ATTESTATION'");
    expect(attest).not.toContain("Copy-Item -LiteralPath $env:ATTESTATION_BUNDLE");
    for (const subject of [
      "$zip", "$observation", "$releaseEvidence",
    ]) expect(verify).toContain(`gh attestation verify ${subject} @verification`);
    for (const prefix of ["zip", "observation", "releaseEvidence"]) {
      expect(verify).toContain(`$${prefix}Status = $LASTEXITCODE`);
      expect(verify).toContain(`Read-VerifiedEntries $${prefix}Json $${prefix}Status`);
    }
    expect(verify).toContain("--signer-workflow");
    expect(verify).toContain("$env:GITHUB_REPOSITORY/.github/workflows/reusable-windows-release.yml");
    expect(verify).toContain("--signer-digest");
    expect(verify).toContain("--source-digest");
    expect(verify).toContain("--source-ref");
    expect(verify).toContain("refs/heads/main");
    expect(verify).toContain("--deny-self-hosted-runners");
    expect(count(verify, "--format json")).toBe(3);
    expect(verify).toContain("-isnot [System.Array]");
    expect(verify).toContain("$entries.Count -lt 1");
    expect(verify).toContain(
      "https://github.com/yaront1111/Moe-NG/.github/workflows/windows-release-candidate.yml@refs/heads/main",
    );
    expect(verify).toContain("buildConfigURI");
    expect(verify).toContain("buildConfigDigest");
    expect(verify).toContain("buildTrigger");
    expect(verify).toContain("buildSignerURI");
    expect(verify).toContain("buildSignerDigest");
    expect(verify).toContain("runnerEnvironment");
    expect(verify).toContain("subjectAlternativeName");
    expect(verify.indexOf("gh attestation verify")).toBeLessThan(
      verify.indexOf("windows-release-candidate-${{ github.sha }}"),
    );
    expect(verify).toContain([
      "            candidate/moe-windows.zip",
      "            candidate/moe-windows.zip.provenance.json",
      "            candidate/moe-windows.zip.release-evidence.json",
      "            candidate/moe-windows.zip.attestation.json",
    ].join("\n"));
  });

  it("never publishes a tag, release, package, or authorized provenance claim", () => {
    expect(candidateSource).not.toContain("contents: write");
    expect(candidateSource).not.toContain("packages: write");
    expect(candidateSource).not.toContain("gh release");
    expect(candidateSource).not.toContain("git tag");
    expect(candidateSource).not.toContain("publicationAuthorized: true");
  });

  it("uses only the approved Windows release authority vocabulary", () => {
    const allowed = new Set([
      "WINDOWS_RELEASE_INPUT_INVALID", "WINDOWS_RELEASE_REF_UNPROTECTED",
      "WINDOWS_RELEASE_REQUIRED_GATE_MISSING", "WINDOWS_RELEASE_SOURCE_MISMATCH",
      "WINDOWS_RELEASE_VERSION_MISMATCH", "WINDOWS_RELEASE_CANDIDATE_MALFORMED",
      "WINDOWS_RELEASE_ARTIFACT_MISMATCH", "WINDOWS_RELEASE_ATTESTATION_INVALID",
      "WINDOWS_RELEASE_SIGNER_MISMATCH", "WINDOWS_RELEASE_PUBLICATION_CONFLICT",
      "WINDOWS_RELEASE_IMMUTABILITY_DISABLED", "WINDOWS_RELEASE_IMMUTABILITY_UNVERIFIED",
      "WINDOWS_RELEASE_NODE_DIGEST_MISMATCH",
      "WINDOWS_RELEASE_TOOLCHAIN_UNAVAILABLE",
    ]);
    const refusals = [...candidateSource.matchAll(
      /(WINDOWS_RELEASE_[A-Z_]+)@([A-Z_]+)/gu,
    )];
    expect(refusals.length).toBeGreaterThan(0);
    // The candidate build now also refuses from authenticate-node.ps1, which interpolates
    // its code into one emitter, so the literal CODE@LAYER pair never appears there. Scan
    // the definition site instead, or a new code escapes the freeze on that surface.
    // WIDENED by task-9ce44211, which blinded the previous anchor. It matched only a code
    // written as a quoted literal immediately after `-Code`; once refusal sites became
    // `-Code (Resolve-RefusalCode -ErrorRecord $_)` with the literals living inside that
    // helper's `return`s, five sites and one entirely new code fell outside the freeze while
    // this arm stayed green. Scanning EVERY quoted WINDOWS_RELEASE_* literal in the file binds
    // the guard to the set of codes the script can emit rather than to one call shape.
    const authenticatorCodes = [...nodeAuthenticator.matchAll(
      /'(WINDOWS_RELEASE_[A-Z_]+)'/gu,
    )].map((match) => match[1] ?? "");
    expect(authenticatorCodes.length).toBeGreaterThan(0);
    expect(authenticatorCodes).toContain("WINDOWS_RELEASE_NODE_DIGEST_MISMATCH");
    expect(authenticatorCodes).toContain("WINDOWS_RELEASE_VERSION_MISMATCH");
    // NON-VACUITY for the widening: a code reachable ONLY through the triage helper must be
    // visible to this scan, or the freeze silently stops covering the sites that use it.
    expect(authenticatorCodes).toContain("WINDOWS_RELEASE_TOOLCHAIN_UNAVAILABLE");
    expect(count(nodeAuthenticator, "$Code@WINDOWS_RELEASE_AUTHORITY")).toBe(1);
    expect(count(nodeAuthenticator, "@WINDOWS_RELEASE_AUTHORITY")).toBe(1);
    for (const code of authenticatorCodes) {
      expect(allowed.has(code), `unapproved code ${code}`).toBe(true);
    }
    for (const refusal of refusals) {
      expect(refusal[2]).toBe("WINDOWS_RELEASE_AUTHORITY");
      expect(allowed.has(refusal[1] ?? ""), `unapproved code ${refusal[1] ?? ""}`).toBe(true);
    }
  });
});

/**
 * EXECUTION ARMS for `authenticate-node.ps1` (task-9ce44211). Every other arm in this file is a
 * source-text scan; these two actually RUN the authenticator, because the defect they pin is a
 * runtime module-resolution failure that no amount of reading the script can show.
 *
 * THE SINGLE VARIABLE IS `PSModulePath`. Both arms build one identical fixture and differ in
 * exactly one byte-level input. That is what makes arm B a DIVERGENCE fixture rather than a
 * reachability one (epic rail 7A): arm A proves the fixture reaches the digest gate at
 * `authenticate-node.ps1:110-112` with every earlier fence satisfied — pins file present and
 * well-formed, `RUNNER_TOOL_CACHE` rooted, `RUNNER_ARCH` in the switch, node.exe present,
 * non-reparse, non-container, and the tracked entry resolvable — so when arm B refuses with a
 * DIFFERENT code, the only mechanism that can have answered is the digest block's catch.
 *
 * WHY THE HOSTILE PATH IS REALISTIC: a pwsh 7 parent exports its own `PSModulePath`, node
 * forwards the environment verbatim to a spawned `powershell.exe` 5.1, and 5.1 then binds
 * `Microsoft.PowerShell.Utility` from the pwsh 7 directory, where `Get-FileHash` is absent.
 * Launching 5.1 FROM pwsh does not reproduce it — pwsh rewrites the child's path — which is why
 * these arms spawn from node.
 */
const POWERSHELL_51 = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const WINDOWS_POWERSHELL_MODULES = "C:\Windows\system32\WindowsPowerShell\v1.0\Modules";

/** The pwsh 7 module directory, DISCOVERED rather than pinned to a version. */
function pwshModuleDirectory(): string | null {
  const probe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "$PSHOME"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return null;
  const home = (probe.stdout ?? "").trim();
  if (home.length === 0) return null;
  const modules = join(home, "Modules");
  return existsSync(modules) ? modules : null;
}

/**
 * Runs the authenticator with a node.exe whose bytes are deliberately NOT the pinned digest, so
 * a run that reaches the digest comparison refuses NODE_DIGEST_MISMATCH and one that cannot
 * resolve `Get-FileHash` refuses something else.
 */
/**
 * Builds a child environment with `PSModulePath` REPLACED rather than shadowed.
 *
 * WHY THIS IS NOT `{ ...process.env, PSModulePath }`. Windows environment names are
 * case-insensitive to the OS but case-SENSITIVE as JavaScript object keys, and vitest's worker
 * exposes the inherited name uppercased as `PSMODULEPATH`. The obvious spread therefore emits
 * BOTH keys, Windows binds the inherited one, and the override is silently discarded — the arm
 * still runs, still passes, and never applies the hostile condition it exists to test. Measured:
 * with the spread, even a PSModulePath containing ONLY the pwsh 7 directory resolved
 * `Get-FileHash`, because the child never saw it.
 */
function childEnvironment(modulePath: string, cache: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^psmodulepath$/iu.test(key)) environment[key] = value;
  }
  environment["PSModulePath"] = modulePath;
  environment["RUNNER_ARCH"] = "X64";
  environment["RUNNER_TOOL_CACHE"] = cache;
  return environment;
}

/** Stages a tool cache whose node.exe is present but is NOT the pinned toolchain. */
function stageToolCache(): string {
  const pins = JSON.parse(
    readFileSync(join(ROOT, "tools", "packaging", "toolchain-pins.json"), "utf8"),
  ) as { readonly nodeVersion: string };
  const cache = mkdtempSync(join(tmpdir(), "moe-authenticate-node-"));
  const directory = join(cache, "node", pins.nodeVersion.slice(1), "x64");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "node.exe"), "deliberately not the pinned toolchain bytes");
  return cache;
}

/** Runs the authenticator against an arbitrary cache and architecture. */
function runAuthenticatorWith(
  modulePath: string, cache: string, architecture: string,
): { output: string; status: number | null } {
  const result = spawnSync(
    POWERSHELL_51,
    [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(ROOT, "tools", "packaging", "authenticate-node.ps1"),
      "-Entry", "tools/packaging/pack-windows-main.ts",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...childEnvironment(modulePath, cache), RUNNER_ARCH: architecture },
    },
  );
  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
}

function runAuthenticator(modulePath: string): { output: string; status: number | null } {
  const pins = JSON.parse(
    readFileSync(join(ROOT, "tools", "packaging", "toolchain-pins.json"), "utf8"),
  ) as { readonly nodeVersion: string };
  const cache = mkdtempSync(join(tmpdir(), "moe-authenticate-node-"));
  // The script strips the leading `v` (`$Pins.nodeVersion.Substring(1)`), so the fixture must
  // too — a `v`-prefixed directory refuses INPUT_INVALID at an EARLIER fence and would make
  // arm A look like arm B for an unrelated reason.
  const directory = join(cache, "node", pins.nodeVersion.slice(1), "x64");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "node.exe"), "deliberately not the pinned toolchain bytes");
  const result = spawnSync(
    POWERSHELL_51,
    [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(ROOT, "tools", "packaging", "authenticate-node.ps1"),
      "-Entry", "tools/packaging/pack-windows-main.ts",
    ],
    { cwd: ROOT, encoding: "utf8", env: childEnvironment(modulePath, cache) },
  );
  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
}

describe("authenticate-node.ps1 resolves its digest cmdlet however it was launched", () => {
  it("reaches the digest gate under Windows PowerShell's own module path", () => {
    const { output, status } = runAuthenticator(WINDOWS_POWERSHELL_MODULES);

    // THE CONTROL. If this ever stops refusing NODE_DIGEST_MISMATCH the fixture has drifted and
    // arm B below proves nothing, so it asserts the exact code rather than merely "refused".
    expect(output).toContain("WINDOWS_RELEASE_NODE_DIGEST_MISMATCH@WINDOWS_RELEASE_AUTHORITY");
    expect(status).toBe(1);
  });

  it("reaches the same digest gate when a pwsh 7 module path is inherited", () => {
    const pwshModules = pwshModuleDirectory();
    // NON-VACUITY: without the pwsh module directory this arm cannot construct the hostile
    // condition, and silently passing would be worse than not running.
    expect(pwshModules).not.toBeNull();
    const { output, status } = runAuthenticator(`${pwshModules};${WINDOWS_POWERSHELL_MODULES}`);

    expect(output).toContain("WINDOWS_RELEASE_NODE_DIGEST_MISMATCH@WINDOWS_RELEASE_AUTHORITY");
    // AND the toolchain failure must not be restamped as caller input: that restamp is the
    // defect, and asserting only the positive above would still pass while it happened.
    expect(output).not.toContain("WINDOWS_RELEASE_INPUT_INVALID");
    expect(status).toBe(1);
  });
});

describe("authenticate-node.ps1 names the gate that actually failed", () => {
  /**
   * LEG 2's whole point is that two DISTINGUISHABLE causes must not share a code, so every arm
   * here asserts the expected code AND the absence of the other one. A positive-only assertion
   * cannot detect aliasing — it passes just as happily when both causes emit the same string.
   */
  it("reports a host that cannot supply the toolchain as a toolchain outage", () => {
    // A cache with no node.exe: Get-Item raises ItemNotFoundException, a HOST failure.
    const empty = mkdtempSync(join(tmpdir(), "moe-authenticate-node-empty-"));
    const { output, status } = runAuthenticatorWith(WINDOWS_POWERSHELL_MODULES, empty, "X64");

    expect(output).toContain("WINDOWS_RELEASE_TOOLCHAIN_UNAVAILABLE@WINDOWS_RELEASE_AUTHORITY");
    expect(output).not.toContain("WINDOWS_RELEASE_INPUT_INVALID");
    expect(status).toBe(1);
  });

  it("reports a caller-supplied architecture as input, not as a toolchain outage", () => {
    const { output, status } = runAuthenticatorWith(
      WINDOWS_POWERSHELL_MODULES, stageToolCache(), "MIPS",
    );

    expect(output).toContain("WINDOWS_RELEASE_INPUT_INVALID@WINDOWS_RELEASE_AUTHORITY");
    expect(output).not.toContain("WINDOWS_RELEASE_TOOLCHAIN_UNAVAILABLE");
    expect(status).toBe(1);
  });

  it("keeps the refusal opaque: no path, parser or exception detail reaches the output", () => {
    const empty = mkdtempSync(join(tmpdir(), "moe-authenticate-node-opaque-"));
    const { output } = runAuthenticatorWith(WINDOWS_POWERSHELL_MODULES, empty, "X64");

    // The :44 boundary promise. The CODE changed in this row; the message SHAPE did not.
    expect(output.trim()).toBe(
      "::error title=windows-release::WINDOWS_RELEASE_TOOLCHAIN_UNAVAILABLE@WINDOWS_RELEASE_AUTHORITY",
    );
    expect(output).not.toContain(empty);
    expect(output).not.toContain("Exception");
  });
});
