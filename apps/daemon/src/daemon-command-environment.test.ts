/**
 * The COMMAND EDGE for `environment.set_variable` / `environment.unset_variable`.
 *
 * The store already has a canary suite (`environment/environment-canary.test.ts`) proving no
 * plaintext reaches durable bytes, events, reads or receipts. This file covers the ONE surface
 * that suite provably cannot see: the daemon ENVELOPE, which unlike the command record actually
 * carries the value. Every arm below is written against the shipped edge, never a re-derivation
 * of it.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { commandFamilyFacts } from "./daemon-command-families.js";
import {
  CAPABILITIES, ENVIRONMENT_FAMILY, OPERATOR_PRINCIPAL_KINDS, familyCapabilityOf,
} from "./daemon-command-vocabulary.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "./mcp-tool-allowlist.js";
import { HUMAN_ONLY_STEPS } from "./orchestrator/agent-spawn-contract.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import {
  ENVIRONMENT_CODE_LAYERS, ENVIRONMENT_REFUSAL_DETAILS, MAX_ENVIRONMENT_VALUE_BYTES,
} from "./environment/environment-contracts.js";
import {
  ENVIRONMENT_COMMAND_KIND_SET, ENVIRONMENT_COMMAND_KIND_UNSET, readEnvironmentVariables,
} from "./environment/environment-store.js";
import {
  CREDENTIAL, PROJECT_ID, cleanUp, credentialSource, openMemoryStore,
} from "./environment/environment-test-fixtures.js";
import { DomainRefusal } from "./daemon-command-dispatch.js";
import { ENVIRONMENT_EDGE_RESULT_CODES, runEnvironmentEdge } from "./daemon-command-environment.js";
import type { EnvironmentEdgeContext, EnvironmentEdgeKind } from "./daemon-command-environment.js";
import { CommandIdConflictError, SqliteEventStore } from "@moe/store";
import type { DurableStoreError } from "@moe/store";

afterEach(cleanUp);

const NOW = "2026-09-06T00:00:00.000Z";
const SECRET = "wqz-EDGE-PLAINTEXT-CANARY-8461-never-echoed";
const ADMIN = CAPABILITIES.ADMIN;
const WORK = CAPABILITIES.WORK;

interface EdgeWorld {
  readonly context: (
    kind: EnvironmentEdgeKind,
    commandId: string,
    payload: Readonly<Record<string, unknown>>,
  ) => EnvironmentEdgeContext;
  readonly store: SqliteEventStore;
}

function edgeWorld(credential: string | null = CREDENTIAL): EdgeWorld {
  const store = openMemoryStore();
  return {
    context: (kind, commandId, payload) => ({
      credential: credentialSource(credential),
      envelope: { commandId, payload },
      kind,
      now: () => NOW,
      projectId: PROJECT_ID,
      store,
    }),
    store,
  };
}

function readBack(store: SqliteEventStore): readonly string[] {
  const read = readEnvironmentVariables(
    { credential: credentialSource(CREDENTIAL), now: () => NOW, projectId: PROJECT_ID, store },
    "production",
  );
  expect(read.ok).toBe(true);
  return read.ok ? read.variables.map((variable) => variable.name) : [];
}

/** The refusal an arm expects, read back off the throw rather than off a re-derived shape. */
function refusalOf(act: () => unknown): DomainRefusal {
  try {
    act();
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
  throw new Error("expected a DomainRefusal, none was thrown");
}

describe("the environment command edge", () => {
  it("sets a variable and answers a durable decision naming the kind's result", () => {
    const world = edgeWorld();
    const decision = runEnvironmentEdge(
      world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-set-1", {
        environment: "production", name: "DATABASE_URL", value: SECRET,
      }),
    );

    expect(decision).toEqual({
      commandId: "cmd-edge-set-1",
      disposition: "DECIDED",
      effectId: null,
      resultCode: "ENVIRONMENT_VARIABLE_SET",
    });
    // Through the STORE's own read, so the arm proves the write landed rather than that the
    // edge returned a shape.
    expect(readBack(world.store)).toEqual(["DATABASE_URL"]);
  });

  it("unsets a variable it had set, through the same edge", () => {
    const world = edgeWorld();
    runEnvironmentEdge(world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-set-2", {
      environment: "production", name: "API_TOKEN", value: SECRET,
    }));
    expect(readBack(world.store)).toEqual(["API_TOKEN"]);

    const decision = runEnvironmentEdge(
      world.context(ENVIRONMENT_COMMAND_KIND_UNSET, "cmd-edge-unset-2", {
        environment: "production", name: "API_TOKEN",
      }),
    );

    expect(decision.resultCode).toBe("ENVIRONMENT_VARIABLE_UNSET");
    expect(decision.disposition).toBe("DECIDED");
    expect(readBack(world.store)).toEqual([]);
  });

  it("passes the ENVELOPE's commandId through, so a retried set never double-writes", () => {
    const world = edgeWorld();
    const context = world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-retry", {
      environment: "production", name: "RETRIED", value: SECRET,
    });
    const first = runEnvironmentEdge(context);
    const versionAfterFirst = world.store.getAggregateVersion(
      `environment/${PROJECT_ID}/production`,
    );
    expect(first.disposition).toBe("DECIDED");
    expect(versionAfterFirst).toBeGreaterThan(0);

    // MEASURED, not assumed: the store keys its receipt by command id and compares REQUEST
    // DIGESTS, and a set's digest can never repeat (fresh seal nonce, fresh eventId). So the
    // retry CONFLICTS rather than replaying. Asserted on the store's own class and code so a
    // silent downgrade to "it threw something" cannot pass.
    let conflict: unknown;
    try {
      runEnvironmentEdge(context);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(CommandIdConflictError);
    expect((conflict as DurableStoreError).code).toBe("COMMAND_ID_CONFLICT");
    // The property that actually matters, and the one a minted-per-call command id would break:
    // the aggregate did NOT advance a second time.
    expect(world.store.getAggregateVersion(`environment/${PROJECT_ID}/production`))
      .toBe(versionAfterFirst);
    // A conflict is where a store error is most tempted to quote what was submitted.
    expect(JSON.stringify(String((conflict as Error).message))).not.toContain(SECRET);
  });

  describe("the store's four refusal codes reach the edge with their own layer", () => {
    it("refuses an unknown environment as ENV_ENVIRONMENT_UNKNOWN at SCOPE", () => {
      const world = edgeWorld();
      const refusal = refusalOf(() => runEnvironmentEdge(
        world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-scope", {
          environment: "not-an-environment", name: "NAME", value: SECRET,
        }),
      ));
      expect(refusal.code).toBe("ENV_ENVIRONMENT_UNKNOWN");
      expect(refusal.layer).toBe(ENVIRONMENT_CODE_LAYERS.ENV_ENVIRONMENT_UNKNOWN);
      expect(refusal.detail).toBe(ENVIRONMENT_REFUSAL_DETAILS.ENV_ENVIRONMENT_UNKNOWN);
    });

    it("refuses a malformed variable name as ENV_NAME_INVALID at NAME", () => {
      const world = edgeWorld();
      const refusal = refusalOf(() => runEnvironmentEdge(
        world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-name", {
          environment: "production", name: "not a name", value: SECRET,
        }),
      ));
      expect(refusal.code).toBe("ENV_NAME_INVALID");
      expect(refusal.layer).toBe(ENVIRONMENT_CODE_LAYERS.ENV_NAME_INVALID);
      expect(refusal.detail).toBe(ENVIRONMENT_REFUSAL_DETAILS.ENV_NAME_INVALID);
    });

    it("refuses an oversized value as ENV_VALUE_TOO_LARGE at VALUE", () => {
      const world = edgeWorld();
      const refusal = refusalOf(() => runEnvironmentEdge(
        world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-size", {
          environment: "production", name: "BIG", value: "x".repeat(1024 * 1024),
        }),
      ));
      expect(refusal.code).toBe("ENV_VALUE_TOO_LARGE");
      expect(refusal.layer).toBe(ENVIRONMENT_CODE_LAYERS.ENV_VALUE_TOO_LARGE);
      expect(refusal.detail).toBe(ENVIRONMENT_REFUSAL_DETAILS.ENV_VALUE_TOO_LARGE);
    });

    it("refuses an unavailable store key as ENV_STORE_KEY_UNAVAILABLE at KEY", () => {
      const world = edgeWorld(null);
      const refusal = refusalOf(() => runEnvironmentEdge(
        world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-key", {
          environment: "production", name: "KEYLESS", value: SECRET,
        }),
      ));
      expect(refusal.code).toBe("ENV_STORE_KEY_UNAVAILABLE");
      expect(refusal.layer).toBe(ENVIRONMENT_CODE_LAYERS.ENV_STORE_KEY_UNAVAILABLE);
      expect(refusal.detail).toBe(ENVIRONMENT_REFUSAL_DETAILS.ENV_STORE_KEY_UNAVAILABLE);
    });
  });

  describe("a non-string field over the wire refuses instead of crashing", () => {
    it.each([
      ["null", null], ["a number", 42], ["an object", { nested: true }], ["absent", undefined],
    ])("refuses %s in `value` at VALUE", (_label, value) => {
      const world = edgeWorld();
      const refusal = refusalOf(() => runEnvironmentEdge(
        world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-typed-value", {
          environment: "production", name: "TYPED", value,
        }),
      ));
      expect(refusal.code).toBe("ENV_VALUE_TOO_LARGE");
      expect(refusal.layer).toBe("VALUE");
    });

    it.each([["null", null], ["a number", 7]])("refuses %s in `name` at NAME", (_label, name) => {
      const world = edgeWorld();
      const refusal = refusalOf(() => runEnvironmentEdge(
        world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-typed-name", {
          environment: "production", name, value: SECRET,
        }),
      ));
      expect(refusal.code).toBe("ENV_NAME_INVALID");
      expect(refusal.layer).toBe("NAME");
    });

    it.each([["null", null], ["a number", 7]])(
      "refuses %s in `environment` at SCOPE", (_label, environment) => {
        const world = edgeWorld();
        const refusal = refusalOf(() => runEnvironmentEdge(
          world.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-edge-typed-scope", {
            environment, name: "SCOPED", value: SECRET,
          }),
        ));
        expect(refusal.code).toBe("ENV_ENVIRONMENT_UNKNOWN");
        expect(refusal.layer).toBe("SCOPE");
      },
    );

    it("refuses a non-string `name` on the UNSET wire too", () => {
      const world = edgeWorld();
      const refusal = refusalOf(() => runEnvironmentEdge(
        world.context(ENVIRONMENT_COMMAND_KIND_UNSET, "cmd-edge-unset-typed", {
          environment: "production", name: null,
        }),
      ));
      expect(refusal.code).toBe("ENV_NAME_INVALID");
      expect(refusal.layer).toBe("NAME");
    });
  });
});

