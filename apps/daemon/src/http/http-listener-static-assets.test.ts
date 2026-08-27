import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { CommandAdapterDeps } from "./http-contract.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  LISTENER_REFUSAL_CODES,
  startControlRoomListener,
} from "./http-listener.js";
import type { ControlRoomListener, StartListenerResult } from "./http-listener.js";
import {
  CAPABILITY,
  GOOD_CREDENTIAL,
  authenticator,
  decisionPort,
  envelopeObject,
  recordingHandler,
  registryOf,
} from "./http-test-fixtures.js";
import {
  CONTROL_ROOM_ASSET_CONTENT_TYPES,
  CONTROL_ROOM_ASSET_MAX_BYTES,
  CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  locateControlRoomAsset,
  readControlRoomAssetBytes,
  resolveControlRoomAssetRoot,
} from "./static-asset-host.js";

/**
 * Every case here drives the REAL listener over a real socket. A guard proved
 * only against the path module would pass while the route that reaches it never
 * runs, and the browser shape - a bare navigation carrying Host and nothing else
 * - is exactly what a direct call to the guard cannot reproduce. The handful of
 * direct calls below pin clauses the socket cannot reach (a raw lone surrogate
 * cannot arrive through Node's parser) or cannot observe (which path a read
 * targeted, and that a locate carries no bytes).
 */
const CSRF = "csrf-token-for-test";
/** The daemon credential the entry would hand the listener; a value, never the fixture's. */
const DAEMON_CREDENTIAL = "daemon-credential-0123456789abcdef0123456789abcdef";
const PAYLOAD_KEYS = ["title"] as const;

const BUNDLE_INDEX = "<!doctype html><title>moe control room</title>\n";
const BUNDLE_SCRIPT = "export const controlRoom = 1;\n";
const BUNDLE_STYLE = ":root{color:#fff}\n";
const NFC_SCRIPT = "export const accent = 'nfc';\n";
const OUTSIDE_SECRET = "export const secret = 'stolen';\n";
/** NFC: U+00E9 as one code point. Its NFD spelling is `e` + U+0301. */
const NFC_NAME = "caf\u00e9.js";

let workspace = "";
let bundleRoot = "";
let outsideRoot = "";
/** index.html carries the CSRF token. */
let csrfLeakRoot = "";
/** assets/app.js carries the daemon credential. */
let credentialLeakRoot = "";
/** The only copy of a secret is in a `.txt`, which the host can never serve. */
let unservableSecretRoot = "";
let noIndexRoot = "";
let directoryIndexRoot = "";
/** A bundle that also carries the files a mis-set root would expose. */
let repoLikeRoot = "";
let foreignBakedRoot = "";
let escapedSecretRoot = "";
/** A credential THIS daemon never held: only the baked env key can name the leak. */
const FOREIGN_CREDENTIAL = "cafe".repeat(16);
/** A secret a minifier must escape, so its verbatim bytes never reach the bundle. */
const ESCAPING_CREDENTIAL = "op\\key\"with-escapes";

function deps(): CommandAdapterDeps {
  return {
    authenticator: authenticator([CAPABILITY]),
    decisions: decisionPort(),
    registry: registryOf("goal.create", recordingHandler().handler, PAYLOAD_KEYS),
  };
}

