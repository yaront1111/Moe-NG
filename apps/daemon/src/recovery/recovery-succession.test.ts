import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionResponse, CommitExpectedVersionDecisionInput } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeRecoveryCryptoPort } from "./recovery-incarnation.node.js";
import { createRecoveryIncarnationService } from "./recovery-incarnation.js";
import type {
  RecoveryIncarnationBinding,
  RecoveryIncarnationCryptoPort,
  RecoveryIncarnationKeyHandle,
} from "./recovery-incarnation-contract.js";
import { anchorIncarnation, readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import {
  RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND,
  RECOVERY_SUCCESSION_COMMAND_KIND,
  RECOVERY_SUCCESSION_ERROR_CODES,
  RECOVERY_SUCCESSION_LAYER,
  RECOVERY_SUCCESSION_SCHEMA_VERSION,
  successionAggregateId,
} from "./recovery-succession-contract.js";
import type {
  RecoverySuccessionErrorCode,
  RecoverySuccessionRecord,
  RecoverySuccessionResult,
} from "./recovery-succession-contract.js";
import { createRecoverySuccessionService, readSuccessionChain } from "./recovery-succession.js";

const PROJECT_ID = "project-recovery-succession";
const GENERATION_DIGEST = "9c".repeat(32);
const AT = "2026-08-09T00:00:00.000Z";

const directories: string[] = [];
const stores: SqliteEventStore[] = [];

/**
 * A real SQLite file, never an in-memory double, because DoD 1 and task rail 5
 * are satisfied only by crossing a connection boundary: `reopen` closes the
 * handle and opens the same path again, which is the closest a test gets to the
 * daemon dying and starting back up.
 */
interface Harness {
  readonly path: string;
  store: SqliteEventStore;
  reopen: () => SqliteEventStore;
}

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "moe-succession-"));
  directories.push(directory);
  const path = join(directory, "store.sqlite");
  const opened = SqliteEventStore.openForProject(path, PROJECT_ID);
  stores.push(opened);
  const state: Harness = {
    path,
    store: opened,
    reopen: (): SqliteEventStore => {
      // Closed first: Windows will not reopen a SQLite file that still has a
      // live handle, and a "reopen" that reused the handle would prove nothing.
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
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      /* a test may have closed it already */
    }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
  }
});

interface Incarnation {
  readonly binding: RecoveryIncarnationBinding;
  readonly keyHandle: RecoveryIncarnationKeyHandle;
}

/**
 * Every incarnation in this suite is minted by the PRODUCTION mint service, so
 * no fixture hand-forges a binding the succession service would be free to
 * disagree with. Each call takes a fresh service because the mint memoizes per
 * restore command within a process — a second hop is a second process.
 */
async function mint(
  port: RecoveryIncarnationCryptoPort,
  restoreCommandId: string,
): Promise<Incarnation> {
  const minted = await createRecoveryIncarnationService(port).mint({
    backupGenerationDigest: GENERATION_DIGEST,
    restoreCommandId,
  });
  if (!minted.ok) throw new Error(`the fixture mint must succeed: ${minted.code}`);
  return { binding: minted.binding, keyHandle: minted.keyHandle };
}

const anchorRequest = Object.freeze({
  correlationId: "corr-anchor",
  decidedAt: AT,
  principalId: "daemon-1",
  projectId: PROJECT_ID,
});

function successionRequest(
  predecessorIncarnationRef: string,
  restoreCommandId: string,
): Record<string, unknown> {
  return {
    backupGenerationDigest: GENERATION_DIGEST,
    correlationId: "corr-succeed",
    decidedAt: AT,
    predecessorIncarnationRef,
    principalId: "daemon-1",
    projectId: PROJECT_ID,
    restoreCommandId,
  };
}

/** Flips one hex nibble: still well-formed hex, no longer the same signature. */
function flipHex(hex: string): string {
  const head = hex.slice(0, 1);
  return `${head === "0" ? "1" : "0"}${hex.slice(1)}`;
}

/**
 * Signs the mint challenge and then refuses, so the SUCCESSOR exists but cannot
 * prove the succession statement. A port that failed on the first call would
 * only re-test the mint service's own refusal.
 */
function refusingSecondSignPort(): RecoveryIncarnationCryptoPort {
  const real = createNodeRecoveryCryptoPort();
  let signs = 0;
  return Object.freeze({
    ...real,
    sign: (handle: RecoveryIncarnationKeyHandle, message: Uint8Array): Promise<Uint8Array> => {
      signs += 1;
      if (signs > 1) return Promise.reject(new Error("hardware signing module is offline"));
      return real.sign(handle, message);
    },
  });
}

