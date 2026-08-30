import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SESSION_AUTHORITY_SCHEMA_VERSION as SHARED_SCHEMA_VERSION, sessionAuthorityCanonicalString }
  from "@moe/contracts";

import { SESSION_AUTHORITY_SCHEMA_VERSION } from "./session-authority-contracts.js";
import { sessionAuthorityRequestDigest } from "./session-authority-protocol.js";

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