function bundleAt(root: string, index = BUNDLE_INDEX): void {
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), index, "utf8");
  writeFileSync(join(root, "assets", "index.js"), BUNDLE_SCRIPT, "utf8");
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "moe-asset-host-"));
  bundleRoot = join(workspace, "bundle");
  outsideRoot = join(workspace, "outside");
  bundleAt(bundleRoot);
  mkdirSync(outsideRoot, { recursive: true });
  writeFileSync(join(bundleRoot, "assets", "index.css"), BUNDLE_STYLE, "utf8");
  writeFileSync(join(bundleRoot, "notes.txt"), "not a servable type\n", "utf8");
  writeFileSync(join(bundleRoot, NFC_NAME), NFC_SCRIPT, "utf8");
  // A DIRECTORY whose name carries a servable extension: it clears the type map
  // and the containment proof, so only the is-a-regular-file clause refuses it.
  mkdirSync(join(bundleRoot, "directory.js"), { recursive: true });
  // One byte over the ceiling and exactly at it. Extended by truncate rather
  // than written, so the fixture costs no time and no real disk.
  writeFileSync(join(bundleRoot, "over.js"), "", "utf8");
  truncateSync(join(bundleRoot, "over.js"), CONTROL_ROOM_ASSET_MAX_BYTES + 1);
  writeFileSync(join(bundleRoot, "atcap.js"), "", "utf8");
  truncateSync(join(bundleRoot, "atcap.js"), CONTROL_ROOM_ASSET_MAX_BYTES);
  writeFileSync(join(outsideRoot, "secret.js"), OUTSIDE_SECRET, "utf8");
  // A junction rather than a file symlink: Windows creates a directory junction
  // without elevation, and Node ignores the type argument on other platforms, so
  // one call gives the same escape shape everywhere this suite runs.
  symlinkSync(outsideRoot, join(bundleRoot, "escape"), "junction");
  // A junction INSIDE the root, to a directory inside the root: every name on
  // the way is legal and the target is contained, so the request serves - and
  // the spelling the caller used is not the path the proven file lives at.
  symlinkSync(join(bundleRoot, "assets"), join(bundleRoot, "alias"), "junction");

  csrfLeakRoot = join(workspace, "csrf-leak");
  bundleAt(csrfLeakRoot, `<!doctype html><script>const csrf = "${CSRF}";</script>\n`);
  credentialLeakRoot = join(workspace, "credential-leak");
  bundleAt(credentialLeakRoot);
  writeFileSync(
    join(credentialLeakRoot, "assets", "app.js"),
    `export const credential = "${DAEMON_CREDENTIAL}";\n`,
    "utf8",
  );
  unservableSecretRoot = join(workspace, "unservable-secret");
  bundleAt(unservableSecretRoot);
  writeFileSync(join(unservableSecretRoot, "notes.txt"), `${CSRF}\n${DAEMON_CREDENTIAL}\n`, "utf8");
  noIndexRoot = join(workspace, "no-index");
  mkdirSync(join(noIndexRoot, "assets"), { recursive: true });
  writeFileSync(join(noIndexRoot, "assets", "index.js"), BUNDLE_SCRIPT, "utf8");
  directoryIndexRoot = join(workspace, "directory-index");
  mkdirSync(join(directoryIndexRoot, "index.html"), { recursive: true });
  repoLikeRoot = join(workspace, "repo-like");
  bundleAt(repoLikeRoot);
  writeFileSync(join(repoLikeRoot, "project.json"), "{\"board\":\"state\"}\n", "utf8");
  writeFileSync(join(repoLikeRoot, "index.js.map"), "{\"mappings\":\"\"}\n", "utf8");
  // A bundle baked for ANOTHER daemon: Vite emits the env key with its literal,
  // so the key itself names the leak even though this process cannot know the
  // value. A clean build carries no such key at all.
  foreignBakedRoot = join(workspace, "foreign-baked");
  bundleAt(foreignBakedRoot);
  writeFileSync(
    join(foreignBakedRoot, "assets", "app.js"),
    "const env={BASE_URL:\"/\",VITE_MOE_LIVE_CREDENTIAL:`" + FOREIGN_CREDENTIAL + "`,VITE_MOE_LIVE_CSRF:`f00d`};\n",
    "utf8",
  );
  // A secret the minifier had to escape: the bundle carries its JSON spelling,
  // which a scan over the verbatim bytes alone would walk straight past.
  escapedSecretRoot = join(workspace, "escaped-secret");
  bundleAt(escapedSecretRoot);
  writeFileSync(
    join(escapedSecretRoot, "assets", "app.js"),
    `export const credential = ${JSON.stringify(ESCAPING_CREDENTIAL)};\n`,
    "utf8",
  );
});

afterAll(() => {
  rmSync(workspace, { force: true, recursive: true });
});

interface AssetReply {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly status: number;
}

/**
 * The BROWSER shape: Host and nothing else. No Origin, no CSRF header and no
 * credential, because a top-level navigation carries none of them - a helper
 * that sent them would prove the route works for a client no browser is. The
 * optional extra headers are the conditional-request ones a browser DOES send.
 */
async function fetchAsset(
  listener: ControlRoomListener,
  path: string,
  init: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly host?: string;
    readonly method?: string;
  } = {},
): Promise<AssetReply> {
  return await new Promise<AssetReply>((resolve, reject) => {
    const call = httpRequest(
      {
        headers: { ...init.headers, host: init.host ?? `127.0.0.1:${listener.port}` },
        host: "127.0.0.1",
        method: init.method ?? "GET",
        path,
        port: listener.port,
        setHost: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          status: response.statusCode ?? 0,
        }));
      },
    );
    call.on("error", reject);
    call.end();
  });
}

/** The JSON surface, sent the way it has always been sent. */
async function postCommand(listener: ControlRoomListener): Promise<AssetReply> {
  const payload = JSON.stringify(envelopeObject());
  return await new Promise<AssetReply>((resolve, reject) => {
    const call = httpRequest(
      {
        headers: {
          "content-length": Buffer.byteLength(payload),
          "content-type": "application/json",
          host: `127.0.0.1:${listener.port}`,
          origin: listener.origin,
          "x-moe-csrf": CSRF,
          "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
          "x-moe-session-credential": GOOD_CREDENTIAL,
        },
        host: "127.0.0.1",
        method: "POST",
        path: "/command",
        port: listener.port,
        setHost: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          status: response.statusCode ?? 0,
        }));
      },
    );
    call.on("error", reject);
    call.end(payload);
  });
}

