/**
 * The production `captureResult` producer, over REAL authorities end to end.
 *
 * NOTHING UNDER TEST IS FAKED. The store is a file-backed `SqliteEventStore`,
 * the repository is a real temp Git repository, and the capture context is
 * sealed by the REAL `createFoundationCaptureLifecycle` — this suite never
 * hand-builds a record, because a hand-built record would let the producer
 * agree with a shape the lifecycle does not actually write.
 *
 * WHY THE PROOF IS AN INPUT. Measured at 1d1a59e: the prelaunch proof is not a
 * field of the durable record (`PreparedCapture.proof` is the only carrier),
 * re-deriving one after a launch refuses with
 * `RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_CHANGED` because the tree no longer
 * equals its sealed input, and `sealPrelaunchProof` is deliberately WITHHELD
 * from `@moe/runner` so no consumer can mint one. So it travels lexically from
 * this dispatch's own preparation, exactly as `captureRef` does. What stops
 * that from being a smuggling seam is the PROOF FENCE: a proof must agree with
 * the durable record read by `captureRef`, so a proof from another attempt —
 * a real one, sealed by a real second preparation — is refused.
 *
 * EVERY REFUSAL PINS CODE **AND** LAYER. Three authorities can refuse here (the
 * ledger reader, this producer, the runner capture seam) and each keeps its own
 * vocabulary verbatim.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hermeticGitEnvironment } from "@moe/runner";
import type { FoundationPrelaunchProof } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import { PROJECT_ID, envelope, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { cleanupRestoreHarnesses, openHarnessStore } from "../recovery/restore-test-harness.js";
import { snapshotFoundationValue } from "./foundation-attempt-codec.js";
import { CAPTURE_KEYS } from "./foundation-attempt-contracts.js";
import { DAEMON_FOUNDATION_CAPTURE } from "./foundation-capture-context-contract.js";
import {
  DAEMON_FOUNDATION_CAPTURE_READER, deriveFoundationCaptureAggregateId,
} from "./foundation-capture-context-ledger.js";
import type { FoundationCaptureContextStore } from "./foundation-capture-context-ledger.js";
import { createFoundationCaptureLifecycle } from "./foundation-capture-lifecycle.js";
import type { PreparedCapture } from "./foundation-capture-lifecycle.js";
import {
  FOUNDATION_CAPTURE_PRODUCER_CODES, FOUNDATION_CAPTURE_PRODUCER_INPUT_KEYS,
  createFoundationCaptureProducer,
} from "./foundation-capture-producer.js";
import type { FoundationCaptureProducerCode } from "./foundation-capture-producer.js";
import { FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION } from "./foundation-repository-scope-contracts.js";

const CASE_TIMEOUT = { timeout: 30_000 } as const;

/** Read OUT of the declared vocabulary: a literal stays green when a member is
 *  renamed or dropped, which is the drift a closed code list exists to catch. */
function code(wanted: string): FoundationCaptureProducerCode {
  const found = FOUNDATION_CAPTURE_PRODUCER_CODES.find((entry) => entry === wanted);
  if (found === undefined) throw new Error(`${wanted} is not in the closed producer vocabulary`);
  return found;
}

const scratchRoots: string[] = [];

afterEach(() => { cleanupRestoreHarnesses(); });
afterAll(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    // 20x250ms, matching the Windows suite's measured value: under full-fleet
    // parallelism a trailing git/scanner handle holds a scratch root well past
    // 5x100ms, and a failed removal leaks a temp directory on every run.
    if (root !== undefined) {
      rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
    }
  }
});

function scratch(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `moe-capture-producer-${label}-`)));
  scratchRoots.push(root);
  return root;
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8", env: hermeticGitEnvironment(process.env),
    shell: false, windowsHide: true,
  }).trim();
}

const DECLARED_PATHS = ["scope/alpha.txt", "scope/beta.txt"] as const;
const REPOSITORY_REF = "repo-1";
const SCOPE_REF = "scope-1";

