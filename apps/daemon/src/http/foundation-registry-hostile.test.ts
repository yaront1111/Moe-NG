import { SqliteEventStore } from "@moe/store";
import type { RuntimeCommandKind } from "@moe/contracts";
import { afterAll, expect, it } from "vitest";

import { DomainRefusal } from "../daemon-command-dispatch.js";
import { PROJECT_ID } from "../recovery/restore-test-harness.js";
import { decodeBase64PayloadBytes, maxEncodedCharsFor } from "./command-payload-bytes.js";
import {
  ACTIVATION_AGGREGATE, DISPATCH_AGGREGATE, activationBytes, cleanupSeamHarnesses,
  commandRequest, dispatchPayload, seamHarness,
} from "./foundation-registry-fixtures.js";
import { handleAsyncCommandRequest, handleCommandRequest } from "./http-adapter.js";
import {
  ASYNC_ENTRY_REQUIRED_CODE, ASYNC_PORT_UNAVAILABLE_CODE, DAEMON_COMMAND_SEAM,
} from "./http-async-contract.js";
import type { CommandAdapterDeps, CommandRegistryEntry } from "./http-contract.js";

/**
 * The hostile matrix for `foundation.dispatch`: every arm asserts the exact code AND the
 * layer that answered, and every refusal arm asserts the store did not move.
 *
 * DoD 2's property is that a CORRUPTED TRANSPORT and a corrupted byte payload are
 * indistinguishable to a caller. That is asserted here by whole-object equality between
 * the two refusals rather than by comparing codes and hoping the rest matches.
 */

const MALFORMED = "FOUNDATION_ATTEMPT_REQUEST_MALFORMED";
const ATTEMPT_LAYER = "DAEMON_FOUNDATION_ATTEMPT";
const KIND = "foundation.dispatch" as RuntimeCommandKind;

afterAll(cleanupSeamHarnesses);

interface StoreCounts {
  readonly activation: number;
  readonly decisions: number;
  readonly dispatch: number;
}

function countsOf(storePath: string): StoreCounts {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    return {
      activation: reader.readEvents(ACTIVATION_AGGREGATE).length,
      decisions: reader.readCommandDecisionsAfter(0n, 1_000).items.length,
      dispatch: reader.readEvents(DISPATCH_AGGREGATE).length,
    };
  } finally {
    reader.close();
  }
}

const BASE64_OF_STRANGER = Buffer.from("not an activation envelope").toString("base64");

/** Every arm the seam itself can answer, with the value that triggers it. */
const BYTES_ARMS = [
  { name: "the base64 field is absent", payload: dispatchPayload({ omitBytes: true }) },
  { name: "the value is not a string", payload: dispatchPayload({ bytesBase64: 42 }) },
  { name: "the value is not canonical base64", payload: dispatchPayload({ bytesBase64: "QR==" }) },
  { name: "the value carries a stray character", payload: dispatchPayload({ bytesBase64: "QQ=A" }) },
  { name: "the value decodes to zero bytes", payload: dispatchPayload({ bytesBase64: "" }) },
  // DoD 2's own case: this one DECODES, so the transport admits it and the attempt
  // codec is what refuses the bytes underneath.
  { name: "the value decodes to bytes the codec rejects",
    payload: dispatchPayload({ bytesBase64: BASE64_OF_STRANGER }) },
] as const;

it("refuses every bytes arm with the codec's own code, and writes nothing", async () => {
  // A sweep that generated nothing would pass while asserting nothing.
  expect(BYTES_ARMS.length).toBeGreaterThan(0);

  const harness = seamHarness("bytes-matrix");
  try {
    const before = countsOf(harness.storePath);
    for (const arm of BYTES_ARMS) {
      const answer = await handleAsyncCommandRequest(harness.deps, commandRequest({
        commandId: `cmd-bytes-${arm.name.replace(/\s+/gu, "-")}`, payload: arm.payload,
      }));
      expect(answer, arm.name).toMatchObject({
        httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
        refusal: { code: MALFORMED, layer: ATTEMPT_LAYER }, stage: "DISPATCH",
      });
    }
    expect(countsOf(harness.storePath)).toStrictEqual(before);
  } finally {
    harness.close();
  }
}, 30_000);

