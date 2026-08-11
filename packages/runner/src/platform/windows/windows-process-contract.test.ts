import { describe, expect, it } from "vitest";

import {
  BROKER_LAYER_BY_WIRE,
  WINDOWS_PROCESS_CODES,
  WINDOWS_PROCESS_LAYERS,
  WINDOWS_PROCESS_TRUTH_CLASSES,
  brokerLayerFromWire,
  isWindowsProcessCode,
  isWindowsProcessLayer,
  processIdentity,
  provenRun,
  unknownOutcome,
} from "./windows-process-contract.js";

describe("the closed vocabularies", () => {
  it("are frozen and free of duplicates", () => {
    for (const vocabulary of [
      WINDOWS_PROCESS_CODES,
      WINDOWS_PROCESS_LAYERS,
      WINDOWS_PROCESS_TRUTH_CLASSES,
    ]) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
      expect(vocabulary.length).toBeGreaterThan(0);
    }
  });

  it("names three broker layers and three layers on this side of the pipe", () => {
    const broker = WINDOWS_PROCESS_LAYERS.filter((layer) => layer.startsWith("BROKER_"));
    const local = WINDOWS_PROCESS_LAYERS.filter((layer) => layer.startsWith("WINDOWS_PROCESS_"));
    expect(broker).toEqual(["BROKER_DESCRIPTOR", "BROKER_PROTOCOL", "BROKER_NATIVE"]);
    expect(local).toEqual([
      "WINDOWS_PROCESS_REQUEST",
      "WINDOWS_PROCESS_RESOLUTION",
      "WINDOWS_PROCESS_TRANSPORT",
    ]);
    expect(broker.length + local.length).toBe(WINDOWS_PROCESS_LAYERS.length);
  });

  it("recognises exactly its own members", () => {
    for (const code of WINDOWS_PROCESS_CODES) {
      expect(isWindowsProcessCode(code)).toBe(true);
    }
    for (const layer of WINDOWS_PROCESS_LAYERS) {
      expect(isWindowsProcessLayer(layer)).toBe(true);
    }
    expect(isWindowsProcessCode("PROCESS_BOUNDARY_")).toBe(false);
    expect(isWindowsProcessLayer("BROKER_NATIVE ")).toBe(false);
    expect(isWindowsProcessCode(1)).toBe(false);
  });
});

describe("the broker refusal layer wire mapping", () => {
  /**
   * PINNED AGAINST `RefusalLayer::wire` IN refusal.rs, which is 1-based on
   * purpose. A 0-based mapping would make an unrecognised byte read as
   * `Descriptor`, so this is a value assertion and not a shape one.
   */
  it("is one-based and matches the broker's frozen bytes", () => {
    expect(brokerLayerFromWire(1)).toBe("BROKER_DESCRIPTOR");
    expect(brokerLayerFromWire(2)).toBe("BROKER_PROTOCOL");
    expect(brokerLayerFromWire(3)).toBe("BROKER_NATIVE");
    expect(Object.isFrozen(BROKER_LAYER_BY_WIRE)).toBe(true);
  });

  it("answers null for every other byte, so the set is closed over all 256", () => {
    const unmapped = [];
    for (let byte = 0; byte < 256; byte += 1) {
      if (byte >= 1 && byte <= 3) continue;
      unmapped.push(brokerLayerFromWire(byte));
    }
    // A sweep that generates zero cases passes while testing nothing.
    expect(unmapped.length).toBe(253);
    expect(unmapped.every((layer) => layer === null)).toBe(true);
  });
});