interface RepositoryFixture {
  readonly head: string;
  readonly root: string;
  readonly worktreeParent: string;
}

/** sha256 objects so the head is 64 hex and bindable as a durable observation;
 *  autocrlf off so a checkout cannot rewrite the bytes the proof sealed. */
function repositoryFixture(label: string): RepositoryFixture {
  const root = scratch(`repo-${label}`);
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, DECLARED_PATHS[0]), Buffer.from("alpha\n", "utf8"));
  writeFileSync(join(root, DECLARED_PATHS[1]), Buffer.from("beta\n", "utf8"));
  runGit(root, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  runGit(root, ["add", "--", ...DECLARED_PATHS]);
  runGit(root, [
    "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "foundation base",
  ]);
  return {
    head: runGit(root, ["rev-parse", "HEAD"]), root, worktreeParent: scratch(`parent-${label}`),
  };
}

/** Registered then bound through the REAL bootstrap seam, never a planted row. */
function boundStore(label: string, fixture: RepositoryFixture): SqliteEventStore {
  const store = openHarnessStore(join(scratch(`store-${label}`), "project.db"));
  const registered = send(store, envelope("project.register", 0, { owner: "owner-1" }));
  if (!registered.ok) throw new Error(`fixture register refused: ${registered.code}`);
  const version = versionOf(readDurableLedger(store, PROJECT_ID), PROJECT_ID);
  const bound = send(store, envelope("project.bind_repository", version, {
    observation: {
      baseRevisionHash: fixture.head, repositoryRef: REPOSITORY_REF, scopeRef: SCOPE_REF,
      truthClass: "DAEMON_VERIFIED",
    },
  }, "cmd-bind-fixture"));
  if (!bound.ok) throw new Error(`fixture bind refused: ${bound.code}`);
  return store;
}

function lifecycleOver(store: SqliteEventStore, fixture: RepositoryFixture): ReturnType<
  typeof createFoundationCaptureLifecycle
> {
  return createFoundationCaptureLifecycle({
    catalogSource: (): unknown => ({
      catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
      entries: [{
        declaredPaths: [...DECLARED_PATHS], projectId: PROJECT_ID,
        repositoryRef: REPOSITORY_REF, scopeRef: SCOPE_REF,
        sourceRepositoryRoot: fixture.root, worktreeParent: fixture.worktreeParent,
      }],
    }),
    clock: () => "2026-08-19T00:00:00.000Z",
    store,
  });
}

const SLOT = Object.freeze({
  attemptAggregateId: "agg-producer-1", attemptId: "attempt-1", nodeKey: "dev-done",
  sessionId: "session-1",
});

interface Prepared {
  readonly fixture: RepositoryFixture;
  readonly prepared: PreparedCapture;
  readonly store: SqliteEventStore;
}

/** One REAL preparation: catalog resolved, worktree materialized, bytes
 *  hydrated, tree proven clean, context durably sealed. */
async function prepare(
  label: string, slot: Readonly<Record<string, string>> = SLOT,
): Promise<Prepared> {
  const fixture = repositoryFixture(label);
  const store = boundStore(label, fixture);
  const prepared = await lifecycleOver(store, fixture).prepareCapture({
    attemptAggregateId: slot["attemptAggregateId"] as string,
    attemptId: slot["attemptId"] as string, nodeKey: slot["nodeKey"] as string,
    projectId: PROJECT_ID, proposedBaseIdentity: fixture.head, proposedCwd: null,
    proposedEntries: [], requestDigest: "d".repeat(64), reservationDigest: "e".repeat(64),
    sessionId: slot["sessionId"] as string,
  });
  if (!prepared.ok) throw new Error(`fixture prepare refused: ${prepared.code}@${prepared.layer}`);
  if (prepared.proof === null) throw new Error("fixture prepare returned no prelaunch proof");
  return { fixture, prepared, store };
}

