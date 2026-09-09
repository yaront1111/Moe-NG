/**
 * `product_contract.sync_env_example` end to end, through the REAL REGISTERED ASYNC ENTRY.
 *
 * WHY EVERY ARM DISPATCHES THROUGH `createDaemonCommandPorts` RATHER THAN CALLING THE HANDLER.
 * The generator has accepted an optional `requiredVariableNames` since it landed and the default
 * `[]` has always won, so an arm that passes names straight to `envExampleBytes` would have
 * passed before this row existed and proves nothing about it. What this row builds is the WIRE,
 * so the wire is what is driven: the entry is taken out of the production registry by kind, and
 * the store, the approval, the repository binding and the git repository are all real.
 *
 * THE REPOSITORY IS A REAL `git init` ON DISK, created per arm and removed in `afterEach` on
 * every exit path including the failing ones (epic rail 4). Nothing here mocks git, because the
 * safety property the row exists for -- that the commit takes the operator's `.env.example` and
 * NOTHING else of theirs -- is a property of git's own `--only` semantics, and a fake runner
 * would only assert that I passed the flags I meant to pass.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  grantHumanAuthority,
  productContractGate1Authority,
  type ProductContractRevisionV2,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope, openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
} from "../product-contract/product-contract-gate-1-contract.js";
import type {
  ProductContractGate1Authority, ProductContractGate1AuthorityInput,
} from "../product-contract/product-contract-gate-1-command.js";
import { runProductContractGate1V2Command }
  from "../product-contract/product-contract-v2-gate-1-command.js";
import { commitProductContractRevisionV2 }
  from "../product-contract/product-contract-v2-store.js";
import { FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION }
  from "../work/foundation-repository-scope-contracts.js";
import { envExampleBytes } from "./controlled-profile/controlled-profile-root-templates.js";
import { ENV_EXAMPLE_SYNC_COMMAND_KIND } from "./env-example-sync-contracts.js";
import {
  ENV_EXAMPLE_SYNCED_RESULT_CODE, ENV_EXAMPLE_UNCHANGED_RESULT_CODE,
} from "./env-example-sync-command.js";

const OPERATOR = "operator-env-example-sync";
const CLOCK = (): string => "2026-09-06T12:00:00.000Z";
const DECIDED_AT = "2026-09-06T12:00:00.000Z";
const PRD = "# Env example sync\n\nThe contract names the variables the product needs.\n";
const PRD_SHA = createHash("sha256").update(PRD, "utf8").digest("hex");
const CONTRACT_ID = "product-contract-env-example";

const scratch: string[] = [];

afterEach(() => {
  closeStores();
  // EVERY exit path, including the failing ones: a leaked temp repository would make every
  // later gate on this board inadmissible.
  while (scratch.length > 0) rmSync(scratch.pop() as string, { force: true, recursive: true });
});

// --------------------------------------------------------------------------- the git repository

function gitRaw(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", shell: false });
}

function git(cwd: string, ...args: readonly string[]): string {
  return gitRaw(cwd, ...args).trim();
}

/**
 * `git status --porcelain` WITHOUT trimming. Column 1 is the INDEX state and column 2 the
 * worktree state, so ` M` (dirty) and `M ` (staged) differ only in a leading space -- the
 * exact distinction arms (F) and (F2) exist to tell apart. Trimming would collapse them and
 * make a bare `git commit` look indistinguishable from `commit --only`.
 */
const statusLines = (root: string): readonly string[] =>
  gitRaw(root, "status", "--porcelain").split("\n").filter((line) => line.length > 0)
    .map((line) => line.replace(/\r$/u, "")).sort();

/** A real repository with one commit and a `.env.example` holding the profile's own bytes. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-env-example-"));
  scratch.push(root);
  git(root, "init", "--quiet", ".");
  git(root, "config", "user.email", "fixture@moe.local");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  writeFileSync(join(root, ".env.example"), profileBytes());
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

/**
 * The profile's own `.env.example`, taken from the PRODUCTION generator rather than retyped: a
 * hand copy would drift the moment the profile gains a line, and this fixture's whole job is to
 * be the bytes the scaffold would have written.
 */
const profileBytes = (): string => envExampleBytes([]);

