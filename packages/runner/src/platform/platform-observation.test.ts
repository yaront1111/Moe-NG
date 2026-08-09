/**
 * Platform boundary vocabulary and Linux classification.
 *
 * Every refusal assertion below pins the exact reason code AND the layer that
 * refused. UNKNOWN is this area's default verdict, so a test that asserts only
 * "the verdict was UNKNOWN" stays green with every gate deleted — it would be
 * measuring the default, not the classifier.
 *
 * The vocabulary literals are hand-written rather than read off the export
 * under test. A list derived from the thing it checks asserts only that the
 * thing equals itself.
 */
import { describe, expect, it } from "vitest";

import {
  PLATFORM_BOUNDARIES,
  PLATFORM_ERROR_CODES,
  PLATFORM_LAYERS,
  PLATFORM_OBSERVATION_VERSION,
  PLATFORM_TRUTH_CLASSES,
  isPlatformFailure,
  type PlatformBoundary,
  type PlatformBoundaryVerdict,
  type PlatformFailure,
  type PlatformObservation,
} from "./platform-contract.js";
import { PLATFORM_LINUX_LAYER, classifyLinuxBoundary } from "./linux-boundary.js";
import { LINUX_SUPPORTED_ARCHITECTURES, observeLinuxPlatform } from "./linux-observation.js";
import {
  CLAUDE_RUNTIME_OBSERVATION_VERSION,
  type ProviderRuntimeObservation,
} from "../providers/claude/claude-observation.js";
import {
  CLAUDE_RECONCILIATION_VERSION,
  type ClaudeReconciliation,
} from "../providers/claude/claude-cancel-reconcile.js";
import { SCOPE_OBSERVATION_VERSION, type ScopeObservation } from "../scope/scope-contract.js";
import {
  WORKSPACE_INPUT_MANIFEST_VERSION,
  type WorkspaceInputManifest,
} from "../workspace/workspace-contract.js";
import type { MirroredLeaseRecord } from "../supervisor/effect-shape.js";
import type { CrashClassification } from "../recovery/crash-classification.js";

const DIGEST = "a".repeat(64);
const COMMIT = "b".repeat(40);
const LINUX_HOST = { os: "linux", arch: "x64", osVersion: "6.8.0-41-generic" } as const;

const AS_OF = "2026-08-09T12:00:00.000Z";
const MAX_AGE_MS = 60_000;
/** 30s before `AS_OF`. */
const FRESH_AT = "2026-08-09T11:59:30.000Z";
/** Exactly `MAX_AGE_MS` before `AS_OF` — the inclusive edge, still fresh. */
const EDGE_AT = "2026-08-09T11:59:00.000Z";
/** One millisecond past the edge. */
const STALE_AT = "2026-08-09T11:58:59.999Z";

function providerObservation(
  overrides: Partial<ProviderRuntimeObservation> = {},
): ProviderRuntimeObservation {
  return {
    observationVersion: CLAUDE_RUNTIME_OBSERVATION_VERSION,
    providerId: "claude",
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "/usr/lib/moe/claude", sha256: DIGEST }],
    reportedVersion: "1.4.2",
    adapterCapabilitySchemaDigest: DIGEST,
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { ...LINUX_HOST },
    freshness: { observedAt: FRESH_AT },
    truthClass: "PROVEN",
    observationDigest: DIGEST,
    ...overrides,
  };
}

const SCOPE: ScopeObservation = {
  observationVersion: SCOPE_OBSERVATION_VERSION,
  baseIdentity: COMMIT,
  worktreeIdentity: COMMIT,
  canonicalEntries: [],
  gitAttribution: {
    headCommit: COMMIT,
    changedPaths: [],
    dirtyPaths: [],
    stagedPaths: [],
    untrackedPaths: [],
    unmergedPaths: [],
    ignoredPaths: [],
  },
  observedAt: FRESH_AT,
  observerVersion: "moe-git-observer/1",
  sha256: DIGEST,
};

