import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { expect, test } from "@playwright/test";

import {
  SESSION_PROOF_ALGORITHM, SESSION_PROOF_PROTOCOL_VERSION,
} from "../../../apps/daemon/src/identity/session-authority-contracts.js";
import {
  canonicalSessionProofBytes, sessionAuthorityRequestDigest,
} from "../../../apps/daemon/src/identity/session-authority-protocol.js";
import { createSessionAuthority } from "../../../apps/daemon/src/identity/session-authority.js";
import { killTree, spawnNode } from "./daemon-children.js";
import {
  LANE_CSRF_TOKEN, createLaneScratch, daemonEnv, repoRoot, serverEnv,
} from "./daemon-ports.js";

/**
 * DoD 4: a REAL browser generates a REAL Ed25519 key in its own Web Crypto, signs the
 * daemon's challenge, and the daemon's OWN verifier opens the session authority.
 *
 * WHY NO UNIT TEST REACHES THIS. Both halves are already green in Node — the daemon suite
 * proves `openSession` accepts a signature made with `node:crypto`, and the client package
 * proves `generateSessionKey` agrees with the daemon's `sessionClientKeyId`. Neither can
 * see what actually breaks in production: a browser Web Crypto key whose SPKI encoding,
 * whose digest, or whose Ed25519 signature bytes differ from Node's. Only a real browser
 * against a real daemon closes that gap.
 *
 * THE MODULE UNDER TEST IS SERVED BY VITE, NOT INLINED. The page imports the shipped
 * `session-key.ts` through the dev server's `/@fs/` entry, so what runs is the module this
 * row delivers, transformed by the real dev module graph. Re-implementing the crypto inside
 * `page.evaluate` would prove Web Crypto works and nothing about whether OUR module does.
 *
 * THE CHALLENGE ENCODING IS COMPOSED, NEVER COPIED (task rail 2). `canonicalSessionProofBytes`
 * is a framed, field-ordered encoding — not the JSON canonical string — and it is Node-only.
 * So the SPEC computes the challenge with the daemon's own function and hands the BYTES to
 * the page to sign. A hand-rolled browser copy would be a second encoding free to drift, and
 * it would drift where nothing grades it: the daemon would simply answer PROOF.
 */

const DAEMON_READY_MS = 90_000;
const DEV_READY_MS = 90_000;
const ORIGIN_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const VITE_ORIGIN = /Local:\s+(http:\/\/localhost:\d+)/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const WIRE_PROTOCOL
  = "moe-runtime-command/1+moe-runtime-query/1+moe-runtime-error-registry/1";
const TRANSPORT_IDS = Object.freeze(["coordination.v1", "terminal.v1"]);
const CREDENTIAL_ID = "credential-browser-open";
const COMMAND_ID = "command-browser-open";

/** What the page reports after generating its key and claiming the approved pairing. */
interface BrowserClaim {
  readonly challenge: Record<string, string>;
  readonly claimStatus: number;
  readonly clientKeyId: string;
  readonly principalId: string;
  readonly privateKeyExtractable: boolean;
  readonly projectId: string;
  readonly publicKeySpkiHex: string;
  readonly requestDigest: string;
  readonly sessionId: string;
}

interface BrowserOpen {
  readonly body: Record<string, unknown>;
  /** The EXACT bytes sent, so the replay arm re-presents them rather than rebuilding. */
  readonly requestBody: string;
  readonly signatureHex: string;
  readonly status: number;
}