/** What the attempt did: rewrite one DECLARED file inside the assigned tree.
 *  A brand-new path would be out of every declared scope and is a different
 *  fact — refused, not captured — so it cannot stand in for authored work. */
function authorInto(prepared: PreparedCapture, bytes: string): void {
  writeFileSync(join(prepared.assignment.realWorktreePath, DECLARED_PATHS[0]),
    Buffer.from(bytes, "utf8"));
}

/** Exactly what `foundation-attempt-service.ts` hands the port, plus the proof. */
function callSite(
  prepared: PreparedCapture, overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    attemptId: prepared.record.attemptId, baseIdentity: prepared.record.inputManifest.baseIdentity,
    captureRef: prepared.captureRef, nodeKey: prepared.record.nodeKey,
    observation: { launched: true }, proof: prepared.proof, sessionId: prepared.record.sessionId,
    ...overrides,
  };
}

const producerOver = (store: FoundationCaptureContextStore): (
  input: Record<string, unknown>,
) => unknown => createFoundationCaptureProducer({ store });

/** `[code, layer]`, so an accepted answer can never satisfy a refusal matcher. */
function refusalOf(answer: unknown): readonly string[] {
  if (answer === null || typeof answer !== "object") return ["NOT_A_RECORD", String(answer)];
  const record = answer as Record<string, unknown>;
  if (record["ok"] !== false) return ["ACCEPTED", "ACCEPTED"];
  return [String(record["code"]), String(record["layer"])];
}

function acceptedAnswer(answer: unknown): Record<string, unknown> {
  if (answer === null || typeof answer !== "object") {
    throw new Error(`producer answered a non-record: ${String(answer)}`);
  }
  const record = answer as Record<string, unknown>;
  if (record["ok"] === false) {
    throw new Error(`producer refused: ${String(record["code"])}@${String(record["layer"])}`);
  }
  return record;
}

describe("captureResult producer accepted control", CASE_TIMEOUT, () => {
  it("answers the exact CAPTURE_KEYS over a real authored delta", async () => {
    const { prepared, store } = await prepare("accepted");
    authorInto(prepared, "alpha authored by the attempt\n");

    const answer = acceptedAnswer(producerOver(store)(callSite(prepared)));

    // EXACT keys: a superset would be silently dropped by the store's
    // `exactKeys` gate and the attempt would settle UNKNOWN with no diagnosis.
    expect(Object.keys(answer).sort()).toEqual([...CAPTURE_KEYS].sort());
    expect(answer["authoredPaths"]).toEqual([DECLARED_PATHS[0]]);
    expect(answer["declaredArtifactRefs"]).toEqual([]);
    const entries = answer["resultTreeEntries"] as readonly Record<string, unknown>[];
    expect(entries.map((entry) => [entry["path"], entry["origin"]])).toEqual([
      [DECLARED_PATHS[0], "AUTHORED"], [DECLARED_PATHS[1], "INHERITED"],
    ]);
    // The PRELAUNCH observation is the only one that may authorize result bytes.
    expect(answer["scopeObservation"]).toEqual(prepared.record.observation);
  });

  it("seals an all-INHERITED answer for a clean run rather than refusing", async () => {
    const { prepared, store } = await prepare("clean");

    const answer = acceptedAnswer(producerOver(store)(callSite(prepared)));

    expect(answer["authoredPaths"]).toEqual([]);
    const entries = answer["resultTreeEntries"] as readonly Record<string, unknown>[];
    expect(entries.map((entry) => entry["origin"])).toEqual(["INHERITED", "INHERITED"]);
  });

  it("answers PLAIN FROZEN DATA that survives the port's snapshot unchanged", async () => {
    const { prepared, store } = await prepare("snapshot");
    authorInto(prepared, "alpha authored\n");

    const answer = acceptedAnswer(producerOver(store)(callSite(prepared)));

    // `contained()` snapshots every answer; an accessor or a foreign prototype
    // flattens and the attempt settles FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN.
    expect(snapshotFoundationValue(answer)).toEqual(answer);
    expect(Object.isFrozen(answer)).toBe(true);
  });
});