async function usingListener(
  started: StartListenerResult,
  run: (listener: ControlRoomListener) => Promise<void>,
): Promise<void> {
  if (!started.ok) throw new Error(`listener refused to start: ${started.code}`);
  // Closed on every exit path including a throwing body: a leaked handle
  // surfaces later on Windows as EBUSY rather than as the real error.
  try {
    await run(started);
  } finally {
    await started.close();
  }
}

/** The entry's shape: the daemon credential travels in as a secret the root may not carry. */
async function startHosting(root: string): Promise<StartListenerResult> {
  return await startControlRoomListener({
    assetRoot: root, assetSecrets: [DAEMON_CREDENTIAL], csrfToken: CSRF, deps: deps(),
  });
}

async function withAssetHost(
  run: (listener: ControlRoomListener) => Promise<void>,
): Promise<void> {
  await usingListener(await startHosting(bundleRoot), run);
}

async function withoutAssetHost(
  run: (listener: ControlRoomListener) => Promise<void>,
): Promise<void> {
  await usingListener(await startControlRoomListener({ csrfToken: CSRF, deps: deps() }), run);
}

/**
 * Names the CODE, the LAYER and the STATUS together. A case asserting only that
 * something was refused passes when the wrong guard answered, and a case
 * asserting only the code passes when the status leaks what the code hides.
 */
function expectAssetRefusal(reply: AssetReply, code: string, status: number): void {
  expect(JSON.parse(reply.body.toString("utf8"))).toEqual({
    code,
    layer: CONTROL_ROOM_LISTENER_LAYER,
  });
  expect(reply.status).toBe(status);
  expect((LISTENER_REFUSAL_CODES as readonly string[]).includes(code)).toBe(true);
}

/** Every policy header, by exact value, on one reply. */
function expectPolicyHeaders(reply: AssetReply): void {
  expect(reply.headers["content-security-policy"])
    .toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  expect(reply.headers["x-frame-options"]).toBe("DENY");
  expect(reply.headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(reply.headers["referrer-policy"]).toBe("no-referrer");
  expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  expect(reply.headers["cache-control"]).toBe("no-cache");
}

const root = () => {
  const resolved = resolveControlRoomAssetRoot(bundleRoot, [CSRF, DAEMON_CREDENTIAL]);
  if (resolved.kind !== "ROOT") throw new Error(`fixture root refused: ${resolved.code}`);
  return resolved;
};

it("answers from a CLOSED extension map, frozen and spelled one way", () => {
  expect(Object.isFrozen(CONTROL_ROOM_ASSET_CONTENT_TYPES)).toBe(true);
  // No `.json` and no `.map`: the built bundle emits neither, and `.json` is
  // what turns a mis-set root into a board-state leak.
  expect(Object.keys(CONTROL_ROOM_ASSET_CONTENT_TYPES).sort()).toEqual([
    ".css", ".html", ".js", ".png", ".svg", ".woff2",
  ]);
  for (const [extension, type] of Object.entries(CONTROL_ROOM_ASSET_CONTENT_TYPES)) {
    expect(extension).toMatch(/^\.[a-z0-9]+$/u);
    expect(type).not.toContain("octet-stream");
  }
});

it("publishes the policy header set as one frozen record and sends it on EVERY static reply", async () => {
  expect(Object.isFrozen(CONTROL_ROOM_ASSET_RESPONSE_HEADERS)).toBe(true);
  expect(Object.keys(CONTROL_ROOM_ASSET_RESPONSE_HEADERS).sort()).toEqual([
    "cache-control", "content-security-policy", "cross-origin-resource-policy",
    "referrer-policy", "x-content-type-options", "x-frame-options",
  ]);
  // React uses bounded style attributes for progress and status visuals. Script
  // remains same-origin only; the style exception must never widen script.
  expect(CONTROL_ROOM_ASSET_RESPONSE_HEADERS["content-security-policy"])
    .toContain("style-src 'self' 'unsafe-inline'");
  expect(CONTROL_ROOM_ASSET_RESPONSE_HEADERS["content-security-policy"])
    .not.toContain("script-src 'self' 'unsafe-inline'");
  await withAssetHost(async (listener) => {
    const success = await fetchAsset(listener, "/");
    expect(success.status).toBe(200);
    expectPolicyHeaders(success);

    const head = await fetchAsset(listener, "/assets/index.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expectPolicyHeaders(head);

    const etag = success.headers["etag"];
    if (typeof etag !== "string") throw new Error("no validator on the success reply");
    const unchanged = await fetchAsset(listener, "/", { headers: { "if-none-match": etag } });
    expect(unchanged.status).toBe(304);
    expectPolicyHeaders(unchanged);

    // A refusal is a reply this route wrote too, and a framed 404 is still a
    // frame; the JSON body keeps its own type.
    const missing = await fetchAsset(listener, "/assets/missing.js");
    expectAssetRefusal(missing, "LISTENER_ASSET_NOT_FOUND", 404);
    expectPolicyHeaders(missing);
    expect(missing.headers["content-type"]).toBe("application/json");
    const rebound = await fetchAsset(listener, "/index.html", { host: "evil.example.com" });
    expectAssetRefusal(rebound, "LISTENER_HOST_INVALID", 403);
    expectPolicyHeaders(rebound);
  });
});

it("serves the entry document at / with its exact bytes and its exact type", async () => {
  await withAssetHost(async (listener) => {
    const reply = await fetchAsset(listener, "/");
    expect(reply.status).toBe(200);
    expect(reply.body.toString("utf8")).toBe(BUNDLE_INDEX);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.headers["content-length"]).toBe(String(Buffer.byteLength(BUNDLE_INDEX)));
    // The type came from a closed map, so the browser may not re-derive one.
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });
});

it("serves the hashed script and stylesheet the built bundle actually references", async () => {
  await withAssetHost(async (listener) => {
    const script = await fetchAsset(listener, "/assets/index.js");
    expect(script.status).toBe(200);
    expect(script.body.toString("utf8")).toBe(BUNDLE_SCRIPT);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");

    const style = await fetchAsset(listener, "/assets/index.css");
    expect(style.status).toBe(200);
    expect(style.body.toString("utf8")).toBe(BUNDLE_STYLE);
    expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");
  });
});

it("HEAD answers the same headers and NO body, with GET's own validator and length", async () => {
  await withAssetHost(async (listener) => {
    const get = await fetchAsset(listener, "/index.html");
    const reply = await fetchAsset(listener, "/index.html", { method: "HEAD" });
    expect(reply.status).toBe(200);
    expect(reply.body.byteLength).toBe(0);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    // The real file's length, not an invented one a client would cache, and the
    // same validator a GET carries: both come from one stat of the proven path.
    expect(reply.headers["content-length"]).toBe(String(Buffer.byteLength(BUNDLE_INDEX)));
    expect(reply.headers["etag"]).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/u);
    expect(reply.headers["etag"]).toBe(get.headers["etag"]);
  });
});

