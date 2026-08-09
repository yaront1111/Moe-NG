/**
 * Behaviour contract for the recovery-window inventory seam.
 *
 * Every specifier here is the bare package root `@moe/runner`: the package
 * `exports` map is exclusive, so a deep subpath does not resolve for a real
 * consumer and testing one would prove nothing about the published seam.
 *
 * Every vocabulary below is hand-written from the task's definition of done, not
 * derived from the module under test. A literal copied out of the implementation
 * agrees with any drift, including drift that deletes a case.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_RECOVERY_INVENTORY_ITEMS,
  RECOVERY_INVENTORY_CLASSES,
  RECOVERY_INVENTORY_ERROR_CODES,
  RECOVERY_INVENTORY_LAYERS,
  RECOVERY_INVENTORY_REF_KINDS,
  RECOVERY_INVENTORY_TRUTH_CLASSES,
  RECOVERY_INVENTORY_UNKNOWN_REASONS,
  RECOVERY_INVENTORY_VERSION,
  collectRecoveryInventory,
  createRecoveryInventoryRegistry,
  isRecoveryInventoryFailure,
} from "@moe/runner";
import type {
  RecoveryInventoryClass,
  RecoveryInventoryReport,
  RecoveryInventoryResult,
} from "@moe/runner";

const LAYER = "INVENTORY_ADAPTER";
const PROJECT = "moe-next";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

const BACKUP = { kind: "BACKUP_CURSOR_GENERATION", ref: "gen-42", digest: DIGEST_A } as const;
const INCARNATION = { kind: "RECOVERY_INCARNATION", ref: "inc-7", digest: DIGEST_B } as const;
const WINDOW = { startInclusive: "2026-08-01T00:00:00Z", endInclusive: "2026-08-09T23:59:59Z" };

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectTag: PROJECT,
    backup: { ...BACKUP },
    incarnation: { ...INCARNATION },
    window: { ...WINDOW },
    configuredClasses: [...RECOVERY_INVENTORY_CLASSES],
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    class: "WORKSPACE",
    projectTag: PROJECT,
    identity: { kind: "PATH", path: "workspaces/alpha" },
    observedAt: "2026-08-05T12:00:00Z",
    facts: { present: true, sizeBytes: 12 },
    sourceProofDigest: DIGEST_C,
    ...overrides,
  };
}

function enumerated(items: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    status: "ENUMERATED",
    items: [...items],
    complete: true,
    negativeProofDigest: null,
    ...overrides,
  };
}

/** Records call counts so "the enumerator never ran" is asserted, not assumed. */
function port(result: unknown | (() => unknown)) {
  const calls: unknown[] = [];
  return {
    calls,
    enumerate: (context: unknown) => {
      calls.push(context);
      const produced = typeof result === "function" ? (result as () => unknown)() : result;
      return Promise.resolve(produced);
    },
  };
}

function registryOf(entries: Record<string, unknown>) {
  return createRecoveryInventoryRegistry(
    Object.entries(entries).map(([cls, enumerate]) => ({
      class: cls as RecoveryInventoryClass,
      enumerate: enumerate as (context: unknown) => Promise<unknown>,
    })),
  );
}

function expectReport(result: RecoveryInventoryResult): RecoveryInventoryReport {
  if (isRecoveryInventoryFailure(result)) {
    throw new Error(`expected a report, got refusal ${result.code}`);
  }
  return result;
}

function proofFor(report: RecoveryInventoryReport, cls: string) {
  const proof = report.proofs.find((candidate) => candidate.class === cls);
  if (proof === undefined) {
    throw new Error(`no coverage proof for configured class ${cls}`);
  }
  return proof;
}