const WORKSPACE: WorkspaceInputManifest = {
  manifestVersion: WORKSPACE_INPUT_MANIFEST_VERSION,
  baseIdentity: COMMIT,
  entries: [],
  sha256: DIGEST,
};

const LEASE: MirroredLeaseRecord = {
  leaseId: "lease-linux-1",
  kind: "WORKSPACE",
  ownerSessionRef: "session-linux-1",
  leaseToken: "token-linux-1",
  epoch: 3,
  state: "ACTIVE",
  serverWallDeadline: 1_000,
  bootId: "boot-linux-1",
  monotonicObservation: 42,
  authorityHashRef: DIGEST,
  version: 1,
};

const RECONCILIATION: ClaudeReconciliation = {
  reconciliationVersion: CLAUDE_RECONCILIATION_VERSION,
  outcome: "PROVEN_RESULT",
  disposition: "COMPLETED",
  anomalies: [],
  streamDigest: DIGEST,
  cancelRequested: false,
  processExit: { kind: "EXITED", code: 0 },
  reconciliationDigest: DIGEST,
};

const CRASH: CrashClassification = {
  kind: "ADOPTED",
  ok: true,
  effectRef: "effect-linux-1",
  postState: "ACTIVE_ADOPTED",
  continuationEvidence: { predecessorRelease: "UNKNOWN", safeHandoff: null },
};

const CONTEXT = { host: { ...LINUX_HOST }, asOf: AS_OF, maxFactAgeMs: MAX_AGE_MS };

function envelope(fact: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { host: { ...LINUX_HOST }, observedAt: FRESH_AT, truthClass: "PROVEN", fact, ...overrides };
}

function baseFacts(): Record<string, unknown> {
  return {
    PROVIDER_LAUNCH: envelope(providerObservation()),
    GIT_WORKSPACE: envelope({ scope: SCOPE, workspace: WORKSPACE }),
    PATH_SYMLINK: envelope({
      path: "/srv/moe/work",
      symlinkTarget: null,
      resolvedPath: "/srv/moe/work",
    }),
    LOCK: envelope({ ...LEASE }),
    SIGNAL_CANCELLATION: envelope(RECONCILIATION),
    RUNTIME_CLOSURE: envelope(providerObservation()),
    CRASH_RECOVERY: envelope(CRASH),
  };
}

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: { ...LINUX_HOST },
    asOf: AS_OF,
    maxFactAgeMs: MAX_AGE_MS,
    facts: baseFacts(),
    ...overrides,
  };
}

/**
 * A fully coherent observation on some other operating system: the declared
 * host, every envelope host and the provider's own `platformIdentity` all
 * agree. Every gate except the Linux one is satisfiable, so ONLY the
 * `host.os` short-circuit can refuse it.
 *
 * This exists because the obvious version of the test does not work. A darwin
 * case whose envelopes still say "linux" is refused by the per-boundary
 * host-match gate, which reports the same code at the same layer — so it stays
 * green with the short-circuit deleted. Verified by mutation, not assumed.
 */
function coherentHostInput(os: string): Record<string, unknown> {
  const host = { ...LINUX_HOST, os };
  const wrap = (fact: unknown): Record<string, unknown> => ({
    host: { ...host },
    observedAt: FRESH_AT,
    truthClass: "PROVEN",
    fact,
  });
  return {
    host: { ...host },
    asOf: AS_OF,
    maxFactAgeMs: MAX_AGE_MS,
    facts: {
      PROVIDER_LAUNCH: wrap(providerObservation({ platformIdentity: { ...host } })),
      GIT_WORKSPACE: wrap({ scope: SCOPE, workspace: WORKSPACE }),
      PATH_SYMLINK: wrap({
        path: "/srv/moe/work",
        symlinkTarget: null,
        resolvedPath: "/srv/moe/work",
      }),
      LOCK: wrap({ ...LEASE }),
      SIGNAL_CANCELLATION: wrap(RECONCILIATION),
      RUNTIME_CLOSURE: wrap(providerObservation({ platformIdentity: { ...host } })),
      CRASH_RECOVERY: wrap(CRASH),
    },
  };
}