/**
 * THE INGRESS CANARY — the one surface `environment/environment-canary.test.ts` provably cannot
 * reach. That suite greps the store file, the event stream, every read response and every
 * receipt, and it passes because `environment-store.ts:99-103` writes commandBytes carrying only
 * `{environment, kind, name}`. THE DAEMON ENVELOPE, BY CONTRAST, CARRIES THE VALUE: it arrives as
 * request bytes, is decoded into a payload, and every generic thing the ingress does with a
 * payload — echoing it into a refusal detail, recording it in a decision, digesting it, logging
 * it — is a leak for this one kind and for no other on the board.
 *
 * EVERY SEARCH IS OVER BYTES, never over parsed values. A plaintext surviving inside a
 * serialised blob is invisible to `expect(x.value).toBeUndefined()` and perfectly visible to
 * anyone who opens the file.
 *
 * EVERY SEARCH CARRIES AN ANTI-VACUITY CONTROL. "No plaintext" is trivially satisfied by
 * searching nothing, which is exactly how this class of test lies, so each surface asserts it is
 * NON-EMPTY and that a token which MUST be there — the variable name, or the command id — IS
 * found. A surface that stops being produced reds on its control rather than passing silently.
 */
describe("the ingress canary: the envelope carries the value and nothing may echo it", () => {
  const CANARY_PROJECT = "proj-environment-canary";
  const CANARY_CREDENTIAL = "environment-canary-operator-credential";
  const CANARY_VARIABLE = "MOE_CANARY_TARGET";

  /** A fresh canary PER TEST: a shared constant could be matched by an unrelated fixture. */
  function canaryValue(): string {
    return `MOE_CANARY_${randomBytes(16).toString("hex")}`;
  }

  interface CanaryWorld {
    readonly close: () => void;
    readonly directory: string;
    readonly send: (
      commandId: string,
      commandKind: string,
      payload: Readonly<Record<string, unknown>>,
    ) => ReturnType<typeof handleCommandRequest>;
    readonly storePath: string;
  }

  function canaryWorld(): CanaryWorld {
    const directory = mkdtempSync(join(tmpdir(), "moe-env-canary-"));
    const storePath = join(directory, "store.db");
    const setup = SqliteEventStore.openForProject(storePath, CANARY_PROJECT);
    installTestRecoveryBinding(setup);
    setup.close();
    const provider = createStoreDependencies({
      clock: () => NOW,
      credential: CANARY_CREDENTIAL,
      principalId: "operator-local",
      projectId: CANARY_PROJECT,
      storePath,
    });
    const deps = provider.provide();
    return {
      close: () => {
        provider.close();
        rmSync(directory, { force: true, recursive: true });
      },
      directory,
      send: (commandId, commandKind, payload) => handleCommandRequest(deps, {
        body: new TextEncoder().encode(JSON.stringify({
          commandId, commandKind, correlationId: `corr-${commandId}`, expectedVersion: 0, payload,
          requestDigest: "b".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
          sessionCredential: CANARY_CREDENTIAL, targetAggregateId: "agg-environment-canary",
        })),
        credential: CANARY_CREDENTIAL,
        protocolVersion: WIRE_PROTOCOL_VERSION,
      }, "HTTP_LISTENER"),
      storePath,
    };
  }

  /** Every byte the store owns on disk: the database, its WAL and its shared-memory index. */
  function storeFileBytes(world: CanaryWorld): Buffer {
    const prefix = basename(world.storePath);
    const files = readdirSync(world.directory).filter((entry) => entry.startsWith(prefix));
    expect(files.length).toBeGreaterThan(0);
    return Buffer.concat(files.map((entry) => readFileSync(join(world.directory, entry))));
  }

  const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, (_key, item) =>
    (item instanceof Uint8Array ? Buffer.from(item).toString("base64") : item)), "utf8");

  /**
   * THE DURABLE COMMAND RECORD for one dispatch, and the digest path with it.
   *
   * MEASURED, and worth stating because it is not what the shared path does: an environment
   * write leaves NO row in the decision ledger. The edge commits through the store's own
   * `commit` (an event append plus a command RECEIPT) rather than through
   * `commitExpectedVersionDecision`, which is what mints a `CommandDecisionRecord`. So the
   * receipt IS the durable command record here, and `requestSha256` on it is the request-digest
   * path this arm covers. Both are searched; the ledger is searched too, so if a later change
   * starts writing one, this arm covers it the same day rather than silently skipping it.
   */
  function durableRecordBytes(world: CanaryWorld, commandId: string): {
    readonly ledger: Buffer; readonly receipt: Buffer;
  } {
    const store = SqliteEventStore.openForProject(world.storePath, CANARY_PROJECT);
    try {
      return {
        ledger: jsonBytes(store.readCommandDecisionsAfter(0n, 1_000).items),
        receipt: jsonBytes(store.getCommandReceipt(commandId)),
      };
    } finally {
      store.close();
    }
  }

  it("leaves ZERO plaintext in the REFUSAL of a malformed request carrying a valid value", () => {
    const world = canaryWorld();
    const secret = canaryValue();
    try {
      // TWO malformed shapes, both carrying a REAL value, because two different layers answer
      // and either one could echo what it was handed.
      // (1) A smuggled key: refused at PAYLOAD_SHAPE by the ingress allow-list, ABOVE the edge.
      const smuggled = world.send("cmd-canary-smuggled", ENVIRONMENT_COMMAND_KIND_SET, {
        environment: "production", name: CANARY_VARIABLE, smuggled: true, value: secret,
      });
      // (2) A missing `environment`: refused by the edge itself, at the SCOPE layer.
      const scoped = world.send("cmd-canary-scopeless", ENVIRONMENT_COMMAND_KIND_SET, {
        name: CANARY_VARIABLE, value: secret,
      });

      const refusals = Buffer.from(JSON.stringify([smuggled, scoped]), "utf8");
      const text = refusals.toString("utf8");
      // CONTROL 1: the surface exists, is non-trivial, and BOTH refusals really happened at the
      // two DIFFERENT layers this arm exists to cover — otherwise "no plaintext" would be
      // satisfied by two empty objects.
      expect(refusals.length).toBeGreaterThan(200);
      expect(text).toContain("INPUT_INVALID");
      expect(text).toContain("PAYLOAD_SHAPE");
      expect(text).toContain("ENV_ENVIRONMENT_UNKNOWN");
      expect(text).toContain("DISPATCH");
      // CONTROL 2, the positive one: the byte search WOULD find this exact secret if a surface
      // carried it. Without this, `includes` returning false proves the technique works no
      // better than it proves the refusal is clean.
      expect(Buffer.from(JSON.stringify({ echoed: secret }), "utf8").includes(secret)).toBe(true);

      expect(refusals.includes(secret)).toBe(false);
    } finally {
      world.close();
    }
  });

  it("leaves ZERO plaintext in the DECISION RECORD, the digest path and the store file", () => {
    const world = canaryWorld();
    const secret = canaryValue();
    try {
      const accepted = world.send("cmd-canary-set", ENVIRONMENT_COMMAND_KIND_SET, {
        environment: "production", name: CANARY_VARIABLE, value: secret,
      });
      // CONTROL: the write actually landed. A refused dispatch writes almost nothing, and every
      // search below would then pass while proving nothing at all.
      expect(accepted).toMatchObject({ outcome: "ACCEPTED" });

      const { ledger, receipt } = durableRecordBytes(world, "cmd-canary-set");
      const files = storeFileBytes(world);
      const response = Buffer.from(JSON.stringify(accepted), "utf8");

      // CONTROLS, one per surface: each is non-empty AND carries a token that MUST be there.
      // The RECEIPT is the durable command record for this kind, and `requestSha256` on it is
      // the request-digest path — a digest is present, the plaintext behind it is not.
      expect(receipt.length).toBeGreaterThan(100);
      expect(receipt.toString("utf8")).toContain("cmd-canary-set");
      expect(receipt.toString("utf8")).toContain("requestSha256");
      // The store file is the strongest surface and the only one that can catch a value hiding
      // in a serialised blob nobody destructured. Its control is the variable NAME, which the
      // store legitimately persists.
      expect(files.length).toBeGreaterThan(1_000);
      expect(files.includes(Buffer.from(CANARY_VARIABLE, "utf8"))).toBe(true);
      expect(response.toString("utf8")).toContain("ENVIRONMENT_VARIABLE_SET");
      // POSITIVE CONTROL for the byte search itself, over the same secret these arms hunt.
      expect(Buffer.from(JSON.stringify({ echoed: secret }), "utf8").includes(secret)).toBe(true);

      expect(receipt.includes(secret)).toBe(false);
      expect(ledger.includes(secret)).toBe(false);
      expect(files.includes(Buffer.from(secret, "utf8"))).toBe(false);
      expect(response.includes(secret)).toBe(false);
    } finally {
      world.close();
    }
  });

  it("writes ZERO plaintext into any console line the dispatch emits", () => {
    const world = canaryWorld();
    const secret = canaryValue();
    const lines: string[] = [];
    const record = (...args: readonly unknown[]): void => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "));
    };
    const spies = (["debug", "error", "info", "log", "warn"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(record));
    try {
      // Accepted AND refused, in that order: a debug line is as likely on the success path as an
      // error line is on the failure one. The buffer is read AFTER both acts, never before.
      world.send("cmd-canary-log-set", ENVIRONMENT_COMMAND_KIND_SET, {
        environment: "production", name: CANARY_VARIABLE, value: secret,
      });
      world.send("cmd-canary-log-refused", ENVIRONMENT_COMMAND_KIND_SET, {
        environment: "no-such-environment", name: CANARY_VARIABLE, value: secret,
      });
      // CONTROL for a surface that may legitimately be EMPTY: "the daemon logged nothing" and
      // "the spy never worked" are indistinguishable otherwise, so the capture is exercised
      // directly, INSIDE the spy's lifetime. A broken spy reds here instead of silently turning
      // the search below into a no-op.
      console.log("environment canary capture control", CANARY_VARIABLE);
    } finally {
      for (const spy of spies) spy.mockRestore();
      world.close();
    }

    expect(lines.at(-1) ?? "").toContain(CANARY_VARIABLE);
    expect(lines.join("\n")).not.toContain(secret);
  });
});