describe("captureResult producer identity fence", CASE_TIMEOUT, () => {
  const IDENTITY_ARMS = Object.freeze([
    ["attemptId", "attempt-impostor"], ["baseIdentity", "f".repeat(64)],
    ["nodeKey", "node-impostor"], ["sessionId", "session-impostor"],
  ] as const);

  it.each(IDENTITY_ARMS)("refuses when the call site's %s disagrees with the record",
    async (key, impostor) => {
      const { prepared, store } = await prepare(`fence-${key}`);
      authorInto(prepared, "alpha authored\n");

      const answer = producerOver(store)(callSite(prepared, { [key]: impostor }));

      expect(refusalOf(answer)).toEqual([
        code("FOUNDATION_CAPTURE_PRODUCER_IDENTITY_MISMATCH"), DAEMON_FOUNDATION_CAPTURE,
      ]);
    });

  it("refuses a captureRef smuggled from another real attempt", async () => {
    const mine = await prepare("fence-mine");
    const theirs = await prepare("fence-theirs", {
      ...SLOT, attemptId: "attempt-2", sessionId: "session-2",
    });
    authorInto(mine.prepared, "alpha authored\n");

    // Their ref resolves — on THEIR store — to a real, honestly sealed record
    // bound to their identities. Nothing about it is malformed; it is simply
    // not this attempt's, which is the whole attack.
    const answer = producerOver(theirs.store)(
      callSite(mine.prepared, { captureRef: theirs.prepared.captureRef }));

    expect(refusalOf(answer)).toEqual([
      code("FOUNDATION_CAPTURE_PRODUCER_IDENTITY_MISMATCH"), DAEMON_FOUNDATION_CAPTURE,
    ]);
  });
});

describe("captureResult producer proof fence", CASE_TIMEOUT, () => {
  it("refuses a REAL proof sealed by another attempt's preparation", async () => {
    const mine = await prepare("proof-mine");
    const theirs = await prepare("proof-theirs", {
      ...SLOT, attemptId: "attempt-2", sessionId: "session-2",
    });
    authorInto(mine.prepared, "alpha authored\n");

    // A genuine proof whose own seal recomputes: only its BINDING to this
    // dispatch's durable record is wrong, which is the only thing left to check
    // once minting is impossible.
    const answer = producerOver(mine.store)(
      callSite(mine.prepared, { proof: theirs.prepared.proof }));

    expect(refusalOf(answer)).toEqual([
      code("FOUNDATION_CAPTURE_PRODUCER_PROOF_UNBOUND"), DAEMON_FOUNDATION_CAPTURE,
    ]);
  });

  it("refuses a proof whose own seal no longer recomputes", async () => {
    const { prepared, store } = await prepare("proof-unsealed");
    authorInto(prepared, "alpha authored\n");
    const tampered = {
      ...(prepared.proof as FoundationPrelaunchProof), scannedByteTotal: 999_999,
    };

    const answer = producerOver(store)(callSite(prepared, { proof: tampered }));

    expect(refusalOf(answer)).toEqual([
      code("FOUNDATION_CAPTURE_PRODUCER_PROOF_UNBOUND"), DAEMON_FOUNDATION_CAPTURE,
    ]);
  });
});

