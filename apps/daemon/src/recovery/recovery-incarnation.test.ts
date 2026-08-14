/**
 * Fresh recovery incarnation and signing-key epoch.
 *
 * Everything here drives the PRODUCTION root (`@moe/daemon`), never a local
 * reimplementation, because a property asserted against a test helper proves
 * only that the helper agrees with itself.
 */
import { createHash, createPublicKey, verify as nodeVerify, webcrypto } from "node:crypto";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  RECOVERY_INCARNATION_ERROR_CODES,
  RECOVERY_INCARNATION_SCHEMA_VERSION,
  createNodeRecoveryCryptoPort,
  createRecoveryIncarnationService,
} from "@moe/daemon";
import type {
  RecoveryIncarnationBinding,
  RecoveryIncarnationCryptoPort,
  RecoveryIncarnationErrorCode,
  RecoveryIncarnationKeyPair,
  RecoveryIncarnationMinted,
  RecoveryIncarnationProof,
  RecoveryIncarnationRefused,
  RecoveryIncarnationRequest,
  RecoveryIncarnationResult,
} from "@moe/daemon";
import { decodeBinding, encodeBinding } from "./recovery-incarnation-binding-codec.js";
import {
  mintGenesisIncarnation,
  nodeGenesisCryptoShell,
} from "./recovery-incarnation-genesis.js";
import type {
  GenesisCryptoShell,
  GenesisMintResult,
} from "./recovery-incarnation-genesis.js";
import { digestOf } from "./recovery-incarnation-contract.js";
import type {
  GenesisIncarnationBinding,
  RestoreIncarnationBinding,
} from "./recovery-incarnation-contract.js";
import {
  RECOVERY_INCARNATION_ORIGINS,
  deriveIncarnation,
  snapshotGenesisContext,
  snapshotRestoreContext,
} from "./recovery-incarnation-context.js";
import type { RecoveryIncarnationOrigin } from "./recovery-incarnation-context.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = `${"b".repeat(63)}9`;
const COMMAND_A = "restore-command-alpha";
const COMMAND_B = "restore-command-beta";
const PROJECT = "proj-genesis-alpha";

const restoreContextInput = (): Record<string, unknown> => ({
  backupGenerationDigest: DIGEST_A,
  restoreCommandId: COMMAND_A,
});

const request = (
  restoreCommandId: string = COMMAND_A,
  backupGenerationDigest: string = DIGEST_A,
): RecoveryIncarnationRequest => ({ backupGenerationDigest, restoreCommandId });

const minted = (result: RecoveryIncarnationResult): RecoveryIncarnationMinted => {
  expect(result.ok).toBe(true);
  return result as RecoveryIncarnationMinted;
};

const refused = (result: RecoveryIncarnationResult): RecoveryIncarnationRefused => {
  expect(result.ok).toBe(false);
  return result as RecoveryIncarnationRefused;
};

/** Every refusal shares this envelope; asserting only the code would miss a leak. */
const expectRefusal = (result: RecoveryIncarnationResult, code: RecoveryIncarnationErrorCode) => {
  const value = refused(result);
  expect(value.code).toBe(code);
  expect(value.layer).toBe("RECOVERY_INCARNATION");
  expect(value.truth).toBe("UNKNOWN");
  expect(value.authority).toBe("NONE");
  expect(value.outcome).toBe("REFUSED");
  expect(Object.hasOwn(value, "binding")).toBe(false);
  expect(Object.hasOwn(value, "keyHandle")).toBe(false);
  return value;
};

const bytes = (fill: number, length = 32): Uint8Array => new Uint8Array(length).fill(fill);

const SENTINEL = "SENTINEL-CAUGHT-DIAGNOSTIC-a1b2c3";

interface PortCalls {
  readonly randomBytes: number[];
  generated: number;
  signed: number;
  verified: number;
  destroyed: number;
  verifiedSpki: Uint8Array | null;
  readonly order: string[];
}

interface Ed25519Pair {
  readonly privateKey: webcrypto.CryptoKey;
  readonly publicKey: webcrypto.CryptoKey;
}

/** `generateKey` is typed to return one key OR a pair; narrow rather than cast. */
const generateEd25519 = async (): Promise<Ed25519Pair> => {
  const generated: unknown = await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  if (
    generated === null ||
    typeof generated !== "object" ||
    !("privateKey" in generated) ||
    !("publicKey" in generated)
  ) {
    throw new Error("expected an Ed25519 key pair");
  }
  return generated as Ed25519Pair;
};

interface StubOptions {
  readonly randomBytes?: (byteLength: number, call: number) => unknown;
  readonly generateSigningKey?: (call: number) => unknown;
  readonly sign?: () => unknown;
  readonly verify?: () => unknown;
  readonly destroy?: () => void;
}

/**
 * A deterministic port. The default path is a REAL Ed25519 key from WebCrypto —
 * only the fault rows replace a leg, so a green row cannot pass by never having
 * exercised real crypto at all.
 */
const stubPort = (options: StubOptions = {}): {
  readonly port: RecoveryIncarnationCryptoPort;
  readonly calls: PortCalls;
} => {
  const calls: PortCalls = {
    destroyed: 0,
    generated: 0,
    order: [],
    randomBytes: [],
    signed: 0,
    verified: 0,
    verifiedSpki: null,
  };
  const keys = new WeakMap<object, webcrypto.CryptoKey>();
  const port: RecoveryIncarnationCryptoPort = {
    destroy: (handle) => {
      calls.destroyed += 1;
      calls.order.push("destroy");
      options.destroy?.();
      keys.delete(handle as object);
    },
    generateSigningKey: async (): Promise<RecoveryIncarnationKeyPair> => {
      const call = calls.generated;
      calls.generated += 1;
      calls.order.push("generateSigningKey");
      if (options.generateSigningKey) {
        return (await options.generateSigningKey(call)) as RecoveryIncarnationKeyPair;
      }
      const pair = await generateEd25519();
      const spki = new Uint8Array(await webcrypto.subtle.exportKey("spki", pair.publicKey));
      const handle = Object.freeze({});
      keys.set(handle, pair.privateKey);
      return { algorithm: "Ed25519", handle, publicKeySpki: spki };
    },
    randomBytes: async (byteLength: number): Promise<Uint8Array> => {
      const call = calls.randomBytes.length;
      calls.randomBytes.push(byteLength);
      calls.order.push("randomBytes");
      if (options.randomBytes) return (await options.randomBytes(byteLength, call)) as Uint8Array;
      return bytes(call + 1, byteLength);
    },
    sign: async (handle, message): Promise<Uint8Array> => {
      calls.signed += 1;
      calls.order.push("sign");
      if (options.sign) return (await options.sign()) as Uint8Array;
      const key = keys.get(handle as object);
      if (key === undefined) throw new Error("unknown handle");
      return new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, key, message));
    },
    verify: async (spki, message, signature): Promise<boolean> => {
      calls.verified += 1;
      calls.order.push("verify");
      // Snapshotted on arrival: the assertion is about what the port was HANDED.
      calls.verifiedSpki = Uint8Array.from(spki);
      if (options.verify) return (await options.verify()) as boolean;
      const pub = await webcrypto.subtle.importKey("spki", spki, { name: "Ed25519" }, true, [
        "verify",
      ]);
      return webcrypto.subtle.verify({ name: "Ed25519" }, pub, signature, message);
    },
  };
  return { calls, port };
};

