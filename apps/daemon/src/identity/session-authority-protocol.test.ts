import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  canonicalSessionProofBytes as sharedCanonicalSessionProofBytes,
  SESSION_AUTHORITY_SCHEMA_VERSION as SHARED_SCHEMA_VERSION,
  sessionAuthorityCanonicalString,
} from "@moe/contracts";
import type { SessionProofChallengeFields } from "@moe/contracts";

import { SESSION_AUTHORITY_SCHEMA_VERSION } from "./session-authority-contracts.js";
import {
  canonicalSessionProofBytes,
  sessionAuthorityRequestDigest,
} from "./session-authority-protocol.js";

const SESSION_PROOF_FIELDS: SessionProofChallengeFields = Object.freeze({
  principalId: "principal-1",
  projectId: "project-1",
  recoveryIncarnationRef: "recovery-1",
  keyEpochRef: "epoch-1",
  sessionId: "session-1",
  credentialId: "credential-1",
  generation: 1,
  clientKeyId: "a".repeat(64),
  transportId: "transport-1",
  requestId: "request-1",
  requestDigest: "b".repeat(64),
  issuedAt: 1_725_000_000_000,
  nonce: "c".repeat(32),
});

const daemonSessionProofBytes:
  (fields: SessionProofChallengeFields) => Uint8Array = canonicalSessionProofBytes;

const daemonProtocolSource = readFileSync(
  new URL("./session-authority-protocol.ts", import.meta.url),
  "utf8",
);
const daemonContractsSource = readFileSync(
  new URL("./session-authority-contracts.ts", import.meta.url),
  "utf8",
);

function sharedProofImportAliases(source: string): readonly string[] {
  const aliases: string[] = [];
  const imports = source.matchAll(
    /import\s*\{([^;]*?)\}\s*from\s*"@moe\/contracts";/gu,
  );
  for (const statement of imports) {
    const alias = statement[1]?.match(
      /\bcanonicalSessionProofBytes\s+as\s+([A-Za-z_$][\w$]*)\b/u,
    )?.[1];
    if (alias !== undefined) aliases.push(alias);
  }
  return Object.freeze(aliases);
}