describe("captureResult producer forwards upstream refusals verbatim", CASE_TIMEOUT, () => {
  it("forwards the ledger reader's own code and layer when no record exists", async () => {
    const { prepared, store } = await prepare("absent");
    // A well-formed ref for a slot nothing ever prepared: the reader answers,
    // not this module, and its answer must cross unrestamped.
    const unprepared = `${prepared.captureRef.slice(0, -1)}${
      prepared.captureRef.endsWith("a") ? "b" : "a"}`;

    const answer = producerOver(store)(callSite(prepared, { captureRef: unprepared }));

    expect(refusalOf(answer)).toEqual([
      "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT", DAEMON_FOUNDATION_CAPTURE_READER,
    ]);
  });

  it("forwards the runner capture seam's own code when the assigned tree is gone", async () => {
    const { prepared, store } = await prepare("root-gone");
    rmSync(prepared.assignment.realWorktreePath, {
      force: true, maxRetries: 20, recursive: true, retryDelay: 250,
    });

    const answer = producerOver(store)(callSite(prepared));

    // POSITIVE CONTROL FIRST. Every assertion below is a `not.toBe` / a
    // `not.toContain`, and an ACCEPTED answer satisfies all of them vacuously —
    // this is the arm that makes the rest of the case mean anything.
    expect((answer as Record<string, unknown>)["ok"]).toBe(false);
    const [code_, layer] = refusalOf(answer);
    // The runner decides; this module only carries. Which runner code fires
    // depends on how the observer trips first, so the LAYER is the pin and the
    // code is asserted to be the runner's vocabulary, never this module's.
    expect(layer).not.toBe(DAEMON_FOUNDATION_CAPTURE);
    expect(FOUNDATION_CAPTURE_PRODUCER_CODES).not.toContain(code_);
  });
});

describe("captureResult producer admits no caller-supplied result fact", CASE_TIMEOUT, () => {
  it("declares exactly the seven server-derived keys and no physical fact", () => {
    // The structural half of the no-minting bar: there is no field on this
    // input through which a root, a path set, a manifest or an authored list
    // could arrive. Every key is an identifier or this dispatch's own proof.
    expect([...FOUNDATION_CAPTURE_PRODUCER_INPUT_KEYS].sort()).toEqual([
      "attemptId", "baseIdentity", "captureRef", "nodeKey", "observation", "proof", "sessionId",
    ]);
  });

  const SMUGGLED = Object.freeze([
    ["assignedRealRoot", "C:/attacker/tree"], ["authoredPaths", ["scope/alpha.txt"]],
    ["declaredScopePaths", ["scope"]], ["inputManifest", { sha256: "0".repeat(64) }],
    ["resultTreeEntries", []], ["scopeObservation", { sha256: "0".repeat(64) }],
  ] as const);

  it.each(SMUGGLED)("refuses an input carrying a smuggled %s", async (key, planted) => {
    const { prepared, store } = await prepare(`smuggle-${key}`);
    authorInto(prepared, "alpha authored\n");

    const answer = producerOver(store)(callSite(prepared, { [key]: planted }));

    expect(refusalOf(answer)).toEqual([
      code("FOUNDATION_CAPTURE_PRODUCER_INPUT_INVALID"), DAEMON_FOUNDATION_CAPTURE,
    ]);
  });

  it("asserts the smuggling sweep actually generated cases", () => {
    expect(SMUGGLED.length).toBeGreaterThan(0);
    expect(IDENTITY_ARM_COUNT).toBeGreaterThan(0);
  });

  it("answers identically whatever the launch observation claims", async () => {
    const { prepared, store } = await prepare("smuggle-observation");
    authorInto(prepared, "alpha authored\n");
    const producer = producerOver(store);

    const honest = acceptedAnswer(producer(callSite(prepared)));
    // The launch observation IS on the input — the port hands it over — and it
    // is the one key the producer never reads. A hostile one names other paths,
    // other digests and another root; none of that may reach the answer, which
    // comes from a scan of the ASSIGNED tree under the durable record.
    const hostile = acceptedAnswer(producer(callSite(prepared, {
      observation: {
        authoredPaths: ["scope/beta.txt"], root: "C:/attacker/tree",
        resultTreeEntries: [{ byteLength: 1, path: "scope/beta.txt", sha256: "0".repeat(64) }],
        truthClass: "PROVEN",
      },
    })));

    expect(hostile).toEqual(honest);
  });

  it("refuses an input missing a required key", async () => {
    const { prepared, store } = await prepare("smuggle-missing");
    const input = callSite(prepared);
    delete input["proof"];

    expect(refusalOf(producerOver(store)(input))).toEqual([
      code("FOUNDATION_CAPTURE_PRODUCER_INPUT_INVALID"), DAEMON_FOUNDATION_CAPTURE,
    ]);
  });
});

