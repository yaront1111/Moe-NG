import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { GitLandingPort, GitObserveResult } from "../repository/git-landing-port.js";
import { verifiedGitRefusal } from "../repository/git-verified-workspace-runtime.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landingAggregateId, landingReceiptId } from "../repository/landing-receipt-contracts.js";
import type { LandingBaselineEntry } from "../repository/landing-receipt-contracts.js";
import type { RepositoryExecutionHandle } from "../repository/repository-execution-contracts.js";
import { executionHandle } from "../repository/repository-execution-record.js";
import { readRepositoryLandingEvidence } from "../repository/repository-landing-intent.js";
import type { VerifiedWorkspaceBinding, VerifiedWorkspaceCapture } from "../repository/verified-workspace-contracts.js";
import { PROJECT_ID, closeStores, hex64, openStore } from "../review/review-test-fixtures.js";
import type { NodeMission } from "./agent-wrapper.js";
import { createNodeLander } from "./node-lander.js";
import {
  LANDING_VERIFICATION_REFUSALS, checkLandingVerification, landingVerificationClass,
} from "./node-lander-verification.js";

afterEach(closeStores);

const NODE = "node-verification-class";
const WORKSPACE = "D:/ws/project";
const VERIFIER_RECEIPT = hex64("ab");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BINDING: VerifiedWorkspaceBinding = Object.freeze({
  branchRef: "refs/heads/main", dirtySha256: "d".repeat(64), headSha: "f".repeat(40), root: WORKSPACE,
  treeSha: "2".repeat(40), version: "moe-verified-workspace/1" as const,
});
const DELIVERED: LandingBaselineEntry = Object.freeze({ blobId: "b".repeat(40), path: "src/new.ts" });
const brief: NodeMission = Object.freeze({ instructions: "build it", test: "pnpm test", title: "Land it", workspace: WORKSPACE });

const observed = (entries: readonly LandingBaselineEntry[]): GitObserveResult => ({ observation: { entries, root: WORKSPACE }, ok: true });
const refusal = (code: string) => ({ code, detail: code, ok: false }) as const;

/** A LANDING-phase reservation from the production constructor, so the journal is really consulted. */
function reservation(): RepositoryExecutionHandle {
  return executionHandle({
    owner: { projectId: PROJECT_ID, nodeRef: NODE, ownershipToken: hex64("cd"), storeId: "store-node-lander-verification" },
    state: { phase: "LANDING", baselineId: "baseline-1", sessionId: "session-1", pid: 4242,
      controllerId: "controller-1", controllerPid: 4241 },
    revision: 5, everExecuted: true,
  }, { root: WORKSPACE, gitDirectory: `${WORKSPACE}/.git` });
}

/**
 * A lander whose verified-workspace capture answers from a SCRIPT, one entry per call, the last
 * entry repeating. The staffing baseline is empty and the seat delivered one new file, so every
 * pass reaches `checkLandingVerification` with real work to land — a zero-delivered pass would
 * test the NOTHING_TO_COMMIT branch instead of the delivery this row protects.
 */
async function scripted(captures: readonly VerifiedWorkspaceCapture[]) {
  const store = openStore();
  const handle = reservation();
  const commits: string[][] = [];
  const queue = [...captures];
  let observation = observed([]);
  let consulted = 0;
  const git: GitLandingPort = {
    async commit(_workspace, paths) {
      commits.push([...paths]);
      return { ok: true, receipt: { branch: "main", parentSha: "f".repeat(40), sha: SHA } };
    },
    async observe() { return observation; },
  };
  const made = createNodeLander({
    clock: () => "2026-09-11T12:00:00.000Z", git, nodeMission: () => brief, nodes: () => [{ nodeRef: NODE }],
    projectId: PROJECT_ID, readAccepted: () => ({ verifierReceiptId: VERIFIER_RECEIPT }),
    readVerifiedBinding: () => BINDING, reservationHandle: handle, store,
    verifiedWorkspace: {
      capture: async () => {
        consulted += 1;
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next === undefined) throw new Error("CAPTURE_SCRIPT_EMPTY");
        return next;
      },
      commit: (workspace, paths, message) => git.commit(workspace, paths, message),
    },
  });
  await made.baseline(NODE);
  observation = observed([DELIVERED]);
  return {
    commits, consulted: () => consulted, handle, made, store,
    receipt: () => readLandingReceipt(store, PROJECT_ID, landingReceiptId(PROJECT_ID, NODE, VERIFIER_RECEIPT)),
    /** Every landing fact — baseline, receipt — is an event on this aggregate, so an unmoved version wrote nothing. */
    version: () => store.getAggregateVersion(landingAggregateId(NODE)),
  };
}