describe("frozen vocabulary", () => {
  it("pins the version, class set, layer, truth classes and ref kinds by value", () => {
    expect(RECOVERY_INVENTORY_VERSION).toBe("moe-recovery-inventory/1");
    expect([...RECOVERY_INVENTORY_CLASSES]).toEqual([
      "PROVIDER_PROCESS_LAUNCH_LOCK",
      "WORKSPACE",
      "GIT_INTEGRATION_ON_DISK",
      "ARTIFACT_OBJECT_STAGING",
    ]);
    expect([...RECOVERY_INVENTORY_LAYERS]).toEqual([LAYER]);
    expect([...RECOVERY_INVENTORY_TRUTH_CLASSES]).toEqual(["COMPLETE", "UNKNOWN"]);
    expect([...RECOVERY_INVENTORY_REF_KINDS]).toEqual([
      "BACKUP_CURSOR_GENERATION",
      "RECOVERY_INCARNATION",
    ]);
    expect(Object.isFrozen(RECOVERY_INVENTORY_CLASSES)).toBe(true);
  });

  it("pins the refusal codes in precedence order and the UNKNOWN reasons", () => {
    expect([...RECOVERY_INVENTORY_ERROR_CODES]).toEqual([
      "RECOVERY_INVENTORY_REQUEST_INVALID",
      "RECOVERY_INVENTORY_PROJECT_TAG_INVALID",
      "RECOVERY_INVENTORY_BACKUP_REF_INVALID",
      "RECOVERY_INVENTORY_INCARNATION_REF_INVALID",
      "RECOVERY_INVENTORY_WINDOW_INVALID",
      "RECOVERY_INVENTORY_CONFIGURED_CLASSES_INVALID",
      "RECOVERY_INVENTORY_CLASS_MISMATCH",
      "RECOVERY_INVENTORY_PROJECT_MISMATCH",
      "RECOVERY_INVENTORY_WINDOW_MISMATCH",
      "RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE",
      "RECOVERY_INVENTORY_COVERAGE_UNKNOWN",
    ]);
    expect([...RECOVERY_INVENTORY_UNKNOWN_REASONS]).toEqual([
      "ENUMERATOR_UNREGISTERED",
      "ENUMERATOR_UNAVAILABLE",
      "ENUMERATOR_FAILED",
      "CAPABILITY_UNSUPPORTED",
      "RESULT_MALFORMED",
      "RESULT_TRUNCATED",
      "RESULT_OVER_LIMIT",
      "NEGATIVE_PROOF_MISSING",
      "ITEM_REJECTED",
    ]);
  });
});

