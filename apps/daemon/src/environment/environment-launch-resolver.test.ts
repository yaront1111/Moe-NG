import { describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";

import { ENVIRONMENT_NAMES } from "./environment-contracts.js";
import type { EnvironmentName } from "./environment-contracts.js";
import {
  LAUNCH_PURPOSES, isLaunchDelivered, isLaunchRefusal, launchDelivery,
  resolveEnvironmentLaunch,
} from "./environment-launch-resolver.js";
import type { LaunchPurpose } from "./environment-launch-resolver.js";
import * as delivery from "./environment-delivery.js";
import { deliverEnvironment } from "./environment-delivery.js";
import type { EnvironmentStoreConfig } from "./environment-projection.js";
import { setEnvironmentVariable, unsetEnvironmentVariable } from "./environment-store.js";
import { agentEnvironment } from "../orchestrator/agent-spawn-environment.js";
import { cleanUp, configFor, openMemoryStore } from "./environment-test-fixtures.js";

/**
 * THE RESOLVER'S ARMS. Each one is about a DECISION this module makes, because everything else -
 * the read, the seal, the merge, the allowlist - is asserted by the suites that own it.
 *
 * EVERY REFUSAL ARM PINS THE CODE **AND** THE LAYER. `ok: false` alone is one added check away
 * from vacuous: the resolver has a SCOPE guard and a KEY path that can both answer, so an arm
 * that only asserted "it refused" would stay green if the wrong one started answering first.
 */

afterEach(() => {
  cleanUp();
  vi.restoreAllMocks();
});

/**
 * ONE name, DIFFERENT values per environment. This is what makes arm (a) non-vacuous: a resolver
 * that ignored its selector and always read the same environment would return a value that is
 * present and well-formed and WRONG, which a single-environment fixture cannot distinguish.
 */
const SHARED_NAME = "DATABASE_URL";
const VERIFY_VALUE = "postgres://app@localhost:5432/verify_db";
const PREVIEW_VALUE = "postgres://app@localhost:5432/preview_db";
const PRODUCTION_VALUE = "postgres://app@localhost:5432/production_db";

/** A host variable in NO allowlist and matching no provider prefix. Arm (b)'s subject. */
const HOST_ONLY = "HOST_ONLY_SECRET";

/**
 * A distinctive string planted in a STORE ERROR's message, never in a value. Arm (e) asserts it
 * is absent from the refusal: a store failure can quote a key, a path or a value, and a resolver
 * that relayed `error.message` would publish whichever it quoted.
 */
const ERROR_SENTINEL = "SENTINEL_FROM_A_STORE_ERROR_MESSAGE";

function seed(
  config: EnvironmentStoreConfig, environment: EnvironmentName, name: string, value: string,
): void {
  const written = setEnvironmentVariable(config, { environment, name, value });
  // A silently refused seed makes every later assertion vacuous.
  expect(written).toMatchObject({ ok: true });
}

/** A world where all three environments hold the SAME name with DIFFERENT values. */
function seededWorld(): EnvironmentStoreConfig {
  const config = configFor(openMemoryStore());
  seed(config, "verify", SHARED_NAME, VERIFY_VALUE);
  seed(config, "preview", SHARED_NAME, PREVIEW_VALUE);
  seed(config, "production", SHARED_NAME, PRODUCTION_VALUE);
  return config;
}

/**
 * A world that HAS sealed variables but whose credential is now unavailable. Seeded FIRST with a
 * working credential and swapped afterwards: seeding is itself a credentialled write, so a config
 * built with a null credential could never have stored anything for the read to fail on, and the
 * arm would be asserting against an empty store rather than an underivable key.
 */
function unkeyedWorld(credential: string | null): EnvironmentStoreConfig {
  return { ...seededWorld(), credential: () => credential };
}

describe("resolveEnvironmentLaunch selects by purpose", () => {
  // (a) THE SELECTED ENVIRONMENT'S VALUE ARRIVES - and no other environment's does.
  it("gives a VERIFIER the verify value and a PREVIEW the preview value, never each other's", () => {
    const config = seededWorld();

    const verifier = resolveEnvironmentLaunch(config, "VERIFIER");
    const preview = resolveEnvironmentLaunch(config, "PREVIEW");
    expect(isLaunchDelivered(verifier)).toBe(true);
    expect(isLaunchDelivered(preview)).toBe(true);
    if (!isLaunchDelivered(verifier) || !isLaunchDelivered(preview)) {
      throw new Error("unreachable: asserted delivered above");
    }

    expect(verifier.environment).toBe("verify");
    expect(verifier.delivered[SHARED_NAME]).toBe(VERIFY_VALUE);
    expect(preview.environment).toBe("preview");
    expect(preview.delivered[SHARED_NAME]).toBe(PREVIEW_VALUE);
    // The negative half: neither boundary can reach `production`, which is the environment a
    // scope confusion would land on and the one that holds the real operator secrets.
    expect(Object.values(verifier.delivered)).not.toContain(PRODUCTION_VALUE);
    expect(Object.values(preview.delivered)).not.toContain(PRODUCTION_VALUE);
    expect(Object.values(verifier.delivered)).not.toContain(PREVIEW_VALUE);
    expect(Object.values(preview.delivered)).not.toContain(VERIFY_VALUE);
  });

  /**
   * The purpose roster, BOTH DIRECTIONS. A test that only iterates the roster shrinks with it: a
   * deleted purpose takes its own coverage away and the suite stays green. So this asserts the
   * SERVED set (what actually resolves) equals the ADVERTISED set, and that the sweep ran.
   */
  it("resolves every advertised purpose, and advertises every purpose it resolves", () => {
    const config = seededWorld();
    const served = new Set<string>();
    for (const purpose of LAUNCH_PURPOSES) {
      const resolved = resolveEnvironmentLaunch(config, purpose);
      // No advertised purpose may refuse in a fully-seeded, credentialled world.
      expect(isLaunchRefusal(resolved)).toBe(false);
      if (isLaunchRefusal(resolved)) continue;
      expect(resolved.purpose).toBe(purpose);
      served.add(purpose);
      if (resolved.environment !== null) {
        // A purpose can only ever select a name the contracts roster carries.
        expect(ENVIRONMENT_NAMES).toContain(resolved.environment);
      }
    }
    // A sweep that silently yielded zero cases would pass every assertion above.
    expect(served.size).toBe(LAUNCH_PURPOSES.length);
    expect(served.size).toBeGreaterThan(1);
    expect([...served].sort()).toEqual([...LAUNCH_PURPOSES].sort());
  });
});

describe("resolveEnvironmentLaunch withholds from coding seats", () => {
  // (c) DoD 3's negative half at the unit level: ZERO variables, not merely "it succeeded".
  it("delivers NOTHING to a CODING_SEAT even when every environment is seeded", () => {
    const config = seededWorld();
    const resolved = resolveEnvironmentLaunch(config, "CODING_SEAT");

    expect(isLaunchRefusal(resolved)).toBe(false);
    if (isLaunchRefusal(resolved)) throw new Error("unreachable: asserted ok above");
    // The count, not the truthiness. `{}` and `{DATABASE_URL: ...}` are both objects.
    expect(Object.keys(resolved.delivered)).toHaveLength(0);
    expect(resolved.environment).toBeNull();
    expect(resolved.purpose).toBe("CODING_SEAT");
    // Not merely absent: no environment's value is reachable through it.
    expect(Object.values(resolved.delivered)).not.toContain(VERIFY_VALUE);
    expect(Object.values(resolved.delivered)).not.toContain(PREVIEW_VALUE);
    expect(Object.values(resolved.delivered)).not.toContain(PRODUCTION_VALUE);
    // The launch-site convenience must agree, since that is what call sites actually use.
    expect(launchDelivery(config, "CODING_SEAT")).toBeUndefined();
  });

  /**
   * THE STORE IS NEVER READ FOR A CODING SEAT. Stronger than "the result was empty": it proves
   * there is no path from a coding-seat launch to plaintext at all, so the property survives a
   * later bug in the half of the module that opens values.
   */
  it("never reaches the delivery read for a CODING_SEAT", () => {
    const config = seededWorld();
    const read = vi.spyOn(delivery, "readEnvironmentDelivery");
    expect(launchDelivery(config, "CODING_SEAT")).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("resolveEnvironmentLaunch refuses with an exact code and layer", () => {
  // (d) UNAVAILABLE DELIVERY. An absent credential is the shipped "no key" case.
  it("refuses ENV_STORE_KEY_UNAVAILABLE at the KEY layer when the credential is absent", () => {
    const resolved = resolveEnvironmentLaunch(unkeyedWorld(null), "VERIFIER");
    expect(resolved).toMatchObject({
      code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false,
    });
  });

  // (d) THE WRONG CREDENTIAL is the same code by design - splitting it would let a caller probe
  // whether a credential is missing or merely incorrect, which is a fact about the secret.
  it("refuses ENV_STORE_KEY_UNAVAILABLE at the KEY layer when the credential is wrong", () => {
    const stolen = unkeyedWorld("not-the-sealing-credential");
    expect(resolveEnvironmentLaunch(stolen, "PREVIEW")).toMatchObject({
      code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false,
    });
  });

  // (d) SCOPE MISMATCH. An off-roster purpose maps to no environment; the guard answers at SCOPE
  // rather than letting a downstream check report it as something else.
  it("refuses ENV_ENVIRONMENT_UNKNOWN at the SCOPE layer for a purpose off the roster", () => {
    const resolved = resolveEnvironmentLaunch(
      seededWorld(), "DEPLOY" as unknown as LaunchPurpose,
    );
    expect(resolved).toMatchObject({
      code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE", ok: false,
    });
    // `DEPLOY` is deliberately NOT advertised: `deploy-service.ts` has no process-environment
    // seam to deliver into (task-04b3ce7e owns that handoff). If it is ever added, this arm
    // fails and forces the roster arm above to be re-read rather than silently widening.
    expect(LAUNCH_PURPOSES as readonly string[]).not.toContain("DEPLOY");
  });

  // (e) NO RAW ERROR DATA. A store throw is MAPPED, never relayed.
  it("maps a thrown store error to a code and lets none of its message escape", () => {
    const config = seededWorld();
    const exploding: EnvironmentStoreConfig = {
      ...config,
      store: new Proxy(config.store, {
        get(target, property, receiver) {
          if (property === "readEvents") {
            return () => { throw new Error(`store read failed: ${ERROR_SENTINEL}`); };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    };

    const resolved = resolveEnvironmentLaunch(exploding, "VERIFIER");
    expect(resolved).toMatchObject({
      code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false,
    });
    // Over the SERIALISED refusal, not over the fields a reader thought to check: a relayed
    // message could arrive in a `detail`, a `cause`, or a field added later.
    expect(JSON.stringify(resolved)).not.toContain(ERROR_SENTINEL);
    expect(launchDelivery(exploding, "VERIFIER")).toBeUndefined();
  });
});

describe("delivery reaches a child under the closed allowlist", () => {
  /**
   * (b) THE ROSTER STILL GOVERNS THE HOST HALF. `agentEnvironment` applies `delivered` LAST to an
   * already-filtered object, so this asserts the two halves compose the way the merge promises:
   * the operator's arbitrary name arrives, and an arbitrary AMBIENT host name still does not.
   */
  it("carries the selected environment's value while excluding a non-allowlisted host variable", () => {
    const config = seededWorld();
    const delivered = launchDelivery(config, "VERIFIER");
    expect(delivered).toBeDefined();

    const host = { [HOST_ONLY]: "ambient-and-unwanted", PATH: "/usr/bin" };
    const environment = agentEnvironment(host, delivered);

    expect(environment[SHARED_NAME]).toBe(VERIFY_VALUE);
    // The whole point of merging UNDER the allowlist rather than around it.
    expect(environment[HOST_ONLY]).toBeUndefined();
    expect(Object.keys(environment)).not.toContain(HOST_ONLY);
  });

  /**
   * THE COLLISION RULE, at the composed surface. The store's name grammar admits `PATH`, so an
   * operator can set one; the allowlisted runtime value must win, or a configuration variable
   * could choose which shell or which `node` a child runs.
   */
  it("keeps the allowlisted runtime value when an operator variable collides with it", () => {
    const config = configFor(openMemoryStore());
    seed(config, "verify", "PATH", "/attacker/controlled/bin");
    const environment = agentEnvironment(
      { PATH: "/real/runtime/bin" }, launchDelivery(config, "VERIFIER"),
    );
    expect(environment["PATH"]).toBe("/real/runtime/bin");
  });
});

/**
 * THE NO-OP, AT THE COMPOSITION (DoD 5). The landed arms already pin the MERGE half:
 * `environment-delivery.test.ts:295` ("builds a byte-identical environment when nothing is
 * delivered") compares `agentEnvironment(host, undefined | {})` against an ABSOLUTE key roster,
 * and `environment-delivery.test.ts:214` proves `deliverEnvironment` returns the very object it
 * was handed BY REFERENCE. Those are reused, not rewritten.
 *
 * WHAT THEY CANNOT SEE is the half this row introduced: whether the RESOLVER, driven at a real
 * boundary against a real store, produces an empty answer at all. The landed arms take
 * "nothing is delivered" as their premise; nothing anywhere asserts that an unconfigured project
 * actually reaches them that way, and a resolver that returned a stale or foreign environment's
 * variables would leave every one of them green.
 *
 * A MEASURED CORRECTION, recorded because it changes what these arms are worth. `undefined` and
 * `{}` are NOT behaviourally different at the merge: `deliverEnvironment` branches on
 * `names.length === 0`, so both take the identity return, and a mutation making `launchDelivery`
 * answer `{}` reds ONLY the two `toBeUndefined` arms below - the reference-identity arm stays
 * green. So that arm is not the discriminator it looks like; it pins that the identity branch is
 * REACHED through the real composition, while the `toBeUndefined` arms pin the resolver's own
 * contract. Both are worth keeping; neither proves what the other does.
 */
describe("an unconfigured project spawns byte-identically", () => {
  const host: NodeJS.ProcessEnv = {
    [HOST_ONLY]: "host-secret-never-delivered",
    LANG: "C.UTF-8",
    MOE_DAEMON_CREDENTIAL: "operator-secret",
    PATH: "/safe/bin",
  };

  /** The roster this construction produced BEFORE this row existed, in order. */
  const BASELINE_KEYS = [
    "LANG", "PATH", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
    "MAX_MCP_OUTPUT_TOKENS", "NO_PROXY", "no_proxy",
  ];

  it("resolves to undefined at every boundary when the project has no variables at all", () => {
    const config = configFor(openMemoryStore());
    // Not `toBeFalsy`: `{}` is truthy-adjacent in the ways that matter here and would take the
    // merge's COPY branch instead of its identity branch.
    for (const purpose of LAUNCH_PURPOSES) {
      expect(launchDelivery(config, purpose)).toBeUndefined();
    }
    expect(LAUNCH_PURPOSES.length).toBeGreaterThan(1); // the sweep really ran
  });

  it("resolves to undefined for an environment that EXISTS but holds nothing", () => {
    // Genuinely different from never-touched: the aggregate HAS events, and the fold has to
    // decide that an unset variable is not a current one. An empty delivery must be
    // indistinguishable from no delivery at the boundary.
    const config = configFor(openMemoryStore());
    seed(config, "verify", "TEMPORARY_TOKEN", "value-about-to-be-retired");
    expect(unsetEnvironmentVariable(config, { environment: "verify", name: "TEMPORARY_TOKEN" }))
      .toMatchObject({ ok: true });

    const resolved = resolveEnvironmentLaunch(config, "VERIFIER");
    expect(isLaunchDelivered(resolved)).toBe(true);
    if (!isLaunchDelivered(resolved)) throw new Error("unreachable: asserted delivered above");
    expect(Object.keys(resolved.delivered)).toHaveLength(0);
    // The convenience collapses an ok-but-empty delivery to `undefined`, which is what preserves
    // the identity branch for a project that emptied its environment rather than never filling it.
    expect(launchDelivery(config, "VERIFIER")).toBeUndefined();
  });

  it("builds the identical environment object, keys and all, for both empty shapes", () => {
    const emptyProject = configFor(openMemoryStore());
    const emptiedProject = configFor(openMemoryStore());
    seed(emptiedProject, "verify", "TEMPORARY_TOKEN", "value-about-to-be-retired");
    expect(unsetEnvironmentVariable(emptiedProject, {
      environment: "verify", name: "TEMPORARY_TOKEN",
    })).toMatchObject({ ok: true });

    for (const config of [emptyProject, emptiedProject]) {
      const after = agentEnvironment(host, launchDelivery(config, "VERIFIER"));
      // Keys AND order, then the whole object: `toEqual` and `JSON.stringify` both IGNORE
      // undefined-valued properties, so an overlay adding `SOMETHING: undefined` slips past
      // either one alone. This is the same pairing the landed arm uses, for the same reason.
      expect(Object.keys(after)).toEqual(BASELINE_KEYS);
      expect(after).toStrictEqual(agentEnvironment(host));
      // The host secrets are still gone - a no-op must not become a widening.
      expect(after[HOST_ONLY]).toBeUndefined();
      expect(after["MOE_DAEMON_CREDENTIAL"]).toBeUndefined();
    }
  });

  it("hands the merge the SAME object back, so there is no copy to reorder", () => {
    // Reference equality through the production merge - the strongest form of "byte-identical",
    // since there is no copy that could reorder keys or add an undefined-valued slot. See the
    // describe header: this does NOT discriminate `undefined` from `{}` (both take the identity
    // branch); it proves the composition REACHES that branch rather than assuming it.
    const allowlisted: NodeJS.ProcessEnv = { LANG: "C.UTF-8", PATH: "/safe/bin" };
    const config = configFor(openMemoryStore());
    const merged = deliverEnvironment(allowlisted, launchDelivery(config, "VERIFIER"));
    expect(merged.environment).toBe(allowlisted);
    expect(merged.collisions).toEqual([]);
  });
});
