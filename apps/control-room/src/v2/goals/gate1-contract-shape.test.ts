import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT_CONTRACT_V2_LIMITS, createProductContractRevisionV2 } from "@moe/core";
import { describe, expect, it } from "vitest";

import { validGate1RevisionShape } from "./gate1-contract-shape.js";
import { snapshotGate1Data } from "./gate1-data-snapshot.js";
import { GATE1_V2_REVISION } from "./gate1-v2-test-fixture.js";

const NAME_LIMIT = 128;
const LONE_SURROGATE = String.fromCharCode(0xd800);
const LIST_LIMIT = 256;

const BASE_DEPLOYMENT = Object.freeze({
  dependsOnRequirementIds: ["technology-runtime"],
  priority: "MUST",
  requirementId: "deployment-loopback",
  statement: "deployment-loopback must hold.",
  supersedesRequirementId: null,
});

/** A full revision whose sole deployment requirement is the row under test. */
function revisionWith(deployment: unknown): unknown {
  return { ...GATE1_V2_REVISION, deploymentRequirements: [deployment] };
}

/** The same revision as a draft, so the CORE validator can judge the identical row. */
function draftWith(deployment: unknown): unknown {
  const {
    advisoryOnly: _advisory, revisionDigest: _digest, version: _version, ...body
  } = GATE1_V2_REVISION;
  return { ...body, deploymentRequirements: [deployment] };
}

const withNames = (value: unknown) => ({
  ...BASE_DEPLOYMENT, environmentVariableNames: value,
});

/** `count` grammar-valid, strictly ascending names: V0000, V0001, ... */
const variableNames = (count: number): readonly string[] => Array.from(
  { length: count }, (_unused, index) => `V${String(index).padStart(4, "0")}`,
);

const REFUSED_NAMES: readonly (readonly [string, unknown])[] = Object.freeze([
  // NAMES ONLY. Every value-shaped entry is refused; the values are obviously fake.
  ["an assignment-shaped entry", ["DB_PASSWORD=REDACTED_FAKE"]],
  ["a colon-shaped entry", ["DB_PASSWORD: REDACTED_FAKE"]],
  ["a space-separated entry", ["DB_PASSWORD REDACTED_FAKE"]],
  ["a lowercase name", ["database_url"]],
  ["a name starting with a digit", ["1DATABASE_URL"]],
  ["a name with a hyphen", ["DATABASE-URL"]],
  ["a name with a quote", ["DATABASE_\"URL"]],
  ["a name with a newline", ["DATABASE_\nURL"]],
  ["a name with a NUL", ["DATABASE_\u0000URL"]],
  ["a name with a leading space", [" DATABASE_URL"]],
  ["an empty name", [""]],
  ["a non-string name", [42]],
  ["a duplicated name", ["DATABASE_URL", "DATABASE_URL"]],
  ["an unsorted list", ["DATABASE_URL", "APP_PORT"]],
  ["a bare string instead of a list", "DATABASE_URL"],
  ["null instead of a list", null],
  ["an object instead of a list", {}],
  // Adversarial shapes a hostile caller reaches for, not shapes a person types.
  ["a lone surrogate, which is not well-formed", [`A${LONE_SURROGATE}B`]],
  ["a non-ASCII name that cannot be an environment variable", ["DATABASE_\u00DCRL"]],
  ["a trailing space", ["DATABASE_URL "]],
  ["an undefined entry", [undefined, "DATABASE_URL"]],
  ["a name one byte past the limit", [`V${"X".repeat(NAME_LIMIT)}`]],
  ["a list one entry past the limit", variableNames(LIST_LIMIT + 1)],
]);

const ACCEPTED_NAMES: readonly (readonly [string, unknown])[] = Object.freeze([
  ["an empty list", []],
  ["a single name", ["DATABASE_URL"]],
  ["several sorted names", ["APP_PORT", "DATABASE_URL", "_LEGACY"]],
  ["a name at exactly the length limit", [`V${"X".repeat(NAME_LIMIT - 1)}`]],
  ["a list at exactly the count limit", variableNames(LIST_LIMIT)],
]);

const coreAccepts = (deployment: unknown): boolean =>
  createProductContractRevisionV2(draftWith(deployment)).ok;