/** Replaces one boundary's envelope, leaving the other six coherent. */
function withFact(boundary: PlatformBoundary, fact: unknown): Record<string, unknown> {
  return baseInput({ facts: { ...baseFacts(), [boundary]: fact } });
}

function verdictFor(
  observation: PlatformObservation,
  boundary: PlatformBoundary,
): PlatformBoundaryVerdict {
  const verdict = observation.verdicts.find((entry) => entry.boundary === boundary);
  if (verdict === undefined) {
    throw new Error(`no verdict published for ${boundary}`);
  }
  return verdict;
}

function refusalFor(observation: PlatformObservation, boundary: PlatformBoundary): PlatformFailure {
  const { failure } = verdictFor(observation, boundary);
  if (failure === null) {
    throw new Error(`${boundary} was not refused`);
  }
  return failure;
}

describe("platform boundary vocabulary", () => {
  it("freezes exactly the seven hand-written boundaries, in order", () => {
    expect([...PLATFORM_BOUNDARIES]).toEqual([
      "PROVIDER_LAUNCH",
      "GIT_WORKSPACE",
      "PATH_SYMLINK",
      "LOCK",
      "SIGNAL_CANCELLATION",
      "RUNTIME_CLOSURE",
      "CRASH_RECOVERY",
    ]);
    expect(PLATFORM_BOUNDARIES.length).toBe(7);
    expect(Object.isFrozen(PLATFORM_BOUNDARIES)).toBe(true);
  });

  it("freezes exactly the two refusing layers", () => {
    expect([...PLATFORM_LAYERS]).toEqual(["PLATFORM_CONTRACT", "PLATFORM_LINUX"]);
    expect(PLATFORM_LAYERS.length).toBe(2);
    expect(Object.isFrozen(PLATFORM_LAYERS)).toBe(true);
  });

  it("freezes exactly the two truth classes", () => {
    expect([...PLATFORM_TRUTH_CLASSES]).toEqual(["PROVEN", "UNKNOWN"]);
    expect(PLATFORM_TRUTH_CLASSES.length).toBe(2);
    expect(Object.isFrozen(PLATFORM_TRUTH_CLASSES)).toBe(true);
  });

  it("freezes exactly the nine hand-written reason codes", () => {
    expect([...PLATFORM_ERROR_CODES]).toEqual([
      "PLATFORM_BOUNDARY_UNKNOWN",
      "PLATFORM_FACT_MALFORMED",
      "PLATFORM_FACT_ABSENT",
      "PLATFORM_HOST_MISMATCH",
      "PLATFORM_FACT_STALE",
      "PLATFORM_FACT_UNPROVEN",
      "PLATFORM_ARCH_UNSUPPORTED",
      "PLATFORM_CLOSURE_UNPINNABLE",
      "PLATFORM_COVERAGE_INCOMPLETE",
    ]);
    expect(PLATFORM_ERROR_CODES.length).toBe(9);
    expect(Object.isFrozen(PLATFORM_ERROR_CODES)).toBe(true);
  });

  it("freezes exactly the two architectures this adapter will classify", () => {
    expect([...LINUX_SUPPORTED_ARCHITECTURES]).toEqual(["x64", "arm64"]);
    expect(Object.isFrozen(LINUX_SUPPORTED_ARCHITECTURES)).toBe(true);
  });
});