/**
 * A provider that answers a verification with a TRUTHY NON-BOOLEAN after
 * `realCalls` honest answers. Production compares with `!== true`, so this must
 * never be read as a proof; a falsiness check would admit it.
 *
 * The count is how the case selects which verification to poison: inside
 * `succeed` the calls are, in order, the predecessor check, the mint's own
 * self-proof, then the succession self-proof.
 */
function truthyVerifyPort(realCalls: number): RecoveryIncarnationCryptoPort {
  const real = createNodeRecoveryCryptoPort();
  let calls = 0;
  return Object.freeze({
    ...real,
    verify: (
      publicKeySpki: Uint8Array,
      message: Uint8Array,
      signature: Uint8Array,
    ): Promise<boolean> => {
      calls += 1;
      // The cast IS the case: a hostile port is not bound by the declared type,
      // and the whole point is that production must refuse this value anyway.
      if (calls > realCalls) return Promise.resolve("verified" as unknown as boolean);
      return real.verify(publicKeySpki, message, signature);
    },
  });
}

/**
 * Simulates the exact race `expectedVersion: 0` exists to lose: another writer
 * anchors the same incarnation between this caller's read and its write. The
 * pre-commit goes through the REAL store, so the conflict the service then sees
 * is the store's own answer rather than a hand-forged decision record.
 */