it("LOCATES without reading: a dispatch carries a length and a validator and no bytes", () => {
  // The socket cannot see whether HEAD read the file, so the clause is pinned
  // at the seam: a locate is measured, never read, for HEAD and GET alike, and
  // the read is a separate step that takes the located record only.
  for (const method of ["HEAD", "GET"]) {
    const located = locateControlRoomAsset(root(), method, "/index.html");
    if (located.kind !== "ASSET") throw new Error(`locate refused: ${located.code}`);
    expect(Object.keys(located).sort()).toEqual(["contentType", "etag", "kind", "provenPath", "size"]);
    expect(located.size).toBe(Buffer.byteLength(BUNDLE_INDEX));
    expect(located.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/u);
    const bytes = readControlRoomAssetBytes(located);
    expect(bytes instanceof Uint8Array).toBe(true);
    expect(Buffer.from(bytes as Uint8Array).toString("utf8")).toBe(BUNDLE_INDEX);
  }
});

it("answers a matching If-None-Match with 304 and no body, and a stale one with the full file", async () => {
  await withAssetHost(async (listener) => {
    const first = await fetchAsset(listener, "/assets/index.js");
    expect(first.status).toBe(200);
    const etag = first.headers["etag"];
    if (typeof etag !== "string") throw new Error("no validator on the success reply");

    const unchanged = await fetchAsset(listener, "/assets/index.js", {
      headers: { "if-none-match": etag },
    });
    expect(unchanged.status).toBe(304);
    expect(unchanged.body.byteLength).toBe(0);
    expect(unchanged.headers["etag"]).toBe(etag);

    // RFC 7232 weak comparison: a strong spelling of the same tag, a list that
    // contains it, and `*` all match.
    for (const header of [etag.replace(/^W\//u, ""), `"nope", ${etag}`, "*"]) {
      const reply = await fetchAsset(listener, "/assets/index.js", {
        headers: { "if-none-match": header },
      });
      expect(reply.status).toBe(304);
      expect(reply.body.byteLength).toBe(0);
    }

    const stale = await fetchAsset(listener, "/assets/index.js", {
      headers: { "if-none-match": "W/\"0-0\"" },
    });
    expect(stale.status).toBe(200);
    expect(stale.body.toString("utf8")).toBe(BUNDLE_SCRIPT);
    // A validator from ANOTHER file never answers for this one.
    const other = await fetchAsset(listener, "/assets/index.css", {
      headers: { "if-none-match": etag },
    });
    expect(other.status).toBe(200);
    expect(other.body.toString("utf8")).toBe(BUNDLE_STYLE);
  });
});

it("refuses a file above the ceiling on GET and HEAD alike, and serves one exactly at it", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(await fetchAsset(listener, "/over.js"), "LISTENER_ASSET_TOO_LARGE", 403);
    // HEAD carries no body even on a refusal, so the status and the type are
    // the whole observable: the same 403 GET got, from the same stat.
    const head = await fetchAsset(listener, "/over.js", { method: "HEAD" });
    expect(head.status).toBe(403);
    expect(head.headers["content-type"]).toBe("application/json");
    expect(head.body.byteLength).toBe(0);
    expectPolicyHeaders(head);
    // Exactly at the ceiling is inside it. HEAD, so the case costs a stat and
    // no transfer; the length is the real one.
    const atCap = await fetchAsset(listener, "/atcap.js", { method: "HEAD" });
    expect(atCap.status).toBe(200);
    expect(atCap.headers["content-length"]).toBe(String(CONTROL_ROOM_ASSET_MAX_BYTES));
    expect(atCap.body.byteLength).toBe(0);
  });
  expect(CONTROL_ROOM_ASSET_MAX_BYTES).toBe(8 * 1024 * 1024);
});