test("a browser-generated key pairs, signs, and opens the session authority", async ({ page }) => {
  test.setTimeout(300_000);
  const root = repoRoot();
  expect(root, "repo root (package.json + pnpm-workspace.yaml)").not.toBeNull();
  if (root === null) return;

  const scratch = createLaneScratch();
  const children: ChildProcess[] = [];
  try {
    // 1. A REAL daemon on an ephemeral port, with the private operator channel that
    //    `daemon-main.ts:212-214` turns into `operatorInput: process.stdin`.
    const daemon = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "daemon-main.ts"),
      `--dependencies=${join(root, "apps", "daemon", "src", "daemon-store-dependencies.ts")}`,
      "--port=0",
      `--csrf-token=${LANE_CSRF_TOKEN}`,
      "--operator-stdin",
    ], root, daemonEnv(scratch, "SPEED"));
    children.push(daemon.child);
    const daemonOrigin = await daemon.waitFor(ORIGIN_LINE, DAEMON_READY_MS);
    expect(daemonOrigin, `daemon origin:\n${daemon.transcript().slice(-800)}`)
      .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

    // 2. The REAL dev server, proxying the daemon's session routes onto one origin.
    const dev = spawnNode([
      join(root, "apps", "control-room", "node_modules", "vite", "bin", "vite.js"),
      "--port", "0",
    ], join(root, "apps", "control-room"), serverEnv(daemonOrigin as string, "ABSENT"));
    children.push(dev.child);
    const devOrigin = await dev.waitFor(VITE_ORIGIN, DEV_READY_MS);
    expect(devOrigin, `vite origin:\n${dev.transcript().slice(-800)}`)
      .toMatch(/^http:\/\/localhost:\d+$/u);
    // SECRET-SWEEP CORPUS (DoD 5), captured from the first navigation onward so nothing
    // the page sends can predate the recorder.
    const requests: string[] = [];
    const logs: string[] = [];
    page.on("request", (request) => {
      requests.push([
        request.method(), request.url(), JSON.stringify(request.headers()),
        request.postData() ?? "",
      ].join(" "));
    });
    page.on("console", (message) => { logs.push(`${message.type()}: ${message.text()}`); });
    page.on("pageerror", (error) => { logs.push(`pageerror: ${error.message}`); });

    await page.goto(`${devOrigin as string}/`, { waitUntil: "domcontentloaded" });

    // 3. Pair. The label is read from the daemon's own response and typed back on the
    //    private pipe; nothing here approves on the operator's behalf.
    const requested = await page.evaluate(async (input: {
      readonly csrf: string; readonly wire: string;
    }) => {
      const response = await fetch("/session/pair/request", {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-moe-csrf": input.csrf,
          "x-moe-protocol-version": input.wire,
        },
        method: "POST",
      });
      return { body: await response.json() as Record<string, unknown>, status: response.status };
    }, { csrf: LANE_CSRF_TOKEN, wire: WIRE_PROTOCOL });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const confirmationLabel = String(requested.body["confirmationLabel"]);
    expect(confirmationLabel).toMatch(CONFIRMATION_LABEL);
    expect(daemon.child.stdin, "the explicit operator pipe must exist").not.toBeNull();
    daemon.child.stdin?.write(`${confirmationLabel}\n`);
    // The daemon echoes its OWN outcome line and `waitFor` returns capture 1, so the
    // pattern must carry a group. Waiting on it removes the only race here: the claim
    // below must not run before the approval has landed.
    expect(await daemon.waitFor(/Paired\. (\w+)@/u, 20_000), daemon.transcript().slice(-600))
      .toBe("APPROVED");

    // 4. THE BROWSER DOES THE KEY WORK. The shipped module is imported through Vite's
    //    `/@fs/` entry, and the private key is retained on `window` so the signing step
    //    below uses the SAME non-extractable key this step generated.
    const claim = await page.evaluate(async (input: {
      readonly credentialId: string; readonly csrf: string; readonly moduleUrl: string;
      readonly requestId: string; readonly transportIds: readonly string[];
      readonly wire: string;
    }): Promise<BrowserClaim> => {
      const module = await import(/* @vite-ignore */ input.moduleUrl) as {
        generateSessionKey: () => Promise<Record<string, unknown>>;
        openSessionRequestDigest: (fields: unknown) => Promise<string>;
        signSessionChallenge: (key: unknown, challenge: Uint8Array) => Promise<string>;
      };
      const key = await module.generateSessionKey();
      if (key["ok"] !== true) throw new Error(`key generation refused: ${String(key["code"])}`);
      const publicKeySpkiHex = String(key["publicKeySpkiHex"]);
      const clientKeyId = String(key["clientKeyId"]);
      Reflect.set(globalThis, "__moeSessionKey", { key, module });

      const response = await fetch("/session/pair/claim", {
        body: JSON.stringify({ publicKeySpkiHex, requestId: input.requestId }),
        headers: {
          "content-type": "application/json",
          "x-moe-csrf": input.csrf,
          "x-moe-protocol-version": input.wire,
        },
        method: "POST",
      });
      const claimed = await response.json() as Record<string, unknown>;
      if (response.status !== 200) {
        throw new Error(`claim refused ${String(response.status)}: ${JSON.stringify(claimed)}`);
      }
      const challenge = claimed["challenge"] as Record<string, string>;
      const principalId = String(claimed["principalId"]);
      const projectId = String(claimed["projectId"]);
      const sessionId = `session-browser-${String(Date.now())}`;
      return {
        challenge,
        claimStatus: response.status,
        clientKeyId,
        principalId,
        privateKeyExtractable: (key["privateKey"] as { extractable: boolean }).extractable,
        projectId,
        publicKeySpkiHex,
        requestDigest: await module.openSessionRequestDigest({
          clientKeyId, credentialId: input.credentialId, generation: 1, kind: "OPEN_SESSION",
          principalId, profileRevisionId: challenge["profileRevisionId"], projectId,
          publicKeySpkiHex, sessionId,
          transportId: input.transportIds[0], transportIds: input.transportIds,
        }),
        sessionId,
      };
    }, {
      credentialId: CREDENTIAL_ID,
      csrf: LANE_CSRF_TOKEN,
      moduleUrl: `/@fs/${join(root, "packages", "control-room-client", "src", "session-key.ts")
        .replace(/\\/gu, "/")}`,
      requestId: String(requested.body["requestId"]),
      transportIds: TRANSPORT_IDS,
      wire: WIRE_PROTOCOL,
    });

    // The key really came from the browser, and its private half cannot be exported.
    expect(claim.claimStatus).toBe(200);
    expect(claim.publicKeySpkiHex).toMatch(/^[0-9a-f]{88}$/u);
    expect(claim.clientKeyId).toMatch(/^[0-9a-f]{64}$/u);
    expect(claim.privateKeyExtractable).toBe(false);
    // The approved claim disclosed exactly the three operands, to this claimant only.
    expect(Object.keys(claim.challenge).sort())
      .toEqual(["keyEpochRef", "profileRevisionId", "recoveryIncarnationRef"]);

    // 5. The DAEMON's own encoding produces the challenge; the BROWSER signs it.
    const issuedAt = Date.now();
    const nonce = "34".repeat(16);
    const challengeBytes = canonicalSessionProofBytes({
      clientKeyId: claim.clientKeyId,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      issuedAt,
      keyEpochRef: claim.challenge["keyEpochRef"] as string,
      nonce,
      principalId: claim.principalId,
      projectId: claim.projectId,
      recoveryIncarnationRef: claim.challenge["recoveryIncarnationRef"] as string,
      requestDigest: claim.requestDigest,
      requestId: COMMAND_ID,
      sessionId: claim.sessionId,
      transportId: TRANSPORT_IDS[0] as string,
    });

    const opened = await page.evaluate(async (input: {
      readonly algorithm: string; readonly challenge: readonly number[];
      readonly credentialId: string; readonly csrf: string; readonly commandId: string;
      readonly issuedAt: number; readonly nonce: string; readonly protocolVersion: number;
      readonly transportIds: readonly string[]; readonly wire: string;
      readonly claim: BrowserClaim;
    }): Promise<BrowserOpen> => {
      const held = Reflect.get(globalThis, "__moeSessionKey") as {
        key: Record<string, unknown>;
        module: { signSessionChallenge: (key: unknown, bytes: Uint8Array) => Promise<string> };
      };
      const signatureHex = await held.module.signSessionChallenge(
        held.key["privateKey"], Uint8Array.from(input.challenge),
      );
      const requestBody = JSON.stringify({
          clientKeyId: input.claim.clientKeyId,
          commandId: input.commandId,
          correlationId: "correlation-browser-open",
          credentialId: input.credentialId,
          principalId: input.claim.principalId,
          proof: {
            algorithm: input.algorithm, issuedAt: input.issuedAt, nonce: input.nonce,
            protocolVersion: input.protocolVersion, signatureHex,
          },
          publicKeySpkiHex: input.claim.publicKeySpkiHex,
          requestDigest: input.claim.requestDigest,
          sessionId: input.claim.sessionId,
          transportId: input.transportIds[0],
          transportIds: input.transportIds,
      });
      const response = await fetch("/session/pair/open", {
        body: requestBody,
        headers: {
          "content-type": "application/json",
          "x-moe-csrf": input.csrf,
          "x-moe-protocol-version": input.wire,
        },
        method: "POST",
      });
      return {
        body: await response.json() as Record<string, unknown>,
        requestBody,
        signatureHex,
        status: response.status,
      };
    }, {
      algorithm: SESSION_PROOF_ALGORITHM,
      challenge: [...challengeBytes],
      claim,
      commandId: COMMAND_ID,
      credentialId: CREDENTIAL_ID,
      csrf: LANE_CSRF_TOKEN,
      issuedAt,
      nonce,
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
      transportIds: TRANSPORT_IDS,
      wire: WIRE_PROTOCOL,
    });

    // THE CLAUSE: the daemon's own verifier accepted a signature made by a browser key.
    expect(opened.signatureHex).toMatch(/^[0-9a-f]{128}$/u);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body["ok"]).toBe(true);
    expect(opened.body["sessionId"]).toBe(claim.sessionId);

    // No key material or signature reached the daemon's log — the only transcript an
    // operator ever reads.
    expect(daemon.transcript()).not.toContain(opened.signatureHex);
    expect(daemon.transcript()).not.toContain(claim.publicKeySpkiHex);

    // ---- DoD 5: THE SECRET SWEEP ----
    //
    // TWO DIFFERENT CLAIMS, and the step is right that they must be named apart.
    //
    // (a) STRUCTURAL. The private key was generated `extractable: false`, so its material
    //     cannot be serialized AT ALL — not by us, not by a caller who wants to, not by a
    //     compromised page. `exportKey` rejects for BOTH pkcs8 and jwk, which is what makes
    //     "the private key never leaves the browser" a platform guarantee rather than a
    //     habit. This is the strong claim and it is asserted first.
    const exportAttempts = await page.evaluate(async () => {
      const held = Reflect.get(globalThis, "__moeSessionKey") as {
        key: Record<string, unknown>;
      };
      const attempt = async (format: string): Promise<string> => {
        try {
          await crypto.subtle.exportKey(
            format as "jwk" | "pkcs8", held.key["privateKey"] as CryptoKey,
          );
          return "EXPORTED";
        } catch (error: unknown) {
          return error instanceof DOMException ? error.name : "THREW";
        }
      };
      return { jwk: await attempt("jwk"), pkcs8: await attempt("pkcs8") };
    });
    expect(exportAttempts.pkcs8).not.toBe("EXPORTED");
    expect(exportAttempts.jwk).not.toBe("EXPORTED");

    // (b) OBSERVED. The corpus the page actually produced carries no unaccounted secret.
    //     THE CORPUS IS ASSERTED NON-EMPTY FIRST: a sweep over zero captured requests
    //     passes vacuously and would prove nothing at all.
    const storage = await page.evaluate(async () => ({
      indexedDb: typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((entry) => entry.name ?? "").join(" ")
        : "",
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(requests.length, "the request corpus must not be empty").toBeGreaterThan(0);
    expect(requests.join("\n")).toContain("/session/pair/claim");
    expect(requests.join("\n")).toContain("/session/pair/open");

    // EVERY long hex token anywhere in the corpus must be one this journey DISCLOSED on
    // purpose. An allowlist, not a `not.toContain` over one spelling: a leak in a form we
    // did not anticipate — a different variable name, a nested field, a storage key — still
    // has to be a long hex run, and any run we cannot account for fails here.
    const corpus = [...requests, ...logs, storage.local, storage.session, storage.indexedDb]
      .join("\n");
    // The allowlist is enumerated with a REASON for each entry, because an allowlist
    // nobody can audit is just a suppression. `requestId` is here because the claim body
    // must name the approved request; it is a pairing correlator with a 60s TTL, not key
    // material, and it is already public to whoever holds the browser.
    const disclosed = new Set([
      claim.publicKeySpkiHex,                        // the PUBLIC half, presented on purpose
      claim.clientKeyId,                             // SHA-256 of that public half
      claim.requestDigest,                           // a digest over public fields
      opened.signatureHex,                           // the proof, which is the point
      claim.challenge["keyEpochRef"],                // store-held operand, disclosed at claim
      claim.challenge["recoveryIncarnationRef"],     // store-held operand, disclosed at claim
      nonce,                                         // this spec's own fixed nonce
      String(requested.body["requestId"]),           // the approved pairing correlator
    ]);
    const unaccounted = (corpus.match(/[0-9a-f]{32,}/gu) ?? [])
      .filter((token) => !disclosed.has(token));
    expect(unaccounted, `unaccounted hex in the browser corpus: ${unaccounted.join(", ")}`)
      .toEqual([]);

    // And nothing resembling a serialized private key by NAME either, in any of the three
    // encodings a leak would take.
    for (const spelling of ["pkcs8", "\"d\":", "privateKey", "BEGIN PRIVATE KEY"]) {
      expect(corpus, `corpus must not carry ${spelling}`).not.toContain(spelling);
    }

    // ---- DoD 6 (a): A DIFFERENT KEY IS REFUSED BY THE PROOF FENCE ----
    //
    // The second key is generated in the BROWSER too, and every other byte of the payload
    // is built the same way as the accepted one — same principal, same digest derivation,
    // same challenge encoding. Only the signing key differs, so a refusal here can only be
    // the proof check. BOTH strings are asserted: a bare "it refused" would be satisfied by
    // the shape fence, the body cap or a replay marker, and would prove that the SYSTEM
    // refuses rather than that the PROOF check refuses (epic rail 7A).
    const wrongKeySessionId = `${claim.sessionId}-wrong-key`;
    // THE DIGEST IS RECOMPUTED FOR THIS SESSION ID. My first attempt reused the accepted
    // digest and the daemon answered AUTHENTICATION_FAILED @ BINDING — the digest fence at
    // session-authority.ts:168, which sits ABOVE the verifier at :171. That is precisely the
    // rail-7A trap this clause names: the request was refused, but by the wrong fence, and
    // asserting only "it refused" would have banked it as proof of the signature check.
    const wrongKeyDigest = sessionAuthorityRequestDigest({
      kind: "OPEN_SESSION",
      projectId: claim.projectId,
      principalId: claim.principalId,
      profileRevisionId: claim.challenge["profileRevisionId"] as string,
      sessionId: wrongKeySessionId,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      clientKeyId: claim.clientKeyId,
      publicKeySpkiHex: claim.publicKeySpkiHex,
      transportId: TRANSPORT_IDS[0] as string,
      transportIds: TRANSPORT_IDS,
    });
    const wrongKeyChallenge = canonicalSessionProofBytes({
      clientKeyId: claim.clientKeyId,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      issuedAt,
      keyEpochRef: claim.challenge["keyEpochRef"] as string,
      nonce,
      principalId: claim.principalId,
      projectId: claim.projectId,
      recoveryIncarnationRef: claim.challenge["recoveryIncarnationRef"] as string,
      requestDigest: wrongKeyDigest,
      requestId: COMMAND_ID,
      sessionId: wrongKeySessionId,
      transportId: TRANSPORT_IDS[0] as string,
    });
    const wrongKey = await page.evaluate(async (input: {
      readonly algorithm: string;
      readonly challenge: readonly number[];
      readonly claim: BrowserClaim;
      readonly commandId: string;
      readonly credentialId: string;
      readonly csrf: string;
      readonly issuedAt: number;
      readonly nonce: string;
      readonly protocolVersion: number;
      readonly requestDigest: string;
      readonly sessionId: string;
      readonly transportIds: readonly string[];
      readonly wire: string;
    }) => {
      const held = Reflect.get(globalThis, "__moeSessionKey") as {
        module: {
          generateSessionKey: () => Promise<Record<string, unknown>>;
          signSessionChallenge: (key: unknown, bytes: Uint8Array) => Promise<string>;
        };
      };
      const other = await held.module.generateSessionKey();
      if (other["ok"] !== true) throw new Error("second key generation refused");
      const signatureHex = await held.module.signSessionChallenge(
        other["privateKey"], Uint8Array.from(input.challenge),
      );
      const response = await fetch("/session/pair/open", {
        body: JSON.stringify({
          clientKeyId: input.claim.clientKeyId,
          commandId: input.commandId,
          correlationId: "correlation-browser-wrong-key",
          credentialId: input.credentialId,
          principalId: input.claim.principalId,
          proof: {
            algorithm: input.algorithm,
            issuedAt: input.issuedAt,
            nonce: input.nonce,
            protocolVersion: input.protocolVersion,
            signatureHex,
          },
          publicKeySpkiHex: input.claim.publicKeySpkiHex,
          requestDigest: input.requestDigest,
          sessionId: input.sessionId,
          transportId: input.transportIds[0],
          transportIds: input.transportIds,
        }),
        headers: {
          "content-type": "application/json",
          "x-moe-csrf": input.csrf,
          "x-moe-protocol-version": input.wire,
        },
        method: "POST",
      });
      return { body: await response.json() as Record<string, unknown>, status: response.status };
    }, {
      algorithm: SESSION_PROOF_ALGORITHM,
      challenge: [...wrongKeyChallenge],
      claim,
      commandId: COMMAND_ID,
      credentialId: CREDENTIAL_ID,
      csrf: LANE_CSRF_TOKEN,
      issuedAt,
      nonce,
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
      requestDigest: wrongKeyDigest,
      sessionId: wrongKeySessionId,
      transportIds: TRANSPORT_IDS,
      wire: WIRE_PROTOCOL,
    });
    expect(wrongKey.body["code"], JSON.stringify(wrongKey.body)).toBe("AUTHENTICATION_FAILED");
    expect(wrongKey.body["layer"], JSON.stringify(wrongKey.body)).toBe("PROOF");

    // ---- DoD 6 (b): A REPLAYED REQUEST ANSWERS FROM THE AUTHORITY'S OWN FENCE ----
    //
    // The accepted payload, re-presented BYTE FOR BYTE. Measured rather than assumed:
    // openSession answers an exact re-presentation from its replay marker, so the honest
    // property is that the second presentation mints NOTHING NEW — same sessionId, never a
    // second authority. A route that turned this into a local refusal would make a dropped
    // response unrecoverable for an honest client, so the arm also pins that the answer is
    // NOT this route's own layer.
    const replayed = await page.evaluate(async (input: {
      readonly body: string;
      readonly csrf: string;
      readonly wire: string;
    }) => {
      const response = await fetch("/session/pair/open", {
        body: input.body,
        headers: {
          "content-type": "application/json",
          "x-moe-csrf": input.csrf,
          "x-moe-protocol-version": input.wire,
        },
        method: "POST",
      });
      return { body: await response.json() as Record<string, unknown>, status: response.status };
    }, { body: opened.requestBody, csrf: LANE_CSRF_TOKEN, wire: WIRE_PROTOCOL });
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    // BYTE-IDENTICAL ANSWER. A route that started refusing, changed its disposition, or
    // answered a different session would move this; the first response is produced by a
    // different request than the second, so no single edit moves both sides.
    expect(JSON.stringify(replayed.body)).toBe(JSON.stringify(opened.body));

    // AND THE PROPERTY ITSELF, MEASURED FROM THE DAEMON'S OWN RECORDS rather than from a
    // key being absent from a response. A second authority for this session would have to
    // advance the aggregate's version; reading it back through the production authority
    // over the daemon's own store is the only place that is observable, because the open
    // route's success body carries no version and never could without leaking one.
    const reader = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
    try {
      const record = createSessionAuthority(reader, {
        clock: () => Date.now(), projectId: scratch.projectId,
      }).readSessionAuthority(claim.sessionId);
      expect(record.status, JSON.stringify(record)).toBe("FOUND");
      if (record.status !== "FOUND") throw new Error("unreachable");
      // ONE durable open after TWO presentations. This is the assertion the clause needs:
      // it fails if the replay minted anything, and it cannot be satisfied by a response
      // shape at all.
      expect(record.authority.version).toBe(1);
      expect(record.authority.publicKey.clientKeyId).toBe(claim.clientKeyId);
      // POSITIVE CONTROL FOR THE READER. A reader that answered FOUND for anything would
      // satisfy the two assertions above without reading the aggregate at all, so a
      // session this journey never opened must come back ABSENT from the same connection.
      expect(createSessionAuthority(reader, {
        clock: () => Date.now(), projectId: scratch.projectId,
      }).readSessionAuthority(`${claim.sessionId}-never-opened`)).toEqual({ status: "ABSENT" });
    } finally {
      reader.close();
    }

  } finally {
    for (const child of [...children].reverse()) await killTree(child);
    try {
      rmSync(scratch.root, { force: true, recursive: true });
    } catch {
      // A scratch dir that outlives its run is a few hundred KB in TEMP, never a fail.
    }
  }
});
