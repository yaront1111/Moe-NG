import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFIRMATORY_FREEZE_AUTHORITY_CODE, CONFIRMATORY_FREEZE_AUTHORITY_LAYER,
  CONFIRMATORY_FREEZE_AUTHORITY_RECORD_PATH,
  readConfirmatoryFreezeAuthority,
} from "./index.js";
import type { ConfirmatoryFreezeAuthorityRefusal } from "./index.js";

/**
 * The refusal this row exists to make durable, asserted through the PUBLIC package root
 * rather than the module file, because the public root is what a consumer can reach.
 *
 * Every arm pins the EXACT code and the EXACT layer. An assertion that only checked
 * "it refused" would pass against any refusal — including a generic catch that had
 * swallowed this decision — and would certify nothing about the decision having been
 * made. Governor ruling comment-b308bf89a6d24978a928eadc5bade7b1, condition (b).
 */
const EXPECTED_REFUSAL = {
  authority: "NONE",
  code: "CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED",
  layer: "CONFIRMATORY_FREEZE_AUTHORITY",
  ok: false,
} as const;

const EXPECTED_KEYS = ["authority", "code", "layer", "ok"] as const;

/**
 * Names that would mean an authority had been granted somewhere in the result. The
 * refusal must carry no custodian, signer, key, registry, seal or corpus field: a
 * consumer that could read one out of this object would have been handed the very
 * entitlement the ruling withholds.
 */
const AUTHORITY_BEARING_FRAGMENTS = [
  "corpus", "custod", "key", "manifest", "registry", "seal", "sign", "trust",
] as const;

/** Environment names a future implementer might reach for to flip a refusal open. */
const PLAUSIBLE_ENVIRONMENT_KEYS = [
  "MOE_BENCHMARK_SIGNING_KEY_ID",
  "MOE_CONFIRMATORY_CORPUS_CUSTODIAN",
  "MOE_CONFIRMATORY_FREEZE_AUTHORITY",
  "MOE_CONFIRMATORY_FREEZE_AUTHORITY_OK",
] as const;

const restoreEnvironment = (): void => {
  for (const name of PLAUSIBLE_ENVIRONMENT_KEYS) delete process.env[name];
};

