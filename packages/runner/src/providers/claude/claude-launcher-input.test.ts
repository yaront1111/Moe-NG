/**
 * The launch-limit admission surface, tested at the module that ENFORCES it.
 *
 * Two subjects, deliberately in one file: the total public validator, and the
 * real request snapshot that must DELEGATE to it. The delegation cases are what
 * make this more than a unit test of a new function — they pin that exactly one
 * production authority decides a ceiling, so a second inline comparison cannot
 * be reintroduced without a named red here.
 *
 * Every ceiling, code, field and layer below is HAND-WRITTEN from the module
 * source, never read off the export under test. A table that silently changed
 * value would therefore fail these assertions instead of quietly redefining
 * them — and the boundary sweep would go equivalent-mutant if it derived its
 * N/N+1 operands from the very table a drill mutates.
 */
import { describe, expect, it } from "vitest";

import { MAX_CLAUDE_RENDERED_CONTEXT_BYTES } from "./claude-launcher-contract.js";
import {
  CLAUDE_LAUNCH_LIMIT_CEILINGS, CLAUDE_LAUNCH_LIMIT_FIELDS, CLAUDE_LAUNCH_LIMIT_ISSUE_CODES,
  snapshotClaudeLaunchRequest, validateClaudeLaunchLimits,
  type ClaudeLaunchLimitField, type ClaudeLaunchLimitIssue, type ClaudeLaunchLimitIssueCode,
  type ClaudeLaunchLimitLayer, type ClaudeLaunchLimitsResult,
} from "./claude-launcher-input.js";
import { launchClaude } from "./claude-launcher.js";
import { boundaryHarness, dependencies, failureOf, request } from "./claude-launcher-test-fixtures.js";

/**
 * The layer literal, written here rather than imported: an expectation that
 * mirrors the constant under test cannot see that constant move.
 */
const LAYER: ClaudeLaunchLimitLayer = "LAUNCH_LIMITS";
const FIELDS: readonly ClaudeLaunchLimitField[] =
  ["stdoutBytes", "stderrBytes", "tailBytes", "timeoutMs"];
const CODES: readonly ClaudeLaunchLimitIssueCode[] = ["CLAUDE_LAUNCH_LIMITS_MALFORMED",
  "CLAUDE_LAUNCH_LIMIT_INVALID", "CLAUDE_LAUNCH_LIMIT_EXCEEDED"];
const CEILINGS: Readonly<Record<ClaudeLaunchLimitField, number>> = {
  stdoutBytes: 1_048_576, stderrBytes: 1_048_576, tailBytes: 65_536, timeoutMs: 600_000,
};
const DIGEST = "ab".repeat(32);

function issue(
  code: ClaudeLaunchLimitIssueCode, field: ClaudeLaunchLimitField | null,
): ClaudeLaunchLimitIssue {
  return { code, layer: LAYER, field };
}
/**
 * Limits at every ceiling, with one field optionally replaced. Mutable on
 * purpose: the detachment cases write through this record after the call.
 */