const nodeService = () => createRecoveryIncarnationService(createNodeRecoveryCryptoPort());

describe("recovery incarnation vocabulary", () => {
  it("publishes exactly three closed codes and freezes them", () => {
    expect([...RECOVERY_INCARNATION_ERROR_CODES]).toEqual([
      "RECOVERY_INCARNATION_INPUT_INVALID",
      "RECOVERY_ENTROPY_UNAVAILABLE",
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    ]);
    expect(Object.isFrozen(RECOVERY_INCARNATION_ERROR_CODES)).toBe(true);
    expect(RECOVERY_INCARNATION_SCHEMA_VERSION).toBe("moe-recovery-incarnation/1");
    expectTypeOf<(typeof RECOVERY_INCARNATION_ERROR_CODES)[number]>()
      .toEqualTypeOf<RecoveryIncarnationErrorCode>();
    expectTypeOf<RecoveryIncarnationResult>()
      .toEqualTypeOf<RecoveryIncarnationMinted | RecoveryIncarnationRefused>();
  });
});

/**
 * The request sweep. Rail: a generated case list must assert it generated
 * cases, or a sweep that silently produced nothing passes while testing
 * nothing. The count is pinned BEFORE any behaviour is asserted.
 */
const INVALID_REQUESTS: readonly (readonly [string, unknown])[] = [
  ["null", null],
  ["undefined", undefined],
  ["a string", "restore"],
  ["an array", [COMMAND_A, DIGEST_A]],
  ["a missing command id", { backupGenerationDigest: DIGEST_A }],
  ["a missing digest", { restoreCommandId: COMMAND_A }],
  ["an empty command id", request("")],
  ["a non-string command id", { backupGenerationDigest: DIGEST_A, restoreCommandId: 7 }],
  ["an over-long command id", request("x".repeat(201))],
  ["whitespace in the command id", request("restore command")],
  ["a control character in the command id", request("restore\u0000command")],
  ["a non-NFC command id", request("restoŕe")],
  ["an uppercase digest", request(COMMAND_A, "A".repeat(64))],
  ["a 63-character digest", request(COMMAND_A, "a".repeat(63))],
  ["a 65-character digest", request(COMMAND_A, "a".repeat(65))],
  ["a non-hex digest", request(COMMAND_A, `${"a".repeat(63)}z`)],
  ["a non-string digest", { backupGenerationDigest: 7, restoreCommandId: COMMAND_A }],
  ["a caller-supplied nonce", { ...request(), nonce: "00" }],
  ["a caller-supplied key epoch", { ...request(), keyEpoch: 4 }],
  ["a caller-supplied counter", { ...request(), counter: 1 }],
  ["a caller-supplied timestamp", { ...request(), timestamp: 1_700_000_000_000 }],
  ["a caller-supplied incarnation ref", { ...request(), incarnationRef: "ref" }],
];

describe("request admission refuses before any crypto call", () => {
  it("generated the whole invalid-request matrix", () => {
    expect(INVALID_REQUESTS.length).toBe(22);
  });

  it.each(INVALID_REQUESTS)("refuses %s", async (_label, value) => {
    const { calls, port } = stubPort();
    const result = await createRecoveryIncarnationService(port).mint(value);
    expectRefusal(result, "RECOVERY_INCARNATION_INPUT_INVALID");
    // The point of the ordering claim: nothing reached the CSPRNG.
    expect(calls.order).toEqual([]);
  });

  it("refuses an accessor-backed request rather than reading it twice", async () => {
    const { calls, port } = stubPort();
    let reads = 0;
    const hostile = {
      backupGenerationDigest: DIGEST_A,
      get restoreCommandId(): string {
        reads += 1;
        return reads === 1 ? COMMAND_A : "swapped-after-first-read";
      },
    };
    expectRefusal(
      await createRecoveryIncarnationService(port).mint(hostile),
      "RECOVERY_INCARNATION_INPUT_INVALID",
    );
    expect(calls.order).toEqual([]);
  });

  it("snapshots the request before the first await so later mutation cannot move it", async () => {
    const { port } = stubPort();
    const mutable = { backupGenerationDigest: DIGEST_A, restoreCommandId: COMMAND_A };
    const pending = createRecoveryIncarnationService(port).mint(mutable);
    mutable.restoreCommandId = COMMAND_B;
    mutable.backupGenerationDigest = DIGEST_B;
    const value = minted(await pending);
    expect(value.binding.restoreCommandId).toBe(COMMAND_A);
    expect(value.binding.backupGenerationDigest).toBe(DIGEST_A);
  });
});

