import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_JSON_STRING_UTF8_BYTES, RUNTIME_COMMAND_ENVELOPE_VERSION,
} from "@moe/contracts";
import type { HttpDispatchPort } from "@moe/mcp";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "./daemon-store-dependencies.js";
import {
  ACTIVATION_AGGREGATE, CREDENTIAL as FOUNDATION_CREDENTIAL, DISPATCH_AGGREGATE,
  cleanupSeamHarnesses, commandRequest, dispatchPayload, seamHarness,
} from "./http/foundation-registry-fixtures.js";
import {
  PROJECTION,
  SNAPSHOT_CHECKPOINT,
  STATE_DIGEST,
  SUBSCRIBER,
  streamPort,
} from "./http/event-stream-fixtures.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { PROJECT_ID } from "./recovery/restore-test-harness.js";
import { FOUNDATION_ATTEMPT_MAX_REQUEST_BYTES } from "./work/foundation-attempt-codec.js";
import { readFoundationAttemptRecord } from "./work/foundation-attempt-service.js";

const CREDENTIAL = "mcp-operator-credential";
const PROJECT = "proj-mcp-port";

const directory = mkdtempSync(join(tmpdir(), "moe-mcp-port-"));
const storePath = join(directory, "store.db");
const provider = createStoreDependencies({
  clock: () => "2026-08-09T12:00:00.000Z",
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();
const subscriptions = provider.subscriptions?.();
if (subscriptions === undefined) throw new Error("provider serves no subscription port");

const port = createMcpDispatchPort({
  deps: provider.provide(),
  fallbackCredential: CREDENTIAL,
  subscriptions,
});

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
  cleanupSeamHarnesses();
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

function requestBytes(request: ReturnType<typeof commandRequest>): Uint8Array {
  if (!(request.body instanceof Uint8Array)) throw new Error("fixture body is not bytes");
  return request.body;
}

const LAUNCH_REFUSAL = process.platform === "win32"
  ? { code: "CLAUDE_RUNTIME_PATH_NOT_FILE", layer: "RUNTIME", truthClass: "SUSPECT" }
  : { code: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", layer: "LAUNCHER", truthClass: "UNKNOWN" };

describe("createMcpDispatchPort", () => {
  it("refuses an unknown credential with the registry code", () => {
    const outcome = port.authenticate("wrong", "goal.create");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("admits the operator credential", () => {
    expect(port.authenticate(CREDENTIAL, "goal.create")).toEqual({ ok: true });
  });

  it("dispatches a command through the committed adapter to a durable decision", async () => {
    const payload = { owner: "operator-local" };
    const envelope = {
      commandId: "cmd-mcp-register",
      commandKind: "project.register",
      correlationId: "corr-mcp-1",
      expectedVersion: 0,
      payload,
      requestDigest: createHash("sha256")
        .update(encoder.encode(JSON.stringify(payload))).digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL,
      targetAggregateId: PROJECT,
    };
    const answer = decode(await port.dispatchCommandBytes(encoder.encode(JSON.stringify(envelope))));
    expect(answer).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      ok: true,
      outcome: "ACCEPTED",
    });
  });

  it("dispatches the real async foundation service over MCP and records its evidence", async () => {
    const harness = seamHarness("mcp-valid");
    try {
      const dispatch = createMcpDispatchPort({
        deps: harness.deps, fallbackCredential: FOUNDATION_CREDENTIAL, subscriptions: streamPort(),
      });
      const answer = decode(await dispatch.dispatchCommandBytes(
        requestBytes(commandRequest({ commandId: "cmd-mcp-foundation" }))));
      expect(answer).toMatchObject({
        httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
        refusal: { code: LAUNCH_REFUSAL.code, layer: LAUNCH_REFUSAL.layer }, stage: "DISPATCH",
      });

      const reader = SqliteEventStore.openForProject(harness.storePath, PROJECT_ID);
      try {
        expect(reader.readEvents(ACTIVATION_AGGREGATE).map((event) => event.eventType))
          .toContain("EffectActivationCommitted");
        expect(reader.readEvents(DISPATCH_AGGREGATE).map((event) => event.eventType)).toEqual([
          "FoundationDispatchReserved", "FoundationAttemptRecorded",
        ]);
        const stored = readFoundationAttemptRecord(reader, ACTIVATION_AGGREGATE);
        expect(stored.ok).toBe(true);
        expect(stored.ok && stored.record).toMatchObject({
          reasonCode: LAUNCH_REFUSAL.code, reasonLayer: LAUNCH_REFUSAL.layer,
          resultManifest: null, truthClass: LAUNCH_REFUSAL.truthClass,
        });
      } finally {
        reader.close();
      }
    } finally {
      harness.close();
    }
  }, 30_000);

  it("forwards corrupted activation bytes to the foundation codec refusal over MCP", async () => {
    const harness = seamHarness("mcp-corrupt");
    try {
      const dispatch = createMcpDispatchPort({
        deps: harness.deps, fallbackCredential: FOUNDATION_CREDENTIAL, subscriptions: streamPort(),
      });
      const payload = dispatchPayload({
        bytesBase64: Buffer.from("not an activation envelope").toString("base64"),
      });
      const answer = decode(await dispatch.dispatchCommandBytes(
        requestBytes(commandRequest({ commandId: "cmd-mcp-corrupt", payload }))));
      expect(answer).toMatchObject({
        httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
        refusal: {
          code: "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", layer: "DAEMON_FOUNDATION_ATTEMPT",
        },
        stage: "DISPATCH",
      });
    } finally {
      harness.close();
    }
  });

  it("serves events.read as the SAME wire frame the HTTP listener serves, bigint and all", () => {
    // The committed ProjectRegistered above must come back as a serialisable PAGE.
    // The store's globalPosition is a bigint; the raw store page cannot cross
    // JSON.stringify, so a port that skipped the wire encoder answered every
    // successful read with UNKNOWN_ERROR — measured live on 2026-08-15.
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q1",
      payload: { limit: 10, projection: "moe.board", subscriberId: "control-room-1" },
      queryKind: "events.read",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ outcome: "PAGE" });
    const events = answer["events"] as readonly Record<string, unknown>[];
    expect(events.map((event) => event["eventType"])).toContain("ProjectRegistered");
    for (const event of events) {
      expect(typeof event["globalPosition"]).toBe("string");
      expect(event["seamObservation"]).toMatchObject({ observer: "DAEMON_SEAM" });
    }
    expect(typeof answer["checkpoint"]).toBe("string");
  });

  it("refuses an unregistered subscriber with the seam's own code, verbatim", () => {
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q1b",
      payload: { projection: "moe.board", subscriberId: "nobody" },
      queryKind: "events.read",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ code: "SUBSCRIPTION_NOT_REGISTERED", outcome: "REFUSED" });
  });

  it("refuses an out-of-bounds page limit before touching the port", () => {
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q1c",
      payload: { limit: 0, projection: "moe.board", subscriberId: "control-room-1" },
      queryKind: "events.read",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ code: "EVENT_STREAM_LIMIT_INVALID", outcome: "REFUSED" });
  });

  it("serves events.resume so a gapped durable subscriber can reseat over MCP", () => {
    // The recovery leg on THIS transport: same seam decision the HTTP route serves,
    // reached through the same subscription port the events.read branch already holds.
    const gapped = createMcpDispatchPort({
      deps: provider.provide(),
      fallbackCredential: CREDENTIAL,
      subscriptions: streamPort({ gap: "HISTORY_PRUNED" }),
    });
    const answer = decode(gapped.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q-resume",
      payload: {
        presentedCursor: { generation: 1, position: SNAPSHOT_CHECKPOINT },
        projection: PROJECTION,
        subscriberId: SUBSCRIBER,
      },
      queryKind: "events.resume",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toEqual({
      cursor: { generation: 1, position: SNAPSHOT_CHECKPOINT },
      outcome: "RESEATED",
      snapshot: {
        checkpoint: SNAPSHOT_CHECKPOINT,
        generation: 1,
        projection: PROJECTION,
        stateDigest: STATE_DIGEST,
      },
    });
  });

  it("forwards a no-gap resume refusal with the seam's own code over the real store", () => {
    // The production composition: control-room-1 reads a PAGE here, so no snapshot
    // cursor was ever issued and the seam must refuse rather than reseat blind.
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q-resume-nogap",
      payload: {
        presentedCursor: { generation: 1, position: "1" },
        projection: "moe.board",
        subscriberId: "control-room-1",
      },
      queryKind: "events.resume",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({
      code: "EVENT_STREAM_CURSOR_NOT_ISSUED", outcome: "REFUSED",
    });
  });

  it("refuses a malformed events.resume payload with the stable INPUT_INVALID", () => {
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q-resume-bad",
      payload: {
        presentedCursor: { generation: "1", position: 4 },
        projection: "moe.board",
        subscriberId: "control-room-1",
      },
      queryKind: "events.resume",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ error: { code: "INPUT_INVALID" }, ok: false });
  });

  it("refuses every other query kind with the stable INPUT_INVALID", () => {
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q2",
      payload: {},
      queryKind: "goal.list",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ error: { code: "INPUT_INVALID" }, ok: false });
  });
});