it("answers a corrupted transport and a corrupted payload identically", async () => {
  const harness = seamHarness("indistinguishable");
  try {
    // Refused by the TRANSPORT: the string never becomes bytes.
    const transport = await handleAsyncCommandRequest(harness.deps, commandRequest({
      commandId: "cmd-arm-transport", payload: dispatchPayload({ bytesBase64: "QR==" }),
    }));
    // Refused by the CODEC: real bytes that are not a request the codec accepts.
    const codec = await handleAsyncCommandRequest(harness.deps, commandRequest({
      commandId: "cmd-arm-codec", payload: dispatchPayload({ bytesBase64: BASE64_OF_STRANGER }),
    }));

    // Whole-object equality: nothing in the answer says WHERE the value died.
    expect(transport).toStrictEqual(codec);
  } finally {
    harness.close();
  }
}, 30_000);

it("lets the OUTER bound answer an oversized base64 field, and says which layer did", async () => {
  const harness = seamHarness("oversized");
  try {
    // The envelope's own string bound (262_144 UTF-8 bytes) is far below the transport's
    // pre-decode ceiling, so a caller can never reach ENCODED_TOO_LARGE through the seam.
    // The bound that DOES answer is named here rather than left to look like the seam's.
    const oversized = "A".repeat(300_000);
    expect(oversized.length).toBeLessThan(maxEncodedCharsFor(1_048_576));

    const answer = await handleAsyncCommandRequest(harness.deps, commandRequest({
      commandId: "cmd-oversized", payload: dispatchPayload({ bytesBase64: oversized }),
    }));

    // MEASURED: the bounded JSON decoder's string limit answers, with its own limit code
    // at its own stage — not the transport's ceiling and not a generic INPUT_INVALID.
    expect(answer).toMatchObject({
      error: { code: "INPUT_LIMIT_EXCEEDED" }, ok: false, stage: "DECODE",
    });

    // The transport's own ceilings are real all the same, asserted at their own layer.
    expect(decodeBase64PayloadBytes("A".repeat(maxEncodedCharsFor(64) + 4), 64))
      .toStrictEqual({ ok: false, reason: "ENCODED_TOO_LARGE" });
    // Inside the encoded ceiling (8 chars for a 4-byte bound) and over the byte bound,
    // so this arm is the DECODED one and not the encoded one wearing its name.
    expect(decodeBase64PayloadBytes(Buffer.alloc(6).toString("base64"), 4))
      .toStrictEqual({ ok: false, reason: "DECODED_TOO_LARGE" });
  } finally {
    harness.close();
  }
}, 30_000);

/** Payload-surface cases, each declaring the layer that must answer it. */
const PAYLOAD_CASES = [
  { code: MALFORMED, layer: ATTEMPT_LAYER, name: "a section is missing",
    payload: { activationRequestBytesBase64: Buffer.from(activationBytes()).toString("base64") },
    stage: "DISPATCH" },
  { code: MALFORMED, layer: ATTEMPT_LAYER, name: "a section has the wrong type",
    payload: { ...dispatchPayload(), binding: "not-an-object" }, stage: "DISPATCH" },
  { code: "INPUT_INVALID", layer: null, name: "an unlisted key is smuggled in",
    payload: { ...dispatchPayload(), smuggled: 1 }, stage: "PAYLOAD_SHAPE" },
  // THE NARROWED ALLOW-LIST this task lands: the graph snapshot and the input manifest are
  // derived server-side, so a payload carrying either KEY is REFUSED at the seam rather than
  // overwritten downstream. A silently-ignored spoof is indistinguishable from an honoured
  // one at the call site, which is why this is an allow-list refusal and not a precedence rule.
  { code: "INPUT_INVALID", layer: null, name: "a caller-supplied graphSnapshot is refused",
    payload: { ...dispatchPayload(),
      graphSnapshot: { completionNodeKey: "dev-c", edges: [], nodes: [] } },
    stage: "PAYLOAD_SHAPE" },
  { code: "INPUT_INVALID", layer: null, name: "a caller-supplied inputManifest is refused",
    payload: { ...dispatchPayload(),
      inputManifest: { baseIdentity: "0".repeat(64), entries: [] } },
    stage: "PAYLOAD_SHAPE" },
  { code: "INPUT_INVALID", layer: null, name: "the unlisted key is __proto__",
    payload: { ...dispatchPayload(), ["__proto__"]: { polluted: true } },
    stage: "PAYLOAD_SHAPE" },
  // MEASURED, and the interesting half of the answer: a non-NFC string is structurally
  // ADMISSIBLE — the codec bounds text, it does not normalise it — so the request is
  // refused one layer later, by the binding check, under the binding's OWN code.
  { code: "FOUNDATION_ATTEMPT_BINDING_MISMATCH", layer: ATTEMPT_LAYER,
    name: "a section carries a non-NFC string",
    payload: { ...dispatchPayload(), binding: { attemptAggregateId: "café", nodeKey: "n",
      sessionId: "s" } },
    stage: "DISPATCH" },
] as const;