/**
 * THE FENCE, ASSERTED AS BEHAVIOUR (DoD 1, 2, 4).
 *
 * Roster membership is NOT the assertion here — `mcp-tool-allowlist.test.ts` and
 * `daemon-command-vocabulary.test.ts` already pin the memberships from the roster side, and a
 * test that iterates a roster shrinks its own iteration when an entry is deleted and stays green
 * (global rail 9). So the SERVED set below is enumerated from the DISPATCH SEAM — the registry's
 * own keys, filtered by the discriminator `entryOf` actually branches on — and every fence is
 * then exercised by DISPATCHING as the wrong principal and as the right one.
 */
describe("the operator fence over the two environment kinds", () => {
  const FENCE_PROJECT = "proj-environment-fence";
  const FENCE_CREDENTIAL = "environment-fence-operator-credential";
  const KINDS = [ENVIRONMENT_COMMAND_KIND_SET, ENVIRONMENT_COMMAND_KIND_UNSET] as const;

  interface FenceWorld {
    readonly agentCredential: (capabilities: readonly string[]) => string;
    readonly close: () => void;
    readonly registry: ReadonlyMap<string, unknown>;
    readonly send: (
      commandId: string,
      commandKind: string,
      payload: Readonly<Record<string, unknown>>,
      credential?: string,
    ) => ReturnType<typeof handleCommandRequest>;
  }

  let world: FenceWorld;

  beforeAll(() => {
    const directory = mkdtempSync(join(tmpdir(), "moe-env-fence-"));
    const storePath = join(directory, "store.db");
    const setup = SqliteEventStore.openForProject(storePath, FENCE_PROJECT);
    installTestRecoveryBinding(setup);
    setup.close();
    const provider = createStoreDependencies({
      clock: () => NOW,
      credential: FENCE_CREDENTIAL,
      principalId: "operator-local",
      projectId: FENCE_PROJECT,
      storePath,
    });
    const deps = provider.provide();
    const send: FenceWorld["send"] = (commandId, commandKind, payload,
      credential = FENCE_CREDENTIAL) => handleCommandRequest(deps, {
      body: new TextEncoder().encode(JSON.stringify({
        commandId, commandKind, correlationId: `corr-${commandId}`, expectedVersion: 0, payload,
        requestDigest: "c".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        sessionCredential: credential, targetAggregateId: "agg-environment-fence",
      })),
      credential,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "HTTP_LISTENER");
    world = {
      // A REAL scoped agent session, minted by the operator exactly as the daemon mints one:
      // a fabricated credential would be refused at AUTHENTICATE and never reach the fence,
      // which would make every arm below pass for the wrong reason.
      agentCredential: (capabilities) => {
        const secret = `secret-agent-${capabilities.join("-")}`;
        const opened = send(`cmd-open-${capabilities.join("-")}`, "session.open", {
          capabilities,
          credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
          expiresAt: "2027-01-01T00:00:00.000Z",
          sessionId: `sess-environment-${capabilities.join("-")}`,
        });
        expect(opened).toMatchObject({ outcome: "ACCEPTED" });
        return secret;
      },
      close: () => {
        provider.close();
        rmSync(directory, { force: true, recursive: true });
      },
      registry: deps.registry as ReadonlyMap<string, unknown>,
      send,
    };
  });

  afterAll(() => world.close());

  it("serves EXACTLY the two environment kinds, enumerated from the dispatch seam", () => {
    // FROM THE SEAM, not from ENVIRONMENT_FAMILY: `commandFamilyFacts(kind).environment` is the
    // literal discriminator `entryOf` branches on, and the keys come from the registry the HTTP
    // adapter serves. Deleting a kind from either side breaks this equality in one direction.
    // STANDALONE kinds are skipped first: `commandFamilyFacts` THROWS for a kind in no family
    // (`foundation.dispatch` is one), so the guard is a fact about the seam, not a convenience.
    const served = [...world.registry.keys()]
      .filter((kind) => familyCapabilityOf(kind) !== null)
      .filter((kind) => commandFamilyFacts(kind as never).environment).sort();

    expect(served).toEqual([...KINDS].sort());
    expect(Object.keys(ENVIRONMENT_FAMILY).sort()).toEqual([...KINDS].sort());
    // BOTH DIRECTIONS over the advertised rosters, spelled out per kind so a deletion on either
    // side reds rather than shrinking an iteration it also controls.
    for (const kind of KINDS) {
      expect(served).toContain(kind);
      expect(OPERATOR_PRINCIPAL_KINDS.has(kind)).toBe(true);
      expect(HUMAN_ONLY_STEPS.has(kind)).toBe(true);
      expect(MCP_EXCLUDED_COMMAND_KINDS).toContain(kind);
      expect(wiredMcpToolKinds()).not.toContain(kind);
    }
    // The converse leg: nothing outside the pair claims the environment family, and no
    // environment kind is quietly advertised over MCP.
    expect(MCP_EXCLUDED_COMMAND_KINDS.filter((kind) => kind.startsWith("environment.")).sort())
      .toEqual([...KINDS].sort());
    expect(wiredMcpToolKinds().filter((kind) => kind.startsWith("environment."))).toEqual([]);
  });

  it("couples the result-code roster to the family, so a third kind cannot answer undefined", () => {
    // FOUND BY ADVERSARIAL REVIEW OF THIS ROW'S OWN DIFF. `entryOf` reaches the edge through
    // `kind as EnvironmentEdgeKind`, and a cast proves nothing at runtime: a third kind added to
    // ENVIRONMENT_FAMILY would dispatch here and index ENVIRONMENT_EDGE_RESULT_CODES to
    // `undefined`, shipping a decision with no result code rather than refusing. Set-equality
    // between the family (what the seam ROUTES) and the result codes (what the edge can ANSWER)
    // makes that a red on the day the third kind is added, and costs no unreachable branch.
    expect(Object.keys(ENVIRONMENT_EDGE_RESULT_CODES).sort())
      .toEqual(Object.keys(ENVIRONMENT_FAMILY).sort());
    for (const kind of KINDS) {
      expect(ENVIRONMENT_EDGE_RESULT_CODES[kind]).toBeTypeOf("string");
    }
  });

  it.each(KINDS)(
    "%s refuses an AGENT-authenticated dispatch and admits the OPERATOR's",
    (kind) => {
      const suffix = kind.replaceAll(".", "-");
      // ADMIN is the capability the kind DEMANDS, held by a real scoped session. The refusal
      // must therefore come from the principal fence, not from a capability check — which is
      // the whole point: a capability gate is not a human fence.
      const agent = world.agentCredential([ADMIN, WORK]);
      // The kind's OWN allow-list: sending `value` to the unset wire is refused at
      // PAYLOAD_SHAPE above the fence, which would prove the allow-list works and the fence
      // nothing at all.
      const agentPayload = kind === ENVIRONMENT_COMMAND_KIND_SET
        ? { environment: "production", name: "AGENT_ATTEMPT", value: "agent-supplied-value" }
        : { environment: "production", name: "AGENT_ATTEMPT" };
      const refused = world.send(`cmd-agent-${suffix}`, kind, agentPayload, agent);

      expect(refused).toMatchObject({
        httpStatus: 403,
        ok: false,
        outcome: "PORT_REFUSED",
        refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" },
        stage: "DISPATCH",
      });

      // The SAME request as the configured operator REACHES the handler. Set lands; unset lands
      // against what set wrote, so both arms end in an accepted decision rather than a refusal
      // that would prove only that the fence is closed to everybody.
      if (kind === ENVIRONMENT_COMMAND_KIND_UNSET) {
        expect(world.send(`cmd-operator-seed-${suffix}`, ENVIRONMENT_COMMAND_KIND_SET, {
          environment: "production", name: "AGENT_ATTEMPT", value: "operator-supplied-value",
        })).toMatchObject({ outcome: "ACCEPTED" });
      }
      const payload = kind === ENVIRONMENT_COMMAND_KIND_SET
        ? { environment: "production", name: "AGENT_ATTEMPT", value: "operator-supplied-value" }
        : { environment: "production", name: "AGENT_ATTEMPT" };
      expect(world.send(`cmd-operator-${suffix}`, kind, payload)).toMatchObject({
        decision: {
          resultCode: kind === ENVIRONMENT_COMMAND_KIND_SET
            ? "ENVIRONMENT_VARIABLE_SET" : "ENVIRONMENT_VARIABLE_UNSET",
        },
        outcome: "ACCEPTED",
      });
    },
  );

  it("carries the agent refusal WITHOUT the value the agent submitted", () => {
    const agent = world.agentCredential([ADMIN, WORK]);
    const secret = `MOE_CANARY_${randomBytes(16).toString("hex")}`;
    const refused = world.send("cmd-agent-leak-check", ENVIRONMENT_COMMAND_KIND_SET, {
      environment: "production", name: "AGENT_LEAK", value: secret,
    }, agent);
    const bytes = Buffer.from(JSON.stringify(refused), "utf8");

    // CONTROLS: the refusal happened and the byte search finds this exact secret when present.
    expect(bytes.toString("utf8")).toContain("OPERATOR_PRINCIPAL_REQUIRED");
    expect(Buffer.from(JSON.stringify({ echoed: secret }), "utf8").includes(secret)).toBe(true);

    expect(bytes.includes(secret)).toBe(false);
  });

  it.each([
    { code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE",
      payload: { environment: "no-such-environment", name: "OK_NAME" } },
    { code: "ENV_NAME_INVALID", layer: "NAME",
      payload: { environment: "production", name: "not a name" } },
    { code: "ENV_VALUE_TOO_LARGE", layer: "VALUE",
      payload: { environment: "production", name: "OK_NAME", oversized: true } },
  ])("surfaces $code at $layer over the wire, carrying no submitted value", ({
    code, layer, payload,
  }) => {
    const secret = `MOE_CANARY_${randomBytes(16).toString("hex")}`;
    // MEASURED sizes, not a round number: the env bound is MAX_ENVIRONMENT_VALUE_BYTES (4096)
    // and the WIRE bound is MAX_JSON_STRING_UTF8_BYTES (262144). A 1 MiB value is refused at
    // DECODE with 413 and never reaches the edge, so the oversized case sits between the two.
    const value = "oversized" in payload
      ? `${secret}${"x".repeat(MAX_ENVIRONMENT_VALUE_BYTES * 2)}` : secret;
    const refused = world.send(`cmd-code-${code}`, ENVIRONMENT_COMMAND_KIND_SET, {
      environment: payload.environment, name: payload.name, value,
    });

    expect(refused).toMatchObject({
      httpStatus: 422,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code, layer },
      stage: "DISPATCH",
    });
    // The detail is the store's FIXED prose, so it can name the fault without naming the value.
    const bytes = Buffer.from(JSON.stringify(refused), "utf8");
    expect(bytes.toString("utf8")).toContain(
      ENVIRONMENT_REFUSAL_DETAILS[code as keyof typeof ENVIRONMENT_REFUSAL_DETAILS],
    );
    expect(Buffer.from(JSON.stringify({ echoed: secret }), "utf8").includes(secret)).toBe(true);
    expect(bytes.includes(secret)).toBe(false);
  });

  it("carries ENV_STORE_KEY_UNAVAILABLE at KEY with no value, on a keyless daemon", () => {
    // The one code the wired daemon above cannot produce: it always has a credential. Asserted
    // at the edge with an ABSENT key source, which is exactly the state
    // `environmentCredential`'s `() => null` default puts an unwired daemon in.
    const secret = `MOE_CANARY_${randomBytes(16).toString("hex")}`;
    const keyless = edgeWorld(null);
    const refusal = refusalOf(() => runEnvironmentEdge(
      keyless.context(ENVIRONMENT_COMMAND_KIND_SET, "cmd-keyless-leak", {
        environment: "production", name: "KEYLESS", value: secret,
      }),
    ));

    expect(refusal.code).toBe("ENV_STORE_KEY_UNAVAILABLE");
    expect(refusal.layer).toBe("KEY");
    expect(refusal.detail).toBe(ENVIRONMENT_REFUSAL_DETAILS.ENV_STORE_KEY_UNAVAILABLE);
    expect(Buffer.from(JSON.stringify({ echoed: secret }), "utf8").includes(secret)).toBe(true);
    expect(Buffer.from(`${refusal.message}${refusal.detail}`, "utf8").includes(secret))
      .toBe(false);
  });
});