const REPOSITORY = new URL("../repository/", import.meta.url);
const read = (url: URL): string => readFileSync(url, "utf8");
const fileName = (url: URL): string => url.pathname.slice(url.pathname.lastIndexOf("/") + 1);

/**
 * The modules the PRODUCTION port's capture() calls, read from the port's own imports rather than
 * listed here — so a capture() that starts calling another module moves the roots with it.
 */
function captureRoots(): readonly URL[] {
  const port = read(new URL("git-verified-workspace-port.ts", REPOSITORY));
  const body = /async capture\(workspace\) \{([\s\S]*?)\r?\n {4}\},/u.exec(port)?.[1];
  if (body === undefined) throw new Error("PORT_CAPTURE_BODY_NOT_FOUND");
  if (/"[A-Z][A-Z0-9_]+"/u.test(body)) throw new Error("PORT_CAPTURE_MINTS_ITS_OWN_CODE");
  const roots: URL[] = [];
  for (const [, names = "", module = ""] of port.matchAll(/import \{([^}]+)\} from "(\.\/[^"]+)\.js";/gu)) {
    const used = names.split(",").some((name) => new RegExp(`\\b${name.trim()}\\b`, "u").test(body));
    if (used) roots.push(new URL(`${module}.ts`, REPOSITORY));
  }
  return roots;
}

/**
 * Every refusal code the capture path can THROW: the literal argument of each `failVerifiedGit(...)`
 * and `new VerifiedGitFailure(...)` call in every module reachable from the roots over relative
 * imports. A call whose argument is not a literal is returned as `unreadable`, never skipped.
 */
function thrownCaptureCodes(): { codes: ReadonlySet<string>; files: readonly string[]; unreadable: readonly string[] } {
  const sources = new Map<string, string>();
  const visit = (url: URL): void => {
    if (sources.has(url.href)) return;
    const text = read(url);
    sources.set(url.href, text);
    for (const [, specifier = ""] of text.matchAll(/from "(\.\.?\/[^"]+)\.js"/gu)) visit(new URL(`${specifier}.ts`, url));
  };
  for (const root of captureRoots()) visit(root);
  const codes = new Set<string>();
  const unreadable: string[] = [];
  const files: string[] = [];
  for (const [href, text] of sources) {
    const name = fileName(new URL(href));
    files.push(name);
    for (const [call, , argument = ""] of text.matchAll(/(?<!function )\b(failVerifiedGit|new VerifiedGitFailure)\(([^)]*)\)/gu)) {
      const literal = /^\s*"([A-Z][A-Z0-9_]*)"\s*$/u.exec(argument)?.[1];
      if (literal === undefined) unreadable.push(`${name}: ${call}`);
      else codes.add(literal);
    }
  }
  return { codes, files, unreadable };
}

