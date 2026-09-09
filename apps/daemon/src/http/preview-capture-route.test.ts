/**
 * THE CAPTURE ROUTE'S BOUNDARY, driven over a real socket against a real previews tree.
 *
 * ONE ARM PER REFUSAL CLASS, and every arm asserts the CODE — never merely that something was
 * refused. Six guards can answer a bad capture path and they answer in a FIXED ORDER, so an arm
 * that only checked "not 200" would stay green while a cheaper guard answered first and the
 * guard it claims to test stopped being reachable. Each case below therefore pins the exact
 * code, the layer and the status together.
 *
 * THE POSITIVE CONTROL IS STRUCTURAL: `serves a real capture` runs against the same root as
 * every refusal, so a route that refused everything would fail it. Without that arm the whole
 * file would pass on a handler that answered 403 unconditionally.
 *
 * THE ROOT IS A REAL `.moe-next/previews` TREE containing exactly the neighbours DoD 3 is about
 * — a `.sqlite`, a `.json`, a dotfile, and the three text types the SHARED content-type map
 * publishes (`.js`, `.html`, `.css`) plus `.svg`. The last four are the interesting ones: they
 * are what a root-confined server built on the unnarrowed locator WOULD have handed out.
 */
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticationResult, Authenticator, CommandAdapterDeps } from "./http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { CONTROL_ROOM_LISTENER_LAYER, LISTENER_REFUSAL_CODES } from "./http-listener-guards.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import { GOOD_CREDENTIAL, decisionPort, recordingHandler, registryOf } from "./http-test-fixtures.js";
import {
  PREVIEW_CAPTURE_CONTENT_TYPES, previewsRootRelativePath,
} from "./preview-capture-route.js";

const CSRF = "csrf-token-for-capture";
const GOAL = "goal-42";
const SHA = "0123456789abcdef0123456789abcdef01234567";
/** Eight bytes of PNG signature and nothing else: the route publishes by NAME, not by decode. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OUTSIDE_SECRET = "the-file-nobody-outside-may-read";

let workspace = "";
let previewsRoot = "";
let outsideRoot = "";
/** A project whose `.moe-next/previews` does not exist at all. */
let bareWorkspace = "";

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "moe-capture-")));
  bareWorkspace = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "moe-capture-bare-")));
  previewsRoot = join(workspace, ...previewsRootRelativePath().split("/"));
  const run = join(previewsRoot, GOAL, SHA);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "journey-home.png"), PNG);

  // The neighbours. Everything here is INSIDE the root and none of it is a capture.
  writeFileSync(join(run, "ledger.sqlite"), "SQLite format 3\u0000", "utf8");
  writeFileSync(join(run, "receipt.json"), "{\"secret\":\"no\"}", "utf8");
  writeFileSync(join(run, ".env"), "MOE_CREDENTIAL=leak", "utf8");
  writeFileSync(join(run, "app.js"), "export const stolen = 1;\n", "utf8");
  writeFileSync(join(run, "index.html"), "<!doctype html>\n", "utf8");
  writeFileSync(join(run, "style.css"), ":root{}\n", "utf8");
  writeFileSync(join(run, "icon.svg"), "<svg onload=\"alert(1)\"/>", "utf8");

  // THE ESCAPE. A junction rather than a file symlink: Windows creates a directory junction
  // without elevation and Node ignores the type argument elsewhere, so one call gives the same
  // shape on every platform this suite runs on. The name sits at the goalId position, so the
  // escaping request is still exactly three segments and reaches the containment check.
  outsideRoot = join(workspace, "outside");
  mkdirSync(join(outsideRoot, SHA), { recursive: true });
  writeFileSync(join(outsideRoot, SHA, "secret.png"), OUTSIDE_SECRET, "utf8");
  symlinkSync(outsideRoot, join(previewsRoot, "escape"), "junction");

  // A junction INSIDE the root pointing INSIDE it: legal all the way down, so it SERVES. This
  // is what stops "refuse every symlink" passing for confinement.
  mkdirSync(join(previewsRoot, "alias"), { recursive: true });
  symlinkSync(join(previewsRoot, GOAL, SHA), join(previewsRoot, "alias", SHA), "junction");
});

afterAll(() => {
  rmSync(workspace, { force: true, recursive: true });
  rmSync(bareWorkspace, { force: true, recursive: true });
});