describe("session proof canonicalization delegates to the shared byte contract", () => {
  it("keeps shared and daemon wrapper bytes identical", () => {
    const throughShared = sharedCanonicalSessionProofBytes(SESSION_PROOF_FIELDS);
    const throughDaemon = daemonSessionProofBytes(SESSION_PROOF_FIELDS);

    expect(throughDaemon).toBeInstanceOf(Uint8Array);
    expect([...throughDaemon]).toEqual([...throughShared]);
  });

  it("contains no daemon-local proof framing or proof-constant definitions", () => {
    expect(daemonProtocolSource).not.toMatch(/\bconst\s+CHALLENGE_ORDER\s*=/u);
    expect(daemonProtocolSource).not.toMatch(
      /\bframed\s*\(\s*SESSION_PROOF_DOMAIN\b/u,
    );
    expect(daemonProtocolSource).not.toMatch(
      /\b(?:export\s+)?const\s+SESSION_PROOF_(?:PROTOCOL_VERSION|ALGORITHM|DOMAIN)\s*=/u,
    );
    expect(daemonContractsSource).not.toMatch(
      /\b(?:export\s+)?const\s+SESSION_PROOF_(?:PROTOCOL_VERSION|ALGORITHM|DOMAIN)\s*=/u,
    );

    const proofCanonicalizers = [
      ...daemonProtocolSource.matchAll(
        /\b(?:export\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/gu,
      ),
    ]
      .map((match) => match[1])
      .filter((name): name is string =>
        name !== undefined
          && /proof/iu.test(name)
          && /canonical|bytes/iu.test(name));
    expect(proofCanonicalizers).toEqual(["canonicalSessionProofBytes"]);
  });

  it("requires the public wrapper to delegate once to a bare shared import", () => {
    const aliases = sharedProofImportAliases(daemonProtocolSource);
    expect(aliases).toHaveLength(1);
    const alias = aliases[0];
    if (alias === undefined) throw new Error("missing shared proof canonicalizer alias");

    const wrapper = daemonProtocolSource.match(
      /export\s+function\s+canonicalSessionProofBytes\s*\(\s*fields:\s*SessionProofChallengeFields\s*\)\s*:\s*Uint8Array\s*\{([\s\S]*?)\n\}/u,
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper?.[1]?.trim()).toBe(`return ${alias}(fields);`);
    const calls = daemonProtocolSource.match(
      new RegExp(`\\b${alias}\\s*\\(`, "gu"),
    ) ?? [];
    expect(calls).toHaveLength(1);
  });
});

/**
 * THE BYTE-IDENTITY ARM (task-d37e8873 DoD 5).
 *
 * `sessionAuthorityRequestDigest` was extracted so a browser can compute the same
 * OPEN_SESSION digest the daemon does: the canonicalization moved to `@moe/contracts`
 * (browser-reachable, no `node:` imports) while hashing stays per-platform — `node:crypto`
 * here, `crypto.subtle` in the Control Room.
 *
 * This arm lives daemon-side because `@moe/contracts` cannot import `@moe/daemon`, so this
 * is the only place both halves are visible at once.
 *
 * IT COMPARES TWO COMPUTED VALUES AND NEVER A SPELLED HEX LITERAL. A pinned literal would
 * pass even if the daemon and the extracted canonicalizer drifted together, which is the
 * exact defect the extraction exists to prevent.
 */
const OPEN_SESSION_FIELDS = Object.freeze({
  clientKeyId: "c".repeat(64),
  credentialId: "credential-1",
  generation: 1,
  kind: "OPEN_SESSION",
  principalId: "principal-1",
  profileRevisionId: "p".repeat(64),
  projectId: "project-1",
  publicKeySpkiHex: "a".repeat(88),
  sessionId: "session-1",
  transportId: "transport-1",
  transportIds: ["transport-1", "transport-2"],
});

const sha256Hex = (value: string): string =>
  createHash("sha256").update(new TextEncoder().encode(value)).digest("hex");

describe("session authority request digest composes the extracted canonicalization", () => {
  it("keeps the daemon and shared schema-version literals identical", () => {
    // The version string is the one value duplicated by the extraction: the daemon keeps
    // its own for aggregate ids and event schemas, and `@moe/contracts` carries a copy so
    // it need not import an app. Divergence would already red the byte-identity arm below,
    // because the prefix is inside the hashed string — but that fails as an opaque digest
    // mismatch. This arm names the cause in one line instead.
    expect(SHARED_SCHEMA_VERSION).toBe(SESSION_AUTHORITY_SCHEMA_VERSION);
  });

  it("equals SHA-256 of the shared canonical string for an OPEN_SESSION field set", () => {
    const throughDaemon = sessionAuthorityRequestDigest(OPEN_SESSION_FIELDS);
    const throughShared = sha256Hex(sessionAuthorityCanonicalString(OPEN_SESSION_FIELDS));
    expect(throughDaemon).toBe(throughShared);
    // Both sides are real work, not two reads of one cache: pin the shape, not the value.
    expect(throughDaemon).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("still normalises key order through the composed path", () => {
    const reordered = {
      transportIds: OPEN_SESSION_FIELDS.transportIds,
      kind: OPEN_SESSION_FIELDS.kind,
      projectId: OPEN_SESSION_FIELDS.projectId,
      principalId: OPEN_SESSION_FIELDS.principalId,
      profileRevisionId: OPEN_SESSION_FIELDS.profileRevisionId,
      sessionId: OPEN_SESSION_FIELDS.sessionId,
      credentialId: OPEN_SESSION_FIELDS.credentialId,
      generation: OPEN_SESSION_FIELDS.generation,
      clientKeyId: OPEN_SESSION_FIELDS.clientKeyId,
      publicKeySpkiHex: OPEN_SESSION_FIELDS.publicKeySpkiHex,
      transportId: OPEN_SESSION_FIELDS.transportId,
    };
    expect(sessionAuthorityRequestDigest(reordered))
      .toBe(sessionAuthorityRequestDigest(OPEN_SESSION_FIELDS));
  });

  it("propagates the shared canonicaliser's refusals instead of hashing a dropped field", () => {
    // If the daemon ever stopped composing the shared module, a private canonicaliser
    // without the safe-integer clause would hash this instead of throwing.
    expect(() => sessionAuthorityRequestDigest({ ...OPEN_SESSION_FIELDS, generation: 1.5 }))
      .toThrow("canonical numbers are safe integers");
  });
});
