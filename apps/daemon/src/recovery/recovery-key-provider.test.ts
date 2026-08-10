import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionResponse, CommitExpectedVersionDecisionInput } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import { createNodeRecoveryCryptoPort } from "./recovery-incarnation.node.js";
import type {
  RecoveryIncarnationCryptoPort,
  RecoveryIncarnationKeyHandle,
  RecoveryIncarnationKeyPair,
} from "./recovery-incarnation-contract.js";
import {
  RECOVERY_KEY_EPOCH_COMMAND_KIND,
  RECOVERY_KEY_EPOCH_SCHEMA_VERSION,
  protectionUnavailable,
  protectionUnverifiable,
} from "./recovery-key-provider-contract.js";
import type {
  RecoveryKeyEpoch,
  RecoveryKeyEpochResult,
  RecoveryKeyProviderPort,
} from "./recovery-key-provider-contract.js";
import {
  encodeKeyEpochPointer,
  keyEpochAggregateId,
  readKeyEpochPointer,
} from "./recovery-key-epoch-store.js";
import { createRecoveryKeyProvider } from "./recovery-key-provider.js";
import { readSuccessionChain } from "./recovery-succession.js";

const PROJECT_ID = "proj-key-epoch";
const PRINCIPAL_ID = "principal-key-epoch";
const CORRELATION_ID = "correlation-key-epoch";
const RESTORE_COMMAND_ID = "restore-key-epoch";
const GENERATION_DIGEST = "7a".repeat(32);
const AT = "2026-08-10T00:00:00.000Z";
const PROTECTED_DIRECTORY = "C:\\moe\\recovery epoch";
const UNANCHORED_REF = "ab".repeat(32);

const directories: string[] = [];
const stores: SqliteEventStore[] = [];

/**
 * A real SQLite file, never an in-memory double: `reopen` closes the handle and
 * opens the same path again, which is the connection boundary a restart crosses.
 * The FULL process-death proof lives in `recovery-key-provider.node.test.ts`;
 * this suite drives the branches a real process death cannot be steered into.
 */
interface Harness {
  readonly path: string;
  store: SqliteEventStore;
  reopen: () => SqliteEventStore;
}

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "moe-key-epoch-"));
  directories.push(directory);
  const path = join(directory, "store.sqlite");
  const opened = SqliteEventStore.openForProject(path, PROJECT_ID);
  stores.push(opened);
  const state: Harness = {
    path,
    store: opened,
    reopen: (): SqliteEventStore => {
      state.store.close();
      const next = SqliteEventStore.openForProject(path, PROJECT_ID);
      stores.push(next);
      state.store = next;
      return next;
    },
  };
  return state;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed by a reopen */
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  backupGenerationDigest: GENERATION_DIGEST,
  correlationId: CORRELATION_ID,
  decidedAt: AT,
  principalId: PRINCIPAL_ID,
  projectId: PROJECT_ID,
  protectedDirectory: PROTECTED_DIRECTORY,
  restoreCommandId: RESTORE_COMMAND_ID,
  ...overrides,
});

const PROTECTED = Object.freeze({
  mechanism: "WIN32_DACL_EXPLICIT_OWNER_ONLY" as const,
  ok: true as const,
  platform: "win32" as const,
});

const fakePort = (
  protect: RecoveryKeyProviderPort["protect"] = () => Promise.resolve(PROTECTED),
): RecoveryKeyProviderPort => Object.freeze({ platform: "win32" as const, protect });