it("DECODES before judging, so an escaped spelling of a real asset still serves", async () => {
  await withAssetHost(async (listener) => {
    // The positive control for the decode step: `%2E` is `.`, and this is the
    // same file as `/assets/index.js`. Without it every encoding case below
    // would pass on a guard that simply refused anything containing a percent.
    const reply = await fetchAsset(listener, "/assets/index%2Ejs");
    expect(reply.status).toBe(200);
    expect(reply.body.toString("utf8")).toBe(BUNDLE_SCRIPT);
    expect(reply.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  });
});

it("refuses a raw dot-dot traversal", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(
      await fetchAsset(listener, "/../outside/secret.js"),
      "LISTENER_ASSET_PATH_TRAVERSAL",
      403,
    );
  });
});

it("refuses a dot-dot traversal that only appears AFTER decoding", async () => {
  await withAssetHost(async (listener) => {
    // `%2e%2e` is `..`. A guard reading the raw spelling never sees it, which is
    // why the decode runs first and the judgement runs on the decoded text.
    expectAssetRefusal(
      await fetchAsset(listener, "/%2e%2e/outside/secret.js"),
      "LISTENER_ASSET_PATH_TRAVERSAL",
      403,
    );
  });
});

it("refuses a traversal whose SEPARATOR is the encoded half", async () => {
  await withAssetHost(async (listener) => {
    // `%2f` is `/`. A guard that split the raw target into segments before
    // decoding would see one segment here - `index.js%2f..%2fsecret.js` - and
    // find nothing wrong with it. Splitting the DECODED text is what sees the
    // `..` this actually spells.
    expectAssetRefusal(
      await fetchAsset(listener, "/assets/index.js%2f..%2f..%2foutside%2fsecret.js"),
      "LISTENER_ASSET_PATH_TRAVERSAL",
      403,
    );
  });
});

it("refuses a single-dot segment rather than normalising it away", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(
      await fetchAsset(listener, "/./index.html"),
      "LISTENER_ASSET_PATH_TRAVERSAL",
      403,
    );
  });
});

it("refuses a DOUBLE-encoded traversal instead of decoding it twice", async () => {
  await withAssetHost(async (listener) => {
    // `%252e%252e` decodes once to `%2e%2e`, which is still an escape and still
    // spells `..`. Decoding again would admit it; refusing the path that decodes
    // differently a second time is the only reading that cannot be layered.
    expectAssetRefusal(
      await fetchAsset(listener, "/%252e%252e/outside/secret.js"),
      "LISTENER_ASSET_ENCODING_INVALID",
      400,
    );
  });
});

it("refuses a percent escape that is not an escape at all", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(
      await fetchAsset(listener, "/assets/%zz.js"),
      "LISTENER_ASSET_ENCODING_INVALID",
      400,
    );
    expectAssetRefusal(
      await fetchAsset(listener, "/assets/%.js"),
      "LISTENER_ASSET_ENCODING_INVALID",
      400,
    );
  });
});

it("refuses a backslash separator, which Windows would honour as a path break", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(
      await fetchAsset(listener, "/assets\\index.js"),
      "LISTENER_ASSET_PATH_TRAVERSAL",
      403,
    );
  });
});

it("refuses a UNC spelling and a drive-absolute spelling, each as its own shape", async () => {
  await withAssetHost(async (listener) => {
    // `//server/share/...` reaches the socket with an empty first segment: a
    // directory claim, not a name under this root.
    expectAssetRefusal(
      await fetchAsset(listener, "//server/share/secret.js"),
      "LISTENER_ASSET_PATH_TRAVERSAL",
      403,
    );
    // `/C:/...` is a rooted drive spelling; the colon is what the segment rule
    // refuses, exactly as it refuses an alternate data stream.
    expectAssetRefusal(
      await fetchAsset(listener, "/C:/Windows/win.ini"),
      "LISTENER_ASSET_SEGMENT_INVALID",
      403,
    );
  });
});

it("refuses a trailing slash rather than answering a directory", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(
      await fetchAsset(listener, "/assets/"),
      "LISTENER_ASSET_PATH_TRAVERSAL",
      403,
    );
  });
});