it("refuses every payload-surface case at the layer that owns it, and writes nothing", async () => {
  expect(PAYLOAD_CASES.length).toBeGreaterThan(0);

  const harness = seamHarness("payload-surface");
  try {
    const before = countsOf(harness.storePath);
    for (const item of PAYLOAD_CASES) {
      const answer = await handleAsyncCommandRequest(harness.deps, commandRequest({
        commandId: `cmd-surface-${item.name.replace(/\s+/gu, "-")}`,
        payload: item.payload as never,
      }));
      expect(answer.ok, item.name).toBe(false);
      if (answer.ok) return;
      expect(answer.stage, item.name).toBe(item.stage);
      if (item.layer === null) {
        expect(answer.outcome, item.name).toBe("REFUSED");
        if (answer.outcome !== "REFUSED") return;
        expect(answer.error.code, item.name).toBe(item.code);
      } else {
        expect(answer.outcome, item.name).toBe("PORT_REFUSED");
        if (answer.outcome !== "PORT_REFUSED") return;
        expect(answer.refusal, item.name).toMatchObject({ code: item.code, layer: item.layer });
      }
    }
    expect(countsOf(harness.storePath)).toStrictEqual(before);
  } finally {
    harness.close();
  }
}, 30_000);

function depsWith(harness: { readonly deps: CommandAdapterDeps }, entry: CommandRegistryEntry,
  decisions = harness.deps.decisions): CommandAdapterDeps {
  return Object.freeze({
    authenticator: harness.deps.authenticator,
    decisions,
    registry: new Map<RuntimeCommandKind, CommandRegistryEntry>([[KIND, entry]]),
  });
}

const throwingSync = (): never => {
  throw new DomainRefusal("SYNC_HANDLER_UNREACHABLE", "TEST", "unreachable");
};

it("turns a REJECTED handler promise into a refusal, not an unhandled rejection", async () => {
  const harness = seamHarness("rejecting-handler");
  try {
    const rejecting = await handleAsyncCommandRequest(depsWith(harness, Object.freeze({
      asyncHandler: async () => await Promise.reject(
        new DomainRefusal("FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN", ATTEMPT_LAYER, "rejected")),
      handler: throwingSync, kind: KIND, payloadKeys: [], requiredCapability: "work.write",
    })), commandRequest({ commandId: "cmd-rejecting", payload: {} }));

    expect(rejecting).toMatchObject({
      ok: false, outcome: "PORT_REFUSED",
      refusal: { code: "FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN", layer: ATTEMPT_LAYER },
      stage: "DISPATCH",
    });

    // An error NEITHER port understands stays a fault: the synchronous entry has always
    // re-thrown one, and the async entry must not quietly turn it into a refusal.
    await expect(handleAsyncCommandRequest(depsWith(harness, Object.freeze({
      asyncHandler: async () => await Promise.reject(new Error("not a refusal")),
      handler: throwingSync, kind: KIND, payloadKeys: [], requiredCapability: "work.write",
    })), commandRequest({ commandId: "cmd-unknown-fault", payload: {} }))).rejects.toThrow(
      "not a refusal");
  } finally {
    harness.close();
  }
}, 30_000);

