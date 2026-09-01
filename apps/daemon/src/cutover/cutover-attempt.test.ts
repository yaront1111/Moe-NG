import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVATION_GENERATION_KEYS,
  GA_ACTIVATION_WORK_REF,
  GO_ACTIVATE_GATE_ID,
  admitActivationBinding,
  type ActivationBinding,
} from "@moe/benchmark";
import { reduceCutover } from "@moe/core";
import type { CutoverCommand, CutoverPreviewCommand } from "@moe/core";

import {
  DurableStoreError,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  SqliteEventStore,
  type CommandDecisionResponse,
  type CommitExpectedVersionDecisionInput,
  type StoredEvent,
} from "@moe/store";

import {
  CUTOVER_ATTEMPT_EVENT_TYPE,
  CUTOVER_ATTEMPT_LAYER,
  type CutoverAttemptStore,
  decodeCutoverAttemptEvent,
  deriveCutoverAttemptAggregateId,
  deriveCutoverDecisionId,
  encodeCutoverAttemptEvent,
} from "./cutover-attempt-contracts.js";
import { admitCutoverActivateApproval } from "./cutover-attempt-commit.js";
import { readCutoverAttemptState } from "./cutover-attempt-reader.js";

const PROJECT_ID = "project-cutover-attempt";
const SAFE_REF = /^[A-Za-z0-9._:/-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function binding(principalId = "human:yaron"): ActivationBinding {
  return Object.freeze({
    authority: Object.freeze({
      gateId: GO_ACTIVATE_GATE_ID,
      grant: Object.freeze({
        gateId: GO_ACTIVATE_GATE_ID,
        grantedAtEpochMs: 1_777_777_777_777,
        principalId,
        principalKind: "HUMAN" as const,
        workRef: GA_ACTIVATION_WORK_REF,
      }),
      workRef: GA_ACTIVATION_WORK_REF,
    }),
    decision: GO_ACTIVATE_GATE_ID,
    generations: Object.freeze({
      backupGenerationDigest: "a".repeat(64),
      distributionManifestSha256: "b".repeat(64),
      importGenerationSha256: "c".repeat(64),
      quiesceRecordSha256: "d".repeat(64),
    }),
    sourceCommit: "e".repeat(40),
  });
}

function previewCommand(): CutoverPreviewCommand {
  return Object.freeze({
    attemptId: "attempt-1",
    commandId: "preview-1",
    expectedVersion: 0,
    kind: "cutover.preview" as const,
    sourceManifestRef: "manifest-1",
    witness: Object.freeze({ inventoryRef: "inventory-1", truthClass: "DAEMON_VERIFIED" as const }),
  });
}

function storedEvent(
  sequence: number,
  command: import("@moe/core").CutoverCommand,
  eventType: string = CUTOVER_ATTEMPT_EVENT_TYPE,
): StoredEvent {
  return Object.freeze({
    aggregateId: deriveCutoverAttemptAggregateId(PROJECT_ID),
    aggregateSequence: sequence,
    commandId: command.commandId,
    committedAt: "2026-08-29T00:00:00.000Z",
    domainSchemaVersion: "moe-domain-schema/0",
    eventId: `cutover-event-${sequence}`,
    eventType,
    globalPosition: BigInt(sequence),
    metadata: new Uint8Array(),
    payload: encodeCutoverAttemptEvent({ admitted: null, command }),
    payloadCodecVersion: OPAQUE_PAYLOAD_CODEC_VERSION,
    recordVersion: EVENT_RECORD_VERSION,
    requestSha256: "f".repeat(64),
  });
}

function readerStore(events: readonly StoredEvent[], error?: Error): CutoverAttemptStore {
  return {
    commitExpectedVersionDecision: () => { throw new Error("unexpected commit"); },
    getCommandDecision: () => null,
    readEvents: () => {
      if (error !== undefined) throw error;
      return events;
    },
  };
}

function seedToImportVerified(store: SqliteEventStore): void {
  const commands: readonly CutoverCommand[] = [
    previewCommand(),
    { commandId: "quiesce-approval-1", expectedVersion: 1, kind: "cutover.admit_quiesce_approval",
      witness: { approvalRef: "quiesce-approval", truthClass: "HUMAN_APPROVED" } },
    { commandId: "begin-quiesce-1", expectedVersion: 2, kind: "cutover.begin_quiesce" },
    { commandId: "complete-quiesce-1", expectedVersion: 3, kind: "cutover.complete_quiesce",
      witness: { identicalManifestRef: "manifest-1", truthClass: "DAEMON_VERIFIED", writeLockRef: "lock-1" } },
    { commandId: "verify-import-1", expectedVersion: 4, kind: "cutover.verify_import",
      witness: { importHeadRef: "import-1", restoreDrillRef: "restore-1", truthClass: "DAEMON_VERIFIED" } },
  ];
  let state: import("@moe/core").CutoverAttemptState | undefined;
  const aggregateId = deriveCutoverAttemptAggregateId(PROJECT_ID);
  for (const [index, command] of commands.entries()) {
    const reduced = reduceCutover(state, command);
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) throw new Error(`seed refused ${reduced.error.code}`);
    expect(reduced.events[0]?.commandKind).toBe(command.kind);
    const payload = encodeCutoverAttemptEvent({ admitted: null, command });
    store.commit({
      aggregateId,
      commandBytes: payload,
      commandId: command.commandId,
      committedAt: "2026-08-29T00:00:00.000Z",
      events: [{ eventId: `seed-${index + 1}`, eventType: CUTOVER_ATTEMPT_EVENT_TYPE, payload }],
      expectedVersion: index,
    });
    state = reduced.state;
  }
  expect(state?.lifecycle).toBe("IMPORT_VERIFIED");
}