/**
 * THE TRANSPORT SEAM ITSELF, over production composition. Every port below is
 * `createMcpDispatchPort` over `createStoreDependencies` with a real store, so no
 * injected dispatcher decides auth, command or durable outcome — the clause DoD 1
 * actually makes. `foundation.dispatch` is the probe because it is the one wired
 * command whose async entry writes durable evidence a caller can count.
 */

const DIGEST64 = "a".repeat(64);

/** INPUT ONLY: the wire bytes, with any field overridable so the staleness and
 *  malformed arms can vary exactly one thing. No rule is re-implemented here. */
function foundationBytes(overrides: Readonly<Record<string, unknown>> = {}): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: "cmd-seam-probe",
    commandKind: "foundation.dispatch",
    correlationId: "corr-foundation",
    expectedVersion: 0,
    payload: dispatchPayload(),
    requestDigest: DIGEST64,
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: FOUNDATION_CREDENTIAL,
    targetAggregateId: ACTIVATION_AGGREGATE,
    ...overrides,
  }));
}

interface DurableCount {
  readonly decisions: number;
  readonly horizon: bigint;
}

/**
 * "Committed nothing" as a COUNT, read back from the store. A refusal that returned a
 * refusal shape while writing a row looks identical from the answer alone.
 */
function durableCount(path: string): DurableCount {
  const reader = SqliteEventStore.openForProject(path, PROJECT_ID);
  try {
    return {
      decisions: reader.readCommandDecisionsAfter(0n, 1_000).items.length,
      horizon: reader.readEventHorizon(),
    };
  } finally {
    reader.close();
  }
}

