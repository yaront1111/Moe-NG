import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { proposedDecision } from "./command-decision-test-helpers.js";
import { DurableStoreError, SqliteEventStore } from "./index.js";
import {
  RECOVERY_BINDING_CODEC_LAYER,
  RECOVERY_BINDING_CODEC_VERSION,
  RECOVERY_INSTALL_REASON_CODES,
  RECOVERY_INSTALL_TRANSACTION_LAYER,
} from "./recovery-install-contracts.js";
import { RECOVERY_INITIAL_INSTALL_REASON_CODES } from "./recovery-initial-install-contracts.js";
import type { RecoveryInitialInstallResult } from "./recovery-initial-install-contracts.js";

const encoder = new TextEncoder();
const REF_X = "1a".repeat(32);
const REF_Y = "2b".repeat(32);
const KEY_EPOCH = "4d".repeat(32);
const PROJECT_ID = "recovery-initial-install-project";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-initial-install-${label}-`));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

function binding(
  slot: string,
  incarnationRef: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef,
    installedAt: "2026-08-14T09:00:00.000Z",
    keyEpochRef: KEY_EPOCH,
    payload: encoder.encode(`binding-for-${incarnationRef}`),
    slot,
    ...overrides,
  };
}

function refused(
  result: RecoveryInitialInstallResult,
  label: string,
): { readonly code: string; readonly layer: string } {
  expect(result.ok, `${label}: expected a refusal, got ${result.outcome}`).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, layer: result.layer };
}

/** The five authoritative history tables the pristine guard reads. */
const HISTORY_TABLES = Object.freeze([
  "command_decisions",
  "command_receipts",
  "domain_events",
  "aggregate_heads",
  "outbox_messages",
]);

function rowCounts(path: string): Readonly<Record<string, number>> {
  const database = new DatabaseSync(path);
  try {
    const counts: Record<string, number> = {};
    for (const table of HISTORY_TABLES) {
      const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
      counts[table] = Number((row as Record<string, unknown>)["total"]);
    }
    return counts;
  } finally {
    database.close();
  }
}

interface HistoryFixture {
  readonly assertPreState: (counts: Readonly<Record<string, number>>) => void;
  readonly label: string;
  readonly seed: (path: string) => void;
}

/**
 * Hand written, never generated: a swept table that silently produced nothing
 * would pass while proving nothing, so the count is asserted below.
 */
const historyFixtures: readonly HistoryFixture[] = [
  {
    assertPreState: (counts) => {
      for (const table of HISTORY_TABLES) {
        expect(counts[table], `${table} rows`).toBeGreaterThan(0);
      }
    },
    label: "one real committed decision",
    seed: (path) => {
      const store = SqliteEventStore.openForProject(path, PROJECT_ID);
      try {
        const response = store.commitExpectedVersionDecision(
          proposedDecision({
            key: {
              commandId: "genesis-history-command",
              principalId: "principal-1",
              projectId: PROJECT_ID,
            },
          }),
        );
        expect(response.disposition).toBe("DECIDED");
      } finally {
        store.close();
      }
    },
  },
  {
    // A plain event commit: no decision row and no outbox row, so the
    // command_decisions and outbox_messages legs are BOTH empty and only the
    // receipts/events/heads legs can answer. Without this fixture the sweep
    // could not tell a five-leg guard from a command_decisions-only one.
    //
    // MEASURED, and why this is not a raw single-table insert: validateSchema
    // (sqlite-schema-integrity.ts:89-129) cross-checks aggregate_heads against
    // domain_events, and PRAGMA foreign_key_check runs at line 24, so NO
    // authoritative history table can be populated in isolation and still be
    // reopened — a lone aggregate_heads row throws STORE_CORRUPT "aggregate
    // heads do not exactly match the event ledger" at open. The reachable
    // subsets are therefore produced through the production write surface.
    assertPreState: (counts) => {
      expect(counts["command_receipts"]).toBe(1);
      expect(counts["domain_events"]).toBe(1);
      expect(counts["aggregate_heads"]).toBe(1);
      expect(counts["command_decisions"]).toBe(0);
      expect(counts["outbox_messages"]).toBe(0);
    },
    label: "an event commit carrying no decision and no outbox",
    seed: (path) => {
      const store = SqliteEventStore.openForProject(path, PROJECT_ID);
      try {
        const result = store.commit({
          aggregateId: "genesis-history-goal",
          commandBytes: encoder.encode("goal.create/v1"),
          commandId: "genesis-history-commit",
          committedAt: "2026-08-14T08:00:00.000Z",
          events: [
            {
              eventId: "genesis-history-event",
              eventType: "goal.created",
              payload: encoder.encode("payload-1"),
            },
          ],
          expectedVersion: 0,
        });
        expect(result.currentVersion).toBe(1);
      } finally {
        store.close();
      }
    },
  },
];

describe("genesis recovery-binding initial install: refusal surface", () => {
  it("publishes a closed registry disjoint from the replacement installer's", () => {
    expect(RECOVERY_INITIAL_INSTALL_REASON_CODES).toEqual([
      "RECOVERY_INITIAL_INSTALL_SLOT_UNSUPPORTED",
      "RECOVERY_INITIAL_INSTALL_PENDING_PRESENT",
      "RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT",
      "RECOVERY_INITIAL_INSTALL_ALREADY_BOUND",
    ]);
    expect(new Set(RECOVERY_INITIAL_INSTALL_REASON_CODES).size).toBe(4);
    const shared: readonly string[] = RECOVERY_INSTALL_REASON_CODES;
    const overlap = RECOVERY_INITIAL_INSTALL_REASON_CODES.filter((code) =>
      shared.includes(code),
    );
    expect(overlap).toEqual([]);
    // The replacement registry must not have grown to absorb these codes.
    expect(RECOVERY_INSTALL_REASON_CODES.length).toBe(8);
  });

  it("refuses an unscoped handle before the codec ever inspects the record", () => {
    const store = SqliteEventStore.open(databasePath("unscoped"));
    try {
      for (const [label, input] of [
        ["well-formed binding", binding("ACTIVE", REF_X)],
        ["malformed binding", { slot: "ARCHIVE" }],
      ] as const) {
        const outcome = refused(store.installInitialRecoveryBinding(input), label);
        expect(outcome.code, label).toBe("RECOVERY_INSTALL_SCOPE_REQUIRED");
        expect(outcome.layer, label).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
      }
    } finally {
      store.close();
    }
  });

  it("refuses a malformed binding at the codec layer once the handle is scoped", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      for (const [label, input, code] of [
        [
          "extra key",
          binding("ACTIVE", REF_X, { authority: "GRANTED" }),
          "RECOVERY_BINDING_SHAPE_INVALID",
        ],
        [
          "unsupported codec version",
          binding("ACTIVE", REF_X, { bindingCodecVersion: "moe-recovery-binding/9" }),
          "RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED",
        ],
      ] as const) {
        const outcome = refused(store.installInitialRecoveryBinding(input), label);
        expect(outcome.code, label).toBe(code);
        expect(outcome.layer, label).toBe(RECOVERY_BINDING_CODEC_LAYER);
      }
      expect(store.readRecoveryBinding("ACTIVE").outcome).toBe("ABSENT");
    } finally {
      store.close();
    }
  });

  it("refuses a genesis binding that names the PENDING slot", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const outcome = refused(
        store.installInitialRecoveryBinding(binding("PENDING", REF_X)),
        "pending slot",
      );
      expect(outcome.code).toBe("RECOVERY_INITIAL_INSTALL_SLOT_UNSUPPORTED");
      expect(outcome.layer).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
      expect(store.readRecoveryBinding("ACTIVE").outcome).toBe("ABSENT");
      expect(store.readRecoveryBinding("PENDING").outcome).toBe("ABSENT");
    } finally {
      store.close();
    }
  });

  it("refuses while a PENDING binding is staged, and answers PENDING before ALREADY_BOUND", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      expect(store.installRecoveryBinding(binding("PENDING", REF_Y)).ok).toBe(true);
      // Pre-state: PENDING occupied, ACTIVE still empty, so only the PENDING
      // guard can answer this attempt.
      expect(store.readRecoveryBinding("PENDING").outcome).toBe("FOUND");
      expect(store.readRecoveryBinding("ACTIVE").outcome).toBe("ABSENT");

      const pendingOnly = refused(
        store.installInitialRecoveryBinding(binding("ACTIVE", REF_X)),
        "pending only",
      );
      expect(pendingOnly.code).toBe("RECOVERY_INITIAL_INSTALL_PENDING_PRESENT");
      expect(pendingOnly.layer).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
      expect(store.readRecoveryBinding("ACTIVE").outcome).toBe("ABSENT");

      expect(store.installRecoveryBinding(binding("ACTIVE", REF_X)).ok).toBe(true);
      expect(store.readRecoveryBinding("ACTIVE").outcome).toBe("FOUND");

      const bothSlots = refused(
        store.installInitialRecoveryBinding(binding("ACTIVE", "5e".repeat(32))),
        "both slots",
      );
      expect(bothSlots.code).toBe("RECOVERY_INITIAL_INSTALL_PENDING_PRESENT");
      expect(bothSlots.layer).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
    } finally {
      store.close();
    }
  });

  it("throws STORE_CLOSED on a closed handle rather than returning a refusal", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    store.close();
    let caught: unknown;
    try {
      store.installInitialRecoveryBinding(binding("ACTIVE", REF_X));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DurableStoreError);
    expect((caught as DurableStoreError).code).toBe("STORE_CLOSED");
  });
});

describe("genesis recovery-binding initial install: pristine history", () => {
  it("has exactly the two hand-written history fixtures", () => {
    expect(historyFixtures.length).toBe(2);
    expect(historyFixtures.map((fixture) => fixture.label)).toEqual([
      "one real committed decision",
      "an event commit carrying no decision and no outbox",
    ]);
  });

  for (const fixture of historyFixtures) {
    it(`refuses genesis over ${fixture.label}`, () => {
      const path = databasePath("history");
      fixture.seed(path);
      fixture.assertPreState(rowCounts(path));

      const store = SqliteEventStore.openForProject(path, PROJECT_ID);
      try {
        const outcome = refused(
          store.installInitialRecoveryBinding(binding("ACTIVE", REF_X)),
          fixture.label,
        );
        expect(outcome.code, fixture.label).toBe("RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT");
        expect(outcome.layer, fixture.label).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
        expect(store.readRecoveryBinding("ACTIVE").outcome, fixture.label).toBe("ABSENT");
      } finally {
        store.close();
      }
    });
  }
});

describe("genesis recovery-binding initial install: unreadable incumbent", () => {
  it("refuses tampered bytes at the codec layer rather than overwriting them", () => {
    const path = databasePath("tampered-bytes");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      expect(store.installRecoveryBinding(binding("ACTIVE", REF_Y)).ok).toBe(true);
    } finally {
      store.close();
    }

    const tamper = new DatabaseSync(path);
    try {
      const changed = tamper
        .prepare("UPDATE recovery_bindings SET binding_bytes = ? WHERE slot = ?")
        .run(encoder.encode("not-a-binding"), "ACTIVE");
      expect(Number(changed.changes)).toBe(1);
    } finally {
      tamper.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const outcome = refused(
        reopened.installInitialRecoveryBinding(binding("ACTIVE", REF_X)),
        "tampered bytes",
      );
      expect(outcome.code).toBe("RECOVERY_BINDING_DIGEST_MISMATCH");
      expect(outcome.layer).toBe(RECOVERY_BINDING_CODEC_LAYER);
    } finally {
      reopened.close();
    }

    const audit = new DatabaseSync(path);
    try {
      const row = audit
        .prepare("SELECT incarnation_ref FROM recovery_bindings WHERE slot = ?")
        .get("ACTIVE") as Record<string, unknown>;
      expect(row["incarnation_ref"]).toBe(REF_Y);
    } finally {
      audit.close();
    }
  });

  it("refuses a diverged indexed column at the transaction layer", () => {
    const path = databasePath("diverged-column");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      expect(store.installRecoveryBinding(binding("ACTIVE", REF_Y)).ok).toBe(true);
    } finally {
      store.close();
    }

    const tamper = new DatabaseSync(path);
    try {
      // Only the column moves; binding_bytes and binding_digest still agree, so
      // the codec cannot answer and the row cross-check must.
      const changed = tamper
        .prepare("UPDATE recovery_bindings SET incarnation_ref = ? WHERE slot = ?")
        .run("5e".repeat(32), "ACTIVE");
      expect(Number(changed.changes)).toBe(1);
    } finally {
      tamper.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const outcome = refused(
        reopened.installInitialRecoveryBinding(binding("ACTIVE", REF_X)),
        "diverged column",
      );
      expect(outcome.code).toBe("RECOVERY_BINDING_ROW_DIVERGED");
      expect(outcome.layer).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
    } finally {
      reopened.close();
    }

    const audit = new DatabaseSync(path);
    try {
      const row = audit
        .prepare("SELECT incarnation_ref FROM recovery_bindings WHERE slot = ?")
        .get("ACTIVE") as Record<string, unknown>;
      expect(row["incarnation_ref"]).toBe("5e".repeat(32));
    } finally {
      audit.close();
    }
  });
});

describe("genesis recovery-binding initial install: durable outcomes", () => {
  it("installs into a pristine store and survives a reopen", () => {
    const path = databasePath("durable");
    let digest: string;
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const result = store.installInitialRecoveryBinding(binding("ACTIVE", REF_X));
      expect(result.ok).toBe(true);
      if (!result.ok || result.outcome !== "INSTALLED") {
        throw new Error(`expected INSTALLED, got ${result.outcome}`);
      }
      expect(result.binding.incarnationRef).toBe(REF_X);
      expect(result.binding.slot).toBe("ACTIVE");
      digest = result.bindingDigest;
    } finally {
      store.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const active = reopened.readRecoveryBinding("ACTIVE");
      expect(active.ok).toBe(true);
      if (!active.ok || active.outcome !== "FOUND") {
        throw new Error(`expected FOUND, got ${active.outcome}`);
      }
      expect(active.binding.incarnationRef).toBe(REF_X);
      expect(active.bindingDigest).toBe(digest);
      expect(active.binding.payload).toEqual(encoder.encode(`binding-for-${REF_X}`));
      expect(reopened.readRecoveryBinding("PENDING").outcome).toBe("ABSENT");
    } finally {
      reopened.close();
    }
  });

  it("yields to an already-installed restore binding without touching its bytes", () => {
    const path = databasePath("restore-preservation");
    let restoreDigest: string;
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const restore = store.installRecoveryBinding(binding("ACTIVE", REF_Y));
      expect(restore.ok).toBe(true);
      if (!restore.ok) throw new Error("restore install must succeed");
      restoreDigest = restore.bindingDigest;

      const genesis = store.installInitialRecoveryBinding(binding("ACTIVE", REF_X));
      expect(genesis.ok).toBe(true);
      if (!genesis.ok || genesis.outcome !== "CURRENT") {
        throw new Error(`expected CURRENT, got ${genesis.outcome}`);
      }
      expect(genesis.authority).toBe("NONE");
      expect(genesis.code).toBe("RECOVERY_INITIAL_INSTALL_ALREADY_BOUND");
      expect(genesis.layer).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
      // The winner is the RESTORE's binding, never the caller's proposal.
      expect(genesis.binding.incarnationRef).toBe(REF_Y);
      expect(genesis.bindingDigest).toBe(restoreDigest);
      expect(genesis.binding.payload).toEqual(encoder.encode(`binding-for-${REF_Y}`));
    } finally {
      store.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const active = reopened.readRecoveryBinding("ACTIVE");
      expect(active.ok).toBe(true);
      if (!active.ok || active.outcome !== "FOUND") {
        throw new Error(`expected FOUND, got ${active.outcome}`);
      }
      expect(active.binding.incarnationRef).toBe(REF_Y);
      expect(active.bindingDigest).toBe(restoreDigest);
      expect(active.binding.payload).toEqual(encoder.encode(`binding-for-${REF_Y}`));
    } finally {
      reopened.close();
    }
  });
});

interface RaceResult {
  readonly bindingDigest?: string;
  readonly code?: string;
  readonly incarnationRef?: string;
  readonly initialInstallType?: string;
  readonly kind: string;
  readonly layer?: string;
  readonly ok?: boolean;
  readonly outcome?: string;
  readonly proposedRef?: string;
}

interface RaceWorker {
  readonly preOpenReady: Promise<void>;
  readonly ready: Promise<void>;
  readonly result: Promise<RaceResult>;
}

const RACE_DEADLINE_MILLISECONDS = 30_000;

/** Bounded: a worker that never reports fails by name instead of hanging. */
function withDeadline<Value>(promise: Promise<Value>, label: string): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`race worker never reported: ${label}`));
    }, RACE_DEADLINE_MILLISECONDS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function startRaceWorker(
  path: string,
  gate: SharedArrayBuffer,
  incarnationRef: string,
  label: string,
): RaceWorker {
  const worker = new Worker(
    new URL("./recovery-initial-install-race-worker.mjs", import.meta.url),
    {
      execArgv: ["--experimental-strip-types"],
      workerData: {
        bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
        databasePath: path,
        gate,
        incarnationRef,
        installedAt: "2026-08-14T09:00:00.000Z",
        keyEpochRef: KEY_EPOCH,
        projectId: PROJECT_ID,
      },
    },
  );
  let resolvePreOpenReady!: () => void;
  let resolveReady!: () => void;
  let resolveResult!: (value: RaceResult) => void;
  const rejecters: ((error: Error) => void)[] = [];
  const preOpenReady = new Promise<void>((resolve, reject) => {
    resolvePreOpenReady = resolve;
    rejecters.push(reject);
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejecters.push(reject);
  });
  const result = new Promise<RaceResult>((resolve, reject) => {
    resolveResult = resolve;
    rejecters.push(reject);
  });
  const rejectAll = (error: Error): void => {
    for (const reject of rejecters) reject(error);
  };
  worker.on("message", (message: RaceResult) => {
    if (message.kind === "PREOPEN_READY") resolvePreOpenReady();
    else if (message.kind === "READY") resolveReady();
    else if (message.kind === "RESULT") resolveResult(message);
  });
  worker.on("error", (error) => rejectAll(error));
  worker.on("exit", (code) => {
    if (code !== 0) rejectAll(new Error(`${label} exited with ${code}`));
  });
  return {
    preOpenReady: withDeadline(preOpenReady, `${label} PREOPEN_READY`),
    ready: withDeadline(ready, `${label} READY`),
    result: withDeadline(result, `${label} RESULT`),
  };
}

async function releaseRace(
  gate: SharedArrayBuffer,
  workers: readonly RaceWorker[],
): Promise<readonly RaceResult[]> {
  await Promise.all(workers.map((worker) => worker.preOpenReady));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, workers.length);
  await Promise.all(workers.map((worker) => worker.ready));
  Atomics.store(new Int32Array(gate), 1, 1);
  Atomics.notify(new Int32Array(gate), 1, workers.length);
  return Promise.all(workers.map((worker) => worker.result));
}

describe("genesis recovery-binding initial install: concurrent handles", () => {
  it("commits exactly one of two racing bindings and tells the loser the winner", async () => {
    const path = databasePath("race");
    SqliteEventStore.openForProject(path, PROJECT_ID).close();

    const gate = new SharedArrayBuffer(8);
    const results = await releaseRace(gate, [
      startRaceWorker(path, gate, REF_X, "race-left"),
      startRaceWorker(path, gate, REF_Y, "race-right"),
    ]);

    // The race actually executed: two workers, two reported results.
    expect(results.length).toBe(2);
    for (const result of results) {
      expect(result.initialInstallType, result.proposedRef).toBe("function");
    }
    expect(results.map((result) => result.outcome).sort()).toEqual(["CURRENT", "INSTALLED"]);
    expect(new Set(results.map((result) => result.proposedRef))).toEqual(
      new Set([REF_X, REF_Y]),
    );

    const winner = results.find((result) => result.outcome === "INSTALLED");
    const loser = results.find((result) => result.outcome === "CURRENT");
    if (winner === undefined || loser === undefined) throw new Error("unreachable");
    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(true);
    expect([REF_X, REF_Y]).toContain(winner.incarnationRef);
    expect(winner.incarnationRef).toBe(winner.proposedRef);
    // The loser is handed the winner's exact binding, not its own proposal.
    expect(loser.incarnationRef).toBe(winner.incarnationRef);
    expect(loser.bindingDigest).toBe(winner.bindingDigest);
    expect(loser.incarnationRef).not.toBe(loser.proposedRef);
    expect(loser.code).toBe("RECOVERY_INITIAL_INSTALL_ALREADY_BOUND");
    expect(loser.layer).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const active = reopened.readRecoveryBinding("ACTIVE");
      expect(active.ok).toBe(true);
      if (!active.ok || active.outcome !== "FOUND") {
        throw new Error(`expected FOUND, got ${active.outcome}`);
      }
      expect(active.binding.incarnationRef).toBe(winner.incarnationRef);
      expect(active.bindingDigest).toBe(winner.bindingDigest);
      expect(reopened.readRecoveryBinding("PENDING").outcome).toBe("ABSENT");
    } finally {
      reopened.close();
    }
  });
});
