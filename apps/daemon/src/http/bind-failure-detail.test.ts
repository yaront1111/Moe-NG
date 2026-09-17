import { describe, expect, it } from "vitest";

import { describeBindFailure } from "./bind-failure-detail.js";

describe("describeBindFailure", () => {
  it("names the syscall, the errno and the address for a held port", () => {
    const error = Object.assign(new Error("listen EADDRINUSE: address already in use"), {
      address: "127.0.0.1", code: "EADDRINUSE", errno: -4091, port: 8080, syscall: "listen",
    });

    expect(describeBindFailure(error, "127.0.0.1", 8080))
      .toBe("listen EADDRINUSE 127.0.0.1:8080");
  });

  it("prefers the host and port the caller asked for over the ones the error carries", () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES", syscall: "listen" });

    expect(describeBindFailure(error, "127.0.0.1", 80)).toBe("listen EACCES 127.0.0.1:80");
  });

  it("says ephemeral rather than 0, which is not a port an operator can check", () => {
    const error = Object.assign(new Error("boom"), { code: "EADDRNOTAVAIL", syscall: "listen" });

    expect(describeBindFailure(error, "127.0.0.1", 0))
      .toBe("listen EADDRNOTAVAIL 127.0.0.1:ephemeral");
    expect(describeBindFailure(error, "127.0.0.1", undefined))
      .toBe("listen EADDRNOTAVAIL 127.0.0.1:ephemeral");
  });

  it("falls back to the error's own name when it carries no errno", () => {
    expect(describeBindFailure(new TypeError("host is not a string"), "127.0.0.1", 9))
      .toBe("listen failed 127.0.0.1:9 (TypeError: host is not a string)");
  });

  it("stays one line whatever the message carried", () => {
    const detail = describeBindFailure(new Error("first\nsecond"), "127.0.0.1", 9);

    expect(detail).not.toContain("\n");
  });

  it("never carries a stack, which is for the diagnostic record and not the operator", () => {
    expect(describeBindFailure(new Error("boom"), "127.0.0.1", 9)).not.toContain("at ");
  });

  it("is total over a hostile throw", () => {
    const hostile = new Proxy({}, { get() { throw new Error("trap"); } });

    expect(() => describeBindFailure(hostile, "127.0.0.1", 9)).not.toThrow();
  });
});