const IDENTITY_ARM_COUNT = 4;

/**
 * PARALLEL ISOLATION, with the lesson from task-f146fa2e's QA reject baked in.
 *
 * TWO IDENTICAL REQUESTS ASSERTING `refs.size === 1` IS A DEDUP CONTROL, NOT AN
 * ISOLATION PROOF: with one identity a lexical capture and a module-level shared
 * `let` both produce one ref, and that exact shape let a sticky-ref mutant
 * survive 3492 green tests one task ago. So both arms here carry DISTINCT
 * identities — distinct attemptId, aggregate and session, so nothing can dedup
 * them — they share ONE store so a module-global would be reachable, and each
 * tree is authored with DIFFERENT bytes so an answer that came from the wrong
 * dispatch is visible in the digest rather than only in the ref.
 */
describe("captureResult producer parallel isolation", CASE_TIMEOUT, () => {
  const ALPHA = "authored by the first attempt\n";
  const BETA = "authored by the SECOND attempt, different length\n";

  async function preparedPair(): Promise<{
    readonly first: PreparedCapture; readonly second: PreparedCapture;
    readonly store: SqliteEventStore;
  }> {
    const fixture = repositoryFixture("parallel");
    const store = boundStore("parallel", fixture);
    const lifecycle = lifecycleOver(store, fixture);
    const prepareOne = async (slot: Readonly<Record<string, string>>): Promise<PreparedCapture> => {
      const answer = await lifecycle.prepareCapture({
        attemptAggregateId: slot["attemptAggregateId"] as string,
        attemptId: slot["attemptId"] as string, nodeKey: slot["nodeKey"] as string,
        projectId: PROJECT_ID, proposedBaseIdentity: fixture.head, proposedCwd: null,
        proposedEntries: [], requestDigest: slot["requestDigest"] as string,
        reservationDigest: slot["reservationDigest"] as string,
        sessionId: slot["sessionId"] as string,
      });
      if (!answer.ok) throw new Error(`prepare refused: ${answer.code}@${answer.layer}`);
      if (answer.proof === null) throw new Error("prepare returned no prelaunch proof");
      return answer;
    };
    const first = await prepareOne({
      ...SLOT, requestDigest: "1".repeat(64), reservationDigest: "2".repeat(64),
    });
    const second = await prepareOne({
      attemptAggregateId: "agg-producer-2", attemptId: "attempt-2", nodeKey: SLOT["nodeKey"],
      requestDigest: "3".repeat(64), reservationDigest: "4".repeat(64), sessionId: "session-2",
    });
    return { first, second, store };
  }

  it("keeps two concurrent captures on genuinely separate trees and answers", async () => {
    const { first, second, store } = await preparedPair();

    // The preparations are distinct BEFORE anything is captured, or the rest of
    // this case would be comparing one dispatch with itself.
    expect(first.captureRef).not.toBe(second.captureRef);
    expect(first.assignment.realWorktreePath).not.toBe(second.assignment.realWorktreePath);

    authorInto(first, ALPHA);
    authorInto(second, BETA);
    const producer = producerOver(store);
    const [answerOne, answerTwo] = await Promise.all([
      Promise.resolve().then(() => producer(callSite(first))),
      Promise.resolve().then(() => producer(callSite(second))),
    ]);

    const entriesOf = (answer: unknown): Map<string, string> => new Map(
      (acceptedAnswer(answer)["resultTreeEntries"] as readonly Record<string, unknown>[])
        .map((entry) => [String(entry["path"]), String(entry["sha256"])]));
    const one = entriesOf(answerOne), two = entriesOf(answerTwo);
    const digest = (bytes: string): string =>
      createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");

    // EACH ANSWER CARRIES ITS OWN TREE'S BYTES. A shared module-level record or
    // ref would hand one dispatch the other's scan, and these two digests are
    // different values rather than merely a set of size two — a swap passes a
    // distinctness check and fails this one.
    expect(one.get(DECLARED_PATHS[0])).toBe(digest(ALPHA));
    expect(two.get(DECLARED_PATHS[0])).toBe(digest(BETA));
    expect(one.get(DECLARED_PATHS[0])).not.toBe(two.get(DECLARED_PATHS[0]));
    // And the untouched sibling is byte-identical in both, so the difference
    // above is the authored path and not two unrelated scans.
    expect(one.get(DECLARED_PATHS[1])).toBe(two.get(DECLARED_PATHS[1]));
  });

  it("refuses to answer either dispatch from the other's durable record", async () => {
    const { first, second, store } = await preparedPair();
    authorInto(first, ALPHA);
    authorInto(second, BETA);
    const producer = producerOver(store);

    // The crossing attack, over ONE store where both records really exist: this
    // dispatch's identifiers against that dispatch's captureRef and proof.
    const crossed = producer(callSite(first, {
      captureRef: second.captureRef, proof: second.proof,
    }));

    expect(refusalOf(crossed)).toEqual([
      code("FOUNDATION_CAPTURE_PRODUCER_IDENTITY_MISMATCH"), DAEMON_FOUNDATION_CAPTURE,
    ]);
    // POSITIVE CONTROL: the same producer, same store, uncrossed, answers. A
    // producer that refused everything would satisfy the assertion above.
    expect(acceptedAnswer(producer(callSite(first)))["authoredPaths"])
      .toEqual([DECLARED_PATHS[0]]);
  });
});