// ------------------------------------------------------------------------------- the store seed

const requirement = (
  requirementId: string, environmentVariableNames?: readonly string[],
): Record<string, unknown> => ({
  dependsOnRequirementIds: [], priority: "MUST", requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
  ...(environmentVariableNames === undefined ? {} : { environmentVariableNames }),
});

const criterion = (criterionId: string, requirementId: string): Record<string, unknown> => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Verify ${criterionId}.`,
});

const CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

function draft(
  revisionId: string,
  names: readonly string[],
  lineage: ProductContractRevisionV2["lineage"] = null,
  contractId: string = CONTRACT_ID,
): Record<string, unknown> {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: OPERATOR,
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId,
    criteria: [criterion("criterion-deployment", "deployment-loopback"),
      criterion("criterion-keyboard", "ux-keyboard"),
      criterion("criterion-latency", "nfr-latency"),
      criterion("criterion-login", "requirement-login"),
      criterion("criterion-runtime", "technology-runtime"),
      criterion("criterion-session", "security-session")],
    deploymentRequirements: [
      { ...requirement("deployment-loopback", names), dependsOnRequirementIds: ["technology-runtime"] },
    ],
    functionalRequirements: [requirement("requirement-login")],
    journeys: [{ criterionIds: ["criterion-login", "criterion-session"],
      journeyId: "journey-login", statement: "A user signs in.", userJobId: "job-access" }],
    lineage,
    materialDecisions: [{ decisionId: "decision-stack", options: [
      { optionId: "option-next", statement: "Use Next.js." },
      { optionId: "option-rust", statement: "Use Axum." },
    ], question: "Which qualified profile?", selectedOptionId: "option-next" }],
    negativeScope: [{ scopeId: "scope-native", statement: "No native client." }],
    nonFunctionalRequirements: [requirement("nfr-latency")],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first use." }],
    productCompleteDefinition: { criterionIds: [...CRITERIA],
      statement: "Every criterion is independently verified." },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId,
    securityPrivacyRequirements: [requirement("security-session")],
    sourceDocumentDigests: [PRD_SHA],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard")],
  };
}

function seededStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  const bound = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind the env-example product source.",
    source: { displayPath: "docs/env-example.md", mediaType: "text/markdown", text: PRD },
    title: "Env example goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!bound.ok) throw new Error(`${bound.code}@fixture-goal`);
  return store;
}

function commitRevision(
  store: SqliteEventStore, value: Record<string, unknown>,
): ProductContractRevisionV2 {
  const outcome = commitProductContractRevisionV2(store, {
    commandId: `command-${String(value["revisionId"])}`,
    correlationId: "correlation-env-example", decidedAt: DECIDED_AT,
    draft: value, goalRef: GOAL_ID, principalId: OPERATOR, projectId: PROJECT_ID,
  });
  if (!outcome.ok) throw new Error(`${outcome.code}@${outcome.layer}`);
  return outcome.revision;
}

const TEST_HUMAN_AUTHORITY: ProductContractGate1Authority = Object.freeze({
  authorize: (input: ProductContractGate1AuthorityInput) => {
    const granted = grantHumanAuthority(
      productContractGate1Authority(input.ref), { kind: "HUMAN", principalId: OPERATOR },
      input.grantedAtEpochMs,
    );
    if (!granted.ok) throw new Error(`${granted.code}@${granted.layer}`);
    return Object.freeze({ gate: granted.gate, ok: true as const });
  },
});

function approve(store: SqliteEventStore, revision: ProductContractRevisionV2): void {
  const commandId = `approve-${revision.revisionId}`;
  const outcome = runProductContractGate1V2Command(store, new TextEncoder().encode(JSON.stringify({
    commandId, correlationId: `correlation-${commandId}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: {
      authentication: { kind: "TEST_ONLY_NON_BEARER" }, contractId: revision.contractId,
      revisionDigest: revision.revisionDigest, revisionId: revision.revisionId,
    },
    principalId: OPERATOR, projectId: PROJECT_ID,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  })), TEST_HUMAN_AUTHORITY, { sessionId: "test-only-session", transportOrigin: "MCP_STDIO" });
  if (!outcome.ok) throw new Error(`${outcome.code}@${outcome.refusedBy}`);
}

