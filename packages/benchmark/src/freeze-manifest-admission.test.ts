import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", { spy: true });

import {
  CONFIRMATORY_FREEZE_MANIFEST_ADMISSION_CODES, admitConfirmatoryFreezeManifest,
  deriveConfirmatoryFreezeCampaignId, deriveConfirmatoryFreezeManifestRegistryRef,
  CONFIRMATORY_FREEZE_BINDING_KINDS, FREEZE_MANIFEST_SCHEMA_VERSION,
  canonicalizeConfirmatoryFreezeManifest, type ConfirmatoryFreezeManifest,
  PINNED_BENCHMARK_SPEC_SHA256, PINNED_REBUILD_DESIGN_SHA256,
  PINNED_DOCUMENT_ROOT_ENV, PRE_FREEZE_AUDIT_LAYER, isPinnedCorpusAuthority,
  readPinnedCorpusAuthority,
} from "./index.js";

const SHA = "d".repeat(64);
const FIXED_TIME = "2026-08-24T10:00:00.000Z";
const SEALED_TIME = "2026-08-24T10:00:01.000Z";
let childBuildRoot = "";
let ownedModule = "";

beforeAll(() => {
  childBuildRoot = mkdtempSync(join(tmpdir(), "moe-freeze-build-"));
  const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
  const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [
    tsc, "-p", join(import.meta.dirname, "..", "tsconfig.json"),
    "--noEmit", "false", "--composite", "false", "--declaration", "false",
    "--declarationMap", "false", "--outDir", childBuildRoot,
  ], { cwd: repositoryRoot, windowsHide: true });
  ownedModule = join(childBuildRoot, "freeze-manifest-admission.js");
});

afterAll(() => rmSync(childBuildRoot, { recursive: true, force: true }));

const runGit = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true });

