/**
 * The restart reconciliation sweep ON THE REAL BOOT PATH — `startDaemon` driven
 * against the PRODUCTION dependency provider over a real file-backed store.
 *
 * Nothing here reimplements the sweep. The attempts are seeded through
 * `commitFoundationPhase`, the writer the dispatch path itself uses; the records
 * are read back with `readReconciliationRecords`, the reader the pure layer
 * exports; and the refusals are provoked by real durable conditions rather than
 * by a stub port answering a hand-written code. A fake port returning
 * `{code:"EXPECTED_VERSION_CONFLICT"}` would prove only that this file can type
 * a string.
 *
 * READINESS IS ASSERTED BY CONNECTING, not by reading the returned verdict. The
 * defect this suite exists to catch is a daemon that becomes READY after a
 * failed sweep, and the refusal object looks identical whether or not the
 * listener started.
 *
 * WINDOWS HANDLE DISCIPLINE: every store and every provider is closed in a
 * `finally` on every exit path. A handle held across the temp-directory cleanup
 * throws EPERM and kills the vitest worker with no output.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";
import { expect, it } from "vitest";

import { DAEMON_ENTRY_REFUSAL_CODES, startDaemon } from "./daemon-entry.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import {
  RESTART_RECONCILIATION_COMMAND_KIND, readReconciliationRecords, reconciliationAggregateId,
} from "./recovery/restart-reconciliation.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_ATTEMPT_RECORD_VERSION, FOUNDATION_RESERVATION_VERSION,
  deriveDispatchAggregateId, encodeFoundationPayload,
} from "./work/foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./work/foundation-attempt-contracts.js";
import { commitFoundationPhase } from "./work/foundation-attempt-store.js";
import { readInFlightFoundationAttempts } from "./work/in-flight-attempts.js";

const PROJECT_ID = "proj-boot-reconcile";
const PRINCIPAL_ID = "operator-local";
const CREDENTIAL = "boot-reconcile-credential";
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
const encoder = new TextEncoder();

type Provider = ReturnType<typeof createStoreDependencies>;

const digestOf = (value: string): string => createHash("sha256").update(value).digest("hex");

async function withDirectory(name: string, run: (storePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `moe-boot-reconcile-${name}-`));
  try {
    await run(join(directory, "store.sqlite"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/** A short-lived second handle, so nothing this file opens outlives its assertion. */
function withStore<T>(storePath: string, run: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

/**
 * The provider is built BEFORE anything is seeded, because that is the real
 * order: a daemon installs its genesis recovery binding on a store with no
 * history, and `installInitialRecoveryBinding` refuses with
 * `RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT` if events already exist. Seeding
 * first would test a store no daemon can own.
 */
async function withProvider(storePath: string, run: (provider: Provider) => Promise<void>): Promise<void> {
  const provider = createStoreDependencies({
    clock: () => DECIDED_AT,
    credential: CREDENTIAL,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    storePath,
  });
  try {
    await run(provider);
  } finally {
    provider.close();
  }
}

function boundFor(slug: string): FoundationAttemptBound {
  return Object.freeze({
    aggregateId: `attempt-${slug}`, claim: {}, commandId: `command-${slug}`,
    correlationId: `correlation-${slug}`, nodeKey: `node-${slug}`, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: `session-${slug}`,
    target: deriveDispatchAggregateId(`attempt-${slug}`),
  });
}

/** The exact reservation body `foundation-attempt-service.ts` commits. */
function reservationBytes(slug: string): Uint8Array {
  const encoded = encodeFoundationPayload({
    activationDigest: digestOf(`activation-${slug}`), attemptAggregateId: `attempt-${slug}`,
    attemptId: `attempt-id-${slug}`, grantId: `grant-${slug}`, nodeKey: `node-${slug}`,
    recordVersion: FOUNDATION_RESERVATION_VERSION, requestDigest: digestOf(`request-${slug}`),
    sessionId: `session-${slug}`,
  });
  if (!encoded.ok) throw new Error(`reservation fixture refused: ${encoded.code}`);
  return encoded.bytes;
}

function recordBytes(slug: string): Uint8Array {
  const encoded = encodeFoundationPayload({
    attemptAggregateId: `attempt-${slug}`, recordVersion: FOUNDATION_ATTEMPT_RECORD_VERSION,
    truthClass: "PROVEN",
  });
  if (!encoded.ok) throw new Error(`record fixture refused: ${encoded.code}`);
  return encoded.bytes;
}

function commitPhase(
  store: SqliteEventStore, slug: string, tag: "RECORDED" | "RESERVED", bytes: Uint8Array,
  expectedVersion: number,
): void {
  const answer = commitFoundationPhase(
    store, boundFor(slug), tag, bytes, expectedVersion, `grant-${slug}:${tag}`);
  if (answer === null || answer.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`seed ${tag} refused for ${slug}`);
  }
}