function preemptedAnchorStore(store: SqliteEventStore): SqliteEventStore {
  const commit = (input: CommitExpectedVersionDecisionInput): CommandDecisionResponse => {
    if (input.commandKind === RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND) {
      store.commitExpectedVersionDecision({
        ...input,
        key: { ...input.key, commandId: `${input.key.commandId}:preempted` },
      });
    }
    return store.commitExpectedVersionDecision(input);
  };
  return new Proxy(store, {
    get: (target, property): unknown => {
      if (property === "commitExpectedVersionDecision") return commit;
      // Read with the TARGET as receiver and bind to it: SqliteEventStore holds
      // private class fields, and a method invoked with the proxy as `this`
      // cannot reach them.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function succeedFrom(
  store: SqliteEventStore,
  predecessorIncarnationRef: string,
  restoreCommandId: string,
  port: RecoveryIncarnationCryptoPort = createNodeRecoveryCryptoPort(),
): Promise<RecoverySuccessionResult> {
  return createRecoverySuccessionService(port).succeed(
    store,
    successionRequest(predecessorIncarnationRef, restoreCommandId),
  );
}

interface RefusalCase {
  readonly name: string;
  readonly code: RecoverySuccessionErrorCode;
  readonly run: (state: Harness) => Promise<RecoverySuccessionResult>;
}

/**
 * One entry per refusal the succession service can produce, and every stable
 * code appears at least once. `RECOVERY_PREDECESSOR_UNVERIFIABLE` earns three
 * entries because it has three genuinely different causes and a single one would
 * leave two guards untested behind a code that already passed.
 */
const REFUSAL_CASES: readonly RefusalCase[] = [
  {
    code: "RECOVERY_SUCCESSION_INPUT_INVALID",
    name: "a request carrying an undeclared key",
    run: async (state) => {
      const port = createNodeRecoveryCryptoPort();
      const origin = await mint(port, "restore-origin");
      anchorIncarnation(state.store, anchorRequest, origin.binding);
      return createRecoverySuccessionService(port).succeed(state.store, {
        ...successionRequest(origin.binding.incarnationRef, "restore-resume"),
        nonce: "caller-supplied",
      });
    },
  },
  {
    code: "RECOVERY_PREDECESSOR_NOT_FOUND",
    name: "a genuine, self-proving predecessor that was never anchored",
    run: async (state) => {
      const port = createNodeRecoveryCryptoPort();
      const unanchored = await mint(port, "restore-origin");
      return succeedFrom(state.store, unanchored.binding.incarnationRef, "restore-resume", port);
    },
  },
  {
    code: "RECOVERY_PREDECESSOR_NOT_FOUND",
    name: "a predecessor reference that names nothing at all",
    run: async (state) => succeedFrom(state.store, `${"ab".repeat(32)}`, "restore-resume"),
  },
  {
    code: "RECOVERY_PREDECESSOR_UNVERIFIABLE",
    name: "an anchored predecessor whose signature has one flipped nibble",
    run: async (state) => {
      const port = createNodeRecoveryCryptoPort();
      const origin = await mint(port, "restore-origin");
      const tampered: RecoveryIncarnationBinding = {
        ...origin.binding,
        proof: {
          ...origin.binding.proof,
          signatureHex: flipHex(origin.binding.proof.signatureHex),
        },
      };
      anchorIncarnation(state.store, anchorRequest, tampered);
      return succeedFrom(state.store, tampered.incarnationRef, "restore-resume", port);
    },
  },
  {
    code: "RECOVERY_PREDECESSOR_UNVERIFIABLE",
    name: "an anchored predecessor whose own proof no longer covers its binding digest",
    run: async (state) => {
      const port = createNodeRecoveryCryptoPort();
      const origin = await mint(port, "restore-origin");
      // The proof is untouched and still verifies perfectly under this binding's
      // own key. Only recomputing digestOf("challenge", bindingDigest) catches
      // that it is now attached to a statement it never signed.
      const tampered: RecoveryIncarnationBinding = {
        ...origin.binding,
        bindingDigest: flipHex(origin.binding.bindingDigest),
      };
      anchorIncarnation(state.store, anchorRequest, tampered);
      return succeedFrom(state.store, tampered.incarnationRef, "restore-resume", port);
    },
  },
  {
    code: "RECOVERY_PREDECESSOR_UNVERIFIABLE",
    name: "an anchored predecessor whose fingerprint does not cover its published key",
    run: async (state) => {
      const port = createNodeRecoveryCryptoPort();
      const origin = await mint(port, "restore-origin");
      const tampered: RecoveryIncarnationBinding = {
        ...origin.binding,
        verificationKeyFingerprint: flipHex(origin.binding.verificationKeyFingerprint),
      };
      anchorIncarnation(state.store, anchorRequest, tampered);
      return succeedFrom(state.store, tampered.incarnationRef, "restore-resume", port);
    },
  },
  {
    code: "RECOVERY_PREDECESSOR_UNVERIFIABLE",
    name: "a port answering the predecessor check with a truthy non-boolean",
    run: async (state) => {
      const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
      anchorIncarnation(state.store, anchorRequest, origin.binding);
      return succeedFrom(
        state.store,
        origin.binding.incarnationRef,
        "restore-resume",
        truthyVerifyPort(0),
      );
    },
  },
  {
    code: "RECOVERY_SUCCESSION_PROOF_UNAVAILABLE",
    name: "a port answering the successor's self-proof with a truthy non-boolean",
    run: async (state) => {
      const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
      anchorIncarnation(state.store, anchorRequest, origin.binding);
      return succeedFrom(
        state.store,
        origin.binding.incarnationRef,
        "restore-resume",
        truthyVerifyPort(2),
      );
    },
  },
  {
    code: "RECOVERY_SUCCESSION_ALREADY_RECORDED",
    name: "a second succession claimed from one predecessor",
    run: async (state) => {
      const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
      anchorIncarnation(state.store, anchorRequest, origin.binding);
      const first = await succeedFrom(state.store, origin.binding.incarnationRef, "restore-resume");
      expect(first.ok).toBe(true);
      return succeedFrom(state.store, origin.binding.incarnationRef, "restore-resume-rival");
    },
  },
  {
    code: "RECOVERY_SUCCESSION_PROOF_UNAVAILABLE",
    name: "a successor that cannot sign the succession statement",
    run: async (state) => {
      const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
      anchorIncarnation(state.store, anchorRequest, origin.binding);
      return succeedFrom(
        state.store,
        origin.binding.incarnationRef,
        "restore-resume",
        refusingSecondSignPort(),
      );
    },
  },
  {
    code: "RECOVERY_INCARNATION_ANCHOR_UNAVAILABLE",
    name: "a successor whose anchor is taken by a concurrent writer",
    run: async (state) => {
      const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
      anchorIncarnation(state.store, anchorRequest, origin.binding);
      return succeedFrom(
        preemptedAnchorStore(state.store),
        origin.binding.incarnationRef,
        "restore-resume",
      );
    },
  },
];

/** Every key name that may appear anywhere in a persisted succession record. */
const PERSISTED_KEYS = Object.freeze([
  "challengeDigest",
  "predecessorBindingDigest",
  "predecessorIncarnationRef",
  "predecessorKeyEpochRef",
  "predecessorVerificationKeyFingerprint",
  "proof",
  "restoreCommandId",
  "schemaVersion",
  "signatureHex",
  "successionDigest",
  "successorBindingDigest",
  "successorIncarnationRef",
  "successorKeyEpochRef",
  "verified",
]);

/** Every key name that may appear anywhere in a persisted incarnation anchor. */
const ANCHORED_KEYS = Object.freeze([
  "backupGenerationDigest",
  "bindingDigest",
  "challengeDigest",
  "incarnationDigest",
  "incarnationRef",
  "keyEpochRef",
  "proof",
  "publicKeyAlgorithm",
  "publicKeySpkiHex",
  "restoreCommandId",
  "schemaVersion",
  "signatureHex",
  "verificationKeyFingerprint",
  "verified",
]);

function keysOf(value: unknown, into: Set<string>): Set<string> {
  if (value === null || typeof value !== "object") return into;
  for (const [key, nested] of Object.entries(value)) {
    into.add(key);
    keysOf(nested, into);
  }
  return into;
}

/** Writes a succession row past the service, to seed durable state it refuses to create. */
function writeRogueSuccession(store: SqliteEventStore, record: RecoverySuccessionRecord): void {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  store.commitExpectedVersionDecision({
    commandKind: RECOVERY_SUCCESSION_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: "corr-rogue",
    decidedAt: AT,
    events: [
      {
        eventId: `rogue:${record.successorIncarnationRef}`,
        eventType: "RecoverySuccessionRecorded",
        payload: bytes,
      },
    ],
    expectedVersion: 0,
    key: {
      commandId: `rogue:${record.predecessorIncarnationRef}`,
      principalId: "daemon-1",
      projectId: PROJECT_ID,
    },
    requestBytes: bytes,
    targetAggregateId: successionAggregateId(record.predecessorIncarnationRef),
  });
}

function persistedBytes(store: SqliteEventStore, commandKind: string): readonly Uint8Array[] {
  const found: Uint8Array[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 50);
    for (const decision of page.items) {
      if (decision.commandKind !== commandKind) continue;
      if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      found.push(decision.resultBytes);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return found;
}

describe("recovery succession refusals", () => {
  it("sweeps a non-empty case table covering every stable code exactly", () => {
    expect(REFUSAL_CASES.length).toBe(11);
    expect(REFUSAL_CASES.length).toBeGreaterThan(0);
    expect([...new Set(REFUSAL_CASES.map((entry) => entry.code))].sort()).toEqual(
      [...RECOVERY_SUCCESSION_ERROR_CODES].sort(),
    );
  });

  for (const entry of REFUSAL_CASES) {
    it(`refuses ${entry.name} with ${entry.code} at the succession layer`, async () => {
      const result = await entry.run(harness());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable: the refusal branch was asserted above");
      expect(result.code).toBe(entry.code);
      expect(result.layer).toBe(RECOVERY_SUCCESSION_LAYER);
      expect(result.outcome).toBe("REFUSED");
      expect(result.truth).toBe("UNKNOWN");
      expect(result.authority).toBe("NONE");
    });
  }

  it("keeps a provider diagnostic out of the refusal it produces", async () => {
    const state = harness();
    const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    anchorIncarnation(state.store, anchorRequest, origin.binding);
    const result = await succeedFrom(
      state.store,
      origin.binding.incarnationRef,
      "restore-resume",
      refusingSecondSignPort(),
    );
    if (result.ok) throw new Error("a port that cannot sign must not produce a record");
    expect(result.reason).not.toContain("hardware signing module");
  });
});

describe("recovery succession durability", () => {
  it("records a succession that survives closing and reopening the store", async () => {
    const state = harness();
    const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    expect(anchorIncarnation(state.store, anchorRequest, origin.binding)).toBe(true);

    const recorded = await succeedFrom(
      state.store,
      origin.binding.incarnationRef,
      "restore-resume",
    );
    if (!recorded.ok) throw new Error(`the succession must be recorded: ${recorded.code}`);
    expect(recorded.record.schemaVersion).toBe(RECOVERY_SUCCESSION_SCHEMA_VERSION);
    expect(recorded.record.predecessorIncarnationRef).toBe(origin.binding.incarnationRef);
    expect(recorded.record.predecessorBindingDigest).toBe(origin.binding.bindingDigest);
    expect(recorded.record.successorIncarnationRef).not.toBe(origin.binding.incarnationRef);
    expect(recorded.record.proof.verified).toBe(true);

    const reopened = state.reopen();
    const chain = readSuccessionChain(reopened, PROJECT_ID, recorded.record.successorIncarnationRef);
    if (!chain.ok) throw new Error(`the chain must be readable after a restart: ${chain.code}`);
    expect(chain.links.map((link) => link.successionDigest)).toEqual([
      recorded.record.successionDigest,
    ]);
    expect(chain.originIncarnationRef).toBe(origin.binding.incarnationRef);
    expect(chain.restoreCommandId).toBe("restore-origin");
  });

  it("anchors an incarnation whose binding reads back byte-identical after a restart", async () => {
    const state = harness();
    const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    expect(anchorIncarnation(state.store, anchorRequest, origin.binding)).toBe(true);

    const reopened = state.reopen();
    const read = readAnchoredIncarnation(reopened, PROJECT_ID, origin.binding.incarnationRef);
    expect(read).toEqual(origin.binding);
    expect(readAnchoredIncarnation(reopened, PROJECT_ID, "no-such-incarnation")).toBeNull();
  });

  it("rebuilds a two-crash chain from durable records alone", async () => {
    const state = harness();
    // Process 1: the interrupted restore. Nothing succeeds it yet.
    const a = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    expect(anchorIncarnation(state.store, anchorRequest, a.binding)).toBe(true);

    // Process 2, after the first crash.
    const afterFirstCrash = state.reopen();
    const first = await succeedFrom(afterFirstCrash, a.binding.incarnationRef, "restore-resume-1");
    if (!first.ok) throw new Error(`the first hop must be recorded: ${first.code}`);

    // Process 3, after the second crash: succeeding the SUCCESSOR only works
    // because hop one anchored it as an incarnation in its own right.
    const afterSecondCrash = state.reopen();
    const second = await succeedFrom(
      afterSecondCrash,
      first.record.successorIncarnationRef,
      "restore-resume-2",
    );
    if (!second.ok) throw new Error(`the second hop must be recorded: ${second.code}`);

    const reopened = state.reopen();
    const chain = readSuccessionChain(
      reopened,
      PROJECT_ID,
      second.record.successorIncarnationRef,
    );
    if (!chain.ok) throw new Error(`the two-hop chain must rebuild: ${chain.code}`);
    expect(chain.links.map((link) => link.predecessorIncarnationRef)).toEqual([
      first.record.successorIncarnationRef,
      a.binding.incarnationRef,
    ]);
    expect(chain.originIncarnationRef).toBe(a.binding.incarnationRef);
    // Read from the anchored ORIGIN binding, not from the newest record: a
    // scheme that only handles one hop cannot produce this command id.
    expect(chain.restoreCommandId).toBe("restore-origin");
  });

  it("reports an anchored origin with no successor as a chain of length zero", async () => {
    const state = harness();
    const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    anchorIncarnation(state.store, anchorRequest, origin.binding);

    const chain = readSuccessionChain(state.reopen(), PROJECT_ID, origin.binding.incarnationRef);
    if (!chain.ok) throw new Error(`an origin is a valid chain: ${chain.code}`);
    expect(chain.links).toEqual([]);
    expect(chain.originIncarnationRef).toBe(origin.binding.incarnationRef);
    expect(chain.restoreCommandId).toBe("restore-origin");
  });

  it("refuses a cyclic durable chain instead of walking it forever", async () => {
    const state = harness();
    const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    anchorIncarnation(state.store, anchorRequest, origin.binding);
    const forward = await succeedFrom(
      state.store,
      origin.binding.incarnationRef,
      "restore-resume",
    );
    if (!forward.ok) throw new Error(`the setup succession must be recorded: ${forward.code}`);

    // ONE BAD ROW, written straight past the service: the successor is recorded
    // as succeeding its own predecessor. The single-shot write cannot produce
    // this, which is exactly why the READ path must not assume it cannot exist —
    // without the visited set this call never returns.
    writeRogueSuccession(state.store, {
      ...forward.record,
      predecessorIncarnationRef: forward.record.successorIncarnationRef,
      successorIncarnationRef: forward.record.predecessorIncarnationRef,
    });

    const chain = readSuccessionChain(
      state.reopen(),
      PROJECT_ID,
      forward.record.successorIncarnationRef,
    );
    expect(chain.ok).toBe(false);
    if (chain.ok) throw new Error("unreachable: the refusal branch was asserted above");
    expect(chain.code).toBe("RECOVERY_SUCCESSION_ALREADY_RECORDED");
    expect(chain.layer).toBe(RECOVERY_SUCCESSION_LAYER);
  });

  it("does not walk a durable row whose refs are not digests", async () => {
    const state = harness();
    const a = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    const b = await mint(createNodeRecoveryCryptoPort(), "restore-resume");
    anchorIncarnation(state.store, anchorRequest, a.binding);
    anchorIncarnation(state.store, anchorRequest, b.binding);

    // A row linking two genuinely anchored incarnations, but one digest field is
    // corrupt. Checking only the KEY SET would admit it and the walk would then
    // report a lineage nobody ever proved.
    writeRogueSuccession(state.store, {
      predecessorBindingDigest: a.binding.bindingDigest,
      predecessorIncarnationRef: a.binding.incarnationRef,
      predecessorKeyEpochRef: a.binding.keyEpochRef,
      predecessorVerificationKeyFingerprint: a.binding.verificationKeyFingerprint,
      proof: { challengeDigest: "ff".repeat(32), signatureHex: "ab".repeat(64), verified: true },
      restoreCommandId: "restore-resume",
      schemaVersion: RECOVERY_SUCCESSION_SCHEMA_VERSION,
      successionDigest: "NOT-A-DIGEST",
      successorBindingDigest: b.binding.bindingDigest,
      successorIncarnationRef: b.binding.incarnationRef,
      successorKeyEpochRef: b.binding.keyEpochRef,
    });

    const chain = readSuccessionChain(state.reopen(), PROJECT_ID, b.binding.incarnationRef);
    if (!chain.ok) throw new Error(`an anchored incarnation is a valid chain: ${chain.code}`);
    expect(chain.links).toEqual([]);
    expect(chain.originIncarnationRef).toBe(b.binding.incarnationRef);
    expect(chain.restoreCommandId).toBe("restore-resume");
  });

  it("refuses to walk a chain from an incarnation that was never anchored", async () => {
    const state = harness();
    const unanchored = await mint(createNodeRecoveryCryptoPort(), "restore-origin");

    const chain = readSuccessionChain(state.store, PROJECT_ID, unanchored.binding.incarnationRef);
    expect(chain.ok).toBe(false);
    if (chain.ok) throw new Error("unreachable: the refusal branch was asserted above");
    expect(chain.code).toBe("RECOVERY_PREDECESSOR_NOT_FOUND");
    expect(chain.layer).toBe(RECOVERY_SUCCESSION_LAYER);
  });
});

describe("recovery succession durable bytes", () => {
  it("persists no key handle and no key material of any kind", async () => {
    const state = harness();
    const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    anchorIncarnation(state.store, anchorRequest, origin.binding);
    const recorded = await succeedFrom(
      state.store,
      origin.binding.incarnationRef,
      "restore-resume",
    );
    if (!recorded.ok) throw new Error(`the succession must be recorded: ${recorded.code}`);

    // Read the BYTES back out of a reopened store. Non-enumerability is not the
    // question; what survives serialization is.
    const reopened = state.reopen();
    const persisted = persistedBytes(reopened, RECOVERY_SUCCESSION_COMMAND_KIND);
    expect(persisted).toHaveLength(1);
    const text = new TextDecoder().decode(persisted[0]);
    const parsed: unknown = JSON.parse(text);

    expect([...keysOf(parsed, new Set<string>())].sort()).toEqual([...PERSISTED_KEYS].sort());
    for (const banned of ["keyHandle", "privateKey", "pkcs8", "secret", "publicKeySpkiHex"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("persists no key handle in the anchor rows either", async () => {
    // DoD 3 says EVERY durable artifact, and a succession writes two kinds of
    // row. The anchor carries the PUBLIC SPKI by design — that is the key a
    // later process verifies against — so this asserts the exact binding key
    // set rather than banning the word "key".
    const state = harness();
    const origin = await mint(createNodeRecoveryCryptoPort(), "restore-origin");
    anchorIncarnation(state.store, anchorRequest, origin.binding);
    const recorded = await succeedFrom(
      state.store,
      origin.binding.incarnationRef,
      "restore-resume",
    );
    if (!recorded.ok) throw new Error(`the succession must be recorded: ${recorded.code}`);

    const anchors = persistedBytes(state.reopen(), RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND);
    // Two: the origin, and the successor anchored before the succession.
    expect(anchors).toHaveLength(2);
    for (const bytes of anchors) {
      const text = new TextDecoder().decode(bytes);
      expect([...keysOf(JSON.parse(text), new Set<string>())].sort()).toEqual(
        [...ANCHORED_KEYS].sort(),
      );
      for (const banned of ["keyHandle", "privateKey", "pkcs8", "secret"]) {
        expect(text).not.toContain(banned);
      }
    }
  });
});