describe("a PROVEN outcome cannot be constructed without the proof it claims", () => {
  const identity = processIdentity(4242, 134309515541692727n);

  it("proves a run when the identity pair and the exit are exact", () => {
    const outcome = provenRun(identity, 0);
    expect(outcome.truthClass).toBe("PROVEN");
    if (outcome.truthClass !== "PROVEN") return;
    expect(outcome.identity).toEqual({ pid: 4242, creationTime: 134309515541692727n });
    expect(outcome.exitCode).toBe(0);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.identity)).toBe(true);
  });

  /**
   * Each of these is a shape an unparsed or defaulted status frame produces. A
   * PID-only identity is the one this file exists to make unrepresentable.
   */
  it.each([
    ["a zero pid", processIdentity(0, 134309515541692727n), 0],
    ["a negative pid", processIdentity(-1, 134309515541692727n), 0],
    ["a fractional pid", processIdentity(4242.5, 134309515541692727n), 0],
    ["a zero creation time", processIdentity(4242, 0n), 0],
    ["a negative exit code", identity, -1],
    ["a fractional exit code", identity, 1.5],
  ])("refuses %s with PROCESS_BOUNDARY_IDENTITY_UNPROVEN on the transport layer", (_, id, exit) => {
    const outcome = provenRun(id, exit);
    expect(outcome.truthClass).toBe("UNKNOWN");
    if (outcome.truthClass !== "UNKNOWN") return;
    expect(outcome.code).toBe("PROCESS_BOUNDARY_IDENTITY_UNPROVEN");
    expect(outcome.layer).toBe("WINDOWS_PROCESS_TRANSPORT");
  });

  it("keeps the identity on an unprovable exit, because the caller still has to reap it", () => {
    const outcome = provenRun(identity, -1);
    expect(outcome.truthClass).toBe("UNKNOWN");
    if (outcome.truthClass !== "UNKNOWN") return;
    expect(outcome.identity).toEqual({ pid: 4242, creationTime: 134309515541692727n });
  });

  it("carries no identity when the identity itself was the unusable part", () => {
    const outcome = provenRun(processIdentity(0, 0n), 0);
    expect(outcome.truthClass).toBe("UNKNOWN");
    if (outcome.truthClass !== "UNKNOWN") return;
    expect(outcome.identity).toBeNull();
  });
});

describe("an UNKNOWN outcome is immutable and copies what it is handed", () => {
  it("freezes itself, its identity and its broker reason", () => {
    const outcome = unknownOutcome(
      "PROCESS_BOUNDARY_BROKER_REFUSED",
      "BROKER_NATIVE",
      "the broker refused",
      {
        identity: processIdentity(7, 9n),
        brokerReason: { layer: "BROKER_NATIVE", reason: 10, code: 87 },
      },
    );
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.identity)).toBe(true);
    expect(Object.isFrozen(outcome.brokerReason)).toBe(true);
    expect(outcome.brokerReason).toEqual({ layer: "BROKER_NATIVE", reason: 10, code: 87 });
  });

  /**
   * The caller's own object must not become frozen as a side effect, and must
   * not stay a back door into the outcome. Both directions matter: freezing in
   * place would mutate something this module does not own, and NOT copying
   * would let a later write to the caller's object rewrite a recorded refusal.
   */
  it("neither freezes nor keeps the caller's refusal object", () => {
    const supplied = { layer: "BROKER_PROTOCOL" as const, reason: 0, code: 0 };
    const outcome = unknownOutcome(
      "PROCESS_BOUNDARY_BROKER_REFUSED",
      "BROKER_PROTOCOL",
      "the broker refused",
      { brokerReason: supplied },
    );
    expect(Object.isFrozen(supplied)).toBe(false);
    expect(outcome.brokerReason).not.toBe(supplied);
    supplied.reason = 9;
    expect(outcome.brokerReason?.reason).toBe(0);
  });

  it("defaults both optional fields to null rather than undefined", () => {
    const outcome = unknownOutcome(
      "PROCESS_BOUNDARY_REQUEST_MALFORMED",
      "WINDOWS_PROCESS_REQUEST",
      "not a record",
    );
    expect(outcome.identity).toBeNull();
    expect(outcome.brokerReason).toBeNull();
  });
});
