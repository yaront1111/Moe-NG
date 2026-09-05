import { randomBytes } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ENVIRONMENT_SEAL_HEADER_BYTES, openEnvironmentValue } from "./environment-cipher.js";
import { environmentValueFingerprint } from "./environment-contracts.js";
import { foldEnvironmentEvents } from "./environment-fold.js";
import {
  environmentAggregateId,
  readEnvironmentVariables,
  setEnvironmentVariable,
} from "./environment-store.js";
import type { EnvironmentReadResult } from "./environment-store.js";
import {
  CREDENTIAL,
  OTHER_CREDENTIAL,
  PROJECT_ID,
  cleanUp,
  closeStores,
  configFor,
  openExistingStore,
  openFileStore,
  unreadableCredentialSource,
} from "./environment-test-fixtures.js";

/**
 * ENCRYPTED AT REST, PROVEN ON BYTES: the exfiltrated-copy scenario, end to end.
 *
 * BOTH HALVES ARE ASSERTED, and the second is the one that matters. A refusal alone proves only
 * that the DAEMON declined - an attacker holding the file does not run the daemon. So each arm
 * also takes the sealed bytes OUT of the copied file and puts them through the cipher directly,
 * which is what an attacker with a hex editor and this source would do.
 *
 * THE CONTROL THAT KEEPS THIS HONEST: every arm first proves the copy is INTACT by opening it
 * with the RIGHT credential. Without that, a refusal could equally mean the copy is corrupt, and
 * "unreadable without the key" would be indistinguishable from "unreadable, full stop".
 */

afterEach(cleanUp);

const PROD = "production";

interface Exfiltrated {
  readonly copyPath: string;
  readonly fingerprint: string;
  readonly secret: string;
}

/**
 * Writes a secret through the production path, CLOSES the store so the WAL is checkpointed into
 * the database file, then copies that file - the shape of a real exfiltration.
 */
function exfiltrate(): Exfiltrated {
  const secret = `MOE_CANARY_${randomBytes(16).toString("hex")}`;
  const { databasePath, directory, store } = openFileStore("source");
  const written = setEnvironmentVariable(configFor(store), {
    environment: PROD, name: "STOLEN_TOKEN", value: secret,
  });
  if (!written.ok) throw new Error(`expected the seed write to be ok, got ${written.code}`);
  // Closing checkpoints the WAL; without it the copied `.db` could be missing the record and
  // every assertion below would be about an empty file.
  closeStores();
  const copyPath = join(directory, "copy.db");
  copyFileSync(databasePath, copyPath);
  return { copyPath, fingerprint: environmentValueFingerprint(secret), secret };
}

function expectKeyRefusal(result: EnvironmentReadResult): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe("ENV_STORE_KEY_UNAVAILABLE");
  expect(result.layer).toBe("KEY");
}

/** The sealed blob as it sits in the COPIED file, reached through the fold, not re-derived. */
function sealedFromCopy(copyPath: string): Uint8Array {
  const store = openExistingStore(copyPath);
  const state = foldEnvironmentEvents(
    store.readEvents(environmentAggregateId(PROJECT_ID, PROD)),
  );
  const record = state.get("STOLEN_TOKEN");
  expect(record).toBeDefined();
  return record?.sealed ?? new Uint8Array();
}

describe("a store copied WITHOUT the daemon credential", () => {
  it("is INTACT - the control, so a refusal below cannot be mistaken for a broken copy", () => {
    const { copyPath, fingerprint } = exfiltrate();
    const read = readEnvironmentVariables(configFor(openExistingStore(copyPath)), PROD);
    if (!read.ok) throw new Error(`expected the copy to read with the right key, got ${read.code}`);
    expect(read.variables).toHaveLength(1);
    expect(read.variables[0]?.name).toBe("STOLEN_TOKEN");
    expect(read.variables[0]?.fingerprintSha256).toBe(fingerprint);
  });

  it("answers ENV_STORE_KEY_UNAVAILABLE at the KEY layer with NO credential", () => {
    const { copyPath } = exfiltrate();
    expectKeyRefusal(readEnvironmentVariables(configFor(openExistingStore(copyPath), null), PROD));
  });

  it("answers ENV_STORE_KEY_UNAVAILABLE with an EMPTY credential, which is how an unset env var arrives", () => {
    const { copyPath } = exfiltrate();
    expectKeyRefusal(readEnvironmentVariables(configFor(openExistingStore(copyPath), ""), PROD));
  });

  it("answers ENV_STORE_KEY_UNAVAILABLE when the credential is PRESENT BUT UNREADABLE", () => {
    const { copyPath, secret } = exfiltrate();
    const config = {
      ...configFor(openExistingStore(copyPath)), credential: unreadableCredentialSource(),
    };
    const result = readEnvironmentVariables(config, PROD);
    expectKeyRefusal(result);
    // The thrown error names a credential PATH; a refusal that relayed it would publish where
    // the secret lives, and could carry the value with it.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("EACCES");
    expect(serialised).not.toContain(".moe/credential");
    expect(serialised).not.toContain(secret);
  });

  it("answers ENV_STORE_KEY_UNAVAILABLE when the credential is present but WRONG", () => {
    const { copyPath } = exfiltrate();
    expectKeyRefusal(
      readEnvironmentVariables(configFor(openExistingStore(copyPath), OTHER_CREDENTIAL), PROD),
    );
  });

  it("YIELDS NO PLAINTEXT when the copied file's BYTES are searched, while the fingerprint IS there", () => {
    const { copyPath, fingerprint, secret } = exfiltrate();
    const bytes = readFileSync(copyPath);
    expect(bytes.includes(secret)).toBe(false);
    // Prefix window too: a leak that stored only part of the value is still a leak.
    expect(bytes.includes(secret.slice(0, 16))).toBe(false);
    // The record IS in the copy - so "no plaintext" is not achieved by an empty file.
    expect(bytes.includes(fingerprint)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("the sealed bytes taken straight out of the copy", () => {
  it("FAIL AUTHENTICATION under a wrong credential rather than yielding garbage", () => {
    const { copyPath } = exfiltrate();
    const opened = openEnvironmentValue(OTHER_CREDENTIAL, sealedFromCopy(copyPath));
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("AUTHENTICATION_FAILED");
  });

  it("FAIL AUTHENTICATION under an EMPTY credential", () => {
    const { copyPath } = exfiltrate();
    const opened = openEnvironmentValue("", sealedFromCopy(copyPath));
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("AUTHENTICATION_FAILED");
  });

  it("OPEN under the right credential - the control proving the seal in the copy is sound", () => {
    const { copyPath, secret } = exfiltrate();
    const opened = openEnvironmentValue(CREDENTIAL, sealedFromCopy(copyPath));
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unreachable");
    expect(new TextDecoder().decode(opened.plaintext)).toBe(secret);
  });

  it("contain no trace of the plaintext on their own, apart from any store framing", () => {
    const { copyPath, secret } = exfiltrate();
    const sealed = Buffer.from(sealedFromCopy(copyPath));
    expect(sealed.includes(secret)).toBe(false);
    expect(sealed.byteLength)
      .toBe(ENVIRONMENT_SEAL_HEADER_BYTES + Buffer.byteLength(secret, "utf8"));
  });
});