function authenticatorFor(capabilities: readonly string[]): Authenticator {
  return {
    authenticate(credential: string | null): AuthenticationResult {
      if (credential !== GOOD_CREDENTIAL) return { verdict: "UNAUTHENTICATED" };
      return {
        principal: { capabilities, principalId: "prin-capture", projectId: "proj-capture" },
        verdict: "AUTHENTICATED",
      };
    },
  };
}

function deps(capabilities: readonly string[] = ["goal.write"]): CommandAdapterDeps {
  return {
    authenticator: authenticatorFor(capabilities),
    decisions: decisionPort(),
    registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
  };
}

interface Reply {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly status: number;
}

async function fetchCapture(
  listener: ControlRoomListener,
  path: string,
  init: { readonly credential?: string | null; readonly method?: string } = {},
): Promise<Reply> {
  const credential = init.credential === undefined ? GOOD_CREDENTIAL : init.credential;
  const headers: Record<string, string> = {
    host: `127.0.0.1:${listener.port}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  if (credential !== null) headers["x-moe-session-credential"] = credential;
  return await new Promise<Reply>((resolve, reject) => {
    const outbound = httpRequest(
      { headers, host: "127.0.0.1", method: init.method ?? "GET", path, port: listener.port, setHost: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          body: Buffer.concat(chunks),
          contentType: typeof response.headers["content-type"] === "string"
            ? response.headers["content-type"] : undefined,
          status: response.statusCode ?? 0,
        }));
      },
    );
    outbound.on("error", reject);
    outbound.end();
  });
}

async function withCaptureHost(
  run: (listener: ControlRoomListener) => Promise<void>,
  directory: string = workspace,
  capabilities: readonly string[] = ["goal.write"],
): Promise<void> {
  const result = await startControlRoomListener({
    csrfToken: CSRF,
    deps: deps(capabilities),
    previewCaptures: { projectDirectory: () => directory },
  });
  if (!result.ok) throw new Error(`listener refused to start: ${result.code}`);
  try {
    await run(result);
  } finally {
    await result.close();
  }
}

/**
 * CODE, LAYER and STATUS together, plus the two DoD-5 clauses that belong on every refusal: the
 * body carries NOTHING but the code and the layer, so it can name neither the resolved path nor
 * the root it was resolved against.
 */
function expectRefusal(reply: Reply, code: string, status: number): void {
  const parsed: unknown = JSON.parse(reply.body.toString("utf8"));
  expect(parsed).toStrictEqual({ code, layer: CONTROL_ROOM_LISTENER_LAYER });
  expect(reply.status).toBe(status);
  expect((LISTENER_REFUSAL_CODES as readonly string[]).includes(code)).toBe(true);
  const text = reply.body.toString("utf8");
  expect(text).not.toContain(previewsRoot);
  expect(text).not.toContain(previewsRoot.replaceAll("\\", "\\\\"));
  expect(text).not.toContain(workspace);
  expect(text).not.toContain(OUTSIDE_SECRET);
}

const capture = (rest: string): string => `/preview/capture/${rest}`;

describe("a path inside the root is served, and nothing else is", () => {
  it("serves a real capture as image/png, byte for byte", async () => {
    await withCaptureHost(async (listener) => {
      const reply = await fetchCapture(listener, capture(`${GOAL}/${SHA}/journey-home.png`));
      expect(reply.status).toBe(200);
      expect(reply.contentType).toBe("image/png");
      expect(reply.body.equals(PNG)).toBe(true);
      // The one media type this route publishes, asserted against the constant it publishes by.
      expect(PREVIEW_CAPTURE_CONTENT_TYPES).toStrictEqual(["image/png"]);
    });
  });

  it("serves through a junction that stays INSIDE the root", async () => {
    // Confinement is measured on the RESOLVED path, so a contained alias is servable. Without
    // this, "refuse anything symlinked" would pass the escape arm below while being wrong.
    await withCaptureHost(async (listener) => {
      const reply = await fetchCapture(listener, capture(`alias/${SHA}/journey-home.png`));
      expect(reply.status).toBe(200);
      expect(reply.body.equals(PNG)).toBe(true);
    });
  });

  it("refuses a capture that is not on disk with LISTENER_ASSET_NOT_FOUND", async () => {
    await withCaptureHost(async (listener) => {
      expectRefusal(
        await fetchCapture(listener, capture(`${GOAL}/${SHA}/journey-nowhere.png`)),
        "LISTENER_ASSET_NOT_FOUND", 404,
      );
    });
  });
});

describe("traversal and escape, one arm per class", () => {
  it("refuses `..` segments with LISTENER_ASSET_PATH_TRAVERSAL", async () => {
    await withCaptureHost(async (listener) => {
      for (const rest of [
        `${GOAL}/../../journey-home.png`,
        `../${GOAL}/${SHA}`,
        `${GOAL}/${SHA}/..`,
      ]) {
        expectRefusal(await fetchCapture(listener, capture(rest)), "LISTENER_ASSET_PATH_TRAVERSAL", 403);
      }
    });
  });

  it("refuses a backslash-spelled escape with LISTENER_ASSET_PATH_TRAVERSAL", async () => {
    // A Windows separator never reaches `join`: the path judge refuses the spelling outright,
    // so the same request is refused identically on a platform where it WOULD have escaped.
    await withCaptureHost(async (listener) => {
      expectRefusal(
        await fetchCapture(listener, capture(`${GOAL}\\..\\..\\journey-home.png`)),
        "LISTENER_ASSET_PATH_TRAVERSAL", 403,
      );
    });
  });

  it("refuses absolute spellings, each by the guard that actually answers", async () => {
    await withCaptureHost(async (listener) => {
      // A leading `/` makes an empty first segment: traversal, before any join.
      expectRefusal(
        await fetchCapture(listener, "/preview/capture//etc/passwd"),
        "LISTENER_ASSET_PATH_TRAVERSAL", 403,
      );
      // A drive letter carries `:`, which the segment rules refuse on EVERY platform — so the
      // Windows-only escape cannot be reached from a POSIX host either.
      expectRefusal(
        await fetchCapture(listener, capture("C:/Windows/win.ini")),
        "LISTENER_ASSET_SEGMENT_INVALID", 403,
      );
    });
  });

  it("refuses encoded separators, singly and doubly encoded, by their own codes", async () => {
    await withCaptureHost(async (listener) => {
      // Decoded ONCE to `../`: the traversal judge sees it, which is the whole point of
      // decoding before judging rather than after.
      expectRefusal(
        await fetchCapture(listener, capture(`%2e%2e%2f%2e%2e%2f${SHA}/journey-home.png`)),
        "LISTENER_ASSET_PATH_TRAVERSAL", 403,
      );
      // DOUBLE encoding changes on a second pass, so the spelling is ambiguous and refused
      // before it can be decoded into a traversal by a downstream consumer.
      expectRefusal(
        await fetchCapture(listener, capture(`%252e%252e%252f${SHA}/journey-home.png`)),
        "LISTENER_ASSET_ENCODING_INVALID", 400,
      );
      // A `%2f`-spelled separator is a SPELLING, not an escape, and this arm pins that on
      // purpose: because the path is decoded ONCE and only then judged, the encoded and plain
      // spellings of the same contained path resolve identically and both serve. Refusing here
      // would be theatre — the danger of `%2f` is a decode that happens AFTER the judgement,
      // which is the order this route does not use. The escape arms above are what prove it.
      const encodedSpelling = await fetchCapture(
        listener, capture(`${GOAL}%2f${SHA}%2fjourney-home.png`),
      );
      expect(encodedSpelling.status).toBe(200);
      expect(encodedSpelling.body.equals(PNG)).toBe(true);
      // And an encoded spelling of an ESCAPING path is still refused, by containment.
      expectRefusal(
        await fetchCapture(listener, capture(`escape%2f${SHA}%2fsecret.png`)),
        "LISTENER_ASSET_OUTSIDE_ROOT", 403,
      );
    });
  });

  it("refuses a junction pointing OUTSIDE the root with LISTENER_ASSET_OUTSIDE_ROOT", async () => {
    // THE ARM A PRE-RESOLUTION CHECK PASSES. Every segment here is legal, the shape is right,
    // the type is right and the file exists — only the REALPATH is outside the root, so this is
    // the one case that proves confinement runs after resolution and not before.
    await withCaptureHost(async (listener) => {
      const reply = await fetchCapture(listener, capture(`escape/${SHA}/secret.png`));
      expectRefusal(reply, "LISTENER_ASSET_OUTSIDE_ROOT", 403);
      expect(reply.body.toString("utf8")).not.toContain(OUTSIDE_SECRET);
    });
  });
});

describe("the confinement is a TYPE as well as a directory", () => {
  it("refuses every non-image inside the root with LISTENER_ASSET_TYPE_UNKNOWN", async () => {
    await withCaptureHost(async (listener) => {
      for (const file of [
        // Outside the shared map already, and named here because they are what really sits
        // beside a captures directory.
        "ledger.sqlite", "receipt.json", ".env",
        // INSIDE the shared map: these four are what an unnarrowed root-confined server would
        // have published, and they are the reason DoD 3 exists.
        "app.js", "index.html", "style.css", "icon.svg",
      ]) {
        const reply = await fetchCapture(listener, capture(`${GOAL}/${SHA}/${file}`));
        expectRefusal(reply, "LISTENER_ASSET_TYPE_UNKNOWN", 415);
        expect(reply.body.toString("utf8")).not.toContain("stolen");
        expect(reply.body.toString("utf8")).not.toContain("MOE_CREDENTIAL");
      }
    });
  });

  it("refuses a type it cannot resolve before it resolves the path at all", async () => {
    // A `.sqlite` that does NOT exist answers TYPE_UNKNOWN, not NOT_FOUND — proof the type gate
    // runs before the filesystem, so a refusal here is never an existence oracle.
    await withCaptureHost(async (listener) => {
      expectRefusal(
        await fetchCapture(listener, capture(`${GOAL}/${SHA}/absent.sqlite`)),
        "LISTENER_ASSET_TYPE_UNKNOWN", 415,
      );
      // And the same for a path that would have escaped: the type answers, never the escape,
      // so the caller cannot learn that the junction resolved.
      expectRefusal(
        await fetchCapture(listener, capture(`escape/${SHA}/secret.json`)),
        "LISTENER_ASSET_TYPE_UNKNOWN", 415,
      );
    });
  });

  it("refuses a shape that is not <goalId>/<sha>/<file> with LISTENER_ASSET_SEGMENT_INVALID", async () => {
    await withCaptureHost(async (listener) => {
      for (const rest of [
        `${GOAL}/journey-home.png`,
        `${GOAL}/${SHA}/nested/journey-home.png`,
        `${GOAL}`,
      ]) {
        expectRefusal(await fetchCapture(listener, capture(rest)), "LISTENER_ASSET_SEGMENT_INVALID", 403);
      }
      // The bare route with no operand. The shared judge maps a bare `/` to the bundle's index
      // document, which is meaningless here — the shape rule answers FIRST, so this route never
      // inherits an index-document notion it has no use for.
      expectRefusal(
        await fetchCapture(listener, "/preview/capture"), "LISTENER_ASSET_SEGMENT_INVALID", 403,
      );
      // A trailing slash is the same bare request: the remainder is `/` either way.
      expectRefusal(
        await fetchCapture(listener, "/preview/capture/"), "LISTENER_ASSET_SEGMENT_INVALID", 403,
      );
      // Two slashes make an empty segment, which is a traversal spelling, not a shape fault.
      expectRefusal(
        await fetchCapture(listener, "/preview/capture//"), "LISTENER_ASSET_PATH_TRAVERSAL", 403,
      );
    });
  });
});

describe("method, authority and composition", () => {
  it("refuses a non-GET with LISTENER_ASSET_METHOD_INVALID: the route is read-only", async () => {
    await withCaptureHost(async (listener) => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        expectRefusal(
          await fetchCapture(listener, capture(`${GOAL}/${SHA}/journey-home.png`), { method }),
          "LISTENER_ASSET_METHOD_INVALID", 405,
        );
      }
    });
  });

  it("refuses an unauthenticated caller before it decides anything about the path", async () => {
    await withCaptureHost(async (listener) => {
      // A real capture and a traversal answer the SAME way without a credential: an anonymous
      // caller cannot use this route to learn what exists.
      const real = await fetchCapture(listener, capture(`${GOAL}/${SHA}/journey-home.png`), { credential: null });
      const bogus = await fetchCapture(listener, capture(`${GOAL}/${SHA}/nothing-here.png`), { credential: null });
      expect(real.status).not.toBe(200);
      expect(real.status).toBe(bogus.status);
      expect(real.body.toString("utf8")).toBe(bogus.body.toString("utf8"));
      expect(real.body.toString("utf8")).not.toContain(workspace);
    });
  });

  it("refuses without goal.write, and refuses as UNAVAILABLE when unwired", async () => {
    await withCaptureHost(async (listener) => {
      const reply = await fetchCapture(listener, capture(`${GOAL}/${SHA}/journey-home.png`));
      expect(JSON.parse(reply.body.toString("utf8"))).toStrictEqual({
        code: "PREVIEW_CAPTURE_CAPABILITY_DENIED", layer: "PREVIEW_READ", outcome: "REFUSED",
      });
    }, workspace, ["work.write"]);

    const unwired = await startControlRoomListener({ csrfToken: CSRF, deps: deps() });
    if (!unwired.ok) throw new Error(unwired.code);
    try {
      expectRefusal(
        await fetchCapture(unwired, capture(`${GOAL}/${SHA}/journey-home.png`)),
        "LISTENER_PREVIEW_UNAVAILABLE", 503,
      );
    } finally {
      await unwired.close();
    }
  });

  it("fails CLOSED when the composed port itself throws", async () => {
    // The port is composition-supplied and its call is the one thing in the handler that can
    // throw. A throwing port must answer a stable code, never escape as a request fault.
    const result = await startControlRoomListener({
      csrfToken: CSRF,
      deps: deps(),
      previewCaptures: {
        projectDirectory: (): string => { throw new Error("composition is broken"); },
      },
    });
    if (!result.ok) throw new Error(result.code);
    try {
      const reply = await fetchCapture(result, capture(`${GOAL}/${SHA}/journey-home.png`));
      expectRefusal(reply, "LISTENER_PREVIEW_UNAVAILABLE", 503);
      expect(reply.body.toString("utf8")).not.toContain("composition is broken");
    } finally {
      await result.close();
    }
  });

  it("refuses a project with no previews directory as LISTENER_ASSET_ROOT_INVALID", async () => {
    await withCaptureHost(async (listener) => {
      expectRefusal(
        await fetchCapture(listener, capture(`${GOAL}/${SHA}/journey-home.png`)),
        "LISTENER_ASSET_ROOT_INVALID", 403,
      );
    }, bareWorkspace);
  });

  it("is reachable on a daemon hosting NO control-room bundle", async () => {
    // The interception sits ahead of the roster check, so `assets === null` — the state that
    // answers LISTENER_ROUTE_UNKNOWN for every non-JSON path — does not reach this route.
    await withCaptureHost(async (listener) => {
      const reply = await fetchCapture(listener, capture(`${GOAL}/${SHA}/journey-home.png`));
      expect(reply.status).toBe(200);
    });
  });

  it("derives its root from the ONE statement of the capture layout", () => {
    expect(previewsRootRelativePath()).toBe(".moe-next/previews");
  });

  /**
   * A NUL BYTE IN A `.ts` MAKES THE WHOLE MODULE INVISIBLE TO EVERY TEXT CENSUS. `grep`,
   * `git grep` and `file` all classify a file carrying one as BINARY — `git grep -n <symbol>
   * -- <file>` prints "Binary file ... matches" and NO LINES — so the module drops silently
   * out of the full-tree literal census this epic requires of any row publishing a route.
   * This row shipped exactly that once: two NUL sentinels in `preview-capture-route.ts`,
   * undisclosed, and undetectable by the tooling that was meant to catch them.
   *
   * NOT VACUOUS, two ways: the counter is first run against a buffer that DOES carry a NUL, so
   * a predicate that had stopped looking fails here rather than passing by finding nothing;
   * and the roster length is pinned, so a sweep that enumerated zero files cannot pass.
   */
  it("ships no NUL byte in any module this row delivers", () => {
    const delivered = [
      "preview-capture-route.ts", "preview-capture-route.js", "preview-capture-route.test.ts",
      "preview-read.ts", "preview-read.js", "preview-read.test.ts",
    ] as const;
    const nulsIn = (bytes: Uint8Array): number => bytes.filter((byte) => byte === 0).length;

    expect(nulsIn(Uint8Array.from([0x61, 0x00, 0x62]))).toBe(1);
    expect(nulsIn(Uint8Array.from([0x61, 0x62]))).toBe(0);

    const offenders = delivered
      .map((name) => ({
        name,
        nuls: nulsIn(readFileSync(fileURLToPath(new URL(name, import.meta.url)))),
      }))
      .filter((entry) => entry.nuls > 0);
    expect(offenders).toEqual([]);
    expect(delivered.length).toBe(6);
  });
});