// ----------------------------------------------------------------------------- the registry edge

const catalogFor = (root: string): Record<string, unknown> => ({
  catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
  entries: [{
    declaredPaths: ["apps/daemon/src"],
    projectId: PROJECT_ID, repositoryRef: "repo-1", scopeRef: "scope-1",
    sourceRepositoryRoot: root, worktreeParent: root,
  }],
});

interface Dispatch {
  readonly commandId: string;
  readonly payload: Record<string, unknown>;
  readonly principalId?: string;
  readonly root: string;
  readonly store: SqliteEventStore;
}

/** THE REGISTERED EDGE: the entry is fetched out of the production registry BY KIND. */
async function dispatch(input: Dispatch): Promise<unknown> {
  const ports = createDaemonCommandPorts({
    clock: CLOCK, foundationCatalogSource: () => catalogFor(input.root),
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store: input.store,
  });
  const entry = ports.registry.get(ENV_EXAMPLE_SYNC_COMMAND_KIND);
  // A missing entry or a missing async handler must FAIL the arm rather than silently make it
  // test a hand-built closure: this lookup IS the "registered" half of the claim.
  if (entry?.asyncHandler === undefined) throw new Error("the registry serves no async entry");
  expect(entry.payloadKeys).toEqual(["contractId"]);
  const handlerInput = {
    envelope: {
      commandId: input.commandId, correlationId: "corr-env-example", decidedAt: DECIDED_AT,
      expectedVersion: 0, kind: ENV_EXAMPLE_SYNC_COMMAND_KIND, payload: input.payload,
      principalId: input.principalId ?? OPERATOR, projectId: PROJECT_ID,
      schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
    },
    principal: { principalId: input.principalId ?? OPERATOR },
  } as unknown as CommandHandlerInput;
  return await entry.asyncHandler(handlerInput);
}

/**
 * Code, LAYER and DETAIL. The detail carries the SOURCE code of the gate that actually refused,
 * and asserting it is what stops these arms going vacuous: this row has FOUR refusal codes but
 * several gates map onto ENV_EXAMPLE_CONTRACT_UNAPPROVED, so an arm that pinned only the code
 * would stay green when the gate it is named for is deleted and a LATER gate answers instead.
 * Measured, not theorised -- step 7 drill D2 deleted the approval resolver and every code-only
 * assertion held.
 */
const refusalOf = async (
  run: Promise<unknown>,
): Promise<readonly [string, string, string]> => {
  try {
    await run;
    return ["RESOLVED", "RESOLVED", "RESOLVED"];
  } catch (error) {
    const thrown = error as {
      readonly code?: unknown; readonly detail?: unknown; readonly layer?: unknown;
    };
    // The SOURCE CODE alone, lifted out of the detail: the surrounding sentence is prose and
    // would make these arms brittle for no gain, while the parenthesised code IS the gate.
    const source = /\(([A-Z0-9_]+)\)$/u.exec(String(thrown.detail));
    return [String(thrown.code), String(thrown.layer), source === null ? "" : source[1] as string];
  }
};

/** An approved contract naming `names`, a bound repository, and the registry that serves both. */
function world(names: readonly string[]): { root: string; store: SqliteEventStore } {
  const store = seededStore();
  approve(store, commitRevision(store, draft("revision-first", names)));
  return { root: repository(), store };
}