/**
 * NO DURABLE SIDE EFFECT. The producer READS the capture context and scans a
 * tree; it is not a writer. Pinned because the opposite is easy to introduce
 * accidentally — a producer that committed anything would make a re-delivery a
 * second decision, and the dispatch replay path returns the stored attempt row
 * on the assumption that capture wrote nothing of its own.
 */
describe("captureResult producer writes nothing durable", CASE_TIMEOUT, () => {
  it("adds no event to the capture aggregate however often it answers", async () => {
    const { prepared, store } = await prepare("no-write");
    authorInto(prepared, "alpha authored\n");
    const aggregate = deriveFoundationCaptureAggregateId(prepared.captureRef);
    const before = store.readEvents(aggregate).length;
    expect(before).toBeGreaterThan(0);

    const producer = producerOver(store);
    acceptedAnswer(producer(callSite(prepared)));
    acceptedAnswer(producer(callSite(prepared)));

    expect(store.readEvents(aggregate).length).toBe(before);
  });

  it("re-scans on a second call rather than serving a stale cached answer", async () => {
    const { prepared, store } = await prepare("rescan");
    authorInto(prepared, "first authoring\n");
    const producer = producerOver(store);
    const before = acceptedAnswer(producer(callSite(prepared)));

    authorInto(prepared, "second authoring, different bytes\n");
    const after = acceptedAnswer(producer(callSite(prepared)));

    // The producer is NOT the replay layer — `dispatch()` short-circuits a
    // re-delivery on the stored attempt row and never reaches here. If this
    // answered from a cache it would be reporting a tree that no longer exists,
    // which is the same class of lie as trusting a caller's result bytes.
    const shaOf = (answer: Record<string, unknown>): string => String(
      (answer["resultTreeEntries"] as readonly Record<string, unknown>[])
        .find((entry) => entry["path"] === DECLARED_PATHS[0])?.["sha256"]);
    expect(shaOf(before)).not.toBe(shaOf(after));
    expect(shaOf(after)).toBe(createHash("sha256")
      .update(Buffer.from("second authoring, different bytes\n", "utf8")).digest("hex"));
  });
});
