/**
 * THE PREVIEW RECEIPT READ, driven against a receipt the REAL PREVIEW PATH wrote.
 *
 * The load-bearing arm below does not plant a receipt. It runs `runPreview` with NO `capture`
 * key, so the production default (`capturePreviewJourneys`) really launches Chromium against a
 * real product that really binds a port, and the receipt this route serves is the one that run
 * committed. A hand-built receipt would let every assertion here pass while the projection
 * disagreed with what the runner actually writes — the `screenshots[].path` spelling in
 * particular is produced by `preview-capture.ts` and validated by the receipt decoder, and a
 * literal in a test is not evidence about either.
 *
 * The same run then feeds the capture route: the bytes served over the socket are asserted to
 * be the bytes on disk, which is the only way "a path inside the root IS served" means anything.
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { recordPreviewReceipt } from "../preview/preview-ledger.js";
import { previewCaptureDirectory, previewReceiptId } from "../preview/preview-receipt-contracts.js";
import { runPreview } from "../preview/preview-runner.js";
import { LISTENING_SERVER, cleanupFixtureWorkspaces, fixtureWorkspace } from "../preview/preview-test-fixtures.js";
import type { AuthenticationResult, Authenticator, CommandAdapterDeps } from "./http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { CONTROL_ROOM_LISTENER_LAYER } from "./http-listener-guards.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import { GOOD_CREDENTIAL, decisionPort, recordingHandler, registryOf } from "./http-test-fixtures.js";
import { createPreviewReadPort, previewUrlIsServable, readPreviewForGoal } from "./preview-read.js";
import type { PreviewReadAnswer } from "./preview-read.js";

const CSRF = "csrf-token-for-preview";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-06T12:00:00.000Z";

/** EXACTLY the members a preview card is told, sorted. `pid`/`projectId`/`version` are absent. */
const PROJECTION_KEYS = [
  "code", "decidedAt", "goalId", "outcome", "receiptId", "screenshots", "sha", "url",
] as const;

type Store = ReturnType<typeof openStore>;

const started: { stop: () => Promise<void> }[] = [];

afterEach(async () => {
  while (started.length > 0) await started.pop()?.stop();
  cleanupFixtureWorkspaces();
});

/** A principal in the STORE's project, so the route's projectId fence is exercised for real. */
function authenticatorFor(capabilities: readonly string[], projectId = PROJECT_ID): Authenticator {
  return {
    authenticate(credential: string | null): AuthenticationResult {
      if (credential !== GOOD_CREDENTIAL) return { verdict: "UNAUTHENTICATED" };
      return {
        principal: { capabilities, principalId: "prin-preview", projectId },
        verdict: "AUTHENTICATED",
      };
    },
  };
}

function deps(capabilities: readonly string[] = ["goal.write"], projectId = PROJECT_ID): CommandAdapterDeps {
  return {
    authenticator: authenticatorFor(capabilities, projectId),
    decisions: decisionPort(),
    registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
  };
}

function landedWorld(): Store {
  const store = openStore();
  driveThrough(store, "goal.close");
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((plan) =>
    plan.goalRef === GOAL_ID && plan.content.snapshot.nodes.some((node) => node.nodeKey === "node-a"));
  const nodeRef = graph === undefined ? "node-a" : compiledExecutionRef(PROJECT_ID, graph, "node-a");
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, "COMMITTED");
  return store;
}

interface Reply {
  readonly body: Buffer;
  readonly status: number;
}

