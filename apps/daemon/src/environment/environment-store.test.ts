import { afterEach, describe, expect, it } from "vitest";

import {
  ENVIRONMENT_VARIABLE_READ_KEYS,
  MAX_ENVIRONMENT_VALUE_BYTES,
  environmentValueFingerprint,
} from "./environment-contracts.js";
import type { EnvironmentCode } from "./environment-contracts.js";
import {
  readEnvironmentVariables,
  setEnvironmentVariable,
  unsetEnvironmentVariable,
} from "./environment-store.js";
import type { EnvironmentReadResult } from "./environment-store.js";
import {
  CREDENTIAL,
  OTHER_CREDENTIAL,
  cleanUp,
  configFor,
  openMemoryStore,
  unreadableCredentialSource,
} from "./environment-test-fixtures.js";

/**
 * The store, driven end to end over a REAL SqliteEventStore. Nothing here is a fake: every arm
 * commits through the production writer and reads back through the production reader.
 *
 * Every refusal arm pins the CODE AND THE LAYER, because three of the four codes are minted by
 * different surfaces and "it refused" would stay green if the wrong one answered first.
 */

afterEach(cleanUp);

const PROD = "production";

function expectRefusal(result: EnvironmentReadResult, code: EnvironmentCode, layer: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(code);
  expect(result.layer).toBe(layer);
}

function names(result: EnvironmentReadResult): readonly string[] {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.variables.map((variable) => variable.name);
}

