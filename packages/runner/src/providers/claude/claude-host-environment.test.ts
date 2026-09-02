import { describe, expect, it } from "vitest";

import { canonicalizeEquivalentSystemRootAliases } from "./claude-host-environment.js";

describe("Claude default-boundary host environment", () => {
  it("collapses byte-identical Windows worker aliases into one frozen host fact", () => {
    const environment = { SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\Windows" };

    const canonical = canonicalizeEquivalentSystemRootAliases(environment);

    expect(canonical).toEqual({ SystemRoot: "C:\\Windows" });
    expect(canonical).not.toBe(environment);
    expect(Object.isFrozen(canonical)).toBe(true);
  });

  it("leaves a single spelling for the physical boundary to validate", () => {
    const environment = { SystemRoot: "Windows" };
    expect(canonicalizeEquivalentSystemRootAliases(environment)).toBe(environment);
  });

  it("does not choose between conflicting aliases", () => {
    const environment = { SystemRoot: "C:\\Windows", SYSTEMROOT: "D:\\Windows" };
    expect(canonicalizeEquivalentSystemRootAliases(environment)).toBe(environment);
  });

  it("never invokes an accessor while inspecting aliases", () => {
    let reads = 0;
    const environment = { SYSTEMROOT: "C:\\Windows" } as Record<string, string>;
    Object.defineProperty(environment, "SystemRoot", {
      enumerable: true,
      get: () => { reads += 1; return "C:\\Windows"; },
    });

    expect(canonicalizeEquivalentSystemRootAliases(environment)).toBe(environment);
    expect(reads).toBe(0);
  });
});