it("refuses an NTFS alternate data stream on a name that would otherwise serve", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(
      await fetchAsset(listener, "/assets/index.js:secret"),
      "LISTENER_ASSET_SEGMENT_INVALID",
      403,
    );
  });
});

it.each([
  ["/NUL.js", "a bare device with a servable extension"],
  ["/COM1.js", "a numbered serial device"],
  ["/LPT9.js", "a numbered printer device"],
  ["/CONIN$.js", "a console device whose name carries a dollar"],
  ["/CON%20.js", "a device whose stem ends in the space Windows drops"],
  ["/assets/index.js.", "a trailing dot Windows strips before resolving"],
  ["/assets/index%09.js", "a control character inside a segment"],
  ["/assets/in<dex.js", "a character Win32 forbids in a file name"],
  ["/assets/index.js%00.txt", "an embedded NUL, which truncates a validated name"],
])("refuses %s (%s) with the segment code", async (path) => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(await fetchAsset(listener, path), "LISTENER_ASSET_SEGMENT_INVALID", 403);
  });
});

it("refuses an over-long path as TEXT, before the filesystem can answer for it", async () => {
  await withAssetHost(async (listener) => {
    // Two legal 130-character segments: every segment is a valid name, no
    // segment is over NTFS's 255, and the whole spelling is 267 characters -
    // over the 260 bound. Without the text clause this reaches the filesystem
    // and comes back NOT_FOUND; the bound is what refuses it as a segment fault.
    const path = `/${"a".repeat(130)}/${"b".repeat(130)}/x.js`;
    expect(path.length).toBeGreaterThan(260);
    expectAssetRefusal(await fetchAsset(listener, path), "LISTENER_ASSET_SEGMENT_INVALID", 403);
  });
});

it("refuses a lone surrogate: at the decode step when percent-encoded, at the text step when raw", async () => {
  await withAssetHost(async (listener) => {
    // `%ED%A0%80` is the UTF-8 shape of U+D800. `decodeURIComponent` refuses a
    // surrogate code point encoded that way, so the measured answer is the
    // ENCODING code, not the segment one - pinned as what it is.
    expectAssetRefusal(
      await fetchAsset(listener, "/x%ED%A0%80.js"),
      "LISTENER_ASSET_ENCODING_INVALID",
      400,
    );
  });
  // A RAW lone surrogate cannot arrive through Node's parser (the request
  // target is bytes), so the `isWellFormed` clause is pinned at the seam: it
  // is the text rule that refuses it, not an ENOENT turned into NOT_FOUND.
  expect(locateControlRoomAsset(root(), "GET", "/x\uD800.js"))
    .toEqual({ code: "LISTENER_ASSET_SEGMENT_INVALID", kind: "LISTENER_REFUSAL" });
});

it("refuses an NFD spelling of a name whose NFC form exists, and serves the NFC spelling", async () => {
  await withAssetHost(async (listener) => {
    // The positive control: the file is `caf\u00e9.js` and its NFC spelling serves.
    const nfc = await fetchAsset(listener, "/caf%C3%A9.js");
    expect(nfc.status).toBe(200);
    expect(nfc.body.toString("utf8")).toBe(NFC_SCRIPT);
    // `e` + U+0301 is the same glyph and a different string. NTFS would say
    // NOT_FOUND and a normalising volume would serve it; the text rule refuses
    // it the same way everywhere, as a segment fault.
    expectAssetRefusal(
      await fetchAsset(listener, "/cafe%CC%81.js"),
      "LISTENER_ASSET_SEGMENT_INVALID",
      403,
    );
  });
});

it("compares a device stem by EQUALITY, so an ordinary name containing one still resolves", async () => {
  await withAssetHost(async (listener) => {
    // The negative control for the device rule. `CONSOLE` merely CONTAINS `CON`;
    // refusing it would mean the guard was matching substrings, and every case
    // above would then pass for the wrong reason. It is absent from the bundle,
    // so the honest answer is NOT_FOUND - the device rule never fired.
    expectAssetRefusal(
      await fetchAsset(listener, "/CONSOLE.js"),
      "LISTENER_ASSET_NOT_FOUND",
      404,
    );
  });
});

it("refuses a path that resolves THROUGH a junction out of the root", async () => {
  await withAssetHost(async (listener) => {
    // Every segment here is a legal name and the extension is servable: the only
    // thing wrong with it is where it lands, which no text rule can see. The
    // containment proof is what refuses it.
    const reply = await fetchAsset(listener, "/escape/secret.js");
    expectAssetRefusal(reply, "LISTENER_ASSET_OUTSIDE_ROOT", 403);
    expect(reply.body.toString("utf8")).not.toContain("stolen");
  });
});