describe("gate 1 deployment requirement environment variable names", () => {
  it("accepts the unchanged fixture contract, in which the field is ABSENT", () => {
    // DoD 2 (a) and the positive control every rejection arm below is measured against:
    // without this, a rejection could be caused by anything in the revision.
    expect(validGate1RevisionShape(GATE1_V2_REVISION)).toBe(true);
    expect(validGate1RevisionShape(revisionWith(BASE_DEPLOYMENT))).toBe(true);
    expect(Object.hasOwn(BASE_DEPLOYMENT, "environmentVariableNames")).toBe(false);
  });

  it("accepts a deployment requirement with an EMPTY names list", () => {
    // DoD 2 (b): absence and emptiness are different states and both must validate.
    expect(validGate1RevisionShape(revisionWith(withNames([])))).toBe(true);
  });

  it.each(ACCEPTED_NAMES)("accepts %s", (_label, value) => {
    expect(validGate1RevisionShape(revisionWith(withNames(value)))).toBe(true);
  });

  it.each(REFUSED_NAMES)("refuses %s", (_label, value) => {
    expect(validGate1RevisionShape(revisionWith(withNames(value)))).toBe(false);
    // The delta really is the names field: the identical row with a valid list is accepted.
    expect(validGate1RevisionShape(revisionWith(withNames(["DATABASE_URL"])))).toBe(true);
  });

  it.each([
    "functionalRequirements", "nonFunctionalRequirements", "securityPrivacyRequirements",
    "technologyRequirements", "uxAccessibilityRequirements",
  ])("refuses the names key on %s: it is a deployment-requirement field", (section) => {
    // Proves the change stayed scoped to one section instead of widening the shared shape.
    const revision = GATE1_V2_REVISION as unknown as Record<string, unknown>;
    const existing = revision[section] as readonly Record<string, unknown>[];
    expect(validGate1RevisionShape({
      ...revision,
      [section]: existing.map((item) => ({ ...item, environmentVariableNames: [] })),
    })).toBe(false);
  });

  it("never executes an accessor smuggled into the names list", () => {
    // MEASURED, and it changed this arm: in production `validGate1RevisionShape` is only
    // ever reached through `snapshotGate1Data` (gate1-contract-admission.ts:12-14), which
    // is what neutralizes accessors. Asserting the shape function on a RAW hostile object
    // would test a composition that does not ship, so this arm runs the real seam.
    const hostile: unknown[] = [];
    Object.defineProperty(hostile, "0", {
      configurable: true,
      enumerable: true,
      get: () => { throw new Error("accessor must never execute"); },
    });
    Object.defineProperty(hostile, "length", { value: 1, writable: true });
    const admit = () => {
      const snapshot = snapshotGate1Data(revisionWith(withNames(hostile)));
      return snapshot.ok && validGate1RevisionShape(snapshot.value);
    };
    expect(admit).not.toThrow();
    expect(admit()).toBe(false);
    // NAME THE LAYER, or this arm is vacuous: it is the SNAPSHOT that refuses, and
    // `validGate1RevisionShape` is never reached. That is the property worth pinning --
    // the shape validator is only ever handed accessor-free plain data.
    expect(snapshotGate1Data(revisionWith(withNames(hostile))).ok).toBe(false);
    // The core reaches the same verdict through its own snapshot step, with a code.
    expect(coreAccepts(withNames(hostile))).toBe(false);
  });

  it("still refuses an unknown key on a deployment requirement", () => {
    // The either-shape check must not have become "any superset of the five keys".
    expect(validGate1RevisionShape(revisionWith({
      ...BASE_DEPLOYMENT, inferredStack: "whatever",
    }))).toBe(false);
    expect(validGate1RevisionShape(revisionWith({
      ...withNames(["DATABASE_URL"]), inferredStack: "whatever",
    }))).toBe(false);
  });
});