function withStore(run: (store: SqliteEventStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-cutover-attempt-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

interface StoreSpy extends CutoverAttemptStore {
  readonly calls: string[];
}

function spyStore(
  store: SqliteEventStore,
  commit?: (input: CommitExpectedVersionDecisionInput) => CommandDecisionResponse,
): StoreSpy {
  const calls: string[] = [];
  return {
    calls,
    commitExpectedVersionDecision(input) {
      calls.push("commitExpectedVersionDecision");
      return commit?.(input) ?? store.commitExpectedVersionDecision(input);
    },
    getCommandDecision(key) {
      calls.push("getCommandDecision");
      return store.getCommandDecision(key);
    },
    readEvents(aggregateId) {
      calls.push("readEvents");
      return store.readEvents(aggregateId);
    },
  };
}

function counts(store: SqliteEventStore): Readonly<{ decisions: number; events: number }> {
  return Object.freeze({
    decisions: store.readCommandDecisionsAfter(0n, 100).items.length,
    events: store.readEvents(deriveCutoverAttemptAggregateId(PROJECT_ID)).length,
  });
}

describe("cutover attempt contracts", () => {
  it("derives a server-owned aggregate id from the project alone", () => {
    const first = deriveCutoverAttemptAggregateId(PROJECT_ID);
    const bindings = [binding(), binding("human:other")];
    const ids = bindings.map(() => deriveCutoverAttemptAggregateId(PROJECT_ID));

    expect(bindings.map((value) => value.authority.grant?.principalId))
      .toEqual(["human:yaron", "human:other"]);
    expect(ids).toEqual([first, first]);
    expect(deriveCutoverAttemptAggregateId("project-other")).not.toBe(first);
  });

  it("derives a bare reducer-safe decision id from every admitted binding fact", () => {
    const decisionId = deriveCutoverDecisionId(binding());

    expect(decisionId).toMatch(HEX64);
    expect(decisionId).toMatch(SAFE_REF);
    expect(decisionId).not.toBe(deriveCutoverDecisionId(binding("human:other")));
  });

  it("round-trips every preview event field through canonical bytes", () => {
    const admittedBinding = binding();
    const grant = admittedBinding.authority.grant;
    expect(grant).not.toBeNull();
    if (grant === null) return;
    const value = Object.freeze({
      admitted: Object.freeze({
        generations: admittedBinding.generations,
        grantedAtEpochMs: grant.grantedAtEpochMs,
        principalId: grant.principalId,
        sourceCommit: admittedBinding.sourceCommit,
      }),
      command: previewCommand(),
    });
    const bytes = encodeCutoverAttemptEvent(value);
    const decoded = decodeCutoverAttemptEvent(bytes);

    expect(CUTOVER_ATTEMPT_EVENT_TYPE).toBe("CutoverAttemptCommandApplied");
    expect(decoded).toEqual({ ok: true, value });
    expect(encodeCutoverAttemptEvent(value)).toEqual(bytes);
  });

  it.each([
    ["garbage", new TextEncoder().encode("not-json")],
    ["truncated", new TextEncoder().encode('{"admitted":null')],
  ])("refuses %s bytes as unreadable evidence", (_case, bytes) => {
    const decoded = decodeCutoverAttemptEvent(bytes);

    expect(decoded).toEqual({
      code: "CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE",
      layer: CUTOVER_ATTEMPT_LAYER,
      ok: false,
      storeCode: null,
    });
  });
});

describe("cutover attempt reader", () => {
  it("returns the stable absent result for a fresh aggregate", () => {
    expect(readCutoverAttemptState(readerStore([]), { projectId: PROJECT_ID })).toEqual({
      code: "CUTOVER_ATTEMPT_STATE_ABSENT",
      layer: CUTOVER_ATTEMPT_LAYER,
      status: "ABSENT",
    });
  });

  it("folds stored commands through the production reducer", () => {
    const result = readCutoverAttemptState(
      readerStore([storedEvent(1, previewCommand())]),
      { projectId: PROJECT_ID },
    );

    expect(result).toMatchObject({
      admitted: null,
      state: { attemptId: "attempt-1", lifecycle: "PREVIEWED", version: 1 },
      status: "PRESENT",
      version: 1,
    });
  });

  it("preserves the durable store code when evidence cannot be read", () => {
    const result = readCutoverAttemptState(
      readerStore([], new DurableStoreError("STORE_CLOSED", "closed by test")),
      { projectId: PROJECT_ID },
    );

    expect(result).toEqual({
      code: "CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE",
      layer: CUTOVER_ATTEMPT_LAYER,
      status: "UNREADABLE",
      storeCode: "STORE_CLOSED",
    });
  });

  it("forwards the reducer code and layer for an illegal stored edge", () => {
    const preview = previewCommand();
    const illegal = Object.freeze({
      commandId: "activate-too-soon",
      expectedVersion: 1,
      kind: "cutover.activate" as const,
    });
    const result = readCutoverAttemptState(
      readerStore([storedEvent(1, preview), storedEvent(2, illegal)]),
      { projectId: PROJECT_ID },
    );

    expect(result).toMatchObject({
      code: "ILLEGAL_TRANSITION",
      layer: "CUTOVER",
      status: "UNREADABLE",
      storeCode: null,
    });
  });

  it("refuses a non-contiguous aggregate sequence at the daemon layer", () => {
    const result = readCutoverAttemptState(
      readerStore([storedEvent(2, previewCommand())]),
      { projectId: PROJECT_ID },
    );

    expect(result).toEqual({
      code: "CUTOVER_ATTEMPT_SEQUENCE_INVALID",
      layer: CUTOVER_ATTEMPT_LAYER,
      status: "UNREADABLE",
      storeCode: null,
    });
  });

  it("refuses an unexpected event type distinctly", () => {
    const result = readCutoverAttemptState(
      readerStore([storedEvent(1, previewCommand(), "OtherEvent")]),
      { projectId: PROJECT_ID },
    );

    expect(result).toEqual({
      code: "CUTOVER_ATTEMPT_EVENT_TYPE_UNEXPECTED",
      layer: CUTOVER_ATTEMPT_LAYER,
      status: "UNREADABLE",
      storeCode: null,
    });
  });

  it("refuses record identity that disagrees with the encoded command", () => {
    const event = storedEvent(1, previewCommand());
    const variants: readonly StoredEvent[] = [
      { ...event, aggregateId: "foreign-aggregate" },
      { ...event, commandId: "foreign-command" },
    ];
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(readCutoverAttemptState(readerStore([variant]), { projectId: PROJECT_ID })).toEqual({
        code: "CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE",
        layer: CUTOVER_ATTEMPT_LAYER,
        status: "UNREADABLE",
        storeCode: null,
      });
    }
  });
});

describe("cutover activate approval writer", () => {
  it("appends exactly one admitted approval event and one decision", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const candidate = binding();
      const grant = candidate.authority.grant;
      expect(grant).not.toBeNull();
      if (grant === null) return;
      const aggregateId = deriveCutoverAttemptAggregateId(PROJECT_ID);
      const before = store.readEvents(aggregateId);
      const decisionsBefore = store.readCommandDecisionsAfter(0n, 100).items;

      const result = admitCutoverActivateApproval(store, {
        correlationId: "cutover-correlation-1",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: candidate,
      });

      expect(result).toMatchObject({ disposition: "COMMITTED", ok: true });
      const after = store.readEvents(aggregateId);
      expect(after.length).toBe(before.length + 1);
      const head = decodeCutoverAttemptEvent(after.at(-1)?.payload);
      expect(head.ok && head.value.command.kind).toBe("cutover.admit_activate_approval");
      const folded = readCutoverAttemptState(store, { projectId: PROJECT_ID });
      expect(folded.status).toBe("PRESENT");
      if (folded.status !== "PRESENT") return;
      const decisionId = deriveCutoverDecisionId(candidate);
      expect(folded.state.lifecycle).toBe("ACTIVATE_APPROVED");
      expect(folded.state.version).toBe(before.length + 1);
      expect(folded.state.activateApprovalRef).toBe(decisionId);
      const decisionsAfter = store.readCommandDecisionsAfter(0n, 100).items;
      expect(decisionsAfter.length).toBe(decisionsBefore.length + 1);
      expect(store.getCommandDecision({
        commandId: decisionId,
        principalId: grant.principalId,
        projectId: PROJECT_ID,
      })?.effectDisposition).toBe("EFFECTS_COMMITTED");
    });
  });

  it("replays from the durable fold without growing either ledger", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const candidate = binding();
      const input = {
        correlationId: "cutover-correlation-replay",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: candidate,
      };
      const first = admitCutoverActivateApproval(store, input);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const before = counts(store);
      const spy = spyStore(store);

      const replay = admitCutoverActivateApproval(spy, input);

      expect(replay).toMatchObject({ disposition: "REPLAYED", ok: true });
      if (!replay.ok) return;
      expect(replay.state.lifecycle).toBe("ACTIVATE_APPROVED");
      expect(replay.state).not.toBe(first.state);
      expect(counts(store)).toEqual(before);
      expect(spy.calls).toEqual([
        "readEvents",
        "getCommandDecision",
        "commitExpectedVersionDecision",
        "readEvents",
      ]);
    });
  });

  it("refuses replay when the re-read approval ref diverges", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const candidate = binding();
      const input = {
        correlationId: "cutover-correlation-diverged",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: candidate,
      };
      expect(admitCutoverActivateApproval(store, input).ok).toBe(true);
      let reads = 0;
      const spy = spyStore(store);
      const divergent: StoreSpy = {
        ...spy,
        readEvents(aggregateId) {
          spy.calls.push("readEvents");
          const events = store.readEvents(aggregateId);
          reads += 1;
          if (reads !== 2) return events;
          const head = events.at(-1);
          const decoded = decodeCutoverAttemptEvent(head?.payload);
          if (head === undefined || !decoded.ok) throw new Error("fixture event unreadable");
          const command = decoded.value.command;
          if (command.kind !== "cutover.admit_activate_approval") throw new Error("fixture edge wrong");
          const changed = {
            ...command,
            witness: { ...command.witness, approvalRef: "0".repeat(64) },
          };
          const payload = encodeCutoverAttemptEvent({ admitted: decoded.value.admitted, command: changed });
          return [...events.slice(0, -1), { ...head, payload }];
        },
      };

      const replay = admitCutoverActivateApproval(divergent, input);

      expect(replay).toEqual({
        code: "CUTOVER_ATTEMPT_REPLAY_DIVERGED",
        layer: CUTOVER_ATTEMPT_LAYER,
        ok: false,
        storeCode: null,
      });
      expect(divergent.calls).toEqual([
        "readEvents",
        "getCommandDecision",
        "commitExpectedVersionDecision",
        "readEvents",
      ]);
    });
  });

  it("refuses replay when admitted bytes drift under a matching approval ref", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const candidate = binding();
      const input = {
        correlationId: "cutover-correlation-admitted-drift",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: candidate,
      };
      expect(admitCutoverActivateApproval(store, input).ok).toBe(true);
      let reads = 0;
      const spy = spyStore(store);
      const divergent: StoreSpy = {
        ...spy,
        readEvents(aggregateId) {
          spy.calls.push("readEvents");
          const events = store.readEvents(aggregateId);
          reads += 1;
          if (reads !== 2) return events;
          const head = events.at(-1);
          const decoded = decodeCutoverAttemptEvent(head?.payload);
          if (head === undefined || !decoded.ok || decoded.value.admitted === null) {
            throw new Error("fixture event unreadable");
          }
          const admitted = { ...decoded.value.admitted, sourceCommit: "6".repeat(40) };
          const payload = encodeCutoverAttemptEvent({ admitted, command: decoded.value.command });
          return [...events.slice(0, -1), { ...head, payload }];
        },
      };

      const replay = admitCutoverActivateApproval(divergent, input);

      expect(replay).toEqual({
        code: "CUTOVER_ATTEMPT_REPLAY_DIVERGED",
        layer: CUTOVER_ATTEMPT_LAYER,
        ok: false,
        storeCode: null,
      });
      expect(divergent.calls).toEqual([
        "readEvents",
        "getCommandDecision",
        "commitExpectedVersionDecision",
        "readEvents",
      ]);
    });
  });

  it("forwards the reducer verdict for a different decision on the approved attempt", () => {
    withStore((store) => {
      seedToImportVerified(store);
      expect(admitCutoverActivateApproval(store, {
        correlationId: "cutover-correlation-first",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: binding(),
      }).ok).toBe(true);
      const before = counts(store);

      const second = admitCutoverActivateApproval(store, {
        correlationId: "cutover-correlation-other",
        decidedAt: "2026-08-29T00:00:02.000Z",
        projectId: PROJECT_ID,
        record: binding("human:other"),
      });

      expect(second.ok).toBe(false);
      if (second.ok || !("error" in second)) return;
      expect(second.layer).toBe("CUTOVER");
      expect(second.error.code).toBe("ILLEGAL_TRANSITION");
      expect(second.error.details?.["sourceState"]).toBe("ACTIVATE_APPROVED");
      expect(counts(store)).toEqual(before);
    });
  });

  it.each([
    [null, "ACTIVATION_BINDING_ABSENT", "GA_ACTIVATION_BINDING"],
    ["caller-shaped", "ACTIVATION_BINDING_SHAPE_INVALID", "GA_ACTIVATION_BINDING"],
    [{ ...binding(), decision: "GO_QUIESCE" }, "ACTIVATION_BINDING_DECISION_MISMATCH", "GA_ACTIVATION_BINDING"],
    [{ ...binding(), authority: { ...binding().authority, workRef: "task-wrong" } },
      "ACTIVATION_BINDING_WORK_MISMATCH", "GA_ACTIVATION_BINDING"],
    [{ ...binding(), generations: { ...binding().generations, backupGenerationDigest: "" } },
      "ACTIVATION_BINDING_GENERATION_UNBOUND", "GA_ACTIVATION_BINDING"],
    [{ ...binding(), authority: { ...binding().authority, grant: null } },
      "APPROVAL_HUMAN_AUTHORITY_REQUIRED", "HUMAN_AUTHORITY_GATE"],
  ])("forwards admission refusal %s before any store call", (record, code, layer) => {
    withStore((store) => {
      const before = counts(store);
      const spy = spyStore(store);

      const result = admitCutoverActivateApproval(spy, {
        correlationId: "cutover-correlation-refused",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record,
      });

      expect(result).toMatchObject({ code, layer, ok: false });
      expect(spy.calls).toEqual([]);
      expect(counts(store)).toEqual(before);
    });
  });

  it("blocks a generations-unbound caller before the store", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const before = counts(store);
      const spy = spyStore(store);
      const record = {
        ...binding(),
        generations: { ...binding().generations, backupGenerationDigest: "" },
      };

      const result = admitCutoverActivateApproval(spy, {
        correlationId: "cutover-correlation-unbound",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record,
      });

      expect(result).toMatchObject({
        code: "ACTIVATION_BINDING_GENERATION_UNBOUND",
        layer: "GA_ACTIVATION_BINDING",
        ok: false,
      });
      expect(spy.calls).toEqual([]);
      expect(counts(store)).toEqual(before);
    });
  });

  it("persists the admission snapshot generations and source commit byte for byte", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const record = {
        ...binding(),
        generations: Object.fromEntries(
          ACTIVATION_GENERATION_KEYS.map((key, index) => [key, String(index + 1).repeat(64)]),
        ),
        sourceCommit: "5".repeat(40),
      };
      const admitted = admitActivationBinding(record);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      expect(admitCutoverActivateApproval(store, {
        correlationId: "cutover-correlation-bytes",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record,
      }).ok).toBe(true);

      const head = store.readEvents(deriveCutoverAttemptAggregateId(PROJECT_ID)).at(-1);
      const decoded = decodeCutoverAttemptEvent(head?.payload);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok || decoded.value.admitted === null) return;
      expect(decoded.value.admitted.generations).toEqual(admitted.binding.generations);
      for (const key of ACTIVATION_GENERATION_KEYS) {
        expect(decoded.value.admitted.generations[key]).toBe(admitted.binding.generations[key]);
      }
      expect(decoded.value.admitted.sourceCommit).toBe(admitted.binding.sourceCommit);
    });
  });

  it("refuses a fold/store version desync with its local stable code", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const stable = [...store.readEvents(deriveCutoverAttemptAggregateId(PROJECT_ID))];
      let iterated = false;
      const unstable = new Proxy(stable, {
        get(target, property, receiver) {
          if (property === "length") return iterated ? target.length + 1 : target.length;
          if (property === "entries") {
            return function* entries() {
              for (const entry of target.entries()) yield entry;
              iterated = true;
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });

      const result = admitCutoverActivateApproval(readerStore(unstable), {
        correlationId: "cutover-correlation-version-desync",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: binding(),
      });

      expect(result).toEqual({
        code: "CUTOVER_ATTEMPT_VERSION_DESYNC",
        layer: CUTOVER_ATTEMPT_LAYER,
        ok: false,
        storeCode: null,
      });
    });
  });

  it.each([
    ["EXPECTED_VERSION_CONFLICT", "CUTOVER_ATTEMPT_EXPECTED_VERSION_CONFLICT"],
    ["STORE_INPUT_INVALID", "CUTOVER_ATTEMPT_FIELD_INVALID"],
    ["STORE_LIMIT_EXCEEDED", "CUTOVER_ATTEMPT_FIELD_INVALID"],
    ["STORE_CLOSED", "CUTOVER_ATTEMPT_STORE_UNAVAILABLE"],
  ] as const)("maps thrown %s without losing provenance", (storeCode, expectedCode) => {
    withStore((store) => {
      seedToImportVerified(store);
      const spy = spyStore(store, () => {
        throw new DurableStoreError(storeCode, "rejected by test");
      });

      const result = admitCutoverActivateApproval(spy, {
        correlationId: "cutover-correlation-store-error",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: binding(),
      });

      expect(result).toEqual({
        code: expectedCode,
        layer: CUTOVER_ATTEMPT_LAYER,
        ok: false,
        storeCode,
      });
    });
  });

  it("treats a returned non-effect decision as an expected-version refusal", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const spy = spyStore(store, (input) => store.commitExpectedVersionDecision({
        ...input,
        expectedVersion: input.expectedVersion - 1,
      }));

      const result = admitCutoverActivateApproval(spy, {
        correlationId: "cutover-correlation-returned-conflict",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: binding(),
      });

      expect(result).toEqual({
        code: "CUTOVER_ATTEMPT_EXPECTED_VERSION_CONFLICT",
        layer: CUTOVER_ATTEMPT_LAYER,
        ok: false,
        storeCode: "EXPECTED_VERSION_CONFLICT",
      });
    });
  });

  it("lets one interleaved writer win and returns the loser's fence code", () => {
    withStore((store) => {
      seedToImportVerified(store);
      const before = counts(store);
      let winner: ReturnType<typeof admitCutoverActivateApproval> | undefined;
      let interleaved = false;
      const port: CutoverAttemptStore = {
        commitExpectedVersionDecision(input) {
          if (!interleaved) {
            interleaved = true;
            winner = admitCutoverActivateApproval(store, {
              correlationId: "cutover-concurrent-winner",
              decidedAt: "2026-08-29T00:00:01.000Z",
              projectId: PROJECT_ID,
              record: binding("human:winner"),
            });
          }
          return store.commitExpectedVersionDecision(input);
        },
        getCommandDecision: (key) => store.getCommandDecision(key),
        readEvents: (aggregateId) => store.readEvents(aggregateId),
      };

      const loser = admitCutoverActivateApproval(port, {
        correlationId: "cutover-concurrent-loser",
        decidedAt: "2026-08-29T00:00:01.000Z",
        projectId: PROJECT_ID,
        record: binding("human:loser"),
      });

      expect(winner).toMatchObject({ disposition: "COMMITTED", ok: true });
      expect(loser).toEqual({
        code: "CUTOVER_ATTEMPT_EXPECTED_VERSION_CONFLICT",
        layer: CUTOVER_ATTEMPT_LAYER,
        ok: false,
        storeCode: "EXPECTED_VERSION_CONFLICT",
      });
      const after = counts(store);
      expect(after.events).toBe(before.events + 1);
      expect(after.decisions).toBe(before.decisions + 2);
    });
  });
});