const seedReserved = (store: SqliteEventStore, slug: string): void =>
  commitPhase(store, slug, "RESERVED", reservationBytes(slug), 0);

/**
 * A write on the attempt's reconciliation aggregate under ANOTHER command kind.
 * `readStored` counts only `reconciliation.decide` decisions, so this advances the
 * aggregate past the expectedVersion the reconciler will present — the real
 * durable condition behind `EXPECTED_VERSION_CONFLICT`, not a stubbed one.
 */
function seedForeignHistory(store: SqliteEventStore, attemptRef: string): void {
  const bytes = encoder.encode(JSON.stringify({ note: "foreign write on the same aggregate" }));
  store.commitExpectedVersionDecision({
    commandKind: "project.register",
    committedResultBytes: bytes,
    correlationId: "correlation-foreign",
    decidedAt: DECIDED_AT,
    events: [{ eventId: `foreign:${attemptRef}`, eventType: "ForeignHistoryWritten", payload: bytes }],
    expectedVersion: 0,
    key: { commandId: `command-foreign-${attemptRef}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: bytes,
    targetAggregateId: reconciliationAggregateId(attemptRef),
  });
}

/** The attempt refs the PRODUCTION enumerator answers, so a seed that produced nothing fails loudly. */
function inFlightRefs(storePath: string, expected: number): readonly string[] {
  const refs = withStore(storePath, (store) => {
    const sweep = readInFlightFoundationAttempts(store, PROJECT_ID);
    if (!sweep.ok) throw new Error(`fixture sweep refused: ${sweep.code}`);
    return sweep.attempts.map((attempt) => attempt.attemptRef);
  });
  expect(refs).toHaveLength(expected);
  return refs;
}

function reconciliationDecisions(storePath: string): readonly CommandDecisionRecord[] {
  return withStore(storePath, (store) => {
    const found: CommandDecisionRecord[] = [];
    let cursor = 0n;
    for (;;) {
      const page = store.readCommandDecisionsAfter(cursor, 200);
      for (const decision of page.items) {
        if (decision.commandKind === RESTART_RECONCILIATION_COMMAND_KIND) found.push(decision);
      }
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return found;
  });
}

const reconciliationDecisionCount = (storePath: string): number =>
  reconciliationDecisions(storePath).length;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Readiness as the network sees it. The returned verdict cannot tell us this. */
async function accepts(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

it("classifies every in-flight attempt on the real boot path and lands one durable record each", async () => {
  await withDirectory("classifies", async (storePath) => {
    let refs: readonly string[] = [];
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => {
        seedReserved(store, "alpha");
        seedReserved(store, "beta");
      });
      refs = inFlightRefs(storePath, 2);
      const started = await startDaemon({ dependencies: provider });
      if (!started.ok) throw new Error(`daemon refused to start: ${started.code}`);
      await started.shutdown();
    });

    const records = withStore(storePath, (store) => readReconciliationRecords(store, PROJECT_ID));
    expect(records.size).toBe(2);
    for (const ref of refs) {
      // A dispatch aggregate carries no crash observation, so the runner REFUSES
      // and the record is honestly UNKNOWN. That is the classification, not a gap.
      expect(records.get(ref)?.classification).toBe("REFUSED");
      expect(records.get(ref)?.truthClass).toBe("UNKNOWN");
    }
  });
}, 30_000);

it("refuses startup with the RECONCILER's own code and layer when the record cannot be committed", async () => {
  await withDirectory("conflict-code", async (storePath) => {
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => seedReserved(store, "conflicted"));
      const [attemptRef] = inFlightRefs(storePath, 1);
      withStore(storePath, (store) => seedForeignHistory(store, attemptRef as string));
      const result = await startDaemon({ dependencies: provider });
      expect(result).toStrictEqual({
        code: "EXPECTED_VERSION_CONFLICT",
        layer: "DURABLE_STORE",
        ok: false,
        source: "RESTART_RECONCILIATION",
      });
      if (result.ok) await result.shutdown();
    });
  });
}, 30_000);

it("does not accept connections after a conflict refuses the sweep", async () => {
  await withDirectory("conflict-ready", async (storePath) => {
    const port = await freePort();
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => seedReserved(store, "conflicted"));
      const [attemptRef] = inFlightRefs(storePath, 1);
      withStore(storePath, (store) => seedForeignHistory(store, attemptRef as string));
      const result = await startDaemon({ dependencies: provider, port });
      try {
        // The ONLY assertion here is readiness: a daemon that boots ready after a
        // failed sweep is the defect, and it is invisible to the returned verdict.
        expect(await accepts(port)).toBe(false);
      } finally {
        if (result.ok) await result.shutdown();
      }
    });
  });
}, 30_000);

it("refuses startup with the ENUMERATOR's own code and layer when the in-flight set is unreadable", async () => {
  await withDirectory("unreadable-code", async (storePath) => {
    await withProvider(storePath, async (provider) => {
      // A final record with no reservation means the reservation was LOST; the
      // enumerator refuses the whole sweep rather than dropping the attempt.
      withStore(storePath, (store) => commitPhase(store, "orphan", "RECORDED", recordBytes("orphan"), 0));
      const result = await startDaemon({ dependencies: provider });
      expect(result).toStrictEqual({
        code: "FOUNDATION_ATTEMPT_DISPATCH_SUSPECT",
        layer: DAEMON_FOUNDATION_ATTEMPT,
        ok: false,
        source: "IN_FLIGHT_SWEEP",
      });
      if (result.ok) await result.shutdown();
    });
  });
}, 30_000);

it("does not accept connections after an unreadable in-flight set refuses the sweep", async () => {
  await withDirectory("unreadable-ready", async (storePath) => {
    const port = await freePort();
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => commitPhase(store, "orphan", "RECORDED", recordBytes("orphan"), 0));
      const result = await startDaemon({ dependencies: provider, port });
      try {
        expect(await accepts(port)).toBe(false);
      } finally {
        if (result.ok) await result.shutdown();
      }
    });
  });
}, 30_000);

it("keeps the two refusal sources distinguishable and out of the entry vocabulary", async () => {
  const seen: Record<string, unknown>[] = [];
  await withDirectory("distinct-read", async (storePath) => {
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => commitPhase(store, "orphan", "RECORDED", recordBytes("orphan"), 0));
      const result = await startDaemon({ dependencies: provider });
      if (result.ok) await result.shutdown();
      seen.push(result as unknown as Record<string, unknown>);
    });
  });
  await withDirectory("distinct-commit", async (storePath) => {
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => seedReserved(store, "conflicted"));
      const [attemptRef] = inFlightRefs(storePath, 1);
      withStore(storePath, (store) => seedForeignHistory(store, attemptRef as string));
      const result = await startDaemon({ dependencies: provider });
      if (result.ok) await result.shutdown();
      seen.push(result as unknown as Record<string, unknown>);
    });
  });

  const [unreadable, conflicted] = seen;
  // "I could not read what was in flight" and "I could not durably record the
  // classification" are different facts with different remedies. Collapsing them
  // would leave an operator unable to tell which happened.
  expect(unreadable?.["code"]).not.toBe(conflicted?.["code"]);
  expect(unreadable?.["layer"]).not.toBe(conflicted?.["layer"]);
  expect(unreadable?.["source"]).not.toBe(conflicted?.["source"]);
  for (const refusal of seen) {
    expect(DAEMON_ENTRY_REFUSAL_CODES as readonly string[]).not.toContain(refusal["code"] as string);
    expect(refusal["layer"]).not.toBe("DAEMON_ENTRY");
  }
}, 60_000);

it("reconciles exactly once per start and writes no duplicate on the second boot", async () => {
  await withDirectory("once", async (storePath) => {
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => seedReserved(store, "solo"));
      inFlightRefs(storePath, 1);
      const first = await startDaemon({ dependencies: provider });
      if (!first.ok) throw new Error(`first start refused: ${first.code}`);
      await first.shutdown();
    });
    const afterFirst = reconciliationDecisionCount(storePath);
    expect(afterFirst).toBe(1);

    await withProvider(storePath, async (provider) => {
      const second = await startDaemon({ dependencies: provider });
      if (!second.ok) throw new Error(`second start refused: ${second.code}`);
      await second.shutdown();
    });

    expect(reconciliationDecisionCount(storePath)).toBe(afterFirst);
    expect(withStore(storePath, (store) => readReconciliationRecords(store, PROJECT_ID)).size).toBe(1);
  });
}, 60_000);

it("starts a clean boot normally and writes no reconciliation records at all", async () => {
  await withDirectory("clean", async (storePath) => {
    await withProvider(storePath, async (provider) => {
      const started = await startDaemon({ dependencies: provider });
      if (!started.ok) throw new Error(`clean boot refused: ${started.code}`);
      try {
        expect(started.port).toBeGreaterThan(0);
        expect(await accepts(started.port)).toBe(true);
      } finally {
        await started.shutdown();
      }
    });
    // The control that stops this suite passing by refusing everything.
    expect(reconciliationDecisionCount(storePath)).toBe(0);
  });
}, 30_000);

it("attributes the reconciliation to the configured principal and project, never to a caller", async () => {
  await withDirectory("attribution", async (storePath) => {
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => seedReserved(store, "attributed"));
      inFlightRefs(storePath, 1);
      const started = await startDaemon({ dependencies: provider });
      if (!started.ok) throw new Error(`start refused: ${started.code}`);
      await started.shutdown();
    });

    const [decision] = reconciliationDecisions(storePath);
    expect(decision).toBeDefined();
    // `DaemonStartOptions` is {csrfToken, dependencies, host, log, port} — it can
    // express none of these. They come from the durable store configuration, and
    // a reconciliation attributed to a caller-named principal is a forged record.
    expect(decision?.key.principalId).toBe(PRINCIPAL_ID);
    expect(decision?.key.projectId).toBe(PROJECT_ID);
    // The decision time is the provider's clock, another boot fact. The raw
    // correlation is not stored (`correlationSha256` is), so this is the field
    // that can actually be read back and pinned.
    expect(decision?.decidedAt).toBe(DECIDED_AT);
  });
}, 30_000);

it("wires the sweep from the PRODUCTION store dependency root, not from a test fixture", async () => {
  await withDirectory("wired", async (storePath) => {
    await withProvider(storePath, async (provider) => {
      withStore(storePath, (store) => seedReserved(store, "wired"));
      const factory = provider.reconciliation;
      expect(typeof factory).toBe("function");
      const outcome = factory?.call(provider).sweep();
      expect(outcome).toStrictEqual({ classified: 1, ok: true });
    });
  });
}, 30_000);