it("refuses an async entry when the decision port cannot commit one", async () => {
  const harness = seamHarness("no-async-port");
  try {
    let called = 0;
    const answer = await handleAsyncCommandRequest(depsWith(harness, Object.freeze({
      asyncHandler: async () => {
        called += 1;
        return await Promise.reject(new Error("must never run"));
      },
      handler: throwingSync, kind: KIND, payloadKeys: [], requiredCapability: "work.write",
      // A port with `decide` only: every port written before the async seam existed.
    }), { decide: harness.deps.decisions.decide.bind(harness.deps.decisions) }),
    commandRequest({ commandId: "cmd-no-async-port", payload: {} }));

    expect(answer).toMatchObject({
      httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
      refusal: { code: ASYNC_PORT_UNAVAILABLE_CODE, layer: DAEMON_COMMAND_SEAM },
      stage: "DISPATCH",
    });
    // Fails CLOSED: the handler is never reached when the port cannot commit it.
    expect(called).toBe(0);
  } finally {
    harness.close();
  }
}, 30_000);

it("refuses an async entry on the sync entry WITHOUT calling its handler at all", async () => {
  const harness = seamHarness("guard-not-handler");
  try {
    // The production entry's synchronous handler already fails closed, so dropping the
    // guard would answer with the SAME code through the handler — an equivalent mutant.
    // This entry's synchronous handler ANSWERS instead of refusing, so only the guard can
    // produce the refusal below, and only the counter can prove it never ran.
    let called = 0;
    const answering = Object.freeze({
      asyncHandler: async () => await Promise.resolve({
        commandId: "cmd-guard", disposition: "DECIDED" as const, effectId: null,
        resultCode: "ASYNC",
      }),
      handler: () => {
        called += 1;
        return { commandId: "cmd-guard", disposition: "DECIDED" as const, effectId: null,
          resultCode: "SYNC_HANDLER_ANSWERED" };
      },
      kind: KIND, payloadKeys: [], requiredCapability: "work.write",
    });

    const answer = handleCommandRequest(
      depsWith(harness, answering), commandRequest({ commandId: "cmd-guard", payload: {} }));

    expect(answer).toMatchObject({
      httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
      refusal: { code: ASYNC_ENTRY_REQUIRED_CODE, layer: DAEMON_COMMAND_SEAM },
      stage: "DISPATCH",
    });
    expect(called).toBe(0);

    // The same entry IS served on the async entry, so the refusal above is about the
    // ENTRY POINT and not about the entry being unusable.
    expect(await handleAsyncCommandRequest(
      depsWith(harness, answering), commandRequest({ commandId: "cmd-guard-2", payload: {} }),
    )).toMatchObject({ decision: { resultCode: "ASYNC" }, ok: true, outcome: "ACCEPTED" });
  } finally {
    harness.close();
  }
}, 30_000);

/**
 * The derivation's OWN refusal arm, driven through the real seam. Without a seeded ACTIVE
 * revision there is no graph to derive, and the point of the case is twofold: the refusal
 * carries the PROJECTION's code and layer rather than a flattened dispatch code, and a
 * returned refusal is not evidence that nothing was written — the store is read back.
 */
it("refuses a dispatch whose ACTIVE graph is absent, unrestamped, and writes nothing", async () => {
  const harness = seamHarness("graph-absent", { seedGraph: false });
  try {
    const before = countsOf(harness.storePath);

    const answer = await handleAsyncCommandRequest(harness.deps, commandRequest({
      commandId: "cmd-graph-absent", payload: dispatchPayload(),
    }));

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.outcome).toBe("PORT_REFUSED");
    if (answer.outcome !== "PORT_REFUSED") return;
    expect(answer.refusal).toMatchObject({
      code: "ACTIVE_GRAPH_ABSENT", layer: "ACTIVE_GRAPH_PROJECTION",
    });
    // Zero residue: no partial activation, dispatch or decision from a refused derivation.
    expect(countsOf(harness.storePath)).toStrictEqual(before);
  } finally {
    harness.close();
  }
}, 30_000);
