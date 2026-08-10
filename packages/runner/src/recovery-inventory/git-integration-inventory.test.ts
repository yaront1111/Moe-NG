/**
 * Behaviour contract for the GIT_INTEGRATION_ON_DISK recovery-inventory adapter.
 *
 * The repositories are real: every happy-path arm runs `git` against an `mkdtemp`
 * directory under the OS temp root through the SAME bounded mechanism the shipped
 * observer uses (`shell: false`, bounded `maxBuffer`, `timeout`, `windowsHide`),
 * and the enumeration itself goes through `createNodeGitObserver`. No ref grammar,
 * digest or path normalizer is reimplemented here.
 *
 * The hostile arms drive injected `GitObserver` stubs, which is what that port
 * exists for: real git cannot be made to emit a truncated record or 4097 branches
 * on demand. Every refusal is asserted END TO END through the shipped
 * `collectRecoveryInventory`, which is the only surface that mints coverage codes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectRecoveryInventory,
  createRecoveryInventoryRegistry,
  isRecoveryInventoryFailure,
} from "@moe/runner";
import type {
  RecoveryInventoryCoverageProof,
  RecoveryInventoryReport,
  RecoveryInventoryUnknownReason,
} from "@moe/runner";

import { ScopeObserverError, type GitObserver, type GitRefListing } from "../scope/scope-contract.js";
import {
  MAX_SCOPE_OBSERVATION_BYTES,
  createNodeGitObserver,
  hermeticGitEnvironment,
} from "../scope/scope-git.js";
import {
  enumerateGitIntegrationInventory,
  gitIntegrationInventoryRegistration,
  type GitIntegrationInventoryInput,
} from "./git-integration-inventory.js";
import { identityKey, readIdentity } from "./recovery-inventory-shape.js";

const CLASS = "GIT_INTEGRATION_ON_DISK";
const LAYER = "INVENTORY_ADAPTER";
const UNKNOWN_CODE = "RECOVERY_INVENTORY_COVERAGE_UNKNOWN";
const PROJECT = "moe-next";
const OBSERVED_AT = "2026-08-05T12:00:00.000Z";
const OUTSIDE_WINDOW = "2026-07-01T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const REF_DIGEST = "c".repeat(64);
const FAKE_COMMIT = "9".repeat(40);

/** Counts coverage cases actually generated: a sweep producing nothing must fail. */
const GENERATED: string[] = [];

const ENV = hermeticGitEnvironment(process.env);

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "moe-recovery-git-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Argument vector only — no shell, no free-form command string, every child bounded. */
function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd,
    env: ENV,
    maxBuffer: MAX_SCOPE_OBSERVATION_BYTES,
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 30_000,
    windowsHide: true,
  });
}