describe("minting through the real Node crypto adapter", () => {
  it("binds one restore command to one backup generation and self-proves it", async () => {
    const value = minted(await nodeService().mint(request()));
    const binding: RecoveryIncarnationBinding = value.binding;
    expect(binding.schemaVersion).toBe(RECOVERY_INCARNATION_SCHEMA_VERSION);
    expect(binding.restoreCommandId).toBe(COMMAND_A);
    expect(binding.backupGenerationDigest).toBe(DIGEST_A);
    expect(binding.publicKeyAlgorithm).toBe("Ed25519");
    expect(value.outcome).toBe("MINTED");
    expect(value.authority).toBe("NONE");
    for (const field of [
      binding.incarnationDigest,
      binding.incarnationRef,
      binding.keyEpochRef,
      binding.verificationKeyFingerprint,
      binding.bindingDigest,
      binding.proof.challengeDigest,
    ]) {
      expect(field).toMatch(/^[0-9a-f]{64}$/);
    }
    // A real Ed25519 signature over the canonical challenge, verified through
    // the port before the service was willing to return it.
    expect(binding.proof.signatureHex).toMatch(/^[0-9a-f]{128}$/);
    expect(binding.proof.verified).toBe(true);
    expect(binding.publicKeySpkiHex).toMatch(/^[0-9a-f]{88}$/);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.proof)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("asks the CSPRNG for exactly 32 bytes", async () => {
    const { calls, port } = stubPort();
    minted(await createRecoveryIncarnationService(port).mint(request()));
    expect(calls.randomBytes).toEqual([32]);
  });

  it("gives two restore commands over ONE backup generation distinct identities", async () => {
    const service = nodeService();
    const first = minted(await service.mint(request(COMMAND_A, DIGEST_A)));
    const second = minted(await service.mint(request(COMMAND_B, DIGEST_A)));
    expect(first.binding.backupGenerationDigest).toBe(second.binding.backupGenerationDigest);
    expect(first.binding.incarnationRef).not.toBe(second.binding.incarnationRef);
    expect(first.binding.incarnationDigest).not.toBe(second.binding.incarnationDigest);
    expect(first.binding.keyEpochRef).not.toBe(second.binding.keyEpochRef);
    expect(first.binding.verificationKeyFingerprint)
      .not.toBe(second.binding.verificationKeyFingerprint);
    expect(first.binding.bindingDigest).not.toBe(second.binding.bindingDigest);
  });

  it("does not remint an identical in-process retry", async () => {
    const { calls, port } = stubPort();
    const service = createRecoveryIncarnationService(port);
    const first = minted(await service.mint(request()));
    const second = minted(await service.mint(request()));
    expect(second.binding).toEqual(first.binding);
    expect(calls.randomBytes).toEqual([32]);
    expect(calls.generated).toBe(1);
  });

  it("refuses to rebind one restore command to a second backup generation", async () => {
    const { calls, port } = stubPort();
    const service = createRecoveryIncarnationService(port);
    minted(await service.mint(request(COMMAND_A, DIGEST_A)));
    expectRefusal(
      await service.mint(request(COMMAND_A, DIGEST_B)),
      "RECOVERY_INCARNATION_INPUT_INVALID",
    );
    expect(calls.generated).toBe(1);
  });

  it("serves two concurrent identical mints from one minting, not two", async () => {
    const { calls, port } = stubPort();
    const service = createRecoveryIncarnationService(port);
    const [first, second] = await Promise.all([service.mint(request()), service.mint(request())]);
    expect(minted(second).binding).toEqual(minted(first).binding);
    expect(calls.randomBytes).toEqual([32]);
    expect(calls.generated).toBe(1);
  });
});

const ENTROPY_FAULTS: readonly (readonly [string, StubOptions])[] = [
  ["the CSPRNG throws", { randomBytes: () => { throw new Error(SENTINEL); } }],
  ["the CSPRNG rejects", { randomBytes: () => Promise.reject(new Error(SENTINEL)) }],
  ["the CSPRNG returns a non-Uint8Array", { randomBytes: () => [1, 2, 3] }],
  ["the CSPRNG returns a string", { randomBytes: () => SENTINEL }],
  ["the CSPRNG returns 31 bytes", { randomBytes: () => bytes(1, 31) }],
  ["the CSPRNG returns 33 bytes", { randomBytes: () => bytes(1, 33) }],
  ["the CSPRNG returns null", { randomBytes: () => null }],
];

const KEY_FAULTS: readonly (readonly [string, StubOptions])[] = [
  ["key generation throws", { generateSigningKey: () => { throw new Error(SENTINEL); } }],
  ["key generation rejects", { generateSigningKey: () => Promise.reject(new Error(SENTINEL)) }],
  ["key generation returns null", { generateSigningKey: () => null }],
  [
    "the algorithm is not Ed25519",
    { generateSigningKey: () => ({ algorithm: "RSA", handle: {}, publicKeySpki: bytes(2, 44) }) },
  ],
  [
    "the SPKI is not a Uint8Array",
    { generateSigningKey: () => ({ algorithm: "Ed25519", handle: {}, publicKeySpki: "ff" }) },
  ],
  [
    "the SPKI is empty",
    {
      generateSigningKey: () => ({
        algorithm: "Ed25519",
        handle: {},
        publicKeySpki: new Uint8Array(0),
      }),
    },
  ],
  [
    "the handle is not an object",
    {
      generateSigningKey: () => ({
        algorithm: "Ed25519",
        handle: "handle",
        publicKeySpki: bytes(2, 44),
      }),
    },
  ],
  [
    "the SPKI is absurdly large",
    {
      generateSigningKey: () => ({
        algorithm: "Ed25519",
        handle: {},
        publicKeySpki: bytes(2, 1025),
      }),
    },
  ],
  ["signing throws", { sign: () => { throw new Error(SENTINEL); } }],
  ["signing returns a non-Uint8Array", { sign: () => SENTINEL }],
  ["verification throws", { verify: () => { throw new Error(SENTINEL); } }],
  ["verification returns false", { verify: () => false }],
  ["verification returns a truthy non-boolean", { verify: () => "yes" }],
];

describe("crypto fault matrix", () => {
  it("generated both fault matrices", () => {
    expect(ENTROPY_FAULTS.length).toBe(7);
    expect(KEY_FAULTS.length).toBe(13);
  });

  it.each(ENTROPY_FAULTS)("refuses ENTROPY_UNAVAILABLE when %s", async (_label, options) => {
    const { calls, port } = stubPort(options);
    const result = await createRecoveryIncarnationService(port).mint(request());
    expectRefusal(result, "RECOVERY_ENTROPY_UNAVAILABLE");
    // Ordering claim: entropy is proven before a key is ever generated.
    expect(calls.generated).toBe(0);
  });

  it.each(KEY_FAULTS)("refuses KEY_EPOCH_UNAVAILABLE when %s", async (_label, options) => {
    const { calls, port } = stubPort(options);
    const result = await createRecoveryIncarnationService(port).mint(request());
    expectRefusal(result, "RECOVERY_KEY_EPOCH_UNAVAILABLE");
    expect(calls.randomBytes).toEqual([32]);
  });

  it("never lets a caught diagnostic escape into the refusal", async () => {
    for (const [, options] of [...ENTROPY_FAULTS, ...KEY_FAULTS]) {
      const { port } = stubPort(options);
      const result = await createRecoveryIncarnationService(port).mint(request());
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      expect(JSON.stringify(result)).not.toContain("SENTINEL");
    }
  });

  /**
   * A port that answers with a getter can show one key to the fingerprint and a
   * different one to the published binding. Nothing downstream would notice:
   * both values are well-formed, the signature verifies, and the binding looks
   * complete while its fingerprint covers bytes nobody ever receives.
   */
  it("cannot be shown one public key and then publish another", async () => {
    let reads = 0;
    const { port } = stubPort({
      generateSigningKey: () => ({
        algorithm: "Ed25519",
        handle: {},
        get publicKeySpki(): Uint8Array {
          reads += 1;
          return bytes(reads, 44);
        },
      }),
      sign: () => bytes(8, 64),
      verify: () => true,
    });
    const value = minted(await createRecoveryIncarnationService(port).mint(request()));
    const published = Buffer.from(value.binding.publicKeySpkiHex, "hex");
    expect(value.binding.verificationKeyFingerprint).toBe(
      createHash("sha256")
        .update("moe-recovery-incarnation/1:key\u0000")
        .update(published)
        .digest("hex"),
    );
  });

  /**
   * Without an explicit bound this row still refuses — but only because real
   * WebCrypto rejects the garbage SPKI at verification time. Asserting that
   * nothing was signed pins the refusal to the size check itself, so the row
   * cannot pass for the wrong reason.
   */
  it("refuses an absurd SPKI before it signs anything with it", async () => {
    const { calls, port } = stubPort({
      generateSigningKey: () => ({
        algorithm: "Ed25519",
        handle: {},
        publicKeySpki: bytes(2, 1025),
      }),
    });
    expectRefusal(
      await createRecoveryIncarnationService(port).mint(request()),
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    );
    expect(calls.signed).toBe(0);
    expect(calls.verified).toBe(0);
  });

  /**
   * The port still holds a reference to the array it handed over. If the mint
   * keeps that reference rather than a copy, a port that mutates it in place
   * after the fingerprint is taken gets one set of bytes VERIFIED and a
   * different set PUBLISHED — a binding whose signature covers a key nobody
   * receives. Reading the property once is not enough; the bytes have to be
   * copied.
   */
  it("verifies the exact key bytes it publishes, even if the port mutates its array", async () => {
    const shared = bytes(2, 44);
    const { calls, port } = stubPort({
      generateSigningKey: () => ({ algorithm: "Ed25519", handle: {}, publicKeySpki: shared }),
      // Runs after the mint has read the key and before it verifies.
      sign: () => {
        shared.fill(9);
        return bytes(8, 64);
      },
      verify: () => true,
    });
    const value = minted(await createRecoveryIncarnationService(port).mint(request()));
    expect(calls.verifiedSpki).not.toBeNull();
    expect(Buffer.from(calls.verifiedSpki as Uint8Array).toString("hex"))
      .toBe(value.binding.publicKeySpkiHex);
  });

  it("keeps the primary code when cleanup also fails", async () => {
    const { calls, port } = stubPort({
      destroy: () => { throw new Error(SENTINEL); },
      verify: () => false,
    });
    expectRefusal(
      await createRecoveryIncarnationService(port).mint(request()),
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    );
    expect(calls.destroyed).toBe(1);
  });
});

describe("freshness is proven on the raw material, not on the caller's context", () => {
  it("refuses a repeated CSPRNG block even when the restore command differs", async () => {
    const { calls, port } = stubPort({ randomBytes: () => bytes(9) });
    const service = createRecoveryIncarnationService(port);
    minted(await service.mint(request(COMMAND_A, DIGEST_A)));
    // Different command AND different generation: the derived reference would
    // differ, so only a comparison on the RAW block can catch this.
    expectRefusal(
      await service.mint(request(COMMAND_B, DIGEST_B)),
      "RECOVERY_ENTROPY_UNAVAILABLE",
    );
    expect(calls.generated).toBe(1);
  });

  it("refuses a repeated public key even when the restore command differs", async () => {
    let call = 0;
    const shared = await generateEd25519();
    const spki = new Uint8Array(await webcrypto.subtle.exportKey("spki", shared.publicKey));
    const { port } = stubPort({
      generateSigningKey: () => ({ algorithm: "Ed25519", handle: {}, publicKeySpki: spki }),
      randomBytes: () => { call += 1; return bytes(call); },
      sign: () => bytes(3, 64),
      verify: () => true,
    });
    const service = createRecoveryIncarnationService(port);
    minted(await service.mint(request(COMMAND_A, DIGEST_A)));
    expectRefusal(
      await service.mint(request(COMMAND_B, DIGEST_B)),
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    );
  });

  it("burns a block seen on an attempt that later failed", async () => {
    let call = 0;
    const { port } = stubPort({
      randomBytes: () => bytes(7),
      // First attempt dies at the key leg AFTER the block was reserved.
      generateSigningKey: () => { call += 1; if (call === 1) throw new Error(SENTINEL); return null; },
    });
    const service = createRecoveryIncarnationService(port);
    expectRefusal(
      await service.mint(request(COMMAND_A, DIGEST_A)),
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    );
    expectRefusal(
      await service.mint(request(COMMAND_B, DIGEST_B)),
      "RECOVERY_ENTROPY_UNAVAILABLE",
    );
  });

  it("lets only one of two simultaneous commands claim a repeated block", async () => {
    const { port } = stubPort({ randomBytes: () => bytes(11) });
    const service = createRecoveryIncarnationService(port);
    const results = await Promise.all([
      service.mint(request(COMMAND_A, DIGEST_A)),
      service.mint(request(COMMAND_B, DIGEST_B)),
    ]);
    expect(results.filter((value) => value.ok).length).toBe(1);
    expectRefusal(
      results.find((value) => !value.ok) as RecoveryIncarnationResult,
      "RECOVERY_ENTROPY_UNAVAILABLE",
    );
  });
});

describe("the binding is a pure function of the fresh material and the request", () => {
  /**
   * Two SEPARATE services, so neither carries the other's freshness memory,
   * fed byte-identical entropy and key material. Identical bindings prove the
   * derivation reads no clock, no counter and no ambient state — the only way
   * a timestamp or sequence number could sneak in is if this failed.
   */
  it("derives byte-identical bindings from byte-identical material", async () => {
    const fixed = (): StubOptions => ({
      generateSigningKey: () => ({
        algorithm: "Ed25519",
        handle: {},
        publicKeySpki: bytes(4, 44),
      }),
      randomBytes: () => bytes(17),
      sign: () => bytes(8, 64),
      verify: () => true,
    });
    const first = minted(await createRecoveryIncarnationService(stubPort(fixed()).port).mint(request()));
    const second = minted(await createRecoveryIncarnationService(stubPort(fixed()).port).mint(request()));
    expect(second.binding).toEqual(first.binding);
  });

  it("moves every derived reference when only the backup generation changes", async () => {
    const service = createRecoveryIncarnationService(stubPort().port);
    const first = minted(await service.mint(request(COMMAND_A, DIGEST_A)));
    const second = minted(await service.mint(request(COMMAND_B, DIGEST_B)));
    expect(first.binding.incarnationRef).not.toBe(second.binding.incarnationRef);
    expect(first.binding.keyEpochRef).not.toBe(second.binding.keyEpochRef);
    expect(first.binding.bindingDigest).not.toBe(second.binding.bindingDigest);
    expect(first.binding.proof.challengeDigest).not.toBe(second.binding.proof.challengeDigest);
  });
});

describe("refusal precedence is strict", () => {
  it("reports INPUT_INVALID when the request is malformed and the CSPRNG is dead", async () => {
    const { calls, port } = stubPort({ randomBytes: () => { throw new Error(SENTINEL); } });
    expectRefusal(
      await createRecoveryIncarnationService(port).mint({ restoreCommandId: COMMAND_A }),
      "RECOVERY_INCARNATION_INPUT_INVALID",
    );
    expect(calls.order).toEqual([]);
  });

  it("reports ENTROPY_UNAVAILABLE when both the CSPRNG and key generation are dead", async () => {
    const { calls, port } = stubPort({
      generateSigningKey: () => { throw new Error(SENTINEL); },
      randomBytes: () => bytes(1, 31),
    });
    expectRefusal(
      await createRecoveryIncarnationService(port).mint(request()),
      "RECOVERY_ENTROPY_UNAVAILABLE",
    );
    expect(calls.generated).toBe(0);
  });
});

/**
 * `CryptoKey` is a Node global but not a type in this package's lib set. Taken
 * from `globalThis` and asserted present below, so the leak check cannot pass
 * by comparing against `undefined`.
 */
const CRYPTO_KEY_CLASS = (globalThis as unknown as { CryptoKey: new () => unknown }).CryptoKey;

/** Recursively walks own properties INCLUDING non-enumerable ones. */
const walk = (value: unknown, seen = new Set<unknown>()): readonly unknown[] => {
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  return [
    value,
    ...Reflect.ownKeys(value).flatMap((key) => [
      typeof key === "symbol" ? key.description : key,
      ...walk((value as Record<PropertyKey, unknown>)[key], seen),
    ]),
  ];
};

describe("no private material escapes the mint", () => {
  it("keeps the signing handle out of the serialized binding", async () => {
    const { port } = stubPort();
    const value = minted(await createRecoveryIncarnationService(port).mint(request()));
    const descriptor = Object.getOwnPropertyDescriptor(value, "keyHandle");
    expect(descriptor?.enumerable).toBe(false);
    expect(typeof value.keyHandle).toBe("object");
    expect(JSON.parse(JSON.stringify(value))).toEqual({
      authority: "NONE",
      binding: value.binding,
      ok: true,
      outcome: "MINTED",
    });
  });

  it("carries no key object, buffer, function or raw nonce anywhere in the result graph", async () => {
    const raw = bytes(23);
    const rawHex = Buffer.from(raw).toString("hex");
    const { port } = stubPort({ randomBytes: () => raw });
    const value = minted(await createRecoveryIncarnationService(port).mint(request()));
    const nodes = walk(value);
    expect(nodes.length).toBeGreaterThan(0);
    expect(typeof CRYPTO_KEY_CLASS).toBe("function");
    for (const node of nodes) {
      expect(typeof node).not.toBe("function");
      expect(node).not.toBeInstanceOf(Error);
      expect(node).not.toBeInstanceOf(ArrayBuffer);
      expect(ArrayBuffer.isView(node)).toBe(false);
      expect(node instanceof CRYPTO_KEY_CLASS).toBe(false);
      if (typeof node === "string") {
        expect(node).not.toBe(rawHex);
        expect(node).not.toMatch(/private|secret|pkcs8|seed/i);
      }
    }
    // The raw block must be hashed, never published: its digest is present and
    // differs from the block itself.
    expect(value.binding.incarnationDigest).toBe(
      createHash("sha256").update("moe-recovery-incarnation/1:nonce\u0000").update(raw).digest("hex"),
    );
    expect(value.binding.incarnationDigest).not.toBe(rawHex);
  });

  it("publishes only the public SPKI the port handed over", async () => {
    const value = minted(await nodeService().mint(request()));
    const spki = Buffer.from(value.binding.publicKeySpkiHex, "hex");
    const imported = await webcrypto.subtle.importKey("spki", spki, { name: "Ed25519" }, true, [
      "verify",
    ]);
    expect(imported.type).toBe("public");
    expect(value.binding.verificationKeyFingerprint).toBe(
      createHash("sha256").update("moe-recovery-incarnation/1:key\u0000").update(spki).digest("hex"),
    );
  });
});

describe("the Node adapter protects its private key", () => {
  it("never resolves a fabricated or structurally cloned handle to a key", async () => {
    const port = createNodeRecoveryCryptoPort();
    const pair = await port.generateSigningKey();
    const message = bytes(5, 16);
    await expect(port.sign({}, message)).rejects.toThrow();
    await expect(port.sign(structuredClone(pair.handle), message)).rejects.toThrow();
    const signature = await port.sign(pair.handle, message);
    expect(await port.verify(pair.publicKeySpki, message, signature)).toBe(true);
  });

  it("stops signing once the handle is destroyed", async () => {
    const port = createNodeRecoveryCryptoPort();
    const pair = await port.generateSigningKey();
    port.destroy(pair.handle);
    await expect(port.sign(pair.handle, bytes(5, 16))).rejects.toThrow();
  });

  it("hands out a non-extractable Ed25519 key and a round-trippable public SPKI", async () => {
    const port = createNodeRecoveryCryptoPort();
    const pair = await port.generateSigningKey();
    expect(pair.algorithm).toBe("Ed25519");
    expect(pair.publicKeySpki).toBeInstanceOf(Uint8Array);
    expect(pair.publicKeySpki.byteLength).toBe(44);
    expect(JSON.stringify(pair.handle)).toBe("{}");
    const imported = await webcrypto.subtle.importKey(
      "spki",
      pair.publicKeySpki,
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    expect(imported.algorithm.name).toBe("Ed25519");
    expect(await port.verify(pair.publicKeySpki, bytes(6, 8), bytes(0, 64))).toBe(false);
  });
});

/**
 * The tagged origin union and the ONE derivation core both mints share. Imported
 * from the module rather than the package root because neither the context nor
 * the genesis shell is part of the daemon's published runtime surface; they are
 * still production code, never a local reimplementation.
 */
describe("the tagged recovery origin union", () => {
  it("publishes exactly two frozen origins", () => {
    expect([...RECOVERY_INCARNATION_ORIGINS]).toEqual(["GENESIS", "RESTORE"]);
    expect(Object.isFrozen(RECOVERY_INCARNATION_ORIGINS)).toBe(true);
    expectTypeOf<RecoveryIncarnationOrigin>().toEqualTypeOf<"GENESIS" | "RESTORE">();
  });

  it("derives the genesis store context itself instead of accepting one", () => {
    const context = snapshotGenesisContext({ projectId: PROJECT });
    expect(context).not.toBeNull();
    expect(context?.origin).toBe("GENESIS");
    expect(context?.storeContextDigest).toBe(digestOf("genesis-store", PROJECT));
  });

  it("refuses a caller-supplied store context digest rather than dropping it", () => {
    expect(
      snapshotGenesisContext({
        projectId: PROJECT,
        storeContextDigest: digestOf("genesis-store", PROJECT),
      }),
    ).toBeNull();
    expect(snapshotGenesisContext({ origin: "GENESIS", projectId: PROJECT })).toBeNull();
    expect(snapshotGenesisContext({ projectId: PROJECT, restoreCommandId: COMMAND_A })).toBeNull();
    expect(snapshotGenesisContext({})).toBeNull();
    expect(snapshotGenesisContext({ projectId: "project with spaces" })).toBeNull();
  });

  it("refuses a restore context carrying genesis fields", () => {
    expect(snapshotRestoreContext(restoreContextInput())).not.toBeNull();
    expect(
      snapshotRestoreContext({ ...restoreContextInput(), projectId: PROJECT }),
    ).toBeNull();
    expect(snapshotRestoreContext({ restoreCommandId: COMMAND_A })).toBeNull();
  });

  it("reads a restore context from descriptors, never from an accessor", () => {
    const hostile = Object.defineProperty({ restoreCommandId: COMMAND_A }, "backupGenerationDigest", {
      configurable: true,
      enumerable: true,
      get: () => DIGEST_A,
    });
    expect(snapshotRestoreContext(hostile)).toBeNull();
  });

  it("separates two origins whose raw context parts are byte-identical", () => {
    // The genesis store digest is what a restore generation digest looks like, so
    // this restore request can name EXACTLY the two strings genesis derives. Only
    // the origin tag is left to tell them apart.
    const storeContextDigest = digestOf("genesis-store", PROJECT);
    const genesis = snapshotGenesisContext({ projectId: PROJECT });
    const restore = snapshotRestoreContext({
      backupGenerationDigest: storeContextDigest,
      restoreCommandId: PROJECT,
    });
    expect(genesis).not.toBeNull();
    expect(restore).not.toBeNull();
    expect([genesis?.projectId, genesis?.storeContextDigest])
      .toEqual([restore?.restoreCommandId, restore?.backupGenerationDigest]);

    const material = {
      incarnationDigest: DIGEST_A,
      publicKeySpkiHex: "ab".repeat(22),
      verificationKeyFingerprint: DIGEST_B,
    };
    const fromGenesis = deriveIncarnation({ context: genesis!, ...material });
    const fromRestore = deriveIncarnation({ context: restore!, ...material });
    expect(fromGenesis.incarnationRef).not.toBe(fromRestore.incarnationRef);
    expect(fromGenesis.keyEpochRef).not.toBe(fromRestore.keyEpochRef);
    expect(fromGenesis.bindingDigest).not.toBe(fromRestore.bindingDigest);
    expect(fromGenesis.challengeDigest).not.toBe(fromRestore.challengeDigest);
  });

  it("binds the published SPKI into the binding digest", () => {
    const context = snapshotGenesisContext({ projectId: PROJECT })!;
    const base = {
      context,
      incarnationDigest: DIGEST_A,
      publicKeySpkiHex: "ab".repeat(22),
      verificationKeyFingerprint: DIGEST_B,
    };
    const moved = deriveIncarnation({ ...base, publicKeySpkiHex: "cd".repeat(22) });
    expect(moved.bindingDigest).not.toBe(deriveIncarnation(base).bindingDigest);
    expect(Object.isFrozen(deriveIncarnation(base))).toBe(true);
  });
});

describe("the binding is an exact discriminated union", () => {
  it("names both branches and nothing else", () => {
    expectTypeOf<RecoveryIncarnationBinding>()
      .toEqualTypeOf<GenesisIncarnationBinding | RestoreIncarnationBinding>();
    expectTypeOf<RestoreIncarnationBinding["origin"]>().toEqualTypeOf<"RESTORE">();
    expectTypeOf<GenesisIncarnationBinding["origin"]>().toEqualTypeOf<"GENESIS">();
  });

  it("keeps the restore branch's two fields at top level and their exact types", () => {
    expectTypeOf<RestoreIncarnationBinding["restoreCommandId"]>().toEqualTypeOf<string>();
    expectTypeOf<RestoreIncarnationBinding["backupGenerationDigest"]>().toEqualTypeOf<string>();
    expectTypeOf<RestoreIncarnationBinding["proof"]>().toEqualTypeOf<RecoveryIncarnationProof>();
  });

  it("makes a genesis branch structurally incapable of carrying restore facts", () => {
    // Exact key sets rather than four negative probes: an exact set also refuses
    // a field a later edit adds, which a `not.toHaveProperty` list never would.
    expectTypeOf<keyof GenesisIncarnationBinding>().toEqualTypeOf<
      | "bindingDigest" | "incarnationDigest" | "incarnationRef" | "keyEpochRef" | "origin"
      | "projectId" | "proof" | "publicKeyAlgorithm" | "publicKeySpkiHex" | "schemaVersion"
      | "storeContextDigest" | "verificationKeyFingerprint"
    >();
    expectTypeOf<keyof RestoreIncarnationBinding>().toEqualTypeOf<
      | "backupGenerationDigest" | "bindingDigest" | "incarnationDigest" | "incarnationRef"
      | "keyEpochRef" | "origin" | "proof" | "publicKeyAlgorithm" | "publicKeySpkiHex"
      | "restoreCommandId" | "schemaVersion" | "verificationKeyFingerprint"
    >();
  });

  it("keeps the port-based service a RESTORE-only mint", () => {
    expectTypeOf<RecoveryIncarnationMinted["binding"]>().toEqualTypeOf<RestoreIncarnationBinding>();
  });

  it("tags every binding the port-based service actually mints", async () => {
    const service = createRecoveryIncarnationService(createNodeRecoveryCryptoPort());
    const value = minted(await service.mint(request()));
    expect(value.binding.origin).toBe("RESTORE");
    expect(value.binding.restoreCommandId).toBe(COMMAND_A);
    expect(value.binding.backupGenerationDigest).toBe(DIGEST_A);
  });
});

/** A GENESIS binding shaped exactly as the codec must accept it. */
const genesisBinding = (): GenesisIncarnationBinding => {
  const context = snapshotGenesisContext({ projectId: PROJECT })!;
  const derived = deriveIncarnation({
    context,
    incarnationDigest: DIGEST_A,
    publicKeySpkiHex: "ab".repeat(22),
    verificationKeyFingerprint: DIGEST_B,
  });
  return Object.freeze({
    bindingDigest: derived.bindingDigest,
    incarnationDigest: DIGEST_A,
    incarnationRef: derived.incarnationRef,
    keyEpochRef: derived.keyEpochRef,
    origin: "GENESIS" as const,
    projectId: context.projectId,
    proof: Object.freeze({
      challengeDigest: derived.challengeDigest,
      signatureHex: "cd".repeat(64),
      verified: true as const,
    }),
    publicKeyAlgorithm: "Ed25519" as const,
    publicKeySpkiHex: "ab".repeat(22),
    schemaVersion: RECOVERY_INCARNATION_SCHEMA_VERSION,
    storeContextDigest: context.storeContextDigest,
    verificationKeyFingerprint: DIGEST_B,
  });
};

const decodeObject = (value: unknown): RecoveryIncarnationBinding | null =>
  decodeBinding(new TextEncoder().encode(JSON.stringify(value)));

const encodedObject = (binding: RecoveryIncarnationBinding): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(encodeBinding(binding))) as Record<string, unknown>;

describe("the durable binding codec is origin-aware", () => {
  it("round-trips both origins through the wire form", async () => {
    const restore = minted(await nodeService().mint(request())).binding;
    expect(decodeBinding(encodeBinding(restore))).toEqual(restore);
    const genesis = genesisBinding();
    expect(decodeBinding(encodeBinding(genesis))).toEqual(genesis);
  });

  it("emits ONE field order per origin, never the caller's", async () => {
    const restore = minted(await nodeService().mint(request())).binding;
    // A binding whose own key insertion order is reversed must still serialize
    // byte-identically, or a re-anchor after a crash would look like a conflict.
    const reordered = Object.fromEntries(
      Object.entries(restore).reverse(),
    ) as unknown as RestoreIncarnationBinding;
    expect(encodeBinding(reordered)).toEqual(encodeBinding(restore));
    expect(Object.keys(encodedObject(genesisBinding()))).toEqual([
      "bindingDigest", "incarnationDigest", "incarnationRef", "keyEpochRef", "origin",
      "proof", "publicKeyAlgorithm", "publicKeySpkiHex", "schemaVersion",
      "verificationKeyFingerprint", "projectId", "storeContextDigest",
    ]);
  });

  it("refuses a genesis payload that counterfeits a restore fact", () => {
    const genesis = encodedObject(genesisBinding());
    expect(decodeObject({ ...genesis, restoreCommandId: COMMAND_A })).toBeNull();
    expect(decodeObject({ ...genesis, backupGenerationDigest: DIGEST_A })).toBeNull();
    const { projectId: _projectId, ...withoutProject } = genesis;
    expect(decodeObject({ ...withoutProject, restoreCommandId: COMMAND_A })).toBeNull();
  });

  it("refuses a restore payload that claims genesis context", async () => {
    const restore = encodedObject(minted(await nodeService().mint(request())).binding);
    expect(decodeObject({ ...restore, projectId: PROJECT })).toBeNull();
    expect(decodeObject({ ...restore, storeContextDigest: DIGEST_A })).toBeNull();
  });

  it("refuses a pre-origin row rather than inventing an origin for it", async () => {
    const restore = encodedObject(minted(await nodeService().mint(request())).binding);
    const { origin: _origin, ...legacy } = restore;
    expect(decodeObject(legacy)).toBeNull();
    expect(decodeObject({ ...restore, origin: "RESTORED" })).toBeNull();
    expect(decodeObject({ ...restore, origin: null })).toBeNull();
  });

  it("generated the whole drifted-row matrix and refuses every case", async () => {
    const restore = encodedObject(minted(await nodeService().mint(request())).binding);
    const genesis = encodedObject(genesisBinding());
    const drop = (row: Record<string, unknown>, key: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
    const cases: readonly (readonly [string, unknown])[] = [
      ...Object.keys(restore).map(
        (key) => [`restore without ${key}`, drop(restore, key)] as const,
      ),
      ...Object.keys(genesis).map(
        (key) => [`genesis without ${key}`, drop(genesis, key)] as const,
      ),
      ["restore with an extra key", { ...restore, extra: 1 }],
      ["genesis with an extra key", { ...genesis, extra: 1 }],
      ["a drifted schema version", { ...restore, schemaVersion: "moe-recovery-incarnation/2" }],
      ["a foreign key algorithm", { ...restore, publicKeyAlgorithm: "Ed448" }],
      ["an unverified proof", { ...restore, proof: { ...(restore["proof"] as object), verified: false } }],
      ["a truncated binding digest", { ...restore, bindingDigest: "abc" }],
      ["a non-hex SPKI", { ...genesis, publicKeySpkiHex: "zz".repeat(22) }],
      ["an empty project id", { ...genesis, projectId: "" }],
      ["a non-hex store context digest", { ...genesis, storeContextDigest: "nope" }],
      ["an empty restore command id", { ...restore, restoreCommandId: "" }],
      ["an array in place of a row", []],
      ["a null row", null],
    ];
    // The sweep must be proven non-empty: a generator that silently yields
    // nothing passes every assertion below while testing nothing at all.
    expect(cases).toHaveLength(36);
    for (const [label, row] of cases) {
      expect(decodeObject(row), label).toBeNull();
    }
    expect(decodeBinding(new TextEncoder().encode("{not json"))).toBeNull();
  });
});

/**
 * The synchronous genesis shell. It exists because `createStoreDependencies` is
 * synchronous and the landed WebCrypto port is async-only; it shares the
 * derivation and self-proof with the port-based service, and differs ONLY in
 * which crypto API it calls.
 */
const genesisShell = (
  overrides: Partial<GenesisCryptoShell> = {},
): GenesisCryptoShell => Object.freeze({ ...nodeGenesisCryptoShell, ...overrides });

const genesisMinted = (result: GenesisMintResult): GenesisIncarnationBinding => {
  if (!result.ok) throw new Error(`the genesis mint must succeed: ${result.code}`);
  return result.binding;
};

const expectGenesisRefusal = (result: GenesisMintResult, code: RecoveryIncarnationErrorCode) => {
  if (result.ok) throw new Error(`expected ${code}, got a minted genesis binding`);
  expect(result.code).toBe(code);
  expect(result.layer).toBe("RECOVERY_INCARNATION");
  expect(result.truth).toBe("UNKNOWN");
  expect(result.authority).toBe("NONE");
  expect(result.outcome).toBe("REFUSED");
  expect(Object.hasOwn(result, "binding")).toBe(false);
  expect(Object.hasOwn(result, "keyHandle")).toBe(false);
};

describe("the synchronous genesis mint", () => {
  it("mints a GENESIS binding whose proof verifies against its own published SPKI", () => {
    const binding = genesisMinted(mintGenesisIncarnation(`${PROJECT}-1`));
    expect(binding.origin).toBe("GENESIS");
    expect(binding.projectId).toBe(`${PROJECT}-1`);
    expect(binding.storeContextDigest).toBe(digestOf("genesis-store", `${PROJECT}-1`));
    expect(binding.schemaVersion).toBe(RECOVERY_INCARNATION_SCHEMA_VERSION);
    expect(binding.publicKeyAlgorithm).toBe("Ed25519");
    expect(binding.proof.verified).toBe(true);
    // Verified HERE, from the published bytes alone — exactly what a later
    // process holding only the durable row can do.
    const publicKey = createPublicKey({
      format: "der",
      key: Buffer.from(binding.publicKeySpkiHex, "hex"),
      type: "spki",
    });
    const ok = nodeVerify(
      null,
      Buffer.from(binding.proof.challengeDigest, "hex"),
      publicKey,
      Buffer.from(binding.proof.signatureHex, "hex"),
    );
    expect(ok).toBe(true);
    expect(binding.verificationKeyFingerprint)
      .toBe(digestOf("key", new Uint8Array(Buffer.from(binding.publicKeySpkiHex, "hex"))));
  });

  it("derives every reference through the SHARED core, not a second derivation", () => {
    const binding = genesisMinted(mintGenesisIncarnation(`${PROJECT}-2`));
    const derived = deriveIncarnation({
      context: snapshotGenesisContext({ projectId: `${PROJECT}-2` })!,
      incarnationDigest: binding.incarnationDigest,
      publicKeySpkiHex: binding.publicKeySpkiHex,
      verificationKeyFingerprint: binding.verificationKeyFingerprint,
    });
    expect(binding.incarnationRef).toBe(derived.incarnationRef);
    expect(binding.keyEpochRef).toBe(derived.keyEpochRef);
    expect(binding.bindingDigest).toBe(derived.bindingDigest);
    expect(binding.proof.challengeDigest).toBe(derived.challengeDigest);
  });

  it("gives two projects distinct identities and never repeats one", () => {
    const first = genesisMinted(mintGenesisIncarnation(`${PROJECT}-3`));
    const second = genesisMinted(mintGenesisIncarnation(`${PROJECT}-4`));
    expect(first.incarnationRef).not.toBe(second.incarnationRef);
    expect(first.keyEpochRef).not.toBe(second.keyEpochRef);
    expect(first.publicKeySpkiHex).not.toBe(second.publicKeySpkiHex);
  });

  it("refuses a project identity nobody could have asserted", () => {
    const empty = mintGenesisIncarnation("");
    expectGenesisRefusal(empty, "RECOVERY_INCARNATION_INPUT_INVALID");
    // Same code and layer as the restore branch, but the reason names the input
    // that was actually refused rather than a restore request nobody sent.
    expect(empty.ok ? "" : empty.reason).toBe(
      "A genesis recovery incarnation must name exactly one asserted project identity.",
    );
    expectGenesisRefusal(
      mintGenesisIncarnation("project with spaces"),
      "RECOVERY_INCARNATION_INPUT_INVALID",
    );
  });

  it("refuses a repeated CSPRNG block with the exact code and layer", () => {
    const repeated = bytes(7);
    const shell = genesisShell({ randomBytes: () => Uint8Array.from(repeated) });
    genesisMinted(mintGenesisIncarnation(`${PROJECT}-5`, shell));
    expectGenesisRefusal(
      mintGenesisIncarnation(`${PROJECT}-6`, shell),
      "RECOVERY_ENTROPY_UNAVAILABLE",
    );
  });

  it("burns a block that was exposed on an attempt which later failed", () => {
    const repeated = bytes(9);
    const dead = genesisShell({
      generateSigningKey: () => {
        throw new Error("no key material");
      },
      randomBytes: () => Uint8Array.from(repeated),
    });
    expectGenesisRefusal(
      mintGenesisIncarnation(`${PROJECT}-7`, dead),
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    );
    // The RESERVATION happened before the key attempt, so the same block cannot
    // be retried through a healthy shell afterwards.
    expectGenesisRefusal(
      mintGenesisIncarnation(`${PROJECT}-8`, genesisShell({ randomBytes: () => Uint8Array.from(repeated) })),
      "RECOVERY_ENTROPY_UNAVAILABLE",
    );
  });

  it("refuses a repeated key epoch even when the entropy is fresh", () => {
    const pair = nodeGenesisCryptoShell.generateSigningKey();
    const shell = genesisShell({ generateSigningKey: () => pair });
    genesisMinted(mintGenesisIncarnation(`${PROJECT}-9`, shell));
    expectGenesisRefusal(
      mintGenesisIncarnation(`${PROJECT}-10`, shell),
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    );
  });

  it("refuses a truthy non-boolean self-proof rather than reading it as verified", () => {
    const shell = genesisShell({ verify: () => "verified" as unknown as boolean });
    expectGenesisRefusal(
      mintGenesisIncarnation(`${PROJECT}-11`, shell),
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    );
  });

  it("refuses an absurd SPKI before it publishes anything derived from it", () => {
    const shell = genesisShell({
      generateSigningKey: () => ({
        ...nodeGenesisCryptoShell.generateSigningKey(),
        publicKeySpki: new Uint8Array(0),
      }),
    });
    expectGenesisRefusal(
      mintGenesisIncarnation(`${PROJECT}-12`, shell),
      "RECOVERY_KEY_EPOCH_UNAVAILABLE",
    );
  });

  it("returns no key handle and leaks no private material into evidence", () => {
    const nonce = bytes(11);
    const shell = genesisShell({ randomBytes: () => Uint8Array.from(nonce) });
    const result = mintGenesisIncarnation(`${PROJECT}-13`, shell);
    const binding = genesisMinted(result);
    expect(Reflect.ownKeys(result).sort()).toEqual(["authority", "binding", "ok", "outcome"]);
    expect(result.ok && result.authority).toBe("NONE");
    const serialized = JSON.stringify(result);
    for (const banned of ["keyHandle", "privateKey", "PRIVATE KEY", "pkcs8", "secret", "nonce"]) {
      expect(serialized).not.toContain(banned);
    }
    // The RAW nonce never appears, in either spelling.
    expect(serialized).not.toContain(Buffer.from(nonce).toString("hex"));
    expect(serialized).not.toContain(Buffer.from(nonce).toString("base64"));
    expect(binding.incarnationDigest).toBe(digestOf("nonce", nonce));
    expect(JSON.parse(serialized)).toEqual({
      authority: "NONE", binding, ok: true, outcome: "MINTED",
    });
  });

  it("survives the durable codec round trip it will be persisted through", () => {
    const binding = genesisMinted(mintGenesisIncarnation(`${PROJECT}-14`));
    expect(decodeBinding(encodeBinding(binding))).toEqual(binding);
  });
});