/** The COMMITTED bytes, UNTRIMMED: the trailing newline is part of what was committed. */
const committedEnvExample = (root: string): string => gitRaw(root, "show", "HEAD:.env.example");
const committedPaths = (root: string): readonly string[] =>
  git(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter((l) => l.length > 0);

// ------------------------------------------------------------------------------------- the arms

describe("product_contract.sync_env_example commits the approved contract's names", () => {
  it("(A) puts every required name into the COMMITTED .env.example", async () => {
    // STRICTLY ASCENDING, because `readEnvironmentVariableNames`
    // (packages/core/.../product-contract-v2-admission.ts:224) refuses an unsorted or
    // duplicated carrier outright -- a contract cannot even HOLD names out of order.
    const { root, store } = world(["APP_PORT", "SENTRY_DSN", "STRIPE_SECRET_KEY"]);
    const before = git(root, "rev-parse", "HEAD");

    const decision = await dispatch({
      commandId: "cmd-sync-a", payload: { contractId: CONTRACT_ID }, root, store,
    });

    expect(decision).toMatchObject({
      commandId: "cmd-sync-a", disposition: "DECIDED",
      resultCode: ENV_EXAMPLE_SYNCED_RESULT_CODE,
    });
    const committed = committedEnvExample(root);
    // The COMMIT happened, not merely the write: these bytes come out of the object database.
    expect(git(root, "rev-parse", "HEAD")).not.toBe(before);
    expect(readFileSync(join(root, ".env.example"), "utf8")).toBe(committed);
    expect(committed.split("\n")).toEqual(expect.arrayContaining([
      "APP_PORT=", "SENTRY_DSN=", "STRIPE_SECRET_KEY=",
    ]));
  });

  it("(B) writes NAMES ONLY, with a positive control that the predicates can fail", async () => {
    const { root, store } = world(["APP_PORT", "STRIPE_SECRET_KEY"]);
    await dispatch({ commandId: "cmd-sync-b", payload: { contractId: CONTRACT_ID }, root, store });

    const contractLines = (text: string): readonly string[] => text.split("\n")
      .filter((line) => line.startsWith("APP_PORT") || line.startsWith("STRIPE_SECRET_KEY"));
    const valued = (lines: readonly string[]): readonly string[] =>
      lines.filter((line) => !/^[A-Z_][A-Z0-9_]*=$/u.test(line));

    const committed = committedEnvExample(root);
    expect(contractLines(committed)).toEqual(["APP_PORT=", "STRIPE_SECRET_KEY="]);
    expect(valued(contractLines(committed))).toEqual([]);
    // POSITIVE CONTROL: the SAME predicates over bytes that DO carry values must find them, so
    // the emptiness above is a fact about the file and not about a predicate that never matches.
    const hostile = "APP_PORT=8080\nSTRIPE_SECRET_KEY=sk_live_51H8xQ2eZvKYlo2C";
    expect(valued(contractLines(hostile))).toEqual([
      "APP_PORT=8080", "STRIPE_SECRET_KEY=sk_live_51H8xQ2eZvKYlo2C",
    ]);
    expect(committed).not.toContain("sk_live");
  });

  it("(C) preserves the profile collision rule and drops a non-conforming name", async () => {
    // DATABASE_URL is a name the PROFILE itself already assigns, with a value. The profile's
    // line must win and the contract's bare declaration must be dropped, or the file would
    // carry the key twice and every consumer of these bytes is last-wins.
    const { root, store } = world(["APP_PORT", "DATABASE_URL"]);
    await dispatch({ commandId: "cmd-sync-c", payload: { contractId: CONTRACT_ID }, root, store });

    const committed = committedEnvExample(root);
    const occurrences = committed.split("\n").filter((line) => line.startsWith("DATABASE_URL"));
    expect(occurrences).toEqual(["DATABASE_URL=postgres://app:CHANGE_ME@localhost:5432/app"]);
    expect(committed).toContain("APP_PORT=");
  });

  it("(C2) cannot be handed a non-conforming name at all: admission refuses first", () => {
    // DoD 3 asks that a non-conforming name is filtered rather than emitted. It cannot be
    // driven through THIS edge, and the reason is a stronger fact than the filter: the
    // contract's own admission refuses to hold such a name, so no approved revision can ever
    // present one. `envExampleBytes`'s `isContractVariableName` filter is defence in depth
    // BELOW this, and the generator's own arm ("drops a name the contract grammar could not
    // have admitted", controlled-profile-generator.test.ts) is where it is exercised. Both
    // layers are asserted; neither is re-implemented.
    const store = seededStore();
    const outcome = commitProductContractRevisionV2(store, {
      commandId: "command-non-conforming", correlationId: "correlation-env-example",
      decidedAt: DECIDED_AT, draft: draft("revision-non-conforming", ["lower"]),
      goalRef: GOAL_ID, principalId: OPERATOR, projectId: PROJECT_ID,
    });
    expect(outcome).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE", ok: false,
    });
    // POSITIVE CONTROL: the identical draft with a CONFORMING name is admitted, so the
    // refusal above is about the name and not about some other defect in this fixture.
    expect(commitProductContractRevisionV2(store, {
      commandId: "command-conforming", correlationId: "correlation-env-example",
      decidedAt: DECIDED_AT, draft: draft("revision-conforming", ["LOWER"]),
      goalRef: GOAL_ID, principalId: OPERATOR, projectId: PROJECT_ID,
    })).toMatchObject({ ok: true });
  });

  it("(D) makes NO commit when the contract names nothing, and none on a replay", async () => {
    const empty = world([]);
    const before = git(empty.root, "rev-parse", "HEAD");
    const bytes = readFileSync(join(empty.root, ".env.example"), "utf8");

    const first = await dispatch({
      commandId: "cmd-sync-d1", payload: { contractId: CONTRACT_ID }, root: empty.root,
      store: empty.store,
    });
    expect(first).toMatchObject({ resultCode: ENV_EXAMPLE_UNCHANGED_RESULT_CODE });
    expect(git(empty.root, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(empty.root, ".env.example"), "utf8")).toBe(bytes);

    // REPLAY: the same names twice. The second run must find nothing to commit.
    const named = world(["APP_PORT"]);
    await dispatch({
      commandId: "cmd-sync-d2", payload: { contractId: CONTRACT_ID }, root: named.root,
      store: named.store,
    });
    const afterFirst = git(named.root, "rev-parse", "HEAD");
    const replay = await dispatch({
      commandId: "cmd-sync-d3", payload: { contractId: CONTRACT_ID }, root: named.root,
      store: named.store,
    });
    expect(replay).toMatchObject({
      effectId: afterFirst, resultCode: ENV_EXAMPLE_UNCHANGED_RESULT_CODE,
    });
    expect(git(named.root, "rev-parse", "HEAD")).toBe(afterFirst);
  });

  it("(E) refuses a CURRENT-but-unapproved revision, and a SUPERSEDED approval", async () => {
    const unapproved = seededStore();
    commitRevision(unapproved, draft("revision-unapproved", ["APP_PORT"]));
    const unapprovedRoot = repository();
    const unapprovedHead = git(unapprovedRoot, "rev-parse", "HEAD");
    expect(await refusalOf(dispatch({
      commandId: "cmd-sync-e1", payload: { contractId: CONTRACT_ID }, root: unapprovedRoot,
      store: unapproved,
    // THE APPROVAL RESOLVER IS WHAT ANSWERED, named by its own code. Pinning only
    // ENV_EXAMPLE_CONTRACT_UNAPPROVED leaves this arm GREEN when the resolver is deleted --
    // measured in step 7 drill D2, which is why the source code is asserted here.
    }))).toEqual(["ENV_EXAMPLE_CONTRACT_UNAPPROVED", "DAEMON_PREREQUISITE",
      "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT"]);
    // Nothing was written and nothing was committed on the refusing path.
    expect(git(unapprovedRoot, "rev-parse", "HEAD")).toBe(unapprovedHead);
    expect(git(unapprovedRoot, "status", "--porcelain")).toBe("");

    // SUPERSEDED: the FIRST revision is approved, then a second becomes current unapproved.
    const superseded = seededStore();
    const first = commitRevision(superseded, draft("revision-first", ["APP_PORT"]));
    approve(superseded, first);
    commitRevision(superseded, draft("revision-second", ["APP_PORT"], {
      parentRevisionDigest: first.revisionDigest, parentRevisionId: first.revisionId,
    }));
    const supersededRoot = repository();
    expect(await refusalOf(dispatch({
      commandId: "cmd-sync-e2", payload: { contractId: CONTRACT_ID }, root: supersededRoot,
      store: superseded,
    }))).toEqual(["ENV_EXAMPLE_CONTRACT_UNAPPROVED", "DAEMON_PREREQUISITE", "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT"]);
    // SAME source code as the unapproved arm, and that is the POINT rather than a duplicate: a
    // superseded approval does not carry over to the revision that replaced it, so the resolver
    // finds NO approval for the CURRENT ref. The two arms differ in their SETUP, not their code.
    expect(committedEnvExample(supersededRoot)).not.toContain("APP_PORT=");
  });

  it("(E2) refuses a non-operator principal at the entry, before any effect", async () => {
    const { root, store } = world(["APP_PORT"]);
    const before = git(root, "rev-parse", "HEAD");
    expect(await refusalOf(dispatch({
      commandId: "cmd-sync-e3", payload: { contractId: CONTRACT_ID },
      principalId: "session-agent-1", root, store,
    }))).toEqual(["OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION", ""]);
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("(F) leaves an unrelated DIRTY file dirty and out of the commit", async () => {
    const { root, store } = world(["APP_PORT"]);
    writeFileSync(join(root, "README.md"), "# fixture edited by the operator\n");
    writeFileSync(join(root, "scratch.txt"), "operator scratch\n");

    await dispatch({ commandId: "cmd-sync-f", payload: { contractId: CONTRACT_ID }, root, store });

    expect(committedPaths(root)).toEqual([".env.example"]);
    // UNTRIMMED: " M" means modified in the WORKTREE and clean in the index -- still dirty,
    // still uncommitted, exactly as the operator left it.
    expect(statusLines(root)).toEqual([" M README.md", "?? scratch.txt"]);
  });

  it("(F2) leaves an unrelated PRE-STAGED file staged and out of the commit", async () => {
    const { root, store } = world(["APP_PORT"]);
    writeFileSync(join(root, "staged.txt"), "operator work in progress\n");
    git(root, "add", "--", "staged.txt");
    expect(statusLines(root)).toEqual(["A  staged.txt"]);

    await dispatch({ commandId: "cmd-sync-f2", payload: { contractId: CONTRACT_ID }, root, store });

    // (i) ABSENT from the commit and (ii) STILL STAGED. A bare `git commit` passes (F) above and
    // fails BOTH of these, which is the whole reason this arm exists beside it.
    expect(committedPaths(root)).toEqual([".env.example"]);
    expect(statusLines(root)).toEqual(["A  staged.txt"]);
    expect(git(root, "show", "HEAD", "--name-only", "--format=")).not.toContain("staged.txt");
  });

  it("(G) refuses a contractId that belongs to another project", async () => {
    const { root, store } = world(["APP_PORT"]);
    const head = git(root, "rev-parse", "HEAD");
    expect(await refusalOf(dispatch({
      commandId: "cmd-sync-g", payload: { contractId: "product-contract-somebody-else" }, root,
      store,
    }))).toEqual(["ENV_EXAMPLE_CONTRACT_UNAPPROVED", "DAEMON_PREREQUISITE",
      "PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT"]);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);

    // AND THE PAYLOAD CANNOT REDIRECT THE READ. A payload naming another project is IGNORED --
    // `projectId` comes from the authenticated composition -- so the REAL contract still syncs.
    // (The ingress would refuse the extra key at PAYLOAD_SHAPE before the handler ever saw it;
    // this arm reaches past that to pin the handler's own source of truth, so a handler that
    // started reading `payload.projectId` would find "project-2" and refuse here.)
    expect(await dispatch({
      commandId: "cmd-sync-g2",
      payload: { contractId: CONTRACT_ID, projectId: "project-2" }, root, store,
    })).toMatchObject({ resultCode: ENV_EXAMPLE_SYNCED_RESULT_CODE });
    expect(committedEnvExample(root)).toContain("APP_PORT=");
  });

  it("(H) refuses a bound directory that is not a git repository, writing nothing", async () => {
    const { store } = world(["APP_PORT"]);
    const plain = mkdtempSync(join(tmpdir(), "moe-env-example-plain-"));
    scratch.push(plain);
    expect(await refusalOf(dispatch({
      commandId: "cmd-sync-h", payload: { contractId: CONTRACT_ID }, root: plain, store,
    }))).toEqual(["ENV_EXAMPLE_REPOSITORY_UNREADABLE", "RUNNER_WORKSPACE", ""]);
    // THE PROBE RUNS BEFORE THE WRITE: no file is left behind in a directory that refused.
    expect(existsSync(join(plain, ".env.example"))).toBe(false);
  });
});