describe("observeLinuxPlatform", () => {
  it("proves all seven boundaries when every fact is present, on-host and fresh", () => {
    const observation = observeLinuxPlatform(baseInput());

    expect(observation.observationVersion).toBe(PLATFORM_OBSERVATION_VERSION);
    expect(observation.truthClass).toBe("PROVEN");
    expect(observation.verdicts.map((verdict) => verdict.boundary)).toEqual([
      ...PLATFORM_BOUNDARIES,
    ]);
    expect(observation.verdicts.every((verdict) => verdict.truthClass === "PROVEN")).toBe(true);
    expect(observation.verdicts.every((verdict) => verdict.failure === null)).toBe(true);
  });

  it("refuses every boundary as PLATFORM_HOST_MISMATCH at PLATFORM_LINUX on a darwin host", () => {
    const observation = observeLinuxPlatform(baseInput({ host: { ...LINUX_HOST, os: "darwin" } }));

    expect(observation.truthClass).toBe("UNKNOWN");
    expect(observation.verdicts.length).toBe(7);
    for (const boundary of PLATFORM_BOUNDARIES) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_HOST_MISMATCH");
      expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
      expect(verdictFor(observation, boundary).truthClass).toBe("UNKNOWN");
    }
  });

  it("refuses every boundary as PLATFORM_HOST_MISMATCH at PLATFORM_LINUX on a win32 host", () => {
    const observation = observeLinuxPlatform(baseInput({ host: { ...LINUX_HOST, os: "win32" } }));

    expect(observation.truthClass).toBe("UNKNOWN");
    for (const boundary of PLATFORM_BOUNDARIES) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_HOST_MISMATCH");
      expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    }
  });

  it("refuses a fully coherent darwin observation, so macOS inherits no Linux verdict", () => {
    const observation = observeLinuxPlatform(coherentHostInput("darwin"));

    expect(observation.truthClass).toBe("UNKNOWN");
    expect(observation.verdicts.length).toBe(7);
    for (const boundary of PLATFORM_BOUNDARIES) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_HOST_MISMATCH");
      expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    }
  });

  it("refuses a fully coherent win32 observation, which is this repository's own host", () => {
    const observation = observeLinuxPlatform(coherentHostInput("win32"));

    expect(observation.truthClass).toBe("UNKNOWN");
    for (const boundary of PLATFORM_BOUNDARIES) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_HOST_MISMATCH");
      expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    }
  });

  it("refuses a fact whose envelope host disagrees with the declared host", () => {
    const observation = observeLinuxPlatform(
      withFact("LOCK", envelope({ ...LEASE }, { host: { ...LINUX_HOST, osVersion: "5.15.0" } })),
    );

    const failure = refusalFor(observation, "LOCK");
    expect(failure.code).toBe("PLATFORM_HOST_MISMATCH");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    expect(failure.boundary).toBe("LOCK");
    expect(verdictFor(observation, "PROVIDER_LAUNCH").truthClass).toBe("PROVEN");
  });

  it("refuses a provider observation whose own embedded host disagrees", () => {
    const observation = observeLinuxPlatform(
      withFact(
        "PROVIDER_LAUNCH",
        envelope(providerObservation({ platformIdentity: { ...LINUX_HOST, os: "darwin" } })),
      ),
    );

    const failure = refusalFor(observation, "PROVIDER_LAUNCH");
    expect(failure.code).toBe("PLATFORM_HOST_MISMATCH");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    expect(failure.boundary).toBe("PROVIDER_LAUNCH");
  });

  it("refuses each declared-absent fact as PLATFORM_FACT_ABSENT, and only that boundary", () => {
    const cases = PLATFORM_BOUNDARIES.map((boundary) => ({
      boundary,
      observation: observeLinuxPlatform(withFact(boundary, null)),
    }));

    // A sweep that silently generates nothing passes while testing nothing.
    expect(cases.length).toBe(7);

    for (const { boundary, observation } of cases) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_FACT_ABSENT");
      expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
      expect(failure.boundary).toBe(boundary);
      expect(observation.truthClass).toBe("UNKNOWN");

      const others = observation.verdicts.filter((verdict) => verdict.boundary !== boundary);
      expect(others.length).toBe(6);
      expect(others.every((verdict) => verdict.truthClass === "PROVEN")).toBe(true);
    }
  });

  it("refuses a prototype-polluted envelope as PLATFORM_FACT_MALFORMED", () => {
    const polluted: unknown = JSON.parse(
      `{"__proto__":{"owned":true},"host":${JSON.stringify(LINUX_HOST)},` +
        `"observedAt":"${FRESH_AT}","truthClass":"PROVEN","fact":null}`,
    );
    const failure = refusalFor(observeLinuxPlatform(withFact("PATH_SYMLINK", polluted)), "PATH_SYMLINK");

    expect(failure.code).toBe("PLATFORM_FACT_MALFORMED");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
  });

  it("refuses an envelope carrying an extra key as PLATFORM_FACT_MALFORMED", () => {
    const extra = envelope({ ...LEASE }, { trusted: true });
    const failure = refusalFor(observeLinuxPlatform(withFact("LOCK", extra)), "LOCK");

    expect(failure.code).toBe("PLATFORM_FACT_MALFORMED");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
  });

  it("refuses an accessor-backed envelope without ever invoking the accessor", () => {
    let reads = 0;
    const shifty: Record<string, unknown> = {
      host: { ...LINUX_HOST },
      observedAt: FRESH_AT,
      fact: { ...LEASE },
    };
    Object.defineProperty(shifty, "truthClass", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "PROVEN" : "UNKNOWN";
      },
    });

    const failure = refusalFor(observeLinuxPlatform(withFact("LOCK", shifty)), "LOCK");

    expect(failure.code).toBe("PLATFORM_FACT_MALFORMED");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    // A validate-then-re-read implementation would take the first answer and
    // record the second; this asserts the classifier never asked at all.
    expect(reads).toBe(0);
  });

  it("refuses non-normalized host text as PLATFORM_FACT_MALFORMED", () => {
    const lone = envelope({ ...LEASE }, { host: { ...LINUX_HOST, osVersion: "6.8.0\uD800" } });
    const failure = refusalFor(observeLinuxPlatform(withFact("LOCK", lone)), "LOCK");

    expect(failure.code).toBe("PLATFORM_FACT_MALFORMED");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
  });

  it("refuses a fact observed past the freshness edge as PLATFORM_FACT_STALE", () => {
    const stale = envelope({ ...LEASE }, { observedAt: STALE_AT });
    const failure = refusalFor(observeLinuxPlatform(withFact("LOCK", stale)), "LOCK");

    expect(failure.code).toBe("PLATFORM_FACT_STALE");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    expect(failure.boundary).toBe("LOCK");
  });

  it("keeps a fact observed exactly at the freshness edge PROVEN", () => {
    const edge = envelope({ ...LEASE }, { observedAt: EDGE_AT });
    const observation = observeLinuxPlatform(withFact("LOCK", edge));

    expect(verdictFor(observation, "LOCK").truthClass).toBe("PROVEN");
    expect(observation.truthClass).toBe("PROVEN");
  });

  it("refuses a fact observed after asOf as PLATFORM_FACT_STALE rather than crediting it", () => {
    const future = envelope({ ...LEASE }, { observedAt: "2026-08-09T12:00:00.001Z" });
    const failure = refusalFor(observeLinuxPlatform(withFact("LOCK", future)), "LOCK");

    expect(failure.code).toBe("PLATFORM_FACT_STALE");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
  });

  it("refuses a provider observation whose own truthClass is UNKNOWN", () => {
    const unproven = envelope(providerObservation({ truthClass: "UNKNOWN" }));
    const failure = refusalFor(
      observeLinuxPlatform(withFact("PROVIDER_LAUNCH", unproven)),
      "PROVIDER_LAUNCH",
    );

    expect(failure.code).toBe("PLATFORM_FACT_UNPROVEN");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
  });

  it("refuses an envelope whose caller-declared truthClass is UNKNOWN", () => {
    const unproven = envelope({ ...LEASE }, { truthClass: "UNKNOWN" });
    const failure = refusalFor(observeLinuxPlatform(withFact("LOCK", unproven)), "LOCK");

    expect(failure.code).toBe("PLATFORM_FACT_UNPROVEN");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
  });

  it("refuses an unsupported architecture at PLATFORM_LINUX for every boundary", () => {
    const observation = observeLinuxPlatform(
      baseInput({ host: { ...LINUX_HOST, arch: "riscv64" } }),
    );

    expect(observation.truthClass).toBe("UNKNOWN");
    for (const boundary of PLATFORM_BOUNDARIES) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_ARCH_UNSUPPORTED");
      expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    }
  });

  it("refuses an unpinnable runtime closure on RUNTIME_CLOSURE only", () => {
    const unpinnable = envelope(providerObservation({ pinningMethod: "UNSUPPORTED" }));
    const observation = observeLinuxPlatform(withFact("RUNTIME_CLOSURE", unpinnable));

    const failure = refusalFor(observation, "RUNTIME_CLOSURE");
    expect(failure.code).toBe("PLATFORM_CLOSURE_UNPINNABLE");
    expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    expect(failure.boundary).toBe("RUNTIME_CLOSURE");
    expect(verdictFor(observation, "PROVIDER_LAUNCH").truthClass).toBe("PROVEN");
  });

  it("refuses an input that omits a boundary key as PLATFORM_COVERAGE_INCOMPLETE", () => {
    const facts = baseFacts();
    delete facts["CRASH_RECOVERY"];
    const observation = observeLinuxPlatform(baseInput({ facts }));

    expect(observation.truthClass).toBe("UNKNOWN");
    expect(observation.verdicts.length).toBe(7);
    for (const boundary of PLATFORM_BOUNDARIES) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_COVERAGE_INCOMPLETE");
      expect(failure.layer).toBe(PLATFORM_LINUX_LAYER);
    }
  });

  it("separates a declared absence from an omitted boundary", () => {
    const absent = observeLinuxPlatform(withFact("CRASH_RECOVERY", null));
    const facts = baseFacts();
    delete facts["CRASH_RECOVERY"];
    const omitted = observeLinuxPlatform(baseInput({ facts }));

    expect(refusalFor(absent, "CRASH_RECOVERY").code).toBe("PLATFORM_FACT_ABSENT");
    expect(refusalFor(omitted, "CRASH_RECOVERY").code).toBe("PLATFORM_COVERAGE_INCOMPLETE");
  });

  it("reports a null host and refuses at PLATFORM_CONTRACT when the host record is unusable", () => {
    const observation = observeLinuxPlatform(baseInput({ host: { os: "linux", arch: "x64" } }));

    expect(observation.host).toBeNull();
    expect(observation.truthClass).toBe("UNKNOWN");
    for (const boundary of PLATFORM_BOUNDARIES) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_FACT_MALFORMED");
      expect(failure.layer).toBe("PLATFORM_CONTRACT");
    }
  });

  it("refuses a non-canonical asOf at PLATFORM_CONTRACT", () => {
    const observation = observeLinuxPlatform(baseInput({ asOf: "2026-08-09 12:00:00" }));

    for (const boundary of PLATFORM_BOUNDARIES) {
      const failure = refusalFor(observation, boundary);
      expect(failure.code).toBe("PLATFORM_FACT_MALFORMED");
      expect(failure.layer).toBe("PLATFORM_CONTRACT");
    }
  });

  it("lets a single UNKNOWN verdict force the aggregate to UNKNOWN", () => {
    const observation = observeLinuxPlatform(withFact("SIGNAL_CANCELLATION", null));

    const unknown = observation.verdicts.filter((verdict) => verdict.truthClass === "UNKNOWN");
    expect(unknown.length).toBe(1);
    expect(observation.verdicts.length).toBe(7);
    expect(observation.truthClass).toBe("UNKNOWN");
  });
});