/** Wraps the REAL Ed25519 port so a fault is injected without faking the crypto. */
const wrapCrypto = (
  overrides: Partial<RecoveryIncarnationCryptoPort>,
): RecoveryIncarnationCryptoPort => {
  const real = createNodeRecoveryCryptoPort();
  return Object.freeze({
    destroy: (handle: RecoveryIncarnationKeyHandle): void => {
      real.destroy(handle);
    },
    generateSigningKey: (): Promise<RecoveryIncarnationKeyPair> => real.generateSigningKey(),
    randomBytes: (length: number): Promise<Uint8Array> | Uint8Array => real.randomBytes(length),
    sign: (handle: RecoveryIncarnationKeyHandle, message: Uint8Array): Promise<Uint8Array> =>
      real.sign(handle, message),
    verify: (spki: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> =>
      real.verify(spki, message, signature),
    ...overrides,
  });
};

const decisionCount = (store: SqliteEventStore): number =>
  store.readCommandDecisionsAfter(0n, 1000).items.length;

const opened = (result: RecoveryKeyEpochResult): RecoveryKeyEpoch => {
  if (!result.ok) throw new Error(`expected OPENED, got ${result.code}`);
  expect(result.outcome).toBe("OPENED");
  expect(result.authority).toBe("NONE");
  return result;
};

/** Both halves of DoD 5, always together: the code AND the layer that refused. */
const answerOf = (result: RecoveryKeyEpochResult): string => {
  if (result.ok) throw new Error("expected REFUSED, got OPENED");
  expect(result.outcome).toBe("REFUSED");
  expect(result.truth).toBe("UNKNOWN");
  expect(result.authority).toBe("NONE");
  return `${result.layer}/${result.code}`;
};

const open = (
  store: SqliteEventStore,
  overrides: Record<string, unknown> = {},
  port: RecoveryKeyProviderPort = fakePort(),
  crypto: RecoveryIncarnationCryptoPort = createNodeRecoveryCryptoPort(),
): Promise<RecoveryKeyEpochResult> =>
  createRecoveryKeyProvider(crypto, port).open(store, request(overrides));

describe("a cold start mints and anchors one durable epoch", () => {
  it("reports MINTED, anchors the incarnation and leaves a readable pointer", async () => {
    const { store } = harness();
    const epoch = opened(await open(store));

    expect(epoch.opening).toBe("MINTED");
    expect(epoch.generation).toBe(0);
    expect(epoch.chainLength).toBe(0);
    // On a cold start the epoch IS its own origin; every later open must keep it.
    expect(epoch.originIncarnationRef).toBe(epoch.incarnationRef);
    expect(epoch.restoreCommandId).toBe(RESTORE_COMMAND_ID);
    expect(epoch.protection).toEqual(PROTECTED);

    const anchored = readAnchoredIncarnation(store, PROJECT_ID, epoch.incarnationRef);
    expect(anchored?.publicKeySpkiHex).toBe(epoch.publicKeySpkiHex);
    const pointer = readKeyEpochPointer(store, PROJECT_ID, RESTORE_COMMAND_ID);
    expect(pointer).toEqual({
      pointer: {
        generation: 0,
        headIncarnationRef: epoch.incarnationRef,
        originIncarnationRef: epoch.incarnationRef,
        restoreCommandId: RESTORE_COMMAND_ID,
        schemaVersion: RECOVERY_KEY_EPOCH_SCHEMA_VERSION,
      },
      state: "PRESENT",
    });
  });
});

describe("reopening resolves the same epoch identity under a different key", () => {
  it("keeps the origin, re-mints the key and links the chain", async () => {
    const state = harness();
    const first = opened(await open(state.store));
    const second = opened(await open(state.reopen()));

    expect(second.opening).toBe("REOPENED");
    // Same identity proves it REOPENED; a different SPKI proves it RE-MINTED
    // rather than resurrected. Either assertion alone passes on the wrong build.
    expect(second.originIncarnationRef).toBe(first.originIncarnationRef);
    expect(second.incarnationRef).not.toBe(first.incarnationRef);
    expect(second.publicKeySpkiHex).not.toBe(first.publicKeySpkiHex);
    expect(second.generation).toBe(1);
    expect(second.chainLength).toBe(1);

    const chain = readSuccessionChain(state.store, PROJECT_ID, second.incarnationRef);
    if (!chain.ok) throw new Error(`expected a chain, got ${chain.code}`);
    expect(chain.originIncarnationRef).toBe(first.incarnationRef);
    expect(chain.links).toHaveLength(1);
    expect(chain.links[0]?.predecessorIncarnationRef).toBe(first.incarnationRef);
    expect(chain.links[0]?.successorIncarnationRef).toBe(second.incarnationRef);
  });

  it("holds the origin across a third process and grows the chain", async () => {
    const state = harness();
    const first = opened(await open(state.store));
    const second = opened(await open(state.reopen()));
    const third = opened(await open(state.reopen()));

    expect(third.originIncarnationRef).toBe(first.originIncarnationRef);
    expect(third.generation).toBe(2);
    expect(third.chainLength).toBe(2);
    expect(new Set([first, second, third].map((e) => e.publicKeySpkiHex)).size).toBe(3);
  });
});

/**
 * The crash the ANCHOR-BEFORE-SUCCEED order leaves behind: the succession record
 * committed but the pointer never advanced. Without a forward heal the retry
 * would try to succeed an already-succeeded predecessor forever, so this is not
 * a nicety — it is the difference between crash-resume and a permanent wedge.
 */
describe("a crash between the succession record and the pointer advance heals", () => {
  it("adopts the recorded successor as the head and keeps one origin", async () => {
    const state = harness();
    const first = opened(await open(state.store));

    // Methods are bound to the TARGET: `SqliteEventStore` reads a `#core`
    // private field, which throws on a proxy receiver.
    const wedged = new Proxy(state.store, {
      get(target, property): unknown {
        if (property === "commitExpectedVersionDecision") {
          return (input: CommitExpectedVersionDecisionInput): CommandDecisionResponse => {
            if (input.commandKind === RECOVERY_KEY_EPOCH_COMMAND_KIND) {
              throw new Error("process died before the pointer advanced");
            }
            return target.commitExpectedVersionDecision(input);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(open(wedged)).rejects.toThrow("process died before the pointer advanced");
    expect(readKeyEpochPointer(state.store, PROJECT_ID, RESTORE_COMMAND_ID)).toMatchObject({
      pointer: { generation: 0, headIncarnationRef: first.incarnationRef },
    });

    const healed = opened(await open(state.reopen()));
    expect(healed.originIncarnationRef).toBe(first.originIncarnationRef);
    expect(healed.chainLength).toBe(2);
    const chain = readSuccessionChain(state.store, PROJECT_ID, healed.incarnationRef);
    if (!chain.ok) throw new Error(`expected a chain, got ${chain.code}`);
    expect(chain.originIncarnationRef).toBe(first.incarnationRef);
  });
});

/**
 * Every declared injection, each pinned to its EXACT code and the layer that
 * refused. `answers` is asserted as an ordered list rather than per-case so a
 * case that silently joined another's answer cannot hide, and the case count is
 * asserted against a HAND-WRITTEN number so a sweep producing zero — or one
 * fewer than declared — fails instead of passing quietly.
 */
type Injection = {
  readonly name: string;
  /** Runs BEFORE the write count is snapshotted, so seeding is not mistaken for a write. */
  readonly arrange?: (state: Harness) => Promise<void>;
  readonly run: (state: Harness) => Promise<RecoveryKeyEpochResult>;
};

const seedUnreadablePointer = (store: SqliteEventStore): void => {
  const bytes = new TextEncoder().encode(JSON.stringify({ drifted: true }));
  const aggregateId = keyEpochAggregateId(PROJECT_ID, RESTORE_COMMAND_ID);
  store.commitExpectedVersionDecision({
    commandKind: RECOVERY_KEY_EPOCH_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: CORRELATION_ID,
    decidedAt: AT,
    events: [{ eventId: `${aggregateId}:0:advanced`, eventType: "RecoveryKeyEpochAdvanced", payload: bytes }],
    expectedVersion: 0,
    key: { commandId: `${aggregateId}:0`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: bytes,
    targetAggregateId: aggregateId,
  });
};

const seedDanglingPointer = (store: SqliteEventStore): void => {
  const bytes = encodeKeyEpochPointer({
    generation: 0,
    headIncarnationRef: UNANCHORED_REF,
    originIncarnationRef: UNANCHORED_REF,
    restoreCommandId: RESTORE_COMMAND_ID,
    schemaVersion: RECOVERY_KEY_EPOCH_SCHEMA_VERSION,
  });
  const aggregateId = keyEpochAggregateId(PROJECT_ID, RESTORE_COMMAND_ID);
  store.commitExpectedVersionDecision({
    commandKind: RECOVERY_KEY_EPOCH_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: CORRELATION_ID,
    decidedAt: AT,
    events: [{ eventId: `${aggregateId}:0:advanced`, eventType: "RecoveryKeyEpochAdvanced", payload: bytes }],
    expectedVersion: 0,
    key: { commandId: `${aggregateId}:0`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: bytes,
    targetAggregateId: aggregateId,
  });
};

/** Establishes a real epoch, then crosses the connection boundary a restart crosses. */
const coldStartThenRestart = async (state: Harness): Promise<void> => {
  opened(await open(state.store));
  state.reopen();
};

const INJECTIONS: readonly Injection[] = Object.freeze([
  {
    name: "input names a predecessor the provider must never accept",
    run: ({ store }): Promise<RecoveryKeyEpochResult> =>
      open(store, { predecessorIncarnationRef: UNANCHORED_REF }),
  },
  {
    name: "the host offers no protection mechanism",
    run: ({ store }): Promise<RecoveryKeyEpochResult> =>
      open(store, {}, fakePort(() => Promise.resolve(protectionUnavailable("OTHER")))),
  },
  {
    name: "protection was applied but did not prove itself on read-back",
    run: ({ store }): Promise<RecoveryKeyEpochResult> =>
      open(store, {}, fakePort(() => Promise.resolve(protectionUnverifiable("win32")))),
  },
  {
    name: "the protection port throws instead of answering",
    run: ({ store }): Promise<RecoveryKeyEpochResult> =>
      open(store, {}, fakePort(() => {
        throw new Error("icacls is not on this host");
      })),
  },
  {
    arrange: ({ store }): Promise<void> => Promise.resolve(seedUnreadablePointer(store)),
    name: "a durable pointer exists but has drifted",
    run: ({ store }): Promise<RecoveryKeyEpochResult> => open(store),
  },
  {
    arrange: ({ store }): Promise<void> => Promise.resolve(seedDanglingPointer(store)),
    name: "the pointer names a head nothing ever anchored",
    run: ({ store }): Promise<RecoveryKeyEpochResult> => open(store),
  },
  {
    arrange: coldStartThenRestart,
    name: "the anchored predecessor does not prove itself",
    run: ({ store }): Promise<RecoveryKeyEpochResult> =>
      open(store, {}, fakePort(), wrapCrypto({ verify: () => Promise.resolve(false) })),
  },
  {
    arrange: coldStartThenRestart,
    name: "the successor key epoch cannot be minted",
    run: ({ store }): Promise<RecoveryKeyEpochResult> =>
      open(store, {}, fakePort(), wrapCrypto({
        generateSigningKey: () => Promise.reject(new Error("no key epoch")),
      })),
  },
]);

const EXPECTED_ANSWERS: readonly string[] = Object.freeze([
  "RECOVERY_KEY_PROVIDER/RECOVERY_KEY_EPOCH_INPUT_INVALID",
  "RECOVERY_KEY_PROVIDER/RECOVERY_KEY_PROTECTION_UNAVAILABLE",
  "RECOVERY_KEY_PROVIDER/RECOVERY_KEY_PROTECTION_UNVERIFIABLE",
  "RECOVERY_KEY_PROVIDER/RECOVERY_KEY_PROTECTION_UNAVAILABLE",
  "RECOVERY_KEY_PROVIDER/RECOVERY_KEY_EPOCH_POINTER_UNREADABLE",
  "RECOVERY_SUCCESSION/RECOVERY_PREDECESSOR_NOT_FOUND",
  "RECOVERY_SUCCESSION/RECOVERY_PREDECESSOR_UNVERIFIABLE",
  "RECOVERY_SUCCESSION/RECOVERY_SUCCESSION_PROOF_UNAVAILABLE",
]);

describe("every declared failure injection refuses with its own code and layer", () => {
  it("generates all eight cases and writes nothing on any of them", async () => {
    // Hand-written, not derived from INJECTIONS.length: a table that counts
    // itself cannot notice an entry that stopped being generated.
    expect(INJECTIONS).toHaveLength(8);
    const answers: string[] = [];
    const generated: string[] = [];
    for (const injection of INJECTIONS) {
      const state = harness();
      await injection.arrange?.(state);
      const before = decisionCount(state.store);
      const result = await injection.run(state);
      answers.push(answerOf(result));
      generated.push(injection.name);
      // Nothing new is written on a refusal — not an anchor, not a pointer,
      // not a succession row — so a refused open leaves no authority behind.
      expect(decisionCount(state.store)).toBe(before);
    }
    expect(generated).toEqual(INJECTIONS.map((injection) => injection.name));
    expect(answers).toHaveLength(8);
    expect(answers).toEqual(EXPECTED_ANSWERS);
    // Seven distinct answers over eight cases: only the two protection-unavailable
    // arms may coincide, and this pins that no third case has joined them.
    expect(new Set(answers).size).toBe(7);
  });
});

/**
 * Every readable byte the provider made durable — decision results and event
 * payloads — read back out of the store. Built from the production rows rather
 * than from a shape constructed here, because a test that inspects its own
 * object learns nothing about what was written. (Request bytes are not part of
 * `CommandDecisionRecord`; the store publishes only their digest, so they cannot
 * be read back and are not claimed to be covered.)
 */
const durableCorpus = (store: SqliteEventStore): string => {
  const decoder = new TextDecoder();
  return [
    ...store.readCommandDecisionsAfter(0n, 1000).items.map((d) => decoder.decode(d.resultBytes)),
    ...store.readEventsAfter(0n, 1000).items.map((event) => decoder.decode(event.payload)),
  ].join("\n");
};

/** DER prefix of a PKCS8-wrapped Ed25519 private key, hex-encoded. */
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const HEX_RUN = /[0-9a-f]{64,}/g;

describe("no private key material reaches anything durable", () => {
  it("keeps the handle non-enumerable and out of every committed byte", async () => {
    const state = harness();
    const first = opened(await open(state.store));
    // Reopened too, so the corpus includes the succession record and the second
    // anchor — the rows a cold start alone would never produce.
    const second = opened(await open(state.reopen()));

    for (const epoch of [first, second]) {
      const descriptor = Object.getOwnPropertyDescriptor(epoch, "keyHandle");
      expect(descriptor?.enumerable).toBe(false);
      expect(typeof epoch.keyHandle).toBe("object");
      expect(Object.keys(JSON.parse(JSON.stringify(epoch)) as object)).not.toContain("keyHandle");
    }

    const durable = durableCorpus(state.store);
    expect(durable).toContain(first.publicKeySpkiHex);
    expect(durable).toContain(second.publicKeySpkiHex);
    expect(durable).not.toContain("PRIVATE KEY");
    expect(durable).not.toContain(PKCS8_ED25519_PREFIX);
    // `"d":` is the JWK private scalar; the leading quote keeps it from matching
    // the tail of a legitimate key such as `backupGenerationDigest":`.
    for (const forbidden of ["privateKey", "keyHandle", "pkcs8", '"d":']) {
      expect(durable).not.toContain(forbidden);
    }

    // Structural, not just name-based: every long hex run the provider wrote
    // must decode to a 32-byte digest, a 44-byte Ed25519 SPKI or a 64-byte
    // Ed25519 signature. A PKCS8 Ed25519 private key is 48 bytes and would
    // introduce a fourth length, so smuggling one in cannot stay invisible.
    const lengths = [...durable.matchAll(HEX_RUN)].map((match) => match[0].length / 2);
    expect(lengths.length).toBeGreaterThan(0);
    expect([...new Set(lengths)].sort((left, right) => left - right)).toEqual([32, 44, 64]);
  });
});