describe("request validation precedence", () => {
  const CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ["non-record request", { __replace: 42 }, "RECOVERY_INVENTORY_REQUEST_INVALID"],
    ["unknown extra key", { surprise: 1 }, "RECOVERY_INVENTORY_REQUEST_INVALID"],
    ["blank project tag", { projectTag: "" }, "RECOVERY_INVENTORY_PROJECT_TAG_INVALID"],
    ["denormalized project tag", { projectTag: "café" }, "RECOVERY_INVENTORY_PROJECT_TAG_INVALID"],
    ["backup ref wrong kind", { backup: { ...BACKUP, kind: "RECOVERY_INCARNATION" } }, "RECOVERY_INVENTORY_BACKUP_REF_INVALID"],
    ["backup digest not sha256", { backup: { ...BACKUP, digest: "nope" } }, "RECOVERY_INVENTORY_BACKUP_REF_INVALID"],
    ["backup digest uppercase", { backup: { ...BACKUP, digest: DIGEST_A.toUpperCase() } }, "RECOVERY_INVENTORY_BACKUP_REF_INVALID"],
    ["incarnation ref wrong kind", { incarnation: { ...INCARNATION, kind: "BACKUP_CURSOR_GENERATION" } }, "RECOVERY_INVENTORY_INCARNATION_REF_INVALID"],
    ["incarnation extra key", { incarnation: { ...INCARNATION, extra: 1 } }, "RECOVERY_INVENTORY_INCARNATION_REF_INVALID"],
    ["window not canonical utc", { window: { startInclusive: "2026-08-01", endInclusive: "2026-08-09T00:00:00Z" } }, "RECOVERY_INVENTORY_WINDOW_INVALID"],
    ["window inverted", { window: { startInclusive: "2026-08-09T00:00:00Z", endInclusive: "2026-08-01T00:00:00Z" } }, "RECOVERY_INVENTORY_WINDOW_INVALID"],
    ["configured classes empty", { configuredClasses: [] }, "RECOVERY_INVENTORY_CONFIGURED_CLASSES_INVALID"],
    ["configured classes duplicated", { configuredClasses: ["WORKSPACE", "WORKSPACE"] }, "RECOVERY_INVENTORY_CONFIGURED_CLASSES_INVALID"],
    ["configured class unknown", { configuredClasses: ["NOT_A_CLASS"] }, "RECOVERY_INVENTORY_CONFIGURED_CLASSES_INVALID"],
  ];

  it("generated every declared refusal case", () => {
    expect(CASES.length).toBe(14);
    expect(CASES.map(([name]) => name)).toContain("window inverted");
  });

  for (const [name, override, code] of CASES) {
    it(`refuses a ${name} with ${code} at ${LAYER}, before any enumerator runs`, async () => {
      const workspace = port(enumerated([item()]));
      const input =
        "__replace" in override ? override["__replace"] : request(override);
      const result = await collectRecoveryInventory(input, registryOf({ WORKSPACE: workspace.enumerate }));

      expect(isRecoveryInventoryFailure(result)).toBe(true);
      if (!isRecoveryInventoryFailure(result)) return;
      expect(result.code).toBe(code);
      expect(result.layer).toBe(LAYER);
      expect(workspace.calls.length).toBe(0);
    });
  }

  it("refuses a registration carrying a field this seam does not understand", async () => {
    const registry = { registrations: [{ class: "WORKSPACE", enumerate: () => ({}), extra: 1 }] };
    const result = await collectRecoveryInventory(request(), registry as never);
    expect(isRecoveryInventoryFailure(result)).toBe(true);
    if (!isRecoveryInventoryFailure(result)) return;
    expect(result.code).toBe("RECOVERY_INVENTORY_REQUEST_INVALID");
    expect(result.layer).toBe(LAYER);
  });

  it("refuses a registration whose class is an accessor rather than data", async () => {
    // A getter could answer "WORKSPACE" for the validation and something else
    // for the invocation, so it is refused outright instead of out-read.
    let reads = 0;
    const hostile = {
      get class() {
        reads += 1;
        return reads === 1 ? "WORKSPACE" : "ARTIFACT_OBJECT_STAGING";
      },
      enumerate: () => ({ status: "UNAVAILABLE" }),
    };
    const result = await collectRecoveryInventory(request(), {
      registrations: [hostile],
    } as never);
    expect(isRecoveryInventoryFailure(result)).toBe(true);
    if (!isRecoveryInventoryFailure(result)) return;
    expect(result.code).toBe("RECOVERY_INVENTORY_REQUEST_INVALID");
    expect(reads).toBe(0);
  });

  it("refuses a registry that registers one class twice", async () => {
    const registry = registryOf({});
    const duplicated = createRecoveryInventoryRegistry([
      { class: "WORKSPACE", enumerate: port(enumerated([])).enumerate },
      { class: "WORKSPACE", enumerate: port(enumerated([])).enumerate },
    ]);
    expect(registry).toBeDefined();
    const result = await collectRecoveryInventory(request(), duplicated);
    expect(isRecoveryInventoryFailure(result)).toBe(true);
    if (!isRecoveryInventoryFailure(result)) return;
    expect(result.code).toBe("RECOVERY_INVENTORY_REQUEST_INVALID");
    expect(result.layer).toBe(LAYER);
  });
});