describe("classifyLinuxBoundary", () => {
  it("refuses a boundary outside the frozen vocabulary at PLATFORM_CONTRACT", () => {
    const result = classifyLinuxBoundary("NETWORK", envelope({ ...LEASE }), CONTEXT);

    expect(isPlatformFailure(result)).toBe(true);
    if (!isPlatformFailure(result)) {
      throw new Error("expected a contract-layer refusal");
    }
    expect(result.code).toBe("PLATFORM_BOUNDARY_UNKNOWN");
    expect(result.layer).toBe("PLATFORM_CONTRACT");
    expect(result.boundary).toBeNull();
  });

  it("refuses a hostile classification context instead of throwing out of the seam", () => {
    const hostile = [
      { host: { ...LINUX_HOST }, asOf: "yesterday", maxFactAgeMs: MAX_AGE_MS },
      { host: { ...LINUX_HOST }, asOf: AS_OF, maxFactAgeMs: Number.POSITIVE_INFINITY },
      { host: { ...LINUX_HOST }, asOf: AS_OF, maxFactAgeMs: -1 },
      { host: null, asOf: AS_OF, maxFactAgeMs: MAX_AGE_MS },
      { host: { ...LINUX_HOST }, asOf: AS_OF },
    ];
    expect(hostile.length).toBe(5);

    for (const context of hostile) {
      const result = classifyLinuxBoundary("LOCK", envelope({ ...LEASE }), context);
      if (!isPlatformFailure(result)) {
        throw new Error("a hostile context must refuse rather than yield a verdict");
      }
      expect(result.code).toBe("PLATFORM_FACT_MALFORMED");
      expect(result.layer).toBe("PLATFORM_CONTRACT");
      expect(result.boundary).toBe("LOCK");
    }
  });

  it("answers as PLATFORM_LINUX for a known boundary, so the layers are distinguishable", () => {
    const result = classifyLinuxBoundary("LOCK", null, CONTEXT);

    expect(isPlatformFailure(result)).toBe(false);
    if (isPlatformFailure(result)) {
      throw new Error("expected a boundary verdict");
    }
    expect(result.boundary).toBe("LOCK");
    expect(result.truthClass).toBe("UNKNOWN");
    expect(result.failure?.code).toBe("PLATFORM_FACT_ABSENT");
    expect(result.failure?.layer).toBe(PLATFORM_LINUX_LAYER);
  });
});