function directory(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function initRepository(name: string): string {
  const repository = directory(name);
  git(repository, ["init"]);
  return repository;
}

/**
 * Three branches whose codepoint order (Z < a < b) differs from every locale
 * collation, plus a real gitlink: `update-index --cacheinfo 160000` is exactly
 * what `submodulePaths()` reads, so the integration target is genuine.
 */
function populatedRepository(): string {
  const repository = initRepository("repo");
  git(repository, ["checkout", "-b", "base"]);
  writeFileSync(join(repository, "tracked.txt"), "tracked");
  git(repository, ["add", "--", "tracked.txt"]);
  git(repository, [
    "-c", "user.name=Moe", "-c", "user.email=moe@example.invalid",
    "commit", "-m", "base",
  ]);
  git(repository, ["branch", "Zeta"]);
  git(repository, ["branch", "alpha"]);
  git(repository, ["update-index", "--add", "--cacheinfo", `160000,${FAKE_COMMIT},vendor/lib`]);
  return repository;
}

function listingOf(refs: readonly { refName: string; targetCommit: string }[]): GitRefListing {
  return { refs, refCount: refs.length, observationDigest: REF_DIGEST };
}

interface StubShape {
  readonly listRefs?: () => GitRefListing;
  readonly submodulePaths?: () => readonly string[];
  readonly headCommit?: () => string;
}

/** A caller-supplied observer, exactly as the injectable port allows. */
function stubObserver(shape: StubShape): GitObserver {
  return {
    headCommit: shape.headCommit ?? ((): string => FAKE_COMMIT),
    statusPorcelainV2: (): Uint8Array => new Uint8Array(),
    lsFilesTracked: (): readonly string[] => [],
    lsFilesIgnored: (): readonly string[] => [],
    submodulePaths: shape.submodulePaths ?? ((): readonly string[] => []),
    listRefs: shape.listRefs ?? ((): GitRefListing => listingOf([])),
  };
}

/** The optional method really is absent: the key is never introduced at all. */
function observerWithoutListRefs(): GitObserver {
  return {
    headCommit: (): string => FAKE_COMMIT,
    statusPorcelainV2: (): Uint8Array => new Uint8Array(),
    lsFilesTracked: (): readonly string[] => [],
    lsFilesIgnored: (): readonly string[] => [],
    submodulePaths: (): readonly string[] => [],
  };
}

function inputFor(observer: GitObserver, observedAt: string = OBSERVED_AT): GitIntegrationInventoryInput {
  return { observer, clock: { observedAt: () => observedAt } };
}

const CONTEXT = {
  class: CLASS,
  projectTag: PROJECT,
  backup: { kind: "BACKUP_CURSOR_GENERATION", ref: "gen-42", digest: DIGEST_A },
  incarnation: { kind: "RECOVERY_INCARNATION", ref: "inc-7", digest: DIGEST_B },
  window: { startInclusive: "2026-08-01T00:00:00Z", endInclusive: "2026-08-09T23:59:59Z" },
} as const;

function request(classes: readonly string[] = [CLASS]): Record<string, unknown> {
  return {
    projectTag: PROJECT,
    backup: { ...CONTEXT.backup },
    incarnation: { ...CONTEXT.incarnation },
    window: { ...CONTEXT.window },
    configuredClasses: [...classes],
  };
}

async function collect(input: GitIntegrationInventoryInput): Promise<RecoveryInventoryReport> {
  const registry = createRecoveryInventoryRegistry([gitIntegrationInventoryRegistration(input)]);
  const result = await collectRecoveryInventory(request(), registry);
  if (isRecoveryInventoryFailure(result)) {
    throw new Error(`expected a report, got refusal ${result.code}`);
  }
  return result;
}

function proofFor(report: RecoveryInventoryReport): RecoveryInventoryCoverageProof {
  const proof = report.proofs.find((candidate) => candidate.class === CLASS);
  if (proof === undefined) {
    throw new Error(`configured class ${CLASS} vanished from the report`);
  }
  GENERATED.push(CLASS);
  return proof;
}

function summary(proof: RecoveryInventoryCoverageProof): Record<string, unknown> {
  return { truth: proof.truth, code: proof.code, reason: proof.reason, layer: proof.layer };
}

const COMPLETE_PROOF = { truth: "COMPLETE", code: null, reason: null, layer: LAYER };

function expectUnknown(report: RecoveryInventoryReport, reason: RecoveryInventoryUnknownReason): void {
  expect(summary(proofFor(report))).toEqual({ truth: "UNKNOWN", code: UNKNOWN_CODE, reason, layer: LAYER });
  expect(report.coverage).toBe("UNKNOWN");
  expect(report.items).toHaveLength(0);
}

function identities(report: RecoveryInventoryReport): readonly string[] {
  return report.items.map((item) => identityKey(item.identity));
}

function factsOf(report: RecoveryInventoryReport, path: string): Record<string, unknown> {
  const found = report.items.find(
    (candidate) => candidate.identity.kind === "PATH" && candidate.identity.path === path,
  );
  if (found === undefined) {
    throw new Error(`no inventory item for external identity ${path}`);
  }
  return { ...found.facts };
}

describe("enumeration over a real repository", () => {
  it("binds every ref and on-disk integration target to the class, an identity and a proof", async () => {
    const report = await collect(inputFor(createNodeGitObserver(populatedRepository(), ENV)));
    expect(summary(proofFor(report))).toEqual(COMPLETE_PROOF);
    expect(report.coverage).toBe("COMPLETE");
    expect(report.items).toHaveLength(4);
    for (const item of report.items) {
      expect(item.class).toBe(CLASS);
      // An item can never belong to another project: the tag is stamped from the
      // request basis, so a foreign row cannot be smuggled into this report.
      expect(item.projectTag).toBe(PROJECT);
      expect(item.observedAt).toBe(OBSERVED_AT);
      expect(item.sourceProofDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(identities(report)).toEqual([
      "PATH refs/heads/Zeta",
      "PATH refs/heads/alpha",
      "PATH refs/heads/base",
      "PATH vendor/lib",
    ]);
    const alpha = factsOf(report, "refs/heads/alpha");
    expect(alpha).toEqual({
      target: "REF",
      refScope: "LOCAL",
      targetCommit: alpha["targetCommit"],
      headObserved: true,
      atHead: true,
    });
    expect(String(alpha["targetCommit"])).toMatch(/^[0-9a-f]{40}$/u);
    expect(factsOf(report, "vendor/lib")).toEqual({
      target: "SUBMODULE",
      declaredPath: "vendor/lib",
    });
  });

  it("proves an observed repository with no refs at all rather than staying silent", async () => {
    const report = await collect(inputFor(createNodeGitObserver(initRepository("empty"), ENV)));
    const proof = proofFor(report);
    expect(summary(proof)).toEqual(COMPLETE_PROOF);
    expect(proof.itemCount).toBe(0);
    // The digest IS the negative proof: "observed, nothing there" is a fact.
    expect(proof.negativeProofDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.coverage).toBe("COMPLETE");
  });
});

/**
 * The heart of the task: three different facts, three different answers. If any
 * two of these collapse, "we looked and found nothing" later reads the same as
 * "we could not look".
 */
describe("empty, absent and unreadable are three different answers", () => {
  it("answers ENUMERATOR_UNAVAILABLE for a path that holds no repository", async () => {
    const report = await collect(inputFor(createNodeGitObserver(directory("not-a-repo"), ENV)));
    expectUnknown(report, "ENUMERATOR_UNAVAILABLE");
    const reading = enumerateGitIntegrationInventory(
      inputFor(createNodeGitObserver(join(root, "not-a-repo"), ENV)),
      CONTEXT,
    );
    // classifyRefFailure attributes every for-each-ref fault to GIT_OBSERVER, so
    // an absent repository names the boundary that answered as well as the code.
    expect(reading.refusal).toEqual({ code: "RUNNER_SCOPE_OBSERVATION_FAILED", layer: "GIT_OBSERVER" });
  });

  it("answers RESULT_TRUNCATED for a record the observer could not read", async () => {
    const observer = stubObserver({
      listRefs: (): GitRefListing => {
        throw new ScopeObserverError("RUNNER_SCOPE_STATUS_MALFORMED", "unreadable record", "GIT_OBSERVER");
      },
    });
    expectUnknown(await collect(inputFor(observer)), "RESULT_TRUNCATED");
    expect(enumerateGitIntegrationInventory(inputFor(observer), CONTEXT).refusal).toEqual({
      code: "RUNNER_SCOPE_STATUS_MALFORMED",
      layer: "GIT_OBSERVER",
    });
  });

  it("keeps the three answers distinct rather than sharing one code", async () => {
    const empty = proofFor(await collect(inputFor(createNodeGitObserver(initRepository("three-empty"), ENV))));
    const absent = proofFor(await collect(inputFor(createNodeGitObserver(directory("three-absent"), ENV))));
    const unreadable = proofFor(
      await collect(
        inputFor(
          stubObserver({
            listRefs: (): GitRefListing => {
              throw new ScopeObserverError("RUNNER_SCOPE_STATUS_MALFORMED", "unreadable", "GIT_OBSERVER");
            },
          }),
        ),
      ),
    );
    const answers = [empty, absent, unreadable].map((proof) => `${proof.truth}/${String(proof.reason)}`);
    expect(answers).toEqual([
      "COMPLETE/null",
      "UNKNOWN/ENUMERATOR_UNAVAILABLE",
      "UNKNOWN/RESULT_TRUNCATED",
    ]);
    expect(new Set(answers).size).toBe(3);
  });

  it("truncates on a bounded-observation overflow, naming the overflow itself", async () => {
    const observer = stubObserver({
      listRefs: (): GitRefListing => {
        throw new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_OVERFLOW", "over 8MiB");
      },
    });
    expectUnknown(await collect(inputFor(observer)), "RESULT_TRUNCATED");
    expect(enumerateGitIntegrationInventory(inputFor(observer), CONTEXT).refusal).toEqual({
      code: "RUNNER_SCOPE_OBSERVATION_OVERFLOW",
      layer: null,
    });
  });
});

describe("the optional ref capability", () => {
  it("answers ENUMERATOR_UNAVAILABLE when the observer does not implement listRefs", async () => {
    const observer = observerWithoutListRefs();
    expect(observer.listRefs).toBeUndefined();
    expectUnknown(await collect(inputFor(observer)), "ENUMERATOR_UNAVAILABLE");
    // No observer error happened at all, which is what separates a missing
    // capability from a repository that answered with a failure.
    expect(enumerateGitIntegrationInventory(inputFor(observer), CONTEXT).refusal).toBeNull();
  });

  it("records an unborn HEAD as an observed fact instead of an unreadable repository", async () => {
    const repository = initRepository("unborn");
    git(repository, ["checkout", "-b", "solo"]);
    writeFileSync(join(repository, "a.txt"), "a");
    git(repository, ["add", "--", "a.txt"]);
    git(repository, [
      "-c", "user.name=Moe", "-c", "user.email=moe@example.invalid",
      "commit", "-m", "solo",
    ]);
    const observer = stubObserver({
      listRefs: (): GitRefListing => listingOf([{ refName: "refs/heads/solo", targetCommit: FAKE_COMMIT }]),
      headCommit: (): string => {
        throw new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_FAILED", "HEAD is unborn");
      },
    });
    const report = await collect(inputFor(observer));
    expect(summary(proofFor(report))).toEqual(COMPLETE_PROOF);
    expect(factsOf(report, "refs/heads/solo")).toEqual({
      target: "REF",
      refScope: "LOCAL",
      targetCommit: FAKE_COMMIT,
      headObserved: false,
      atHead: false,
    });
  });
});

describe("silence, ceilings and rejected rows", () => {
  it("refuses NEGATIVE_PROOF_MISSING for an empty answer nothing can verify", async () => {
    // The answer this module must never produce, pinned against the class so a
    // regression that drops the proof is named rather than merely failing.
    const registry = createRecoveryInventoryRegistry([
      {
        class: CLASS,
        enumerate: () => ({ status: "ENUMERATED", items: [], complete: true, negativeProofDigest: null }),
      },
    ]);
    const result = await collectRecoveryInventory(request(), registry);
    if (isRecoveryInventoryFailure(result)) {
      throw new Error(`expected a report, got refusal ${result.code}`);
    }
    expectUnknown(result, "NEGATIVE_PROOF_MISSING");
  });

  it("reports RESULT_OVER_LIMIT one ref above the ceiling", async () => {
    const refs = Array.from({ length: 4097 }, (_ignored, index) => ({
      refName: `refs/heads/b${index}`,
      targetCommit: FAKE_COMMIT,
    }));
    expect(refs).toHaveLength(4097);
    expectUnknown(await collect(inputFor(stubObserver({ listRefs: () => listingOf(refs) }))), "RESULT_OVER_LIMIT");
  });

  it("refuses an item observed outside the exact recovery window", async () => {
    const observer = createNodeGitObserver(populatedRepository(), ENV);
    const registry = createRecoveryInventoryRegistry([
      gitIntegrationInventoryRegistration(inputFor(observer, OUTSIDE_WINDOW)),
    ]);
    const result = await collectRecoveryInventory(request(), registry);
    if (isRecoveryInventoryFailure(result)) {
      throw new Error(`expected a report, got refusal ${result.code}`);
    }
    expect(summary(proofFor(result))).toEqual({
      truth: "UNKNOWN",
      code: "RECOVERY_INVENTORY_WINDOW_MISMATCH",
      reason: "ITEM_REJECTED",
      layer: LAYER,
    });
    expect(result.items).toHaveLength(0);
  });
});

describe("two spellings of one integration target", () => {
  const duplicated = (): GitObserver =>
    stubObserver({ submodulePaths: (): readonly string[] => ["vendor\\lib", "vendor/lib"] });

  it("emits both rows and lets the shipped reader fold them onto one key", () => {
    const reading = enumerateGitIntegrationInventory(inputFor(duplicated()), CONTEXT);
    if (reading.reading.status !== "ENUMERATED") {
      throw new Error(`expected an enumeration, got ${reading.reading.status}`);
    }
    expect(reading.reading.items).toHaveLength(2);
    const [first, second] = reading.reading.items as readonly { identity: unknown }[];
    const left = readIdentity(first?.identity);
    const right = readIdentity(second?.identity);
    if (left === null || right === null) {
      throw new Error("the enumerator emitted an identity the shipped reader rejects");
    }
    expect(identityKey(left)).toBe(identityKey(right));
  });

  it("refuses rather than merging or dropping one of them", async () => {
    const report = await collect(inputFor(duplicated()));
    expect(summary(proofFor(report))).toEqual({
      truth: "UNKNOWN",
      code: "RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE",
      reason: "ITEM_REJECTED",
      layer: LAYER,
    });
    expect(report.items).toHaveLength(0);
  });
});

/**
 * DoD 4. Asserted against the production enumerator's own output, not against the
 * aggregate's re-sort and not against a comparator reimplemented in this file.
 */
describe("deterministic order and digest", () => {
  const REFS = [
    { refName: "refs/heads/Zeta", targetCommit: FAKE_COMMIT },
    { refName: "refs/heads/alpha", targetCommit: FAKE_COMMIT },
    { refName: "refs/heads/base", targetCommit: FAKE_COMMIT },
  ];
  const SUBMODULES = ["Vendor/one", "assets\\two"];

  function orderOf(
    refs: readonly { refName: string; targetCommit: string }[],
    submodules: readonly string[],
  ): { readonly keys: readonly string[]; readonly proof: string | null } {
    const reading = enumerateGitIntegrationInventory(
      inputFor(stubObserver({ listRefs: () => listingOf(refs), submodulePaths: () => submodules })),
      CONTEXT,
    ).reading;
    if (reading.status !== "ENUMERATED") {
      throw new Error(`expected an enumeration, got ${reading.status}`);
    }
    const keys = reading.items.map((item) => {
      const identity = readIdentity((item as { identity: unknown }).identity);
      if (identity === null) throw new Error("the enumerator emitted an unreadable identity");
      return identityKey(identity);
    });
    return { keys, proof: reading.negativeProofDigest };
  }

  it("orders by code point, which no locale collation reproduces", () => {
    // en-US collation would order alpha < base < Zeta and assets < Vendor; code
    // points order Z(0x5A) < a(0x61) < b(0x62) and V(0x56) < a(0x61).
    expect(orderOf(REFS, SUBMODULES).keys).toEqual([
      "PATH Vendor/one",
      "PATH assets/two",
      "PATH refs/heads/Zeta",
      "PATH refs/heads/alpha",
      "PATH refs/heads/base",
    ]);
  });

  it("is unchanged when the port presents the same population in another order", () => {
    const forward = orderOf(REFS, SUBMODULES);
    const reversed = orderOf([...REFS].reverse(), [...SUBMODULES].reverse());
    expect(reversed.keys).toEqual(forward.keys);
    expect(reversed.proof).toBe(forward.proof);
    expect(forward.proof).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("normalizes separators so one target has one identity on every platform", () => {
    expect(orderOf([], ["assets\\two"]).keys).toEqual(["PATH assets/two"]);
    expect(orderOf([], ["assets/two"]).proof).toBe(orderOf([], ["assets\\two"]).proof);
  });
});

describe("coverage sweep", () => {
  it("generated a non-zero, exact number of coverage cases for the git class", () => {
    expect(GENERATED.filter((entry) => entry === CLASS)).toHaveLength(14);
    expect(GENERATED.length).toBeGreaterThan(0);
  });
});