describe("gate 1 shape agrees with the core admission validator", () => {
  // DoD 4. The two requirement key rosters are hand transcriptions of each other
  // (gate1-contract-shape.ts:21,27 and product-contract-v2-admission.ts:50,54), and a
  // divergence stays invisible until a contract round-trips. Rather than compare source
  // text, feed the SAME deployment requirement to BOTH production surfaces and require
  // the same verdict -- that is agreement measured through what actually ships.
  it.each([...ACCEPTED_NAMES])("agrees on accepting %s", (_label, value) => {
    expect(coreAccepts(withNames(value))).toBe(true);
    expect(validGate1RevisionShape(revisionWith(withNames(value)))).toBe(true);
  });

  it.each([...REFUSED_NAMES])("agrees on refusing %s", (_label, value) => {
    expect(coreAccepts(withNames(value))).toBe(false);
    expect(validGate1RevisionShape(revisionWith(withNames(value)))).toBe(false);
  });

  it("agrees that the field is optional", () => {
    expect(coreAccepts(BASE_DEPLOYMENT)).toBe(true);
    expect(validGate1RevisionShape(revisionWith(BASE_DEPLOYMENT))).toBe(true);
  });

  it("agrees that an unknown key on a deployment requirement is refused", () => {
    const stray = { ...BASE_DEPLOYMENT, inferredStack: "whatever" };
    expect(coreAccepts(stray)).toBe(false);
    expect(validGate1RevisionShape(revisionWith(stray))).toBe(false);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_SHAPE = join(HERE, "gate1-contract-shape.ts");
const CORE_ADMISSION = join(
  HERE, "..", "..", "..", "..", "..",
  "packages", "core", "src", "product-contract", "product-contract-v2-admission.ts",
);

/** The literal key list of a `const <name> = Object.freeze([...])` roster, in file order. */
function roster(path: string, name: string): readonly string[] {
  const source = readFileSync(path, "utf8");
  const declaration = new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]`).exec(source);
  if (declaration?.[1] === undefined) throw new Error(`no ${name} roster in ${path}`);
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

/** The `ENVIRONMENT_VARIABLE_NAME = /.../;` literal, so the two grammars cannot drift. */
function grammar(path: string): string {
  const found = /const ENVIRONMENT_VARIABLE_NAME = (\/.*\/);/.exec(readFileSync(path, "utf8"));
  if (found?.[1] === undefined) throw new Error(`no name grammar in ${path}`);
  return found[1];
}

/** A deployment requirement missing exactly one of the five shared keys. */
function missing(key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = BASE_DEPLOYMENT as Record<string, unknown>;
  return rest;
}

describe("the two transcribed requirement rosters agree", () => {
  // DoD 4. The rosters are HAND TRANSCRIPTIONS of each other and a divergence stays
  // invisible until a contract round-trips. The core roster is module-private and
  // exporting it would force packages/core/src/index.ts plus the hard-coded
  // `expect(EXPECTED_EXPORTS.length).toBe(256)` at index-surface.test.ts:333 -- two files
  // outside this row -- and would publish a browser mirror's twin as core API for a
  // test-only need. So this pins the transcriptions by source text, the fallback the plan
  // sanctions, while the `agrees with the core admission validator` block above pins the
  // BEHAVIOUR through both production surfaces, which is the stronger half.
  it.each(["REQUIREMENT_KEYS", "DEPLOYMENT_REQUIREMENT_KEYS"])(
    "transcribes %s identically on both sides", (name) => {
      const browser = roster(BROWSER_SHAPE, name);
      const core = roster(CORE_ADMISSION, name);
      expect(browser.length).toBeGreaterThan(0); // the roster was really found, not empty
      expect(browser).toEqual(core);
    },
  );

  it("keeps the deployment roster equal to the shared roster plus the names carrier", () => {
    const shared = roster(CORE_ADMISSION, "REQUIREMENT_KEYS");
    const deployment = roster(CORE_ADMISSION, "DEPLOYMENT_REQUIREMENT_KEYS");
    expect([...deployment].sort()).toEqual([...shared, "environmentVariableNames"].sort());
    expect(deployment).toHaveLength(shared.length + 1);
  });

  it("transcribes the environment-variable name grammar identically on both sides", () => {
    expect(grammar(BROWSER_SHAPE)).toBe(grammar(CORE_ADMISSION));
    expect(grammar(BROWSER_SHAPE)).toBe("/^[A-Z_][A-Z0-9_]*$/");
  });

  it("transcribes the two bounds from the core limits the browser cannot import", () => {
    // These are read from the SHIPPED core constant, not from a second transcription.
    expect(NAME_LIMIT).toBe(PRODUCT_CONTRACT_V2_LIMITS.maxEnvironmentVariableNameBytes);
    expect(LIST_LIMIT).toBe(PRODUCT_CONTRACT_V2_LIMITS.maxEnvironmentVariableNames);
    const source = readFileSync(BROWSER_SHAPE, "utf8");
    expect(source).toContain(`const MAX_ENVIRONMENT_VARIABLE_NAME = ${NAME_LIMIT};`);
    expect(source).toContain(`const MAX_ENVIRONMENT_VARIABLE_NAMES = ${LIST_LIMIT};`);
  });

  it.each([
    "dependsOnRequirementIds", "priority", "requirementId", "statement",
    "supersedesRequirementId",
  ])("agrees that dropping the shared key %s refuses a deployment requirement", (key) => {
    // Pins the OLD roster too: a test that only pins the new one lets this pair drift.
    const dropped = missing(key);
    expect(Object.keys(dropped)).toHaveLength(4); // the key really was dropped
    expect(coreAccepts(dropped)).toBe(false);
    expect(validGate1RevisionShape(revisionWith(dropped))).toBe(false);
  });
});