function limitsAt(field?: ClaudeLaunchLimitField, value?: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = { ...CEILINGS };
  if (field !== undefined) record[field] = value;
  return record;
}
function refusalOf(value: unknown): ClaudeLaunchLimitIssue {
  const result: ClaudeLaunchLimitsResult = validateClaudeLaunchLimits(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  return result.issue;
}
/**
 * A request valid at every OTHER gate in `snapshotClaudeLaunchRequest`, so a
 * null answer provably comes from the limits and not from an earlier field.
 */
function launchRequest(limits: unknown): Record<string, unknown> {
  return {
    runtime: { quotedObservation: null, installedRoot: "C:\\installed", pinRoot: "C:\\pins",
      fs: {}, facts: {}, clock: {} },
    duplicateDelivery: null, effect: null, attempt: null, grant: null, claim: null,
    wrapperIdentity: "wrapper:1", bootstrapCredentialDigest: DIGEST, priorRegistration: null,
    argv: ["--print", "hello"], cwd: "C:\\work", environment: { LANG: "en_US.UTF-8" },
    reconciliation: null, limits, renderedContext: "sealed context\n",
    contextManifestDigest: DIGEST, launchSelection: null,
  };
}
async function expectMalformedContext(candidate: Record<string, unknown>): Promise<void> {
  expect(snapshotClaudeLaunchRequest(candidate)).toBeNull();
  const harness = boundaryHarness();
  const result = await launchClaude(candidate,
    { platform: "win32", deps: dependencies(harness, harness.log) });
  expect(failureOf(result)).toEqual({ code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: "LAUNCHER" });
  expect(harness.requests).toEqual([]);
}
describe("snapshotClaudeLaunchRequest admits only bounded sealed context", () => {
  it("accepts the exact UTF-8 byte bound and carries both bindings byte-for-byte", () => {
    const renderedContext = "é".repeat(MAX_CLAUDE_RENDERED_CONTEXT_BYTES / 2);
    expect(Buffer.byteLength(renderedContext, "utf8")).toBe(MAX_CLAUDE_RENDERED_CONTEXT_BYTES);
    const candidate = { ...request(), renderedContext, contextManifestDigest: DIGEST };
    const snapshot = snapshotClaudeLaunchRequest(candidate);
    if (snapshot === null || typeof snapshot === "symbol") throw new Error("expected admission");
    expect(snapshot.renderedContext).toBe(renderedContext);
    expect(snapshot.contextManifestDigest).toBe(DIGEST);
  });
  const CONTEXT_FAULTS = Object.freeze([
    ["refuses absent rendered context at the launcher layer", (value: Record<string, unknown>) => {
      delete value["renderedContext"];
    }],
    ["refuses non-string rendered context at the launcher layer", (value: Record<string, unknown>) => {
      value["renderedContext"] = Buffer.from("bytes");
    }],
    ["refuses ill-formed UTF-16 rendered context at the launcher layer", (value: Record<string, unknown>) => {
      value["renderedContext"] = "\ud800";
    }],
    ["refuses rendered context one UTF-8 byte over the bound at the launcher layer",
      (value: Record<string, unknown>) => {
        value["renderedContext"] = "é".repeat(MAX_CLAUDE_RENDERED_CONTEXT_BYTES / 2) + "a";
      }],
  ] as const);
  it("generates exactly four unique rendered-context refusal arms", () => {
    expect(CONTEXT_FAULTS.length).toBe(4);
    expect(new Set(CONTEXT_FAULTS.map(([title]) => title)).size).toBe(CONTEXT_FAULTS.length);
  });
  it.each(CONTEXT_FAULTS)("%s", async (_title, mutate) => {
    const candidate: Record<string, unknown> = { ...request() };
    mutate(candidate);
    await expectMalformedContext(candidate);
  });
});
describe("snapshotClaudeLaunchRequest admits only lowercase manifest digests", () => {
  const DIGEST_FAULTS = Object.freeze([
    ["refuses absent context digest at the launcher layer", (value: Record<string, unknown>) => {
      delete value["contextManifestDigest"];
    }],
    ["refuses non-string context digest at the launcher layer", (value: Record<string, unknown>) => {
      value["contextManifestDigest"] = 7;
    }],
    ["refuses uppercase context digest at the launcher layer", (value: Record<string, unknown>) => {
      value["contextManifestDigest"] = DIGEST.toUpperCase();
    }],
    ["refuses 63-character context digest at the launcher layer", (value: Record<string, unknown>) => {
      value["contextManifestDigest"] = "a".repeat(63);
    }],
    ["refuses 65-character context digest at the launcher layer", (value: Record<string, unknown>) => {
      value["contextManifestDigest"] = "a".repeat(65);
    }],
    ["refuses non-hex context digest at the launcher layer", (value: Record<string, unknown>) => {
      value["contextManifestDigest"] = `${"a".repeat(63)}g`;
    }],
  ] as const);
  it("generates exactly six unique manifest-digest refusal arms", () => {
    expect(DIGEST_FAULTS.length).toBe(6);
    expect(new Set(DIGEST_FAULTS.map(([title]) => title)).size).toBe(DIGEST_FAULTS.length);
  });
  it.each(DIGEST_FAULTS)("%s", async (_title, mutate) => {
    const candidate: Record<string, unknown> = { ...request() };
    mutate(candidate);
    await expectMalformedContext(candidate);
  });
});
describe("the published launch-limit vocabulary", () => {
  it("names exactly four fields, three codes and four ceilings", () => {
    expect([...CLAUDE_LAUNCH_LIMIT_FIELDS]).toEqual(FIELDS);
    expect(CLAUDE_LAUNCH_LIMIT_FIELDS.length).toBe(4);
    expect([...CLAUDE_LAUNCH_LIMIT_ISSUE_CODES]).toEqual(CODES);
    expect(CLAUDE_LAUNCH_LIMIT_ISSUE_CODES.length).toBe(3);
    expect(CLAUDE_LAUNCH_LIMIT_CEILINGS).toEqual(CEILINGS);
    expect(Object.keys(CLAUDE_LAUNCH_LIMIT_CEILINGS).length).toBe(4);
  });

  it("freezes the table and both rosters", () => {
    expect(Object.isFrozen(CLAUDE_LAUNCH_LIMIT_CEILINGS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_LAUNCH_LIMIT_FIELDS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_LAUNCH_LIMIT_ISSUE_CODES)).toBe(true);
  });
});

describe("validateClaudeLaunchLimits at each literal ceiling", () => {
  it("generates one boundary pair per field", () => {
    expect(FIELDS.length).toBe(4);
  });

  it.each(FIELDS)("admits %s at its exact ceiling", (field) => {
    const result = validateClaudeLaunchLimits(limitsAt(field, CEILINGS[field]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected admission");
    expect(result.limits).toEqual(CEILINGS);
  });

  it.each(FIELDS)("refuses %s one over its ceiling, naming that field", (field) => {
    expect(refusalOf(limitsAt(field, CEILINGS[field] + 1)))
      .toEqual(issue("CLAUDE_LAUNCH_LIMIT_EXCEEDED", field));
  });
});

describe("validateClaudeLaunchLimits refuses a non-positive or non-integer bound", () => {
  const NON_VALUES: readonly unknown[] = [0, -0, -1, 1.5, 2 ** 53, "5", null, undefined, true, NaN,
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  it("sweeps every field against every non-value", () => {
    expect(FIELDS.length * NON_VALUES.length).toBe(48);
    for (const field of FIELDS) {
      for (const value of NON_VALUES) {
        expect(refusalOf(limitsAt(field, value)))
          .toEqual(issue("CLAUDE_LAUNCH_LIMIT_INVALID", field));
      }
    }
  });
});

describe("validateClaudeLaunchLimits refuses a malformed record without naming a field", () => {
  it("refuses a non-record, a wrong key set and a symbol-keyed record", () => {
    const missing = limitsAt();
    delete missing["timeoutMs"];
    const extra = { ...limitsAt(), surprise: 1 };
    const symbolKeyed = { ...limitsAt(), [Symbol("extra")]: 1 };
    const values: readonly unknown[] = [null, undefined, "x", 7, [], missing, extra, symbolKeyed];
    expect(values.length).toBe(8);
    for (const value of values) {
      expect(refusalOf(value)).toEqual(issue("CLAUDE_LAUNCH_LIMITS_MALFORMED", null));
    }
  });

  it("refuses an accessor-backed field without ever running the caller's getter", () => {
    let reads = 0;
    const accessor = { ...limitsAt(), get stdoutBytes(): number { reads += 1; return 1; } };
    expect(refusalOf(accessor)).toEqual(issue("CLAUDE_LAUNCH_LIMITS_MALFORMED", null));
    expect(reads).toBe(0);
  });

  it("stays TOTAL against a throwing trap and a revoked proxy", () => {
    const trapped = new Proxy(limitsAt(), { ownKeys() { throw new Error("trap"); } });
    const revocable = Proxy.revocable(limitsAt(), {});
    revocable.revoke();
    for (const value of [trapped, revocable.proxy]) {
      expect(refusalOf(value)).toEqual(issue("CLAUDE_LAUNCH_LIMITS_MALFORMED", null));
    }
  });

  it("reports the first offending field in declaration order", () => {
    expect(refusalOf({ ...limitsAt(), stderrBytes: 0, timeoutMs: 0 }))
      .toEqual(issue("CLAUDE_LAUNCH_LIMIT_INVALID", "stderrBytes"));
    expect(refusalOf({ ...limitsAt(), stdoutBytes: -1, tailBytes: CEILINGS.tailBytes + 1 }))
      .toEqual(issue("CLAUDE_LAUNCH_LIMIT_INVALID", "stdoutBytes"));
  });
});

describe("the admitted limits are detached from the caller", () => {
  it("freezes the result and never echoes the caller record", () => {
    const input = limitsAt();
    const result = validateClaudeLaunchLimits(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected admission");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.limits)).toBe(true);
    expect(result.limits as unknown).not.toBe(input);
    input["stdoutBytes"] = 1;
    expect(result.limits.stdoutBytes).toBe(CEILINGS.stdoutBytes);
  });

  it("freezes the refusal it hands back", () => {
    const result = validateClaudeLaunchLimits(limitsAt("tailBytes", 0));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issue)).toBe(true);
  });
});

/**
 * The delegation seam. `snapshotClaudeLaunchRequest` keeps its OUTER contract —
 * every limit defect is still a bare null, which the launcher restamps as
 * CLAUDE_LAUNCH_REQUEST_MALFORMED at LAUNCHER — but the DECISION must come from
 * the validator above. Inlining a second comparison, or accepting the caller's
 * limits unchecked, reddens the cases below.
 */
describe("snapshotClaudeLaunchRequest delegates every limit decision", () => {
  it("admits limits at every ceiling and carries them detached and frozen", () => {
    const limits = limitsAt();
    const snapshot = snapshotClaudeLaunchRequest(launchRequest(limits));
    if (snapshot === null || typeof snapshot === "symbol") throw new Error("expected a snapshot");
    expect(snapshot.limits).toEqual(CEILINGS);
    expect(snapshot.limits as unknown).not.toBe(limits);
    expect(Object.isFrozen(snapshot.limits)).toBe(true);
    limits["tailBytes"] = 1;
    expect(snapshot.limits.tailBytes).toBe(CEILINGS.tailBytes);
  });

  it.each(FIELDS)("refuses the whole request when %s is one over its ceiling", (field) => {
    expect(snapshotClaudeLaunchRequest(launchRequest(limitsAt(field, CEILINGS[field] + 1))))
      .toBeNull();
  });

  it.each(FIELDS)("refuses the whole request when %s is not positive", (field) => {
    expect(snapshotClaudeLaunchRequest(launchRequest(limitsAt(field, 0)))).toBeNull();
  });

  it("refuses a malformed and a hostile limits operand as a bare null", () => {
    const revocable = Proxy.revocable(limitsAt(), {});
    revocable.revoke();
    expect(snapshotClaudeLaunchRequest(launchRequest({ stdoutBytes: 1 }))).toBeNull();
    expect(snapshotClaudeLaunchRequest(launchRequest(revocable.proxy))).toBeNull();
    expect(snapshotClaudeLaunchRequest(launchRequest(
      new Proxy(limitsAt(), { ownKeys() { throw new Error("trap"); } })))).toBeNull();
  });
});