describe("confirmatory freeze authority is unassigned (task-22b69ee5)", () => {
  afterEach(() => {
    restoreEnvironment();
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("routes bytes from the fixed record source through strict validation", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ readFileSync: () => new TextEncoder().encode("{") }));
    const module = await import("./confirmatory-freeze-authority.js");

    const result = module.readConfirmatoryFreezeAuthority();

    expect(result).toMatchObject({
      authority: "NONE",
      code: "CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED",
      layer: "CONFIRMATORY_FREEZE_AUTHORITY",
      ok: false,
    });
  });

  it("codes a non-missing file-read failure as unreadable at the authority layer", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      readFileSync: () => {
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      },
    }));
    const module = await import("./confirmatory-freeze-authority.js");

    expect(module.readConfirmatoryFreezeAuthority()).toEqual({
      authority: "NONE",
      code: "CONFIRMATORY_FREEZE_AUTHORITY_UNREADABLE",
      layer: "CONFIRMATORY_FREEZE_AUTHORITY",
      ok: false,
    });
  });

  it("has no authority record installed at the reader's fixed path", () => {
    expect(CONFIRMATORY_FREEZE_AUTHORITY_RECORD_PATH).toBe(
      "packages/benchmark/authority/confirmatory-freeze-authority.json",
    );
    const recordUrl = new URL(`../../../${CONFIRMATORY_FREEZE_AUTHORITY_RECORD_PATH}`, import.meta.url);

    expect(existsSync(recordUrl)).toBe(false);
  });

  it("still returns the exact unassigned tuple when no authority record is installed", () => {
    const result = readConfirmatoryFreezeAuthority();

    expect(result).toEqual({
      authority: "NONE",
      code: "CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED",
      layer: "CONFIRMATORY_FREEZE_AUTHORITY",
      ok: false,
    });
  });

  it("exports the exact code and layer literals the ruling named", () => {
    expect(CONFIRMATORY_FREEZE_AUTHORITY_CODE).toBe("CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED");
    expect(CONFIRMATORY_FREEZE_AUTHORITY_LAYER).toBe("CONFIRMATORY_FREEZE_AUTHORITY");
  });

  it("refuses with exactly the ruled code at exactly the ruled layer", () => {
    const refusal = readConfirmatoryFreezeAuthority();

    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error("no record may grant authority on the committed tree");
    expect(refusal.code).toBe("CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED");
    expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_AUTHORITY");
    expect(refusal.authority).toBe("NONE");
    expect(refusal.ok).toBe(false);
    expect(refusal).toEqual(EXPECTED_REFUSAL);
  });

  it("carries exactly four keys, asserted in both directions", () => {
    const refusal = readConfirmatoryFreezeAuthority();
    const actual = Object.keys(refusal).sort();

    // Both directions: a subset check would stay green if a `custodian` field were
    // added, and an "every expected key is present" check would stay green if the
    // refusal grew a success arm beside them.
    expect(actual).toEqual([...EXPECTED_KEYS]);
    for (const key of EXPECTED_KEYS) expect(Object.hasOwn(refusal, key)).toBe(true);
    expect(actual.length).toBe(EXPECTED_KEYS.length);
    expect(Reflect.ownKeys(refusal)).toHaveLength(EXPECTED_KEYS.length);
  });

  it("declares no authority-bearing field under any name, at any depth", () => {
    const refusal = readConfirmatoryFreezeAuthority();

    expect(AUTHORITY_BEARING_FRAGMENTS.length).toBeGreaterThan(0);
    for (const fragment of AUTHORITY_BEARING_FRAGMENTS) {
      for (const key of Object.keys(refusal)) {
        expect(key.toLowerCase()).not.toContain(fragment);
      }
    }
    // No depth to hide one at: every value is a primitive, so there is no nested
    // container a signer, key or corpus digest could be smuggled inside.
    for (const value of Object.values(refusal)) {
      expect(typeof value === "string" || typeof value === "boolean").toBe(true);
    }
    expect(Object.values(refusal)).toHaveLength(EXPECTED_KEYS.length);
  });

  it("takes no parameter, so no caller-supplied input can flip it", () => {
    expect(readConfirmatoryFreezeAuthority.length).toBe(0);

    // Hostile call: force arguments past the declared zero-arity signature. A reader
    // that consulted a claimed custodian would answer differently here.
    const forced = readConfirmatoryFreezeAuthority as unknown as (
      ...args: readonly unknown[]
    ) => ConfirmatoryFreezeAuthorityRefusal;
    const supplied = [
      { authority: "GRANTED", ok: true },
      { custodian: "worker-4b8f0e0a", signerKeyId: "fixture-key" },
      true,
      "CONFIRMATORY_FREEZE_AUTHORITY_ASSIGNED",
    ] as const;

    for (const argument of supplied) {
      expect(forced(argument)).toEqual(EXPECTED_REFUSAL);
    }
    expect(forced(...supplied)).toEqual(EXPECTED_REFUSAL);
  });

  it("refuses identically after plausible environment mutation", () => {
    const before = readConfirmatoryFreezeAuthority();
    for (const name of PLAUSIBLE_ENVIRONMENT_KEYS) process.env[name] = "1";

    const after = readConfirmatoryFreezeAuthority();

    expect(after).toEqual(EXPECTED_REFUSAL);
    if (after.ok) throw new Error("environment mutation granted confirmatory authority");
    expect(after.code).toBe("CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED");
    expect(after.layer).toBe("CONFIRMATORY_FREEZE_AUTHORITY");
    expect(after).toEqual(before);
    // Positive control on the mutation itself: the env really was set, so the arm is
    // not vacuously green against an environment that never changed.
    for (const name of PLAUSIBLE_ENVIRONMENT_KEYS) expect(process.env[name]).toBe("1");
  });

  it("hands every caller a fresh frozen refusal that cannot be edited into a grant", () => {
    const first = readConfirmatoryFreezeAuthority();
    const second = readConfirmatoryFreezeAuthority();

    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    const mutable = first as unknown as Record<string, unknown>;
    expect(() => {
      "use strict";
      mutable["ok"] = true;
    }).toThrow(TypeError);
    expect(() => {
      "use strict";
      mutable["custodian"] = "worker-4b8f0e0a";
    }).toThrow(TypeError);

    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("no record may grant authority on the committed tree");
    expect(first.code).toBe("CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED");
    // A mutation of one caller's copy must not reach the next caller's.
    expect(readConfirmatoryFreezeAuthority()).toEqual(EXPECTED_REFUSAL);
  });
});