/** The live client's shape: Host, Origin, CSRF, protocol version and the credential. */
async function call(
  listener: ControlRoomListener,
  path: string,
  init: { readonly credential?: string | null; readonly method?: string; readonly payload?: string } = {},
): Promise<Reply> {
  const credential = init.credential === undefined ? GOOD_CREDENTIAL : init.credential;
  const headers: Record<string, string | number> = {
    host: `127.0.0.1:${listener.port}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  if (credential !== null) headers["x-moe-session-credential"] = credential;
  if (init.payload !== undefined) {
    headers["content-length"] = Buffer.byteLength(init.payload);
    headers["content-type"] = "application/json";
  }
  return await new Promise<Reply>((resolve, reject) => {
    const outbound = httpRequest(
      { headers, host: "127.0.0.1", method: init.method ?? "POST", path, port: listener.port, setHost: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          body: Buffer.concat(chunks), status: response.statusCode ?? 0,
        }));
      },
    );
    outbound.on("error", reject);
    outbound.end(init.payload ?? undefined);
  });
}

async function withListener(
  options: Parameters<typeof startControlRoomListener>[0],
  run: (listener: ControlRoomListener) => Promise<void>,
): Promise<void> {
  const result = await startControlRoomListener(options);
  if (!result.ok) throw new Error(`listener refused to start: ${result.code}`);
  try {
    await run(result);
  } finally {
    await result.close();
  }
}

/**
 * THE LEAK PREDICATE, applied to the SERIALISED answer. Returns the clause that tripped, so an
 * arm can assert WHICH leak it found rather than that something matched — and so the positive
 * control below can prove each clause is individually reachable.
 */
export function firstLeakIn(serialised: string, hostPaths: readonly string[]): string | null {
  for (const hostPath of hostPaths) {
    if (serialised.includes(hostPath)) return `HOST_PATH:${hostPath}`;
    if (serialised.includes(hostPath.replaceAll("\\", "\\\\"))) return `HOST_PATH:${hostPath}`;
  }
  if (serialised.includes(GOOD_CREDENTIAL)) return "CREDENTIAL";
  if (serialised.includes(CSRF)) return "CSRF";
  if (/https?:\/\/[^"/]*@/u.test(serialised)) return "URL_USERINFO";
  if (/"[A-Za-z]:\\\\/u.test(serialised) || /"\/(?:etc|home|Users|tmp|var)\//u.test(serialised)) {
    return "ABSOLUTE_PATH";
  }
  return null;
}

describe("the preview receipt read, against a receipt the real preview path wrote", () => {
  it("serves url, screenshots, outcome and code as the runner committed them", async () => {
    const store = landedWorld();
    const workspace = fixtureWorkspace({
      files: { "server.mjs": LISTENING_SERVER },
      scripts: { preview: "node server.mjs" },
    });

    // No `capture` key at all: `runPreview` falls through to its production default and really
    // drives Chromium, so the screenshots below are captures, not literals.
    const run = await runPreview(
      {
        clock: () => DECIDED_AT,
        contractFacts: () => ({
          deploymentStatements: ["preview command: node server.mjs"],
          journeys: [
            { journeyId: "journey-home", statement: "Arrive." },
            { journeyId: "journey-checkout", statement: "Buy.\npreview path: /checkout" },
          ],
        }),
        process: { startTimeoutMs: 30_000 },
        projectId: PROJECT_ID,
        store,
      },
      { goalId: GOAL_ID, sha: SHA, workspace },
    );
    if (!run.ok) throw new Error(`expected a start, got ${run.refusal.code}`);
    started.push(run.started.handle);

    const answer = readPreviewForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID });
    if (answer.kind !== "PRESENT") throw new Error(`expected PRESENT, got ${answer.kind}`);
    const preview = answer.preview;

    // DoD 1's four, plus the operands a card cannot act without.
    expect(preview.outcome).toBe("STARTED");
    expect(preview.code).toBeNull();
    expect(preview.url).toBe(run.started.handle.origin);
    expect(preview.goalId).toBe(GOAL_ID);
    expect(preview.sha).toBe(SHA);
    expect(preview.receiptId).toBe(previewReceiptId(PROJECT_ID, GOAL_ID, SHA));

    const prefix = `${previewCaptureDirectory(GOAL_ID, SHA)}/`;
    expect(preview.screenshots.map((shot) => shot.path)).toStrictEqual([
      `${prefix}journey-home.png`,
      `${prefix}journey-checkout.png`,
    ]);
    // The advertised paths are real bytes, decoding as PNGs — the same discipline the runner's
    // own suite holds itself to, re-asserted here because THIS route is what publishes them.
    for (const shot of preview.screenshots) {
      const bytes = readFileSync(join(workspace, ...shot.path.split("/")));
      expect([...bytes.subarray(0, 8)]).toStrictEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    // EXACT KEYS, and the three withheld members named individually so a future "helpful"
    // addition of `pid` reads as the leak it is rather than as an off-by-one.
    expect(Object.keys(preview).sort()).toStrictEqual([...PROJECTION_KEYS]);
    expect(Object.hasOwn(preview, "pid")).toBe(false);
    expect(Object.hasOwn(preview, "projectId")).toBe(false);
    expect(Object.hasOwn(preview, "version")).toBe(false);

    // NO LEAK (DoD 5): the workspace is a real absolute host path and appears nowhere.
    expect(firstLeakIn(JSON.stringify(answer), [workspace])).toBeNull();
  }, 180_000);

  it("serves the captured bytes over the socket, byte for byte, and only for a credential", async () => {
    const store = landedWorld();
    const workspace = fixtureWorkspace({
      files: { "server.mjs": LISTENING_SERVER },
      scripts: { preview: "node server.mjs" },
    });
    const run = await runPreview(
      {
        clock: () => DECIDED_AT,
        contractFacts: () => ({
          deploymentStatements: ["preview command: node server.mjs"],
          journeys: [{ journeyId: "journey-home", statement: "Arrive." }],
        }),
        process: { startTimeoutMs: 30_000 },
        projectId: PROJECT_ID,
        store,
      },
      { goalId: GOAL_ID, sha: SHA, workspace },
    );
    if (!run.ok) throw new Error(`expected a start, got ${run.refusal.code}`);
    started.push(run.started.handle);

    const answer = readPreviewForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID });
    if (answer.kind !== "PRESENT") throw new Error(`expected PRESENT, got ${answer.kind}`);
    const shot = answer.preview.screenshots[0];
    if (shot === undefined) throw new Error("the real run captured nothing");
    const onDisk = readFileSync(join(workspace, ...shot.path.split("/")));
    // The receipt's relative path IS the capture route's operand: no client-side rewriting.
    const route = `/preview/capture/${shot.path.slice(".moe-next/previews/".length)}`;

    await withListener(
      {
        csrfToken: CSRF,
        deps: deps(),
        previewCaptures: { projectDirectory: () => workspace },
        previewReads: createPreviewReadPort(store),
      },
      async (listener) => {
        const served = await call(listener, route, { method: "GET" });
        expect(served.status).toBe(200);
        expect(served.body.equals(onDisk)).toBe(true);

        // An unauthenticated caller learns nothing — not even that the file is there.
        const anonymous = await call(listener, route, { credential: null, method: "GET" });
        expect(anonymous.status).not.toBe(200);
        expect(anonymous.body.toString("utf8")).not.toContain(workspace);
      },
    );
  }, 180_000);
});

describe("absent, refused, and the exact-key fence", () => {
  it("reads a goal with no receipt as ABSENT rather than refusing", async () => {
    const store = landedWorld();
    const answer = readPreviewForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID });
    expect(answer).toStrictEqual({ goalId: GOAL_ID, kind: "ABSENT" });

    await withListener(
      { csrfToken: CSRF, deps: deps(), previewReads: createPreviewReadPort(store) },
      async (listener) => {
        const reply = await call(listener, "/preview/read", {
          payload: JSON.stringify({ goalId: GOAL_ID }),
        });
        expect(reply.status).toBe(200);
        expect(JSON.parse(reply.body.toString("utf8"))).toStrictEqual({
          goalId: GOAL_ID, kind: "ABSENT",
        });
      },
    );
  });

  it("refuses a url with embedded userinfo by CODE and LAYER, on a receipt the ledger wrote", async () => {
    const store = landedWorld();
    // Written through `recordPreviewReceipt`, the production write surface — not planted bytes.
    const written = recordPreviewReceipt(store, {
      code: null,
      decidedAt: DECIDED_AT,
      goalId: GOAL_ID,
      pid: 4242,
      projectId: PROJECT_ID,
      screenshots: [],
      sha: SHA,
      url: "http://operator:hunter2@127.0.0.1:4173/",
    });
    if (!written.ok) throw new Error(written.code);

    const answer = readPreviewForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID });
    expect(answer).toStrictEqual({
      code: "PREVIEW_READ_URL_UNSERVABLE", kind: "REFUSED", layer: "PREVIEW_READ",
    });
    // The refusal carries no url at all, so the credential in it cannot reach the browser.
    expect(JSON.stringify(answer)).not.toContain("hunter2");
  });

  it("judges every unservable url spelling, and admits the loopback one the runner writes", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "http://operator:hunter2@127.0.0.1:4173/",
      "http://operator@127.0.0.1:4173/",
      "file:///C:/Windows/win.ini",
      "not a url",
    ]) {
      expect({ url, servable: previewUrlIsServable(url) }).toStrictEqual({ url, servable: false });
    }
    expect(previewUrlIsServable("http://127.0.0.1:4173")).toBe(true);
    expect(previewUrlIsServable("https://127.0.0.1:4173/checkout")).toBe(true);
  });

  it("refuses every non-exact body with LISTENER_PREVIEW_REQUEST_INVALID at the listener layer", async () => {
    const store = landedWorld();
    await withListener(
      { csrfToken: CSRF, deps: deps(), previewReads: createPreviewReadPort(store) },
      async (listener) => {
        for (const payload of [
          "{}",
          JSON.stringify({ goalId: GOAL_ID, projectId: "someone-elses-project" }),
          JSON.stringify({ goalRef: GOAL_ID }),
          JSON.stringify({ goalId: "" }),
          JSON.stringify({ goalId: 7 }),
          JSON.stringify([GOAL_ID]),
          "null",
        ]) {
          const reply = await call(listener, "/preview/read", { payload });
          expect({ payload, body: JSON.parse(reply.body.toString("utf8")), status: reply.status })
            .toStrictEqual({
              payload,
              body: {
                code: "LISTENER_PREVIEW_REQUEST_INVALID", layer: CONTROL_ROOM_LISTENER_LAYER,
              },
              status: 400,
            });
        }
        // A GET is refused by the roster's own non-POST guard, with the same code.
        const viaGet = await call(listener, "/preview/read", { method: "GET" });
        expect(JSON.parse(viaGet.body.toString("utf8"))).toStrictEqual({
          code: "LISTENER_PREVIEW_REQUEST_INVALID", layer: CONTROL_ROOM_LISTENER_LAYER,
        });
      },
    );
  });

  it("refuses as UNAVAILABLE when unwired, and as CAPABILITY_DENIED without goal.write", async () => {
    const store = landedWorld();
    // No `previewReads` key: an unwired daemon must never answer ABSENT.
    await withListener({ csrfToken: CSRF, deps: deps() }, async (listener) => {
      const reply = await call(listener, "/preview/read", {
        payload: JSON.stringify({ goalId: GOAL_ID }),
      });
      expect(reply.status).toBe(503);
      expect(JSON.parse(reply.body.toString("utf8"))).toStrictEqual({
        code: "LISTENER_PREVIEW_UNAVAILABLE", layer: CONTROL_ROOM_LISTENER_LAYER,
      });
    });

    // The port IS wired here, so a denial can only be the capability gate.
    await withListener(
      {
        csrfToken: CSRF,
        deps: deps(["work.write"]),
        previewReads: createPreviewReadPort(store),
      },
      async (listener) => {
        const reply = await call(listener, "/preview/read", {
          payload: JSON.stringify({ goalId: GOAL_ID }),
        });
        expect(JSON.parse(reply.body.toString("utf8"))).toStrictEqual({
          code: "PREVIEW_READ_CAPABILITY_DENIED", kind: "REFUSED", layer: "PREVIEW_READ",
        });
      },
    );
  });

  it("answers a foreign project's goal as ABSENT, never with another project's receipt", async () => {
    const store = landedWorld();
    const written = recordPreviewReceipt(store, {
      code: null, decidedAt: DECIDED_AT, goalId: GOAL_ID, pid: 99, projectId: PROJECT_ID,
      screenshots: [], sha: SHA, url: "http://127.0.0.1:4173",
    });
    if (!written.ok) throw new Error(written.code);

    const mine = readPreviewForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID });
    expect(mine.kind).toBe("PRESENT");
    const theirs = readPreviewForGoal(store, { goalId: GOAL_ID, projectId: "another-project" });
    expect(theirs).toStrictEqual({ goalId: GOAL_ID, kind: "ABSENT" });
  });
});

describe("the no-leak assertion can fail", () => {
  it("trips on a host path, a credential, a csrf token and embedded userinfo", () => {
    // THE POSITIVE CONTROL. `firstLeakIn` returns null for every honest answer above; without
    // these four, that null would be indistinguishable from a predicate that matches nothing.
    const hostPath = process.platform === "win32" ? "C:\\Users\\op\\moe" : "/home/op/moe";
    expect(firstLeakIn(JSON.stringify({ directory: hostPath }), [hostPath]))
      .toBe(`HOST_PATH:${hostPath}`);
    expect(firstLeakIn(JSON.stringify({ token: GOOD_CREDENTIAL }), [])).toBe("CREDENTIAL");
    expect(firstLeakIn(JSON.stringify({ token: CSRF }), [])).toBe("CSRF");
    expect(firstLeakIn(JSON.stringify({ url: "http://op:pw@127.0.0.1:4173/" }), []))
      .toBe("URL_USERINFO");
    // An absolute path this arm was never handed as a known root still trips the shape clause.
    expect(firstLeakIn(JSON.stringify({ path: "/etc/passwd" }), [])).toBe("ABSOLUTE_PATH");
    expect(firstLeakIn(JSON.stringify({ path: "C:\\Windows\\win.ini" }), []))
      .toBe("ABSOLUTE_PATH");
    // And it is not a predicate that matches everything: an honest projection is clean.
    const honest: PreviewReadAnswer = {
      kind: "PRESENT",
      preview: {
        code: null, decidedAt: DECIDED_AT, goalId: GOAL_ID, outcome: "STARTED",
        receiptId: previewReceiptId(PROJECT_ID, GOAL_ID, SHA),
        screenshots: [{ journeyRef: "journey-home", path: `${previewCaptureDirectory(GOAL_ID, SHA)}/journey-home.png` }],
        sha: SHA, url: "http://127.0.0.1:4173",
      },
    };
    expect(firstLeakIn(JSON.stringify(honest), ["/home/op/moe"])).toBeNull();
  });
});