/**
 * Drives every reason code out of the production surface in one place, so the
 * assertion does not depend on which other tests ran. A code nobody can reach
 * cannot be added to the vocabulary, and a code that stops being reachable
 * takes this red.
 */
function reachableErrorCodes(): ReadonlySet<string> {
  const codes = new Set<string>();
  const collect = (observation: PlatformObservation): void => {
    for (const verdict of observation.verdicts) {
      if (verdict.failure !== null) {
        codes.add(verdict.failure.code);
      }
    }
  };

  collect(observeLinuxPlatform(baseInput({ host: { ...LINUX_HOST, os: "darwin" } })));
  collect(observeLinuxPlatform(baseInput({ host: { ...LINUX_HOST, arch: "riscv64" } })));
  collect(observeLinuxPlatform(baseInput({ host: { os: "linux", arch: "x64" } })));
  collect(observeLinuxPlatform(withFact("LOCK", null)));
  collect(observeLinuxPlatform(withFact("LOCK", envelope({ ...LEASE }, { trusted: true }))));
  collect(observeLinuxPlatform(withFact("LOCK", envelope({ ...LEASE }, { observedAt: STALE_AT }))));
  collect(
    observeLinuxPlatform(withFact("PROVIDER_LAUNCH", envelope(providerObservation({ truthClass: "UNKNOWN" })))),
  );
  collect(
    observeLinuxPlatform(
      withFact("RUNTIME_CLOSURE", envelope(providerObservation({ pinningMethod: "UNSUPPORTED" }))),
    ),
  );

  const short = baseFacts();
  delete short["LOCK"];
  collect(observeLinuxPlatform(baseInput({ facts: short })));

  const unknownBoundary = classifyLinuxBoundary("NETWORK", envelope({ ...LEASE }), CONTEXT);
  if (isPlatformFailure(unknownBoundary)) {
    codes.add(unknownBoundary.code);
  }

  return codes;
}

describe("closed reason-code vocabulary", () => {
  it("reaches every declared code and declares every reachable code", () => {
    const reached = reachableErrorCodes();

    expect(reached.size).toBeGreaterThan(0);
    expect(reached.size).toBe(PLATFORM_ERROR_CODES.length);
    expect([...reached].sort()).toEqual([...PLATFORM_ERROR_CODES].sort());
  });
});