function dispatchEventTypes(path: string, aggregateId: string): readonly string[] {
  const reader = SqliteEventStore.openForProject(path, PROJECT_ID);
  try {
    return reader.readEvents(aggregateId).map((event) => event.eventType);
  } finally {
    reader.close();
  }
}

describe("the MCP transport seam over the production foundation command path", () => {
  it("answers stdio-shaped and HTTP-context delivery with byte-identical decisions", async () => {
    const stdio = seamHarness("mcp-parity-stdio");
    const http = seamHarness("mcp-parity-http");
    try {
      // The stdio arm carries ONE process identity as its fallback; the HTTP arm has
      // NO fallback at all, so its credential can only come from the request context.
      // Without that asymmetry both arms would run the same path and prove nothing.
      const stdioPort = createMcpDispatchPort({
        deps: stdio.deps, fallbackCredential: FOUNDATION_CREDENTIAL, subscriptions: streamPort(),
      });
      // HELD AS THE HTTP BRIDGE HOLDS IT (mcp-http/mcp-http-host.ts:129).
      // `createMcpDispatchPort` is declared `StdioDispatchPort`, whose
      // `dispatchCommandBytes(bytes)` takes no context; the HTTP MCP host holds the
      // SAME value as an `HttpDispatchPort` and passes a per-request bearer. Driving
      // it through the one-argument type would test the fallback, never the context.
      const httpPort = createMcpDispatchPort({
        deps: http.deps, subscriptions: streamPort(),
      }) as unknown as HttpDispatchPort;
      const bytes = foundationBytes({ commandId: "cmd-seam-parity" });
      const stdioAnswer = decoder.decode(await stdioPort.dispatchCommandBytes(bytes));
      const httpAnswer = decoder.decode(await httpPort.dispatchCommandBytes(
        bytes, { credential: FOUNDATION_CREDENTIAL }));

      // Pinned FIRST: two identical AUTHENTICATION_FAILED answers are also byte-identical.
      expect(JSON.parse(stdioAnswer)).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: LAUNCH_REFUSAL.code, layer: LAUNCH_REFUSAL.layer },
        stage: "DISPATCH",
      });
      expect(httpAnswer).toBe(stdioAnswer);
      for (const path of [stdio.storePath, http.storePath]) {
        expect(dispatchEventTypes(path, DISPATCH_AGGREGATE)).toEqual([
          "FoundationDispatchReserved", "FoundationAttemptRecorded",
        ]);
      }
    } finally {
      stdio.close();
      http.close();
    }
  }, 60_000);

  it("leaves one decision and one authority holder under duplicate concurrent delivery",
    async () => {
      const harness = seamHarness("mcp-duplicate");
      try {
        const dispatch = createMcpDispatchPort({
          deps: harness.deps, fallbackCredential: FOUNDATION_CREDENTIAL,
          subscriptions: streamPort(),
        });
        const bytes = foundationBytes({ commandId: "cmd-seam-duplicate" });
        const answers = (await Promise.all([
          dispatch.dispatchCommandBytes(bytes),
          dispatch.dispatchCommandBytes(bytes),
        ])).map((answer) => decode(answer));

        // ROW COUNTS FIRST, and the order is load-bearing rather than stylistic.
        // Measured under a mutation drill: a second durable reservation also changes
        // the code the winner answers with, so an earlier code assertion short-circuits
        // and the counts below never run. Asserted first, they are the assertion that
        // actually reddens, and "the second call did not throw" can never stand in for
        // "the second call wrote nothing".
        const reader = SqliteEventStore.openForProject(harness.storePath, PROJECT_ID);
        try {
          const dispatched = reader.readEvents(DISPATCH_AGGREGATE).map((row) => row.eventType);
          expect(dispatched.filter((type) => type === "FoundationDispatchReserved"))
            .toHaveLength(1);
          expect(dispatched.filter((type) => type === "FoundationAttemptRecorded"))
            .toHaveLength(1);
          const activated = reader.readEvents(ACTIVATION_AGGREGATE)
            .map((row) => row.eventType)
            .filter((type) => type === "EffectActivationCommitted");
          expect(activated).toHaveLength(1);
          const stored = readFoundationAttemptRecord(reader, ACTIVATION_AGGREGATE);
          expect(stored.ok && stored.record).toMatchObject({
            reasonCode: LAUNCH_REFUSAL.code, reasonLayer: LAUNCH_REFUSAL.layer,
          });
        } finally {
          reader.close();
        }

        // Exactly one launch, and the loser says WHY it did not launch. A second call
        // that merely "did not throw" is indistinguishable from a second launch.
        const codes = answers
          .map((answer) => (answer["refusal"] as Record<string, unknown>)["code"])
          .sort();
        expect(codes).toEqual(
          [LAUNCH_REFUSAL.code, "FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS"].sort());
      } finally {
        harness.close();
      }
    }, 60_000);

  it("commits nothing for advisory reads, including a command envelope at the read surface",
    () => {
      const harness = seamHarness("mcp-advisory");
      try {
        const dispatch = createMcpDispatchPort({
          deps: harness.deps, fallbackCredential: FOUNDATION_CREDENTIAL,
          subscriptions: streamPort(),
        });
        const before = durableCount(harness.storePath);
        const advisory = decode(dispatch.dispatchQueryBytes(encoder.encode(JSON.stringify({
          correlationId: "corr-advisory",
          payload: { projection: "moe.board", subscriberId: "control-room-1" },
          queryKind: "events.read",
          schemaVersion: "moe-runtime-query/1",
          sessionCredential: FOUNDATION_CREDENTIAL,
        }))));
        expect(advisory["outcome"]).not.toBe("ACCEPTED");
        // The same fully valid, fully credentialled command envelope that DOES commit on
        // the command entry: the read surface must refuse it rather than serve it.
        const smuggled = decode(dispatch.dispatchQueryBytes(
          foundationBytes({ commandId: "cmd-seam-advisory" })));
        expect(smuggled).toMatchObject({ error: { code: "INPUT_INVALID" }, ok: false });
        expect(durableCount(harness.storePath)).toEqual(before);
      } finally {
        harness.close();
      }
    });
});