describe("coverage protocol", () => {
  it("answers UNKNOWN/ENUMERATOR_UNREGISTERED for every configured class when nothing is registered", async () => {
    const report = expectReport(await collectRecoveryInventory(request(), registryOf({})));

    expect(report.proofs.length).toBe(RECOVERY_INVENTORY_CLASSES.length);
    expect(report.proofs.map((proof) => proof.class)).toEqual([...RECOVERY_INVENTORY_CLASSES]);
    for (const cls of RECOVERY_INVENTORY_CLASSES) {
      const proof = proofFor(report, cls);
      expect(proof.truth).toBe("UNKNOWN");
      expect(proof.code).toBe("RECOVERY_INVENTORY_COVERAGE_UNKNOWN");
      expect(proof.reason).toBe("ENUMERATOR_UNREGISTERED");
      expect(proof.layer).toBe(LAYER);
      expect(proof.itemCount).toBe(0);
    }
    expect(report.coverage).toBe("UNKNOWN");
    expect(report.items.length).toBe(0);
  });

  it("emits one proof per CONFIGURED class, never per returned class", async () => {
    const workspace = port(enumerated([item()]));
    const report = expectReport(
      await collectRecoveryInventory(
        request({ configuredClasses: ["WORKSPACE", "GIT_INTEGRATION_ON_DISK"] }),
        registryOf({ WORKSPACE: workspace.enumerate }),
      ),
    );

    expect(report.proofs.map((proof) => proof.class)).toEqual([
      "WORKSPACE",
      "GIT_INTEGRATION_ON_DISK",
    ]);
    expect(proofFor(report, "WORKSPACE").truth).toBe("COMPLETE");
    expect(proofFor(report, "GIT_INTEGRATION_ON_DISK").truth).toBe("UNKNOWN");
    expect(report.coverage).toBe("UNKNOWN");
  });

  it("never calls an enumerator registered for an unconfigured class", async () => {
    const workspace = port(enumerated([item()]));
    const artifact = port(enumerated([]));
    const report = expectReport(
      await collectRecoveryInventory(
        request({ configuredClasses: ["WORKSPACE"] }),
        registryOf({ WORKSPACE: workspace.enumerate, ARTIFACT_OBJECT_STAGING: artifact.enumerate }),
      ),
    );

    expect(workspace.calls.length).toBe(1);
    expect(artifact.calls.length).toBe(0);
    expect(report.proofs.length).toBe(1);
  });

  const UNKNOWN_CASES: readonly (readonly [string, unknown, string])[] = [
    ["an unavailable enumerator", { status: "UNAVAILABLE" }, "ENUMERATOR_UNAVAILABLE"],
    ["an unsupported capability", { status: "UNSUPPORTED" }, "CAPABILITY_UNSUPPORTED"],
    ["a malformed result", { status: "ENUMERATED" }, "RESULT_MALFORMED"],
    ["a non-record result", 7, "RESULT_MALFORMED"],
    ["a truncated result", enumerated([item()], { complete: false }), "RESULT_TRUNCATED"],
    [
      "an over-limit result",
      enumerated(Array.from({ length: MAX_RECOVERY_INVENTORY_ITEMS + 1 }, () => item())),
      "RESULT_OVER_LIMIT",
    ],
    ["an empty COMPLETE claim with no negative proof", enumerated([]), "NEGATIVE_PROOF_MISSING"],
  ];

  it("generated every declared UNKNOWN case", () => {
    expect(UNKNOWN_CASES.length).toBe(7);
    // Six distinct reasons across seven cases: a structurally wrong ENUMERATED
    // record and a non-record answer are both RESULT_MALFORMED on purpose, and
    // are kept as separate cases because only one of them exercises the
    // exact-key reader.
    expect(new Set(UNKNOWN_CASES.map(([, , reason]) => reason)).size).toBe(6);
    expect(UNKNOWN_CASES.filter(([, , reason]) => reason === "RESULT_MALFORMED").length).toBe(2);
  });

  for (const [name, result, reason] of UNKNOWN_CASES) {
    it(`maps ${name} to COVERAGE_UNKNOWN/${reason} at ${LAYER}`, async () => {
      const workspace = port(result);
      const report = expectReport(
        await collectRecoveryInventory(
          request({ configuredClasses: ["WORKSPACE"] }),
          registryOf({ WORKSPACE: workspace.enumerate }),
        ),
      );
      const proof = proofFor(report, "WORKSPACE");

      expect(proof.truth).toBe("UNKNOWN");
      expect(proof.code).toBe("RECOVERY_INVENTORY_COVERAGE_UNKNOWN");
      expect(proof.reason).toBe(reason);
      expect(proof.layer).toBe(LAYER);
      expect(report.items.length).toBe(0);
      expect(report.coverage).toBe("UNKNOWN");
    });
  }

  it("maps a rejected enumerator promise to COVERAGE_UNKNOWN/ENUMERATOR_FAILED", async () => {
    const registry = createRecoveryInventoryRegistry([
      { class: "WORKSPACE", enumerate: () => Promise.reject(new Error("boom")) },
    ]);
    const report = expectReport(
      await collectRecoveryInventory(request({ configuredClasses: ["WORKSPACE"] }), registry),
    );
    const proof = proofFor(report, "WORKSPACE");
    expect(proof.reason).toBe("ENUMERATOR_FAILED");
    expect(proof.code).toBe("RECOVERY_INVENTORY_COVERAGE_UNKNOWN");
    expect(proof.layer).toBe(LAYER);
  });

  it("maps a synchronously throwing enumerator to COVERAGE_UNKNOWN/ENUMERATOR_FAILED", async () => {
    const registry = createRecoveryInventoryRegistry([
      {
        class: "WORKSPACE",
        enumerate: () => {
          throw new Error("sync boom");
        },
      },
    ]);
    const report = expectReport(
      await collectRecoveryInventory(request({ configuredClasses: ["WORKSPACE"] }), registry),
    );
    expect(proofFor(report, "WORKSPACE").reason).toBe("ENUMERATOR_FAILED");
  });

  it("accepts an empty class only with a negative proof digest, and records it", async () => {
    const workspace = port(enumerated([], { negativeProofDigest: DIGEST_C }));
    const report = expectReport(
      await collectRecoveryInventory(
        request({ configuredClasses: ["WORKSPACE"] }),
        registryOf({ WORKSPACE: workspace.enumerate }),
      ),
    );
    const proof = proofFor(report, "WORKSPACE");
    expect(proof.truth).toBe("COMPLETE");
    expect(proof.reason).toBe(null);
    expect(proof.code).toBe(null);
    expect(proof.negativeProofDigest).toBe(DIGEST_C);
    expect(proof.itemCount).toBe(0);
    expect(report.coverage).toBe("COMPLETE");
  });

  it("reports COMPLETE only when every configured class is COMPLETE", async () => {
    const good = port(enumerated([item()]));
    const bad = port({ status: "UNAVAILABLE" });
    const report = expectReport(
      await collectRecoveryInventory(
        request({ configuredClasses: ["WORKSPACE", "ARTIFACT_OBJECT_STAGING"] }),
        registryOf({ WORKSPACE: good.enumerate, ARTIFACT_OBJECT_STAGING: bad.enumerate }),
      ),
    );
    expect(proofFor(report, "WORKSPACE").truth).toBe("COMPLETE");
    expect(report.coverage).toBe("UNKNOWN");
  });
});

