/**
 * The durable safe-boundary observation: a FACT ABOUT WHAT THE HOST SAW, not a
 * declaration that things are safe.
 *
 * `ExpansionReleaseEvidence` names `safeBoundaryObserved` and `observationRef` and nothing
 * in production wrote either. The field exists separately from the terminality flags for
 * one reason: an agent must not be able to assert its own boundary was observed. So every
 * case below drives the writer with attempt IDENTITY only, and the answer is derived from
 * the durable provider-run record the host committed.
 *
 * THE PINNED PREDICATE (measured in step 1, restated here because the tests encode it):
 * TRUE only when the record decodes AND `launch.truthClass === "PROVEN"` AND `launch.exit`
 * is `EXITED` or `SIGNALLED` AND `terminal !== "UNKNOWN"` AND `launch.completedAt !== null`.
 * `ClaudeLaunchExit` has a third arm — `{kind: "UNOBSERVED"}` — which is NON-NULL and means
 * the host did NOT see the boundary crossed, so `exit !== null` alone would return true on
 * the one value that denies observation. Record present but a clause failing is FALSE;
 * record absent or unreadable is a typed UNKNOWN refusal that records nothing.
 *
 * Everything durable here goes through production: `runEffectActivateCommand` for the
 * activation the reader binds against, and `commitProviderRunRecord` for the run. The
 * activation body is copied from the provider-run reader suite, which copied it from the
 * attempt-reader suite that owns the canonical shape — nothing here computes a grant, a
 * digest or an aggregate id, because the ingress doing that is what makes the bytes
 * evidence instead of a fixture agreeing with itself.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderFactUnknown, ProviderRunRef } from "@moe/runner";
import type { CommandDecisionKey, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  PROVIDER_RUN_RECORD_VERSION,
} from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import {
  SAFE_BOUNDARY_OBSERVATION_LAYER, readSafeBoundaryObservation, recordSafeBoundaryObservation,
} from "./safe-boundary-observation.js";
import type {
  SafeBoundaryObservationInput, SafeBoundaryStore,
} from "./safe-boundary-observation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
/** Wall SECONDS; the scheduler's overdue rule is `seconds > deadline`. */
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;

const ATTEMPT = "attempt-boundary";
const SESSION = "session-owner";
const EPOCH = 41;

interface ActivationSpec {
  readonly attemptId: string;
  readonly epoch: number;
  readonly sessionId: string;
  readonly slug: string;
}