describe("the MCP transport seam refuses hostile command bytes and commits nothing", () => {
  const harness = seamHarness("mcp-hostile");
  // ONE composition, held two ways, exactly as production holds it: the stdio entry
  // holds `StdioDispatchPort` and falls back to the process credential, while
  // `mcp-http/mcp-http-host.ts:129` holds the same value as an `HttpDispatchPort` and
  // passes a per-request bearer. Two ports would have been two authorities.
  const composed = createMcpDispatchPort({
    deps: harness.deps, fallbackCredential: FOUNDATION_CREDENTIAL, subscriptions: streamPort(),
  });
  const httpDispatch = composed as unknown as HttpDispatchPort;

  afterAll(() => {
    harness.close();
  });

  interface SeamRefusal {
    readonly answer: Record<string, unknown>;
    readonly transportsAgree: boolean;
    readonly wrote: boolean;
  }

  /**
   * Delivers the SAME bytes over both transports and reads the store before and
   * after: the refusal, its transport parity, AND the untouched ledger. A refusal
   * that returned a refusal shape while writing a row is invisible to the answer.
   */
  async function refusedOnBothTransports(bytes: Uint8Array): Promise<SeamRefusal> {
    const before = durableCount(harness.storePath);
    const viaStdio = decoder.decode(await composed.dispatchCommandBytes(bytes));
    const viaHttp = decoder.decode(await httpDispatch.dispatchCommandBytes(
      bytes, { credential: FOUNDATION_CREDENTIAL }));
    const after = durableCount(harness.storePath);
    return {
      answer: JSON.parse(viaStdio) as Record<string, unknown>,
      transportsAgree: viaHttp === viaStdio,
      wrote: after.decisions !== before.decisions || after.horizon !== before.horizon,
    };
  }

  it("refuses malformed JSON at the transport decode layer", async () => {
    const refused = await refusedOnBothTransports(encoder.encode("{ this is not json"));
    expect(refused.answer).toMatchObject({
      error: { code: "INPUT_INVALID" }, ok: false, outcome: "REFUSED", stage: "DECODE",
    });
    expect(refused.transportsAgree).toBe(true);
    expect(refused.wrote).toBe(false);
  });

  it("refuses an oversized activation payload at the transport bound, not the codec's",
    async () => {
      // The transport's 256 KiB string bound is STRICTLY TIGHTER than the foundation
      // codec's 1 MiB request ceiling once the bytes are base64-encoded, so that codec
      // ceiling is unreachable from this transport and DECODE always answers first.
      const base64CeilingLength = Math.ceil(FOUNDATION_ATTEMPT_MAX_REQUEST_BYTES / 3) * 4;
      expect(base64CeilingLength).toBeGreaterThan(MAX_JSON_STRING_UTF8_BYTES);

      const oversized = "A".repeat(MAX_JSON_STRING_UTF8_BYTES + 4);
      expect(oversized.length).toBeGreaterThan(MAX_JSON_STRING_UTF8_BYTES);
      const refused = await refusedOnBothTransports(foundationBytes({
        commandId: "cmd-seam-oversized",
        payload: dispatchPayload({ bytesBase64: oversized }),
      }));
      expect(refused.answer).toMatchObject({
        error: {
          code: "INPUT_LIMIT_EXCEEDED", details: { limitName: "JSON_STRING_UTF8_BYTES" },
        },
        ok: false, outcome: "REFUSED", stage: "DECODE",
      });
      expect(refused.transportsAgree).toBe(true);
      expect(refused.wrote).toBe(false);
    });

  it("refuses a stale envelope schema version at the transport decode layer", async () => {
    const refused = await refusedOnBothTransports(foundationBytes({
      commandId: "cmd-seam-stale", schemaVersion: "moe-runtime-command/0",
    }));
    expect(refused.answer).toMatchObject({
      error: {
        code: "SCHEMA_VERSION_UNSUPPORTED",
        details: { supportedSchemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION },
      },
      ok: false, outcome: "REFUSED", stage: "DECODE",
    });
    expect(refused.transportsAgree).toBe(true);
    expect(refused.wrote).toBe(false);
  });

  it("refuses a forged bearer at the authenticate layer, before any decode", async () => {
    // HTTP-ONLY BY CONSTRUCTION, and that is the finding rather than a gap: the stdio
    // entry has exactly one identity — the process credential it was started with — so
    // a forged bearer is only representable on the Streamable HTTP transport.
    const before = durableCount(harness.storePath);
    const answer = decode(await httpDispatch.dispatchCommandBytes(
      foundationBytes({ commandId: "cmd-seam-forged" }),
      { credential: "forged-operator-credential" }));
    expect(answer).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED" }, ok: false, outcome: "REFUSED",
      stage: "AUTHENTICATE",
    });
    expect(durableCount(harness.storePath)).toEqual(before);
  });
});