const makeRepository = (): { readonly path: string; readonly head: string } => {
  const path = mkdtempSync(join(tmpdir(), "moe-freeze-admission-"));
  runGit(path, ["init", "--quiet"]);
  runGit(path, ["config", "user.email", "freeze-test@example.invalid"]);
  runGit(path, ["config", "user.name", "Freeze Test"]);
  writeFileSync(join(path, "README.md"), "clean\n", "utf8");
  runGit(path, ["add", "README.md"]);
  runGit(path, ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture"]);
  return { path, head: runGit(path, ["rev-parse", "HEAD"]).trim() };
};

const buildManifest = (
  implementationSha: string,
  changes: Partial<ConfirmatoryFreezeManifest> = {},
): ConfirmatoryFreezeManifest => {
  const campaignLabel = changes.campaignLabel ?? "confirmatory-r4";
  const campaignId = deriveConfirmatoryFreezeCampaignId({
    schemaVersion: FREEZE_MANIFEST_SCHEMA_VERSION,
    campaignLabel,
    implementationSha,
    designSha256: PINNED_REBUILD_DESIGN_SHA256,
    benchmarkSha256: PINNED_BENCHMARK_SPEC_SHA256,
  });
  const bindings = CONFIRMATORY_FREEZE_BINDING_KINDS.map((kind) => ({
    kind,
    sha256: kind === "DESIGN" ? PINNED_REBUILD_DESIGN_SHA256
      : kind === "BENCHMARK" ? PINNED_BENCHMARK_SPEC_SHA256 : SHA,
  }));
  return {
    schemaVersion: FREEZE_MANIFEST_SCHEMA_VERSION,
    projectId: "moe-next",
    campaignLabel,
    campaignId,
    implementationSha,
    implementationFrozenAt: FIXED_TIME,
    sealedAt: SEALED_TIME,
    manifestRegistryRef: deriveConfirmatoryFreezeManifestRegistryRef(campaignId),
    attestation: { status: "UNATTESTED", signerKeyId: null, publicRegistryReference: null },
    bindings,
    ...changes,
  };
};

const manifestBytes = (manifest: ConfirmatoryFreezeManifest): Uint8Array =>
  new TextEncoder().encode(canonicalizeConfirmatoryFreezeManifest(manifest));

const childAdmission = (cwd: string, bytes: Uint8Array, env?: NodeJS.ProcessEnv) => {
  const script = `
    const { admitConfirmatoryFreezeManifest } = await import(process.argv[1]);
    const result = admitConfirmatoryFreezeManifest(Buffer.from(process.argv[2], "base64"));
    process.stdout.write(JSON.stringify(result));
  `;
  const output = execFileSync(process.execPath, [
    "--input-type=module", "--eval", script, pathToFileURL(ownedModule).href,
    Buffer.from(bytes).toString("base64"),
  ], { cwd, encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
  return JSON.parse(output) as Record<string, unknown>;
};

const refusalOf = (input: unknown) => {
  const result = admitConfirmatoryFreezeManifest(input);
  if (result.ok) throw new Error("expected an admission refusal");
  return result;
};

/**
 * CORPUS CALLS SHARE THIS BOUNDARY (task-e1b479134f6c4c2282bd7b13af693460). The pinned
 * reader now observes its OWN repository's authority through `git -C <corpusRoot> ...`,
 * and those calls land inside the window between admission's two horizon observations. A
 * flat `mockImplementationOnce` queue would hand them the responses meant for the horizon,
 * so an arm about a MOVED horizon would quietly become an arm about an exhausted mock.
 *
 * Corpus calls are the ones carrying `-C`. They are answered with a fixed clean authority
 * so they cannot perturb the arm, and the queue serves only the implementation-repository
 * horizon each arm is actually about. `horizonCalls` counts the same way, so a call-count
 * assertion still means what it meant before the corpus observed anything.
 */
const CORPUS_STAND_IN_HEAD = "c".repeat(40);

const horizonSequence = (...responses: readonly Buffer[]): void => {
  const gitMock = vi.mocked(execFileSync);
  gitMock.mockClear();
  let index = 0;
  gitMock.mockImplementation(((_file: string, args: readonly string[]) => {
    if (args[0] === "-C") {
      return args.includes("rev-parse")
        ? Buffer.from(`${CORPUS_STAND_IN_HEAD}\n`)
        : Buffer.alloc(0);
    }
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response;
  }) as never);
};

const horizonCalls = (): number => vi.mocked(execFileSync).mock.calls
  .filter((call) => (call[1] as readonly string[] | undefined)?.[0] !== "-C").length;

const cleanHorizon = (head: string, pairs: number): Buffer[] =>
  Array.from({ length: pairs }, () => [Buffer.from(`${head}\n`), Buffer.alloc(0)]).flat();

/**
 * `mockReset` before `restoreAllMocks`, and both matter. Several arms queue `mockImplementationOnce`
 * sequences for the Git boundary. If one of those arms fails BEFORE consuming its queue, the
 * leftovers are handed to the next arm's very first Git call — `makeRepository` then dies with
 * "fatal: not in a git directory" and a mutation drill's red lands on an innocent neighbour.
 * Resetting the queue keeps a red attributable to the arm that actually owns it.
 */
afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.restoreAllMocks();
});

/**
 * CORPUS GATE (task-e1b479134f6c4c2282bd7b13af693460). The pinned corpus is now
 * mandatory-explicit - MOE_PINNED_DOCUMENT_ROOT or a refusal - so the real-byte arms in
 * this file cannot run on a host that has not been pointed at one. They are GATED, never
 * deleted and never re-based on synthetic bytes, and the gate is never silent: the arm
 * below always executes and names the exact code that closed them, so "corpus absent" can
 * never be misread as "these arms passed".
 */
const CORPUS = readPinnedCorpusAuthority();
const itWithCorpus = it.skipIf(!isPinnedCorpusAuthority(CORPUS));

describe("pinned corpus gate (task-e1b479134f6c4c2282bd7b13af693460)", () => {
  it("names the exact refusal gating the real-byte arms, rather than skipping silently", () => {
    if (isPinnedCorpusAuthority(CORPUS)) {
      expect(CORPUS.head).toMatch(/^[a-f0-9]{40}$/);
      expect(CORPUS.status).toBe("");
      return;
    }
    expect(CORPUS.layer).toBe(PRE_FREEZE_AUDIT_LAYER);
    if (!process.env[PINNED_DOCUMENT_ROOT_ENV]?.trim()) {
      expect(CORPUS.code).toBe("CORPUS_ROOT_UNSET");
    } else {
      expect(CORPUS.code).toMatch(/^CORPUS_ROOT_(UNREADABLE|UNVERSIONED|DIRTY|MOVED)$/);
    }
  });
});

describe("confirmatory freeze manifest admission refusal vocabulary", () => {
  itWithCorpus("admits a clean hash-bound campaign as frozen UNATTESTED truth", () => {
    const head = "a".repeat(40);
    horizonSequence(...cleanHorizon(head, 4));
    const input = buildManifest(head);
    const encoded = manifestBytes(input);
    const canonical = new TextDecoder().decode(encoded);
    const first = admitConfirmatoryFreezeManifest(encoded);
    if (!first.ok) throw new Error(`${first.code}/${first.sourceCode}`);
    expect(first.manifest).toEqual(input);
    expect(first.manifestSha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(first.custody).toEqual({ status: "UNATTESTED", attestedCustody: "UNKNOWN" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.manifest)).toBe(true);
    expect(Object.isFrozen(first.manifest.attestation)).toBe(true);
    expect(Object.isFrozen(first.manifest.bindings)).toBe(true);
    expect(Object.isFrozen(first.manifest.bindings[0])).toBe(true);
    expect(Date.parse(first.manifest.sealedAt)).toBeGreaterThan(
      Date.parse(first.manifest.implementationFrozenAt),
    );
    expect(first.manifest.attestation.signerKeyId).toBeNull();
    expect(first.manifest.attestation.publicRegistryReference).toBeNull();
    expect(JSON.stringify(first)).not.toContain('"status":"ATTESTED"');
    expect(JSON.stringify(first)).not.toContain("signature");

    encoded.fill(0);
    const stableHash = first.manifestSha256;
    const stableManifest = JSON.stringify(first.manifest);
    const second = admitConfirmatoryFreezeManifest(manifestBytes(input));
    if (!second.ok) throw new Error(`${second.code}/${second.sourceCode}`);
    expect(second.manifestSha256).toBe(stableHash);
    expect(JSON.stringify(second.manifest)).toBe(stableManifest);
    expect(first.manifestSha256).toBe(stableHash);
    expect(JSON.stringify(first.manifest)).toBe(stableManifest);
    expect(horizonCalls()).toBe(8);
  });

  itWithCorpus("derives stable identity and makes a changed implementation a new campaign", () => {
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    const a1 = buildManifest(headA);
    const a2 = buildManifest(headA);
    const b = buildManifest(headB);
    expect(a2.campaignId).toBe(a1.campaignId);
    expect(a2.manifestRegistryRef).toBe(a1.manifestRegistryRef);
    expect(b.campaignId).not.toBe(a1.campaignId);
    expect(b.manifestRegistryRef).not.toBe(a1.manifestRegistryRef);

    const retained = { ...b, campaignId: a1.campaignId, manifestRegistryRef: a1.manifestRegistryRef };
    horizonSequence(...cleanHorizon(headB, 4));
    const refusal = refusalOf(manifestBytes(retained));
    expect(refusal.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_REGISTRY_MISMATCH");
    expect(refusal.sourceCode).toBe("CONFIRMATORY_FREEZE_REGISTRY_MISMATCH");
    const admitted = admitConfirmatoryFreezeManifest(manifestBytes(b));
    expect(admitted.ok).toBe(true);
    expect(horizonCalls()).toBe(8);
  });

  itWithCorpus("produces nine and only nine reachable wrapper codes with exact source attribution", () => {
    const repository = makeRepository();
    try {
      const base = buildManifest(repository.head);
      const conflicting = { ...base, bindings: base.bindings.map((binding, index) =>
        index === 1 ? { kind: "DESIGN" as const, sha256: SHA } : binding) };
      const registryMismatch = { ...base, manifestRegistryRef: `sha256:${"e".repeat(64)}` };
      const foreign = { ...base, projectId: "foreign-project" };
      const wrongImplementation = buildManifest("e".repeat(40));
      const foreignResult = childAdmission(repository.path, manifestBytes(foreign));
      const registryResult = childAdmission(repository.path, manifestBytes(registryMismatch));
      const implementationResult = childAdmission(repository.path, manifestBytes(wrongImplementation));
      writeFileSync(join(repository.path, "README.md"), "dirty\n", "utf8");
      const dirtyResult = childAdmission(repository.path, manifestBytes(base));
      runGit(repository.path, ["checkout", "--", "README.md"]);

      const contractCases = [
        refusalOf(undefined),
        refusalOf(new TextEncoder().encode("{")),
        refusalOf(manifestBytes({ ...base, schemaVersion: "moe-confirmatory-freeze-manifest/2" as never })),
        refusalOf(manifestBytes(conflicting)),
      ];
      const headA = repository.head;
      const headB = "f".repeat(40);
      horizonSequence(Buffer.from(`${headA}\n`), Buffer.alloc(0),
        Buffer.from(`${headB}\n`), Buffer.alloc(0));
      const moved = refusalOf(manifestBytes(base));
      expect(horizonCalls()).toBe(4);

      const cases = [
        ...contractCases,
        foreignResult,
        dirtyResult,
        registryResult,
        moved,
        implementationResult,
      ] as const;
      const expected = [
        ["CONFIRMATORY_FREEZE_MANIFEST_MISSING", "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT"],
        ["CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT"],
        ["CONFIRMATORY_FREEZE_MANIFEST_STALE", "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT"],
        ["CONFIRMATORY_FREEZE_MANIFEST_CONFLICTING", "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT"],
        ["CONFIRMATORY_FREEZE_PROJECT_FOREIGN", "CONFIRMATORY_FREEZE_MANIFEST_IDENTITY"],
        ["CONFIRMATORY_FREEZE_GIT_DIRTY", "CONFIRMATORY_FREEZE_GIT"],
        ["CONFIRMATORY_FREEZE_REGISTRY_MISMATCH", "CONFIRMATORY_FREEZE_MANIFEST_IDENTITY"],
        ["CONFIRMATORY_FREEZE_GIT_HORIZON_MOVED", "CONFIRMATORY_FREEZE_GIT"],
        ["CONFIRMATORY_FREEZE_GIT_IMPLEMENTATION_MISMATCH", "CONFIRMATORY_FREEZE_GIT"],
      ] as const;
      let generatedCases = 0;
      cases.forEach((result, index) => {
        expect(result.ok).toBe(false);
        expect(result.code).toBe(CONFIRMATORY_FREEZE_MANIFEST_ADMISSION_CODES[index]);
        expect(result.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_ADMISSION");
        expect([result.sourceCode, result.sourceLayer]).toEqual(expected[index]);
        generatedCases += 1;
      });
      expect(generatedCases).toBe(9);
      expect(generatedCases).toBe(CONFIRMATORY_FREEZE_MANIFEST_ADMISSION_CODES.length);
      expect(generatedCases).toBeGreaterThan(0);
    } finally {
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  /**
   * A1 names the hash-committed binding as the SOLE integrity mechanism, so each half of
   * `bindingRefusal`'s conjunction needs its own arm. One wrong VALUE under a correct KIND is the
   * only shape that reaches it: planting a second DESIGN entry makes the decoder refuse
   * CONFLICTING first, and a wrong campaign id is answered by `campaignRefusal` instead. Both
   * halves are covered because a mutant that drops either one still satisfies the other's arm.
   */
  itWithCorpus("attributes one wrong binding value per half to the binding layer, not the campaign layer", () => {
    const repository = makeRepository();
    try {
      const base = buildManifest(repository.head);
      const wrongValue = "c".repeat(64);
      const rebind = (target: string) => ({
        ...base,
        bindings: base.bindings.map((binding) => (
          binding.kind === target ? { ...binding, sha256: wrongValue } : binding)),
      });
      const wrongDesign = rebind("DESIGN");
      const wrongBenchmark = rebind("BENCHMARK");

      // Each still satisfies the exact-kind roster, so neither can be refused as CONFLICTING.
      const roster = [...CONFIRMATORY_FREEZE_BINDING_KINDS];
      expect(wrongDesign.bindings.map(({ kind }) => kind)).toEqual(roster);
      expect(wrongBenchmark.bindings.map(({ kind }) => kind)).toEqual(roster);
      expect(wrongDesign.campaignId).toBe(base.campaignId);
      expect(wrongBenchmark.manifestRegistryRef).toBe(base.manifestRegistryRef);

      const halves = [
        { half: "DESIGN", result: childAdmission(repository.path, manifestBytes(wrongDesign)) },
        { half: "BENCHMARK", result: childAdmission(repository.path, manifestBytes(wrongBenchmark)) },
      ] as const;
      let generatedCases = 0;
      halves.forEach(({ half, result }) => {
        // The half is carried into the assertion so a failure names which one of the
        // conjunction's two comparisons stopped refusing.
        expect({
          half,
          ok: result.ok,
          code: result.code,
          layer: result.layer,
          sourceCode: result.sourceCode,
          sourceLayer: result.sourceLayer,
        }).toEqual({
          half,
          ok: false,
          code: "CONFIRMATORY_FREEZE_MANIFEST_REGISTRY_MISMATCH",
          layer: "CONFIRMATORY_FREEZE_MANIFEST_ADMISSION",
          sourceCode: "CONFIRMATORY_FREEZE_BINDING_MISMATCH",
          sourceLayer: "CONFIRMATORY_FREEZE_MANIFEST_BINDINGS",
        });
        generatedCases += 1;
      });
      expect(generatedCases).toBe(2);
      expect(generatedCases).toBeGreaterThan(0);

      // The SAME wrapper code carries a second, distinct attribution. Pin both, or the wrapper
      // code alone cannot say which layer refused.
      const campaign = childAdmission(repository.path, manifestBytes({
        ...base, manifestRegistryRef: `sha256:${"e".repeat(64)}`,
      }));
      expect(campaign.code).toBe(halves[0].result.code);
      expect(campaign.sourceCode).toBe("CONFIRMATORY_FREEZE_REGISTRY_MISMATCH");
      expect(campaign.sourceLayer).toBe("CONFIRMATORY_FREEZE_MANIFEST_IDENTITY");
      expect(campaign.sourceCode).not.toBe(halves[0].result.sourceCode);
      expect(campaign.sourceLayer).not.toBe(halves[0].result.sourceLayer);
    } finally {
      rmSync(repository.path, { recursive: true, force: true });
    }
  });

  it("fails closed when Git cannot execute or decode its horizon", () => {
    const repository = makeRepository();
    const nonRepository = mkdtempSync(join(tmpdir(), "moe-not-git-"));
    try {
      const result = childAdmission(nonRepository, manifestBytes(buildManifest(repository.head)));
      expect(result.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED");
      expect(result.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_ADMISSION");
      expect(result.sourceCode).toBe("CONFIRMATORY_FREEZE_GIT_UNREADABLE");
      expect(result.sourceLayer).toBe("CONFIRMATORY_FREEZE_GIT");
    } finally {
      rmSync(repository.path, { recursive: true, force: true });
      rmSync(nonRepository, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * The queued sequence counts Git calls, so it is only exact while the CORPUS makes none.
   * With a root configured the pinned reader observes corpus authority — its own Git calls,
   * against a different repository — and would eat this arm's queue, turning a horizon
   * assertion into an unrelated MALFORMED. Pinning the corpus to unset keeps this arm about
   * the implementation repository's horizon on every host, configured or not.
   */
  it("detects a status-only horizon movement from a nonempty staged sequence", () => {
    const savedRoot = process.env[PINNED_DOCUMENT_ROOT_ENV];
    delete process.env[PINNED_DOCUMENT_ROOT_ENV];
    const head = "a".repeat(40);
    horizonSequence(Buffer.from(`${head}\n`), Buffer.alloc(0),
      Buffer.from(`${head}\n`),
      Buffer.from("1 .M N... README.md\0"));
    const refusal = refusalOf(manifestBytes(buildManifest(head)));
    expect(refusal.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_HORIZON_MOVED");
    expect(refusal.sourceCode).toBe("CONFIRMATORY_FREEZE_GIT_HORIZON_MOVED");
    expect(refusal.sourceLayer).toBe("CONFIRMATORY_FREEZE_GIT");
    expect(horizonCalls()).toBe(4);
    if (savedRoot !== undefined) process.env[PINNED_DOCUMENT_ROOT_ENV] = savedRoot;
  });

  // Two real Git repositories plus a child Node read measured 10.75s with signing disabled.
  // Bound this integration arm separately from the pure admission checks.
  it("attributes independently re-read pinned-document drift to its source reader", { timeout: 30_000 }, () => {
    const repository = makeRepository();
    const root = mkdtempSync(join(tmpdir(), "moe-pins-"));
    try {
      const plans = join(root, "docs", "plans");
      mkdirSync(plans, { recursive: true });
      writeFileSync(join(plans, "2026-08-05-moe-rebuild-design.md"), "tampered", "utf8");
      writeFileSync(join(plans, "2026-08-05-moe-best-tool-benchmark-spec.md"), "tampered", "utf8");
      // A COMMITTED corpus, so the only thing wrong with it is the bytes. Left untracked,
      // the corpus fence would answer CORPUS_ROOT_UNVERSIONED first and this arm would
      // silently stop testing the source reader it is named for.
      runGit(root, ["init", "--quiet"]);
      runGit(root, ["config", "user.email", "freeze-test@example.invalid"]);
      runGit(root, ["config", "user.name", "Freeze Test"]);
      runGit(root, ["add", "--all"]);
      runGit(root, ["commit", "--quiet", "--no-gpg-sign", "-m", "tampered corpus fixture"]);
      const result = childAdmission(repository.path, manifestBytes(buildManifest(repository.head)), {
        MOE_PINNED_DOCUMENT_ROOT: root,
      });
      expect(result.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_REGISTRY_MISMATCH");
      expect(result.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_ADMISSION");
      expect(result.sourceCode).toBe("SPEC_BYTES_UNPINNED");
      expect(result.sourceLayer).toBe("PRE_FREEZE_AUDIT");
    } finally {
      rmSync(repository.path, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