function activationBytes(spec: ActivationSpec): Uint8Array {
  const { attemptId, epoch, sessionId, slug } = spec;
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: sessionId, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch, expectedVersion: 7, leaseToken: `token-${slug}`,
    ownerSessionRef: sessionId,
  } as const;
  const claim = {
    claimId: `claim-${slug}`, claimedAt: DECIDED_AT, intentId: `intent-${slug}`,
    lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${slug}`, attemptId, intentId: `intent-${slug}`,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${slug}`,
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId: `intent-${slug}`,
          leaseBinding: lease, predecessorCursor: `cursor-${slug}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: slug, slotRef: `held-${slug}`, state: "RESERVED" }],
      slot: {
        dimension: slug, requestId: `req-${slug}`, slotRef: `slot-${slug}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const blind: ProviderFactUnknown = {
  known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT",
};

const refOf = (slug: string): ProviderRunRef => ({
  provider: "claude", runRef: `run-${slug}`, effectIntentId: `intent-${slug}`,
  attemptRef: ATTEMPT, epoch: EPOCH,
});

/** The base record: a legal run the host never saw terminate. Each case narrows it. */
const recordOf = (slug: string, overrides: Partial<ProviderRunRecord> = {}): ProviderRunRecord => ({
  recordVersion: PROVIDER_RUN_RECORD_VERSION,
  providerRunRef: refOf(slug),
  launch: {
    kind: "REFUSED", truthClass: "UNKNOWN", reasonCode: null, reasonLayer: null, exit: null,
    effectDigest: null, activationDigest: null, runtimeBindingDigest: null,
    quotedRuntimeDigest: null, freshRuntimeDigest: null, pinnedClosureDigest: null,
    observationDigest: null, startedAt: null, completedAt: null,
  },
  declared: blind,
  observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
  terminal: "UNKNOWN",
  infrastructure: "EXIT_UNOBSERVED",
  tokens: {
    inputTokens: blind, outputTokens: blind, cacheCreationInputTokens: blind,
    cacheReadInputTokens: blind, coverage: "UNKNOWN",
  },
  steps: { turns: blind, coverage: "UNKNOWN" },
  sequence: { known: true, value: 3 },
  concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
  observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
  observedEnd: null,
  usage: [], usageRefusals: [], upstreamRefusal: null,
  stdoutReceiptDigest: { known: true, value: `stdout-${slug}` },
  stderrReceiptDigest: { known: true, value: `stderr-${slug}` },
  recordDigest: "",
  ...overrides,
});

/** A run the host DID see cross its boundary: proven truth, a real exit, a classified end. */
const observedRecord = (slug: string): ProviderRunRecord => recordOf(slug, {
  infrastructure: "NONE",
  launch: {
    ...recordOf(slug).launch,
    kind: "OBSERVED", truthClass: "PROVEN", exit: { kind: "EXITED", code: 0 },
    startedAt: DECIDED_AT, completedAt: DECIDED_AT,
  },
  terminal: "COMPLETED",
});

function openStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-safe-boundary-${label}-`));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

/** Activation first: the run reader binds the attempt before it reads any run page. */
function seedActivation(store: SqliteEventStore, slug: string): void {
  const outcome = runEffectActivateCommand(store, activationBytes({
    attemptId: ATTEMPT, epoch: EPOCH, sessionId: SESSION, slug,
  }));
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
}

function seedRun(store: SqliteEventStore, slug: string, record: ProviderRunRecord): void {
  const key: CommandDecisionKey = {
    commandId: `cmd-run-${slug}`, principalId: SESSION, projectId: PROJECT_ID,
  };
  const outcome = commitProviderRunRecord(store, {
    correlationId: `corr-run-${slug}`, decidedAt: DECIDED_AT, key, record,
    requestBytes: encoder.encode(`provider-run-request-${slug}`),
  });
  if (!outcome.ok) throw new Error(`provider run refused: ${outcome.code} at ${outcome.layer}`);
}

/** Identity and decision metadata only: no clock, no boundary field, nothing to claim. */
const inputFor = (slug: string): SafeBoundaryObservationInput => ({
  attemptRef: ATTEMPT,
  correlationId: `corr-boundary-${slug}`,
  key: { commandId: `cmd-boundary-${slug}`, principalId: SESSION, projectId: PROJECT_ID },
  projectId: PROJECT_ID,
  requestBytes: encoder.encode(`safe-boundary-request-${slug}`),
});

/** The real store behind the reader port, so a case can rewrite ONE method and nothing else. */
function delegate(store: SqliteEventStore): SafeBoundaryStore {
  return {
    commitExpectedVersionDecision: (input) => store.commitExpectedVersionDecision(input),
    getCommandDecision: (key) => store.getCommandDecision(key),
    getCommandReceipt: (commandId) => store.getCommandReceipt(commandId),
    getHealth: () => store.getHealth(),
    readEventHorizon: () => store.readEventHorizon(),
    readEvents: (aggregateId) => store.readEvents(aggregateId),
    readEventsByTypeAfter: (eventType, after, limit) =>
      store.readEventsByTypeAfter(eventType, after, limit),
  };
}

function countEvents(store: SqliteEventStore, aggregateId: string): number {
  return store.readEvents(aggregateId).length;
}

afterEach(cleanupRestoreHarnesses);

describe("recordSafeBoundaryObservation derives the boundary from the durable run", () => {
  it("records TRUE with a resolvable ref when the host observed the exit", () => {
    const store = openStore("observed");
    try {
      seedActivation(store, "observed");
      seedRun(store, "observed", observedRecord("observed"));

      const written = recordSafeBoundaryObservation(store, inputFor("observed"));

      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error(written.code);
      expect(written.observation.safeBoundaryObserved).toBe(true);
      expect(written.observation.observationRef).toMatch(/^[0-9a-f]{64}$/u);
      // Bound to the DURABLE record, never to anything the caller sent.
      expect(written.observation.providerRunRef).toEqual(refOf("observed"));
      expect(written.observation.recordDigest).toMatch(/^[0-9a-f]{64}$/u);
      // The instant comes off the DURABLE record, not off any clock or caller value.
      expect(written.observation.derivedAt).toBe(DECIDED_AT);
    } finally {
      store.close();
    }
  });

  it("records FALSE when the run exists but no exit was ever seen", () => {
    const store = openStore("no-exit");
    try {
      seedActivation(store, "no-exit");
      // Every other clause SATISFIED, so the red can only be the exit clause: the base
      // fixture also carries UNKNOWN truth, and truth answers first.
      const base = observedRecord("no-exit");
      seedRun(store, "no-exit", recordOf("no-exit", {
        infrastructure: base.infrastructure,
        launch: { ...base.launch, exit: null },
        terminal: base.terminal,
      }));

      const written = recordSafeBoundaryObservation(store, inputFor("no-exit"));

      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error(written.code);
      // The VALUE, not merely its presence: this is what blocks the release.
      expect(written.observation.safeBoundaryObserved).toBe(false);
      expect(written.observation.reasonCode).toBe("SAFE_BOUNDARY_EXIT_UNOBSERVED");
    } finally {
      store.close();
    }
  });

  it("records FALSE on the UNOBSERVED exit arm, which is non-null and denies observation", () => {
    const store = openStore("unobserved-arm");
    try {
      seedActivation(store, "unobserved-arm");
      const base = observedRecord("unobserved-arm");
      seedRun(store, "unobserved-arm", recordOf("unobserved-arm", {
        infrastructure: base.infrastructure,
        launch: { ...base.launch, exit: { kind: "UNOBSERVED" } },
        terminal: base.terminal,
      }));

      const written = recordSafeBoundaryObservation(store, inputFor("unobserved-arm"));

      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error(written.code);
      expect(written.observation.safeBoundaryObserved).toBe(false);
      expect(written.observation.reasonCode).toBe("SAFE_BOUNDARY_EXIT_UNOBSERVED");
    } finally {
      store.close();
    }
  });

  it("records FALSE when the launch truth is not PROVEN", () => {
    const store = openStore("weak-truth");
    try {
      seedActivation(store, "weak-truth");
      const base = observedRecord("weak-truth");
      seedRun(store, "weak-truth", recordOf("weak-truth", {
        infrastructure: base.infrastructure,
        launch: { ...base.launch, truthClass: "UNKNOWN" },
        terminal: base.terminal,
      }));

      const written = recordSafeBoundaryObservation(store, inputFor("weak-truth"));

      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error(written.code);
      expect(written.observation.safeBoundaryObserved).toBe(false);
      expect(written.observation.reasonCode).toBe("SAFE_BOUNDARY_TRUTH_INADEQUATE");
    } finally {
      store.close();
    }
  });

  it("records FALSE when the exit was seen but the terminal was never classified", () => {
    const store = openStore("terminal-unknown");
    try {
      seedActivation(store, "terminal-unknown");
      // Truth PROVEN and a real EXITED exit, so the two earlier clauses PASS and the only
      // clause left to answer is the terminal one. A host can watch a process leave and still
      // have no classified outcome for it, and that is not an observed safe boundary.
      const base = observedRecord("terminal-unknown");
      seedRun(store, "terminal-unknown", recordOf("terminal-unknown", {
        infrastructure: base.infrastructure,
        launch: base.launch,
        terminal: "UNKNOWN",
      }));

      const written = recordSafeBoundaryObservation(store, inputFor("terminal-unknown"));

      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error(written.code);
      expect(written.observation.safeBoundaryObserved).toBe(false);
      expect(written.observation.reasonCode).toBe("SAFE_BOUNDARY_TERMINAL_UNCLASSIFIED");
    } finally {
      store.close();
    }
  });

  it("records FALSE when every earlier clause passes but no end was ever recorded", () => {
    const store = openStore("end-unrecorded");
    try {
      seedActivation(store, "end-unrecorded");
      // The last clause, isolated: PROVEN truth, an EXITED exit and a COMPLETED terminal all
      // hold, and only `completedAt` is missing. Without an end instant there is no moment the
      // boundary can be said to have been crossed at.
      const base = observedRecord("end-unrecorded");
      seedRun(store, "end-unrecorded", recordOf("end-unrecorded", {
        infrastructure: base.infrastructure,
        launch: { ...base.launch, completedAt: null },
        terminal: base.terminal,
      }));

      const written = recordSafeBoundaryObservation(store, inputFor("end-unrecorded"));

      expect(written.ok).toBe(true);
      if (!written.ok) throw new Error(written.code);
      expect(written.observation.safeBoundaryObserved).toBe(false);
      expect(written.observation.reasonCode).toBe("SAFE_BOUNDARY_END_UNRECORDED");
    } finally {
      store.close();
    }
  });

  it("refuses with a typed UNKNOWN, and records nothing, when no run exists at all", () => {
    const store = openStore("absent");
    try {
      seedActivation(store, "absent");

      const written = recordSafeBoundaryObservation(store, inputFor("absent"));

      expect(written.ok).toBe(false);
      if (written.ok) throw new Error("an absent run must never become an observation");
      expect([written.code, written.layer])
        .toEqual(["SAFE_BOUNDARY_RUN_UNREADABLE", SAFE_BOUNDARY_OBSERVATION_LAYER]);
      expect(written.upstreamCode).not.toBe("");
    } finally {
      store.close();
    }
  });
});

/** Rail 1: an agent may not declare its own boundary safe. */
const FORBIDDEN_KEYS = ["safeBoundaryObserved", "observationRef", "boundaryClaim"] as const;

describe("no caller-supplied boundary claim is ever admitted", () => {
  it("refuses every forbidden key by exact-record admission and records nothing", () => {
    expect(FORBIDDEN_KEYS.length).toBeGreaterThan(0);
    const store = openStore("claim");
    try {
      seedActivation(store, "claim");
      seedRun(store, "claim", observedRecord("claim"));
      let refusals = 0;

      for (const key of FORBIDDEN_KEYS) {
        const written = recordSafeBoundaryObservation(store, {
          ...inputFor("claim"), [key]: true,
        } as unknown as SafeBoundaryObservationInput);

        expect(written.ok, key).toBe(false);
        if (written.ok) continue;
        expect([written.code, written.layer], key)
          .toEqual(["SAFE_BOUNDARY_INPUT_MALFORMED", SAFE_BOUNDARY_OBSERVATION_LAYER]);
        refusals += 1;
      }

      // The sweep must have actually generated its cases, not silently produced none.
      expect(refusals).toBe(FORBIDDEN_KEYS.length);
    } finally {
      store.close();
    }
  });
});

describe("readSafeBoundaryObservation resolves only refs that name a real observation", () => {
  it("returns the SAME observation the writer committed", () => {
    const store = openStore("resolve");
    try {
      seedActivation(store, "resolve");
      seedRun(store, "resolve", observedRecord("resolve"));
      const written = recordSafeBoundaryObservation(store, inputFor("resolve"));
      if (!written.ok) throw new Error(written.code);

      const read = readSafeBoundaryObservation(store, {
        observationRef: written.observation.observationRef, projectId: PROJECT_ID,
      });

      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.code);
      expect(read.observation).toEqual(written.observation);
    } finally {
      store.close();
    }
  });

  it("refuses bytes that no longer match the record, even when they still decode", () => {
    const store = openStore("tampered");
    try {
      seedActivation(store, "tampered");
      seedRun(store, "tampered", observedRecord("tampered"));
      const written = recordSafeBoundaryObservation(store, inputFor("tampered"));
      if (!written.ok) throw new Error(written.code);

      // Decodes fine and carries the same fields — only the BYTES differ, which is
      // exactly the drift a decode-only reader would answer from.
      const tampered: SafeBoundaryStore = {
        ...delegate(store),
        readEvents: (aggregateId) => store.readEvents(aggregateId).map((event) => ({
          ...event,
          payload: encoder.encode(` ${decoder.decode(event.payload)}`),
        })),
      };

      const read = readSafeBoundaryObservation(tampered, {
        observationRef: written.observation.observationRef, projectId: PROJECT_ID,
      });

      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("re-encoded bytes that differ must never be answered");
      expect([read.code, read.layer])
        .toEqual(["SAFE_BOUNDARY_OBSERVATION_UNREADABLE", SAFE_BOUNDARY_OBSERVATION_LAYER]);
    } finally {
      store.close();
    }
  });

  it("refuses a ref that names nothing rather than accepting it as an identifier", () => {
    const store = openStore("dangling");
    try {
      seedActivation(store, "dangling");
      seedRun(store, "dangling", observedRecord("dangling"));
      recordSafeBoundaryObservation(store, inputFor("dangling"));

      const read = readSafeBoundaryObservation(store, {
        observationRef: "b".repeat(64), projectId: PROJECT_ID,
      });

      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("a dangling ref must never resolve");
      expect([read.code, read.layer])
        .toEqual(["SAFE_BOUNDARY_OBSERVATION_ABSENT", SAFE_BOUNDARY_OBSERVATION_LAYER]);
    } finally {
      store.close();
    }
  });
});

describe("replay is byte-stable and appends nothing", () => {
  it("answers the same observation twice and writes exactly one event", () => {
    const store = openStore("replay");
    try {
      seedActivation(store, "replay");
      seedRun(store, "replay", observedRecord("replay"));
      const first = recordSafeBoundaryObservation(store, inputFor("replay"));
      if (!first.ok) throw new Error(first.code);
      const before = countEvents(store, first.aggregateId);

      const second = recordSafeBoundaryObservation(store, inputFor("replay"));

      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error(second.code);
      expect(second.observation.observationRef).toBe(first.observation.observationRef);
      expect(second.disposition).toBe("REPLAYED");
      expect(countEvents(store, first.aggregateId)).toBe(before);

      // A DIFFERENT caller over the SAME durable facts lands on the SAME aggregate, because
      // the ref identifies the observation and not the request. It therefore CONFLICTS
      // rather than committing a second truth — and a ref that varied with caller metadata
      // would land on a fresh aggregate and commit happily, which is the drift this pins.
      const other = recordSafeBoundaryObservation(store, {
        ...inputFor("replay"), correlationId: "corr-boundary-replay-other",
        key: { commandId: "cmd-boundary-other", principalId: SESSION, projectId: PROJECT_ID },
      });

      expect(other.ok).toBe(false);
      if (other.ok) throw new Error("a second caller must not commit a second observation");
      expect([other.code, other.layer])
        .toEqual(["SAFE_BOUNDARY_COMMIT_CONFLICT", SAFE_BOUNDARY_OBSERVATION_LAYER]);
      expect(countEvents(store, first.aggregateId)).toBe(before);
    } finally {
      store.close();
    }
  });
});