it("reads the PROVEN path, never the caller's spelling: an alias inside the root serves the canonical file", async () => {
  await withAssetHost(async (listener) => {
    const reply = await fetchAsset(listener, "/alias/index.js");
    expect(reply.status).toBe(200);
    expect(reply.body.toString("utf8")).toBe(BUNDLE_SCRIPT);
  });
  // The bytes alone cannot tell the two reads apart (the alias reaches the same
  // file), so the clause is pinned where it is decided: the located record names
  // the canonical path, and the read takes that record and nothing else.
  const located = locateControlRoomAsset(root(), "GET", "/alias/index.js");
  if (located.kind !== "ASSET") throw new Error(`locate refused: ${located.code}`);
  expect(located.provenPath).toBe(realpathSync.native(join(bundleRoot, "assets", "index.js")));
  expect(located.provenPath).not.toContain("alias");
});

it("refuses an extension absent from the map rather than guessing a type", async () => {
  await withAssetHost(async (listener) => {
    // The file EXISTS. Refusing it on type alone is the point: an unknown
    // extension is never served as octet-stream guesswork.
    expectAssetRefusal(await fetchAsset(listener, "/notes.txt"), "LISTENER_ASSET_TYPE_UNKNOWN", 415);
    expectAssetRefusal(await fetchAsset(listener, "/assets"), "LISTENER_ASSET_TYPE_UNKNOWN", 415);
  });
});

it("serves no .json and no .map even from a root that carries them", async () => {
  // A bundle that ALSO holds the files a mis-set root would expose. Both exist,
  // both would pass every path rule; the closed map is what keeps them off the
  // wire, and that is what made dropping the two extensions worth doing.
  await usingListener(await startHosting(repoLikeRoot), async (listener) => {
    expectAssetRefusal(await fetchAsset(listener, "/project.json"), "LISTENER_ASSET_TYPE_UNKNOWN", 415);
    expectAssetRefusal(await fetchAsset(listener, "/index.js.map"), "LISTENER_ASSET_TYPE_UNKNOWN", 415);
    expect((await fetchAsset(listener, "/")).status).toBe(200);
  });
});

it("refuses a servable extension that names a directory or nothing at all", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(
      await fetchAsset(listener, "/directory.js"),
      "LISTENER_ASSET_NOT_FOUND",
      404,
    );
    expectAssetRefusal(
      await fetchAsset(listener, "/assets/missing.js"),
      "LISTENER_ASSET_NOT_FOUND",
      404,
    );
  });
});

it("answers GET and HEAD only, refusing a write method aimed at an asset path", async () => {
  await withAssetHost(async (listener) => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expectAssetRefusal(
        await fetchAsset(listener, "/index.html", { method }),
        "LISTENER_ASSET_METHOD_INVALID",
        405,
      );
    }
  });
});

it("still refuses a foreign Host on the asset route, which is what stops a rebound name", async () => {
  await withAssetHost(async (listener) => {
    expectAssetRefusal(
      await fetchAsset(listener, "/index.html", { host: "evil.example.com" }),
      "LISTENER_HOST_INVALID",
      403,
    );
  });
});

it("leaves the JSON surface exactly as it was while hosting a bundle", async () => {
  await withAssetHost(async (listener) => {
    const reply = await postCommand(listener);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body.toString("utf8"))).toMatchObject({ outcome: "ACCEPTED" });
  });
});

it("hosts NOTHING when no root was given: the JSON routes answer and asset paths 404", async () => {
  await withoutAssetHost(async (listener) => {
    const command = await postCommand(listener);
    expect(command.status).toBe(200);
    expect(JSON.parse(command.body.toString("utf8"))).toMatchObject({ outcome: "ACCEPTED" });

    // The pre-existing answer, unchanged: no static host was wired, so these are
    // unknown routes rather than missing assets.
    for (const path of ["/", "/index.html", "/assets/index.js"]) {
      expectAssetRefusal(await fetchAsset(listener, path), "LISTENER_ROUTE_UNKNOWN", 404);
    }
  });
});

