import { describe, expect, it } from "vitest";

import {
  describeTruthClass,
  type TruthPresentationResult,
} from "@moe/control-room-model";

function expectInvalid(result: TruthPresentationResult): void {
  expect(result).toEqual({
    ok: false,
    error: {
      code: "TRUTH_CLASS_INVALID",
      message: "Truth class must be a daemon-supplied supported value.",
    },
  });
}

describe("fail-closed truth-class input", () => {
  it.each([
    "",
    "observed",
    "UNKNOWN ",
    "DAEMON-VERIFIED",
    "POLICY_APPROVED",
    null,
    undefined,
    false,
    0,
    0n,
    Symbol("OBSERVED"),
    {},
    [],
    new String("OBSERVED"),
    () => "OBSERVED",
  ])("rejects invalid input %# without defaulting to UNKNOWN", (input) => {
    const result = describeTruthClass(input);
    expectInvalid(result);
    expect(result).not.toBe(describeTruthClass("UNKNOWN"));
  });

  it("rejects a missing argument with the stable typed error", () => {
    expectInvalid(Reflect.apply(describeTruthClass, undefined, []));
  });

  it("rejects object and callable proxies without invoking traps", () => {
    let trapCount = 0;
    const countAndThrow = (): never => {
      trapCount += 1;
      throw new Error("proxy trap must not run");
    };
    const objectProxy = new Proxy({}, {
      get: countAndThrow,
      getOwnPropertyDescriptor: countAndThrow,
      getPrototypeOf: countAndThrow,
      has: countAndThrow,
      ownKeys: countAndThrow,
    });
    const callableProxy = new Proxy(() => "OBSERVED", {
      apply: countAndThrow,
      get: countAndThrow,
      getOwnPropertyDescriptor: countAndThrow,
      getPrototypeOf: countAndThrow,
      has: countAndThrow,
      ownKeys: countAndThrow,
    });

    expectInvalid(describeTruthClass(objectProxy));
    expectInvalid(describeTruthClass(callableProxy));
    expect(trapCount).toBe(0);
  });

  it("rejects revoked object and callable proxies without throwing", () => {
    const revokedObject = Proxy.revocable({}, {});
    const revokedCallable = Proxy.revocable(() => "UNKNOWN", {});
    revokedObject.revoke();
    revokedCallable.revoke();

    expect(() => describeTruthClass(revokedObject.proxy)).not.toThrow();
    expect(() => describeTruthClass(revokedCallable.proxy)).not.toThrow();
    expectInvalid(describeTruthClass(revokedObject.proxy));
    expectInvalid(describeTruthClass(revokedCallable.proxy));
  });

  it("returns the same deterministic error bytes for every invalid input", () => {
    const first = describeTruthClass("NOT_A_TRUTH_CLASS");
    const second = describeTruthClass(undefined);
    expect(second).toBe(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("deep immutability", () => {
  it("deeply freezes successful envelopes and descriptors", () => {
    const result = describeTruthClass("OBSERVED");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("OBSERVED fixture must succeed");
    }

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.descriptor)).toBe(true);
    expect(() => {
      (result as unknown as { descriptor: null }).descriptor = null;
    }).toThrow();
    expect(() => {
      (result.descriptor as { shortLabel: string }).shortLabel = "BAD";
    }).toThrow();
    expect(describeTruthClass("OBSERVED")).toBe(result);
    expect(result.descriptor.shortLabel).toBe("OBS");
  });

  it("deeply freezes failure envelopes and error payloads", () => {
    const result = describeTruthClass("NOT_A_TRUTH_CLASS");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("invalid fixture must fail");
    }

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.error)).toBe(true);
    expect(() => {
      (result.error as { code: string }).code = "UNKNOWN";
    }).toThrow();
    expect(result.error.code).toBe("TRUTH_CLASS_INVALID");
  });
});