describe("setEnvironmentVariable", () => {
  it("answers the read shape - and NOTHING else - for the variable it stored", () => {
    const config = configFor(openMemoryStore());
    const result = setEnvironmentVariable(config, {
      environment: PROD, name: "DATABASE_URL", value: "postgres://secret",
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.variables).toHaveLength(1);
    const [variable] = result.variables;
    expect(Object.keys(variable ?? {}).sort()).toEqual([...ENVIRONMENT_VARIABLE_READ_KEYS]);
    expect(variable?.name).toBe("DATABASE_URL");
    expect(variable?.isSet).toBe(true);
    expect(variable?.fingerprintSha256).toBe(environmentValueFingerprint("postgres://secret"));
    expect(variable?.updatedAt).toBe("2026-09-05T00:00:00.000Z");
  });

  it("round trips through a SECOND read against the same store", () => {
    const config = configFor(openMemoryStore());
    setEnvironmentVariable(config, { environment: PROD, name: "A_KEY", value: "alpha" });
    const read = readEnvironmentVariables(config, PROD);
    if (!read.ok) throw new Error(`expected ok, got ${read.code}`);
    expect(read.variables).toEqual([{
      fingerprintSha256: environmentValueFingerprint("alpha"),
      isSet: true,
      name: "A_KEY",
      updatedAt: "2026-09-05T00:00:00.000Z",
    }]);
  });

  it("keeps the three environments separate", () => {
    const config = configFor(openMemoryStore());
    setEnvironmentVariable(config, { environment: "verify", name: "SHARED", value: "v" });
    setEnvironmentVariable(config, { environment: "preview", name: "ONLY_PREVIEW", value: "p" });
    expect(names(readEnvironmentVariables(config, "verify"))).toEqual(["SHARED"]);
    expect(names(readEnvironmentVariables(config, "preview"))).toEqual(["ONLY_PREVIEW"]);
    expect(names(readEnvironmentVariables(config, PROD))).toEqual([]);
  });

  it("lists variables in name order regardless of write order", () => {
    const config = configFor(openMemoryStore());
    for (const name of ["ZULU", "ALPHA", "MIKE"]) {
      setEnvironmentVariable(config, { environment: PROD, name, value: name });
    }
    expect(names(readEnvironmentVariables(config, PROD))).toEqual(["ALPHA", "MIKE", "ZULU"]);
  });

  it("stores an EMPTY value as SET, distinct from absent", () => {
    const config = configFor(openMemoryStore());
    setEnvironmentVariable(config, { environment: PROD, name: "EMPTY_ONE", value: "" });
    const read = readEnvironmentVariables(config, PROD);
    expect(names(read)).toEqual(["EMPTY_ONE"]);
    if (!read.ok) throw new Error("unreachable");
    expect(read.variables[0]?.fingerprintSha256).toBe(environmentValueFingerprint(""));
  });
});

describe("the fingerprint", () => {
  it("CHANGES when the value changes", () => {
    const config = configFor(openMemoryStore());
    const first = setEnvironmentVariable(config, {
      environment: PROD, name: "TOKEN", value: "before",
    });
    const second = setEnvironmentVariable(config, {
      environment: PROD, name: "TOKEN", value: "after",
    });
    if (!first.ok || !second.ok) throw new Error("expected both writes to be accepted");
    expect(second.variables[0]?.fingerprintSha256)
      .not.toBe(first.variables[0]?.fingerprintSha256);
    expect(second.variables[0]?.fingerprintSha256).toBe(environmentValueFingerprint("after"));
  });

  it("is STABLE across a no-op re-set of the SAME value, though the seal bytes differ", () => {
    const config = configFor(openMemoryStore());
    const first = setEnvironmentVariable(config, {
      environment: PROD, name: "TOKEN", value: "unchanged",
    });
    const second = setEnvironmentVariable(config, {
      environment: PROD, name: "TOKEN", value: "unchanged",
    });
    if (!first.ok || !second.ok) throw new Error("expected both writes to be accepted");
    expect(second.variables[0]?.fingerprintSha256)
      .toBe(first.variables[0]?.fingerprintSha256);
  });

  it("keeps one variable's fingerprint stable while a SIBLING is updated", () => {
    const config = configFor(openMemoryStore());
    const before = setEnvironmentVariable(config, {
      environment: PROD, name: "STEADY", value: "steady-value",
    });
    setEnvironmentVariable(config, { environment: PROD, name: "MOVING", value: "one" });
    setEnvironmentVariable(config, { environment: PROD, name: "MOVING", value: "two" });
    const after = readEnvironmentVariables(config, PROD);
    if (!before.ok || !after.ok) throw new Error("expected reads to be accepted");
    const steady = after.variables.find((variable) => variable.name === "STEADY");
    expect(steady?.fingerprintSha256).toBe(before.variables[0]?.fingerprintSha256);
  });
});

describe("unsetEnvironmentVariable", () => {
  it("removes the variable from the CURRENT state", () => {
    const config = configFor(openMemoryStore());
    setEnvironmentVariable(config, { environment: PROD, name: "GOING", value: "g" });
    setEnvironmentVariable(config, { environment: PROD, name: "STAYING", value: "s" });
    const unset = unsetEnvironmentVariable(config, { environment: PROD, name: "GOING" });
    expect(names(unset)).toEqual(["STAYING"]);
    expect(names(readEnvironmentVariables(config, PROD))).toEqual(["STAYING"]);
  });

  it("is idempotent: unsetting an absent name is accepted and changes nothing", () => {
    const config = configFor(openMemoryStore());
    setEnvironmentVariable(config, { environment: PROD, name: "STAYING", value: "s" });
    const first = unsetEnvironmentVariable(config, { environment: PROD, name: "NEVER_SET" });
    const second = unsetEnvironmentVariable(config, { environment: PROD, name: "NEVER_SET" });
    expect(names(first)).toEqual(["STAYING"]);
    expect(names(second)).toEqual(["STAYING"]);
  });

  it("lets a variable be re-set after an unset, with a fresh fingerprint", () => {
    const config = configFor(openMemoryStore());
    setEnvironmentVariable(config, { environment: PROD, name: "CYCLED", value: "first" });
    unsetEnvironmentVariable(config, { environment: PROD, name: "CYCLED" });
    const again = setEnvironmentVariable(config, {
      environment: PROD, name: "CYCLED", value: "second",
    });
    if (!again.ok) throw new Error(`expected ok, got ${again.code}`);
    expect(again.variables[0]?.fingerprintSha256).toBe(environmentValueFingerprint("second"));
  });
});

describe("the four refusals, each pinned to its code AND its layer", () => {
  it.each([
    ["staging"], ["Production"], ["PRODUCTION"], [""], ["prod"],
  ])("refuses ENV_ENVIRONMENT_UNKNOWN at the SCOPE layer for %s", (environment) => {
    const config = configFor(openMemoryStore());
    expectRefusal(
      setEnvironmentVariable(config, { environment, name: "A_KEY", value: "v" }),
      "ENV_ENVIRONMENT_UNKNOWN", "SCOPE",
    );
    expectRefusal(
      unsetEnvironmentVariable(config, { environment, name: "A_KEY" }),
      "ENV_ENVIRONMENT_UNKNOWN", "SCOPE",
    );
    expectRefusal(
      readEnvironmentVariables(config, environment),
      "ENV_ENVIRONMENT_UNKNOWN", "SCOPE",
    );
  });

  it.each([
    ["lowercase", "database_url"], ["leading digit", "9LIVES"], ["hyphen", "A-B"],
    ["equals sign", "A=B"], ["empty", ""],
  ])("refuses ENV_NAME_INVALID at the NAME layer for a %s name", (_why, name) => {
    const config = configFor(openMemoryStore());
    expectRefusal(
      setEnvironmentVariable(config, { environment: PROD, name, value: "v" }),
      "ENV_NAME_INVALID", "NAME",
    );
    expectRefusal(
      unsetEnvironmentVariable(config, { environment: PROD, name }),
      "ENV_NAME_INVALID", "NAME",
    );
  });

  it("refuses ENV_VALUE_TOO_LARGE at the VALUE layer one byte past the bound", () => {
    const config = configFor(openMemoryStore());
    const atBound = "x".repeat(MAX_ENVIRONMENT_VALUE_BYTES);
    expect(setEnvironmentVariable(config, {
      environment: PROD, name: "BIG_ONE", value: atBound,
    }).ok).toBe(true);
    expectRefusal(
      setEnvironmentVariable(config, { environment: PROD, name: "BIG_ONE", value: `${atBound}x` }),
      "ENV_VALUE_TOO_LARGE", "VALUE",
    );
  });

  it("refuses ENV_VALUE_TOO_LARGE by UTF-8 BYTES, not code units", () => {
    const config = configFor(openMemoryStore());
    const wide = "\u{1F600}".repeat(MAX_ENVIRONMENT_VALUE_BYTES / 4 + 1);
    expect(wide.length).toBeLessThan(MAX_ENVIRONMENT_VALUE_BYTES);
    expectRefusal(
      setEnvironmentVariable(config, { environment: PROD, name: "WIDE_ONE", value: wide }),
      "ENV_VALUE_TOO_LARGE", "VALUE",
    );
  });

  it.each([
    ["absent", null], ["empty", ""],
  ])("refuses ENV_STORE_KEY_UNAVAILABLE at the KEY layer for an %s credential", (_why, value) => {
    const config = configFor(openMemoryStore(), value);
    expectRefusal(
      setEnvironmentVariable(config, { environment: PROD, name: "A_KEY", value: "v" }),
      "ENV_STORE_KEY_UNAVAILABLE", "KEY",
    );
    expectRefusal(
      readEnvironmentVariables(config, PROD),
      "ENV_STORE_KEY_UNAVAILABLE", "KEY",
    );
  });

  it("refuses ENV_STORE_KEY_UNAVAILABLE when the credential source THROWS", () => {
    const store = openMemoryStore();
    const config = {
      ...configFor(store), credential: unreadableCredentialSource(),
    };
    expectRefusal(
      setEnvironmentVariable(config, { environment: PROD, name: "A_KEY", value: "v" }),
      "ENV_STORE_KEY_UNAVAILABLE", "KEY",
    );
  });

  it("refuses ENV_STORE_KEY_UNAVAILABLE when the credential is present but WRONG", () => {
    const store = openMemoryStore();
    setEnvironmentVariable(configFor(store), {
      environment: PROD, name: "A_KEY", value: "sealed-under-the-right-key",
    });
    expectRefusal(
      readEnvironmentVariables(configFor(store, OTHER_CREDENTIAL), PROD),
      "ENV_STORE_KEY_UNAVAILABLE", "KEY",
    );
  });

  it("commits NOTHING when a write arrives under the WRONG credential", () => {
    const store = openMemoryStore();
    setEnvironmentVariable(configFor(store), { environment: PROD, name: "A_KEY", value: "v" });
    expectRefusal(
      setEnvironmentVariable(configFor(store, OTHER_CREDENTIAL), {
        environment: PROD, name: "B_KEY", value: "smuggled",
      }),
      "ENV_STORE_KEY_UNAVAILABLE", "KEY",
    );
    // Read back under the RIGHT credential: the refused write must not have landed.
    expect(names(readEnvironmentVariables(configFor(store), PROD))).toEqual(["A_KEY"]);
  });

  it("checks the SCOPE before the NAME, so a doubly-invalid call has ONE stable answer", () => {
    const config = configFor(openMemoryStore());
    expectRefusal(
      setEnvironmentVariable(config, { environment: "staging", name: "bad-name", value: "v" }),
      "ENV_ENVIRONMENT_UNKNOWN", "SCOPE",
    );
  });

  it("refuses BEFORE committing anything: a refused write leaves the environment empty", () => {
    const config = configFor(openMemoryStore());
    setEnvironmentVariable(config, { environment: PROD, name: "bad-name", value: "v" });
    setEnvironmentVariable(config, {
      environment: PROD, name: "TOO_BIG", value: "x".repeat(MAX_ENVIRONMENT_VALUE_BYTES + 1),
    });
    expect(names(readEnvironmentVariables(config, PROD))).toEqual([]);
  });
});

describe("hostile input reaching the entry points at runtime", () => {
  it.each([
    ["null", null], ["undefined", undefined], ["a number", 7], ["an object", {}], ["an array", []],
  ])("refuses a %s value at the VALUE layer instead of throwing", (_why, value) => {
    const config = configFor(openMemoryStore());
    expectRefusal(
      setEnvironmentVariable(config, {
        environment: PROD, name: "A_KEY", value: value as unknown as string,
      }),
      "ENV_VALUE_TOO_LARGE", "VALUE",
    );
  });

  it.each([
    ["null", null], ["a number", 7], ["an object", {}],
  ])("refuses a %s name at the NAME layer instead of throwing", (_why, name) => {
    const config = configFor(openMemoryStore());
    expectRefusal(
      setEnvironmentVariable(config, {
        environment: PROD, name: name as unknown as string, value: "v",
      }),
      "ENV_NAME_INVALID", "NAME",
    );
  });

  it("refuses a null environment at the SCOPE layer instead of throwing", () => {
    const config = configFor(openMemoryStore());
    expectRefusal(
      readEnvironmentVariables(config, null as unknown as string),
      "ENV_ENVIRONMENT_UNKNOWN", "SCOPE",
    );
  });

  it("does not let a value carrying template or quote syntax escape into the fold", () => {
    const config = configFor(openMemoryStore());
    const hostile = "\"},{\"name\":\"INJECTED\",\"sealed\":\"AA==\",\"x\":\"${oops}";
    expect(setEnvironmentVariable(config, {
      environment: PROD, name: "HOSTILE", value: hostile,
    }).ok).toBe(true);
    // The value is sealed before it is serialised, so it cannot forge a second record.
    expect(names(readEnvironmentVariables(config, PROD))).toEqual(["HOSTILE"]);
  });
});

describe("the caller's command id", () => {
  it("is used verbatim when supplied, so a retried command can dedupe in the store", () => {
    const store = openMemoryStore();
    const config = configFor(store);
    const commandId = "command-environment-set-1";
    expect(setEnvironmentVariable(config, {
      commandId, environment: PROD, name: "A_KEY", value: "v",
    }).ok).toBe(true);
    expect(store.getCommandReceipt(commandId)).not.toBeNull();
  });

  it("is minted when omitted, so two writes without one do not collide", () => {
    const config = configFor(openMemoryStore());
    expect(setEnvironmentVariable(config, {
      environment: PROD, name: "A_KEY", value: "one",
    }).ok).toBe(true);
    expect(setEnvironmentVariable(config, {
      environment: PROD, name: "A_KEY", value: "two",
    }).ok).toBe(true);
    const read = readEnvironmentVariables(config, PROD);
    if (!read.ok) throw new Error(`expected ok, got ${read.code}`);
    expect(read.variables[0]?.fingerprintSha256).toBe(environmentValueFingerprint("two"));
  });
});

describe("no refusal on any path carries a value", () => {
  const SECRET = "MOE-STORE-REFUSAL-CANARY";

  it.each([
    ["unknown environment", { environment: "staging", name: "A_KEY", value: SECRET }],
    ["invalid name", { environment: PROD, name: "bad-name", value: SECRET }],
    ["oversized value", {
      environment: PROD, name: "A_KEY", value: `${SECRET}${"x".repeat(MAX_ENVIRONMENT_VALUE_BYTES)}`,
    }],
  ])("keeps the submitted value out of the %s refusal", (_why, input) => {
    const config = configFor(openMemoryStore());
    const result = setEnvironmentVariable(config, input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("keeps the CREDENTIAL out of the key refusal", () => {
    const store = openMemoryStore();
    setEnvironmentVariable(configFor(store), { environment: PROD, name: "A_KEY", value: "v" });
    const result = setEnvironmentVariable(configFor(store, OTHER_CREDENTIAL), {
      environment: PROD, name: "B_KEY", value: SECRET,
    });
    expect(result.ok).toBe(false);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(OTHER_CREDENTIAL);
    expect(serialised).not.toContain(CREDENTIAL);
  });
});