describe("the closed verification-refusal table", () => {
  // DoD 1. The reachable set is read out of the IMPLEMENTATION — the literals the capture path throws,
  // its refuser's fallback, checkLandingVerification's own codes — never out of the table under test.
  // A test that iterated the table could only shrink with it and would stay green while a code
  // silently dropped out of classification.
  it("classifies exactly the refusal codes checkLandingVerification can return", () => {
    const thrown = thrownCaptureCodes();
    // Non-vacuity: the walk reached the capture implementation, from the port's own imports.
    expect(thrown.files).toEqual(expect.arrayContaining(["git-verified-workspace-capture.ts", "git-verified-workspace-runtime.ts"]));
    // The one non-literal call site is failVerifiedGit forwarding its own parameter. Any other would be
    // a code this scan cannot read, so it fails HERE rather than escaping classification.
    expect(thrown.unreadable).toEqual(["git-verified-workspace-runtime.ts: new VerifiedGitFailure(code)"]);
    // Anything else a capture throws is answered with the refuser's fallback code.
    const fallback = verifiedGitRefusal(new Error("not a VerifiedGitFailure")).code;
    const own = [...read(new URL("./node-lander-verification.ts", import.meta.url)).matchAll(/\bcode: "([A-Z][A-Z0-9_]*)"/gu)]
      .map(([, code]) => code);
    expect(own).toEqual(expect.arrayContaining([
      "LANDING_VERIFIER_BINDING_MISSING", "LANDING_VERIFIED_WORKSPACE_UNCONFIGURED", "LANDING_VERIFIED_WORKSPACE_CHANGED",
    ]));
    const reachable = [...new Set([...own, ...thrown.codes, fallback])].sort();
    expect(reachable).toEqual(expect.arrayContaining(["VERIFIED_WORKSPACE_DRIFT", "VERIFIED_WORKSPACE_GIT_FAILED"]));
    // BOTH directions at once: every reachable code is classified AND every classified code is reachable.
    expect(Object.keys(LANDING_VERIFICATION_REFUSALS).sort()).toEqual(reachable);
  });

  // The other half of the reachable set is whatever the port hands back, unchanged — which is why the
  // capture sources above ARE the rest of the roster.
  it("hands a capture refusal back verbatim", async () => {
    const refused = refusal("CAPTURE_REFUSAL_PASSED_THROUGH");
    expect(await checkLandingVerification({
      brief, nodeRef: NODE, projectId: PROJECT_ID, receiptId: VERIFIER_RECEIPT, store: openStore(),
      readBinding: () => BINDING, port: { capture: async () => refused, commit: async () => refused },
    })).toEqual({ code: "CAPTURE_REFUSAL_PASSED_THROUGH", detail: "CAPTURE_REFUSAL_PASSED_THROUGH", ok: false });
  });

  it("answers null, not a class, for a code the table does not name", () => {
    expect(landingVerificationClass("VERIFIED_WORKSPACE_DRIFT")).toBe("TRANSIENT");
    expect(landingVerificationClass("LANDING_VERIFIED_WORKSPACE_CHANGED")).toBe("STRUCTURAL");
    for (const code of ["VERIFIED_WORKSPACE_NOT_IN_THE_TABLE", "constructor", "toString", "__proto__", ""]) {
      expect(landingVerificationClass(code), code).toBeNull();
    }
  });
});