describe("item admission", () => {
  const ITEM_CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
    [
      "an item attributed to another class",
      { class: "ARTIFACT_OBJECT_STAGING" },
      "RECOVERY_INVENTORY_CLASS_MISMATCH",
    ],
    [
      "an item from another project",
      { projectTag: "other-project" },
      "RECOVERY_INVENTORY_PROJECT_MISMATCH",
    ],
    [
      "an item observed before the window",
      { observedAt: "2026-07-31T23:59:59Z" },
      "RECOVERY_INVENTORY_WINDOW_MISMATCH",
    ],
    [
      "an item observed after the window",
      { observedAt: "2026-08-10T00:00:00Z" },
      "RECOVERY_INVENTORY_WINDOW_MISMATCH",
    ],
  ];

  it("generated every declared item-refusal case", () => {
    expect(ITEM_CASES.length).toBe(4);
  });

  for (const [name, override, code] of ITEM_CASES) {
    it(`refuses ${name} with ${code} rather than dropping it`, async () => {
      const workspace = port(enumerated([item(override)]));
      const report = expectReport(
        await collectRecoveryInventory(
          request({ configuredClasses: ["WORKSPACE"] }),
          registryOf({ WORKSPACE: workspace.enumerate }),
        ),
      );
      const proof = proofFor(report, "WORKSPACE");

      expect(proof.truth).toBe("UNKNOWN");
      expect(proof.code).toBe(code);
      expect(proof.reason).toBe("ITEM_REJECTED");
      expect(proof.layer).toBe(LAYER);
      expect(report.items.length).toBe(0);
    });
  }

  it("admits both inclusive window edges", async () => {
    const workspace = port(
      enumerated([
        item({ observedAt: WINDOW.startInclusive, identity: { kind: "PATH", path: "a" } }),
        item({ observedAt: WINDOW.endInclusive, identity: { kind: "PATH", path: "b" } }),
      ]),
    );
    const report = expectReport(
      await collectRecoveryInventory(
        request({ configuredClasses: ["WORKSPACE"] }),
        registryOf({ WORKSPACE: workspace.enumerate }),
      ),
    );
    expect(proofFor(report, "WORKSPACE").truth).toBe("COMPLETE");
    expect(report.items.length).toBe(2);
  });

  it("refuses duplicate identities that alias only after PATH separator normalization", async () => {
    const workspace = port(
      enumerated([
        item({ identity: { kind: "PATH", path: "workspaces/alpha" } }),
        item({ identity: { kind: "PATH", path: "workspaces\\alpha" } }),
      ]),
    );
    const report = expectReport(
      await collectRecoveryInventory(
        request({ configuredClasses: ["WORKSPACE"] }),
        registryOf({ WORKSPACE: workspace.enumerate }),
      ),
    );
    const proof = proofFor(report, "WORKSPACE");
    expect(proof.code).toBe("RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE");
    expect(proof.reason).toBe("ITEM_REJECTED");
    expect(proof.truth).toBe("UNKNOWN");
  });

  it("keeps OPAQUE identity bytes distinct even when they differ only by separator", async () => {
    const workspace = port(
      enumerated([
        item({ identity: { kind: "OPAQUE", id: "provider\\lock" } }),
        item({ identity: { kind: "OPAQUE", id: "provider/lock" } }),
      ]),
    );
    const report = expectReport(
      await collectRecoveryInventory(
        request({ configuredClasses: ["WORKSPACE"] }),
        registryOf({ WORKSPACE: workspace.enumerate }),
      ),
    );
    expect(proofFor(report, "WORKSPACE").truth).toBe("COMPLETE");
    expect(report.items.length).toBe(2);
  });
});