it.each([
  ["a path that is not a directory", (): string => join(bundleRoot, "index.html")],
  ["a directory that does not exist", (): string => join(workspace, "no-such-bundle")],
  ["a relative spelling", (): string => "bundle"],
  ["an empty spelling", (): string => ""],
])("REFUSES TO START on %s as the asset root", async (_label, root) => {
  const started = await startHosting(root());
  expect(started).toMatchObject({
    code: "LISTENER_ASSET_ROOT_INVALID",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
  // The operator's fix travels as a detail; it names the root, never a secret.
  expect(typeof (started as { detail?: unknown }).detail).toBe("string");
  expect(JSON.stringify(started)).not.toContain(CSRF);
  expect(JSON.stringify(started)).not.toContain(DAEMON_CREDENTIAL);
  expect(started).not.toHaveProperty("port");
});

it.each([
  ["no index.html at all", (): string => noIndexRoot],
  ["an index.html that is a directory", (): string => directoryIndexRoot],
])("REFUSES TO START on a directory with %s: a root must be a bundle", async (_label, root) => {
  // Both roots exist, both are directories, and one of them even holds a
  // servable script. What neither holds is the bundle's entry document as a
  // regular file, which is what stops a repo root, a volume root or an empty
  // directory from being hosted.
  const started = await startHosting(root());
  expect(started).toMatchObject({
    code: "LISTENER_ASSET_ROOT_INVALID",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
  expect((started as { detail?: string }).detail).toContain("index.html");
});

it("REFUSES TO START over a root whose index.html carries the CSRF token, naming the file and not the token", async () => {
  const started = await startHosting(csrfLeakRoot);
  expect(started).toMatchObject({
    code: "LISTENER_ASSET_ROOT_LEAKS_SECRET",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
  const detail = (started as { detail?: string }).detail ?? "";
  expect(detail).toContain("/index.html");
  expect(JSON.stringify(started)).not.toContain(CSRF);
  expect(started).not.toHaveProperty("port");
});

it("REFUSES TO START over a root whose script carries the daemon credential the entry handed in", async () => {
  const started = await startHosting(credentialLeakRoot);
  expect(started).toMatchObject({
    code: "LISTENER_ASSET_ROOT_LEAKS_SECRET",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
  const detail = (started as { detail?: string }).detail ?? "";
  // The request-path spelling, so the operator knows WHICH file to rebuild.
  expect(detail).toContain("/assets/app.js");
  expect(JSON.stringify(started)).not.toContain(DAEMON_CREDENTIAL);
  // The same root with no credential to scan for starts: the scan compares what
  // it was given, and the CSRF token is not in that bundle.
  await usingListener(
    await startControlRoomListener({ assetRoot: credentialLeakRoot, csrfToken: CSRF, deps: deps() }),
    async (listener) => { expect((await fetchAsset(listener, "/")).status).toBe(200); },
  );
});

it("REFUSES TO START over a bundle baked for ANOTHER daemon, by the env key it carries", async () => {
  // This process does not hold FOREIGN_CREDENTIAL, so a scan over its own
  // values would accept the root and hand a live secret from some other daemon
  // to every loopback process. The baked key is the tell.
  const started = await startHosting(foreignBakedRoot);
  expect(started).toMatchObject({
    code: "LISTENER_ASSET_ROOT_LEAKS_SECRET",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
  expect((started as { detail?: string }).detail ?? "").toContain("/assets/app.js");
  expect(JSON.stringify(started)).not.toContain(FOREIGN_CREDENTIAL);
});

it("REFUSES TO START over a bundle carrying the JSON-escaped spelling of a secret it holds", async () => {
  // The verbatim bytes of ESCAPING_CREDENTIAL never appear in the file - only
  // the escaped form the minifier writes - and the scan must still find it.
  const started = await startControlRoomListener({
    assetRoot: escapedSecretRoot, assetSecrets: [ESCAPING_CREDENTIAL], csrfToken: CSRF, deps: deps(),
  });
  expect(started).toMatchObject({
    code: "LISTENER_ASSET_ROOT_LEAKS_SECRET",
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  });
  expect((started as { detail?: string }).detail ?? "").toContain("/assets/app.js");
  // The same root is clean for a daemon that does not hold that secret.
  await usingListener(await startHosting(escapedSecretRoot), async (listener) => {
    expect((await fetchAsset(listener, "/")).status).toBe(200);
  });
});

it("starts over a root whose only copy of a secret sits in a file it can never serve", async () => {
  // The negative control for the scan's scope: `notes.txt` holds both secrets
  // and is refused on type before any byte is read, so it is not servable and
  // is not scanned. A scan that refused this root would be reading files the
  // host does not publish.
  await usingListener(await startHosting(unservableSecretRoot), async (listener) => {
    expect((await fetchAsset(listener, "/")).status).toBe(200);
    expectAssetRefusal(await fetchAsset(listener, "/notes.txt"), "LISTENER_ASSET_TYPE_UNKNOWN", 415);
  });
});

it("binds NOTHING behind a refused start: the port it was given is still free afterwards", async () => {
  // An ephemeral port, learned and released, then handed to a start that must
  // refuse on its root. If the listener resolved the root AFTER binding, the
  // refusal would come back without a `port` and leave a socket on this one -
  // which is why the earlier "no port property" assertion could not fail for the
  // reason it named. Rebinding is the observation that can.
  const probe = createServer();
  await new Promise<void>((resolve) => { probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("probe did not bind");
  const port = address.port;
  await new Promise<void>((resolve) => { probe.close(() => resolve()); });

  const started = await startControlRoomListener({
    assetRoot: noIndexRoot, csrfToken: CSRF, deps: deps(), port,
  });
  expect(started).toMatchObject({ code: "LISTENER_ASSET_ROOT_INVALID", ok: false });

  const rebind = createServer();
  const bound = await new Promise<boolean>((resolve) => {
    rebind.once("error", () => resolve(false));
    rebind.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (bound) await new Promise<void>((resolve) => { rebind.close(() => resolve()); });
  expect(bound).toBe(true);
});