describe("the lander on a verified-workspace refusal", () => {
  // DoD 2 (task-cab96ebcd3b6403cbbf412bdad839403). HEAD moved between the capture's first and final
  // read: a MOMENT, not a property of the receipt or of the repository. Pre-row the lander recorded
  // it durably, landOne returned null for that acceptance forever, and ACCEPTED work never landed.
  it("reports a transient capture failure without recording it, then lands on the next pass", async () => {
    const f = await scripted([refusal("VERIFIED_WORKSPACE_DRIFT"), { binding: BINDING, ok: true }]);
    const before = f.version();
    expect(await f.made.landOnce()).toEqual([
      { detail: "VERIFIED_WORKSPACE_DRIFT", nodeRef: NODE, outcome: "VERIFIED_WORKSPACE_DRIFT" },
    ]);
    // Read back from the ledger, not from the report: no receipt, no event of any kind on the landing
    // aggregate, and no journaled intent — the next pass inherits nothing from this one.
    expect(f.receipt()).toEqual({ code: "LANDING_RECEIPT_NOT_FOUND", ok: false });
    expect(f.version()).toBe(before);
    expect(readRepositoryLandingEvidence(f.store, f.handle))
      .toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_MISSING" });
    expect(f.commits).toEqual([]);
    expect(await f.made.landOnce()).toEqual([
      { detail: `${SHA.slice(0, 10)} on main, 1 file(s)`, nodeRef: NODE, outcome: "COMMITTED" },
    ]);
    expect(f.consulted()).toBe(2);
    const landed = f.receipt();
    expect(landed.ok && landed.receipt.outcome).toBe("COMMITTED");
    expect(f.commits).toEqual([["src/new.ts"]]);
  });

  // DoD 1 and 3, through the real lander for EVERY classified code: the table decides, code by code,
  // rather than a special case for DRIFT. Each case asserts its own code, on the receipt or the report.
  it("records every STRUCTURAL code durably and leaves every TRANSIENT one to the next pass", async () => {
    const cases = Object.entries(LANDING_VERIFICATION_REFUSALS);
    expect(new Set(cases.map(([, kind]) => kind))).toEqual(new Set(["STRUCTURAL", "TRANSIENT"]));
    let swept = 0;
    for (const [code, kind] of cases) {
      const f = await scripted([refusal(code), { binding: BINDING, ok: true }]);
      const before = f.version();
      const first = await f.made.landOnce();
      const afterFirst = f.receipt();
      if (kind === "STRUCTURAL") {
        expect(first, code).toEqual([{ detail: `${code}: ${code}`, nodeRef: NODE, outcome: "REFUSED" }]);
        expect(afterFirst.ok && afterFirst.receipt.refusal?.code, code).toBe(code);
        // Consumed: the next pass is silent although the capture now succeeds.
        expect(await f.made.landOnce(), code).toEqual([]);
        expect(f.commits, code).toEqual([]);
      } else {
        expect(first, code).toEqual([{ detail: code, nodeRef: NODE, outcome: code }]);
        expect(afterFirst, code).toEqual({ code: "LANDING_RECEIPT_NOT_FOUND", ok: false });
        expect(f.version(), code).toBe(before);
        expect((await f.made.landOnce())[0]?.outcome, code).toBe("COMMITTED");
        expect(f.commits, code).toEqual([["src/new.ts"]]);
      }
      swept += 1;
    }
    expect(swept).toBe(cases.length);
  });

  // DoD 3. LANDING_VERIFIED_WORKSPACE_CHANGED is the parent row's whole delivery
  // (task-29f367530d954a18a8580f184b09c65d), produced here the production way: a capture whose binding
  // differs from the verified one. It must stay DURABLE. As a retry, a seat whose verified bytes were
  // changed would loop with no receipt, invisible to everything that reads the landing ledger.
  it("keeps LANDING_VERIFIED_WORKSPACE_CHANGED durable: recorded with its code and never retried", async () => {
    const f = await scripted([{ binding: { ...BINDING, treeSha: "3".repeat(40) }, ok: true }, { binding: BINDING, ok: true }]);
    expect(await f.made.landOnce()).toEqual([{
      detail: "LANDING_VERIFIED_WORKSPACE_CHANGED: current workspace differs from the verified candidate",
      nodeRef: NODE, outcome: "REFUSED",
    }]);
    const receipt = f.receipt();
    expect(receipt.ok && receipt.receipt.refusal?.code).toBe("LANDING_VERIFIED_WORKSPACE_CHANGED");
    expect(receipt.ok && receipt.receipt.commit).toBeNull();
    // The workspace matches the verified candidate again, and still nothing lands: the check never re-ran.
    expect(await f.made.landOnce()).toEqual([]);
    expect(f.consulted()).toBe(1);
    expect(f.commits).toEqual([]);
  });

  // A code outside the table inherits NEITHER class. Nothing is recorded, and it answers its own stable
  // outcome, which the delivery runtime does not retry, so the checkout is contained: neither looped nor
  // released. Only a non-production port can reach this; the roster arm above proves the production one cannot.
  it("answers LANDING_VERIFICATION_UNCLASSIFIED for a code outside the table and records nothing", async () => {
    const f = await scripted([refusal("VERIFIED_WORKSPACE_NOT_IN_THE_TABLE")]);
    const before = f.version();
    expect(await f.made.landOnce()).toEqual([{
      detail: "VERIFIED_WORKSPACE_NOT_IN_THE_TABLE: VERIFIED_WORKSPACE_NOT_IN_THE_TABLE",
      nodeRef: NODE, outcome: "LANDING_VERIFICATION_UNCLASSIFIED",
    }]);
    expect(f.receipt()).toEqual({ code: "LANDING_RECEIPT_NOT_FOUND", ok: false });
    expect(f.version()).toBe(before);
    expect(f.commits).toEqual([]);
  });
});