describe("determinism, digests and immutability", () => {
  async function collectWith(items: readonly unknown[], overrides: Record<string, unknown> = {}) {
    const workspace = port(enumerated(items));
    return expectReport(
      await collectRecoveryInventory(
        request({ configuredClasses: ["WORKSPACE"], ...overrides }),
        registryOf({ WORKSPACE: workspace.enumerate }),
      ),
    );
  }

  const SHUFFLED = [
    item({ identity: { kind: "PATH", path: "b/two" } }),
    item({ identity: { kind: "OPAQUE", id: "zeta" } }),
    item({ identity: { kind: "PATH", path: "a/one" } }),
  ];

  it("orders items and digests identically regardless of enumerator order", async () => {
    const forward = await collectWith(SHUFFLED);
    const reversed = await collectWith([...SHUFFLED].reverse());

    expect(forward.items.map((entry) => entry.identity)).toEqual(
      reversed.items.map((entry) => entry.identity),
    );
    expect(forward.inventoryDigest).toBe(reversed.inventoryDigest);
    expect(forward.items.length).toBe(3);
  });

  it("orders by code point rather than locale collation", async () => {
    const report = await collectWith([
      item({ identity: { kind: "OPAQUE", id: "Z-upper" } }),
      item({ identity: { kind: "OPAQUE", id: "a-lower" } }),
    ]);
    const ids = report.items.map((entry) =>
      entry.identity.kind === "OPAQUE" ? entry.identity.id : entry.identity.path,
    );
    expect(ids).toEqual(["Z-upper", "a-lower"]);
  });

  it("is insensitive to the key order a caller happened to build a fact record in", async () => {
    const first = await collectWith([item({ facts: { present: true, sizeBytes: 12 } })]);
    const second = await collectWith([item({ facts: { sizeBytes: 12, present: true } })]);
    expect(first.inventoryDigest).toBe(second.inventoryDigest);
  });

  const SENSITIVITY: readonly (readonly [string, Record<string, unknown>])[] = [
    ["the project tag", { projectTag: "another-project" }],
    ["the backup ref digest", { backup: { ...BACKUP, digest: DIGEST_C } }],
    ["the incarnation ref digest", { incarnation: { ...INCARNATION, digest: DIGEST_C } }],
    ["the window", { window: { ...WINDOW, endInclusive: "2026-08-09T23:59:58Z" } }],
  ];

  it("generated every declared basis-sensitivity case", () => {
    expect(SENSITIVITY.length).toBe(4);
  });

  for (const [name, override] of SENSITIVITY) {
    it(`changes the basis digest when ${name} changes`, async () => {
      const base = await collectWith([item()]);
      const altered = await collectWith([item()], override);
      expect(altered.basisDigest).not.toBe(base.basisDigest);
      expect(altered.inventoryDigest).not.toBe(base.inventoryDigest);
    });
  }

  it("changes the inventory digest when an item fact or source proof changes", async () => {
    const base = await collectWith([item()]);
    const factChanged = await collectWith([item({ facts: { present: false, sizeBytes: 12 } })]);
    const proofChanged = await collectWith([item({ sourceProofDigest: DIGEST_A })]);

    expect(factChanged.inventoryDigest).not.toBe(base.inventoryDigest);
    expect(proofChanged.inventoryDigest).not.toBe(base.inventoryDigest);
  });

  it("binds a __proto__ fact into the digest instead of silently dropping it", async () => {
    // `Object.keys` reports an own "__proto__" data property (JSON.parse makes
    // one), but assigning it onto a plain `{}` accumulator is swallowed by the
    // inherited setter. A reader that accumulates into `{}` therefore validates
    // a fact and then loses it, admitting the item with evidence that never
    // reaches the digest — the silent drop this contract exists to forbid.
    const smuggled = JSON.parse('{"__proto__":"hostile","present":true}') as Record<
      string,
      unknown
    >;
    expect(Object.keys(smuggled)).toContain("__proto__");

    const withSmuggled = await collectWith([item({ facts: smuggled })]);
    const withoutIt = await collectWith([item({ facts: { present: true } })]);

    expect(withSmuggled.items.length).toBe(1);
    expect(Object.keys(withSmuggled.items[0]?.facts ?? {})).toContain("__proto__");
    expect(withSmuggled.inventoryDigest).not.toBe(withoutIt.inventoryDigest);
  });

  it("returns a deeply frozen report", async () => {
    const report = await collectWith([item()]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.items)).toBe(true);
    expect(Object.isFrozen(report.proofs)).toBe(true);
    expect(Object.isFrozen(report.items[0])).toBe(true);
    expect(Object.isFrozen(report.items[0]?.facts)).toBe(true);
    expect(Object.isFrozen(report.configuredClasses)).toBe(true);
  });

  it("ignores registry mutation attempted after the call began", async () => {
    const entries = [{ class: "WORKSPACE" as const, enumerate: port(enumerated([item()])).enumerate }];
    const registry = createRecoveryInventoryRegistry(entries);
    entries.push({ class: "WORKSPACE" as const, enumerate: port(enumerated([])).enumerate });

    const report = expectReport(
      await collectRecoveryInventory(request({ configuredClasses: ["WORKSPACE"] }), registry),
    );
    expect(proofFor(report, "WORKSPACE").itemCount).toBe(1);
  });

  it("produces byte-identical reports across repeated concurrent collection", async () => {
    const [a, b] = await Promise.all([collectWith([item()]), collectWith([item()])]);
    expect(a?.inventoryDigest).toBe(b?.inventoryDigest);
  });
});
