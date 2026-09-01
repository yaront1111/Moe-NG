import { request as httpRequest } from "node:http";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_ID,
  RUN_ID,
  bootstrapSequence,
  closeStores,
  driveThrough,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { budgetCommitmentDigest, budgetCommitmentMaterial }
  from "../budget/budget-commitment.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { readApprovalIntentSources } from "../planning/approval-intent-sources.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, CommandAdapterDeps } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import {
  BUDGET_COMMITMENT_READ_CODES,
  BUDGET_COMMITMENT_READ_PATH,
  createBudgetCommitmentReadPort,
} from "./budget-commitment-read.js";
import type { BudgetCommitmentReadPort } from "./budget-commitment-read.js";

/**
 * task-80b6bf7c: the transport edge that lets a client WITHOUT a `SqliteEventStore`
 * obtain the shared-builder budget commitment for a finalized run.
 *
 * EVERY ARM DRIVES THE COMPOSED LISTENER over a real socket, never
 * `handleBudgetCommitmentReadRequest` directly. A handler-level arm cannot tell
 * "registered" from "written but never routed", and being routable is the entire
 * point of the row (epic rail 8B).
 *
 * NO ARM SPELLS A DIGEST. The happy path compares the route's answer against
 * `budgetCommitmentDigest(budgetCommitmentMaterial(store, ...))` recomputed in the
 * arm from the same store, so a route that returned a constant — or a lawful
 * change to the material — is caught rather than frozen.
 */

const FOREIGN_PROJECT = "project-foreign";
const CSRF = "csrf-budget-commitment-read";
const CREDENTIAL = "budget-commitment-read-session";
const NO_CAPABILITY_CREDENTIAL = "budget-commitment-read-readonly";
const FOREIGN_PROJECT_CREDENTIAL = "budget-commitment-read-foreign";

/** The route's own private layer. Asserted as a STRING so exporting it is not required. */
const READ_LAYER = "BUDGET_COMMITMENT_READ";
const RUN_BINDING_LAYER = "APPROVAL_RUN_BINDING";
const PREREQUISITE_LAYER = "DAEMON_PREREQUISITE";

const listeners: ControlRoomListener[] = [];

afterEach(async () => {
  while (listeners.length > 0) await listeners.pop()?.close();
  closeStores();
});

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

/** The world the shipped journey leaves just BEFORE its approval: sealed, PLAN_REVIEW. */
function sealedStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}

/**
 * A run that EXISTS but never finalized. Built by replaying the shipped sequence up to
 * and including the first `plan.propose` and stopping before the finalize terminal —
 * `driveThrough` cannot express this, because it matches on `kind` and both proposes
 * share one.
 */
function proposedButUnfinalizedStore(): SqliteEventStore {
  const store = openStore();
  for (const request of bootstrapSequence()) {
    if (request.commandId === "cmd-finalize") break;
    const outcome = send(store, request);
    if (!outcome.ok) throw new Error(`fixture setup failed at ${request.kind}: ${outcome.code}`);
  }
  return store;
}

/**
 * The commitment the STORE-SIDE builder produces for this run, recomputed here from the
 * same durable state the route reads. This is the production builder
 * (`budget-commitment.ts`), not the route's module, so the equality measures transport
 * rather than agreeing with itself.
 */
function storeSideCommitment(store: SqliteEventStore): string {
  const sources = readApprovalIntentSources(store, PROJECT_ID, RUN_ID);
  if (!("binding" in sources) || !sources.binding.ok) {
    throw new Error("fixture store is not sealed: no approved run binding");
  }
  const material = budgetCommitmentMaterial(store, {
    approvedRun: {
      runBinding: sources.binding.binding,
      verifiedGraphRevisionRef: sources.graphRevisionRef,
    },
    goalRef: sources.goalRef,
    projectId: PROJECT_ID,
  });
  if (!material.ok) throw new Error(`fixture material unavailable: ${material.code}`);
  return budgetCommitmentDigest(material.material);
}

function authentication(credential: string | null): AuthenticationResult {
  if (credential === CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.PLANNING], principalId: "planner", projectId: PROJECT_ID,
      },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === NO_CAPABILITY_CREDENTIAL) {
    return {
      principal: { capabilities: [], principalId: "reader", projectId: PROJECT_ID },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === FOREIGN_PROJECT_CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.PLANNING], principalId: "foreign",
        projectId: FOREIGN_PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  return { verdict: "UNAUTHENTICATED" };
}

/**
 * A listener whose ONLY wired collaborator is the route under test: the decision port
 * and the command registry throw, so an arm that reached either fails loudly instead of
 * passing for the wrong reason.
 */
async function start(port?: BudgetCommitmentReadPort): Promise<ControlRoomListener> {
  const deps: CommandAdapterDeps = {
    authenticator: { authenticate: authentication },
    decisions: {
      decide: (): never => { throw new Error("budget commitment read entered the decision port"); },
    },
    registry: {
      get: (): never => { throw new Error("budget commitment read entered the registry"); },
    },
  } as unknown as CommandAdapterDeps;
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps,
    ...(port === undefined ? {} : { budgetCommitment: port }),
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  listeners.push(started);
  return started;
}

async function readReply(
  listener: ControlRoomListener, method: string, headers: Record<string, string>, payload: string,
): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const target = listener.origin + BUDGET_COMMITMENT_READ_PATH;
    const outbound = httpRequest(target, { headers, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (text === "" ? {} : JSON.parse(text)) as Readonly<Record<string, unknown>>,
          status: response.statusCode ?? 0,
        });
      });
    });
    outbound.on("error", reject);
    outbound.end(payload);
  });
}

async function post(
  listener: ControlRoomListener,
  options: {
    readonly body?: unknown;
    readonly credential?: string | null;
    readonly csrf?: string | null;
    readonly method?: string;
  } = {},
): Promise<Reply> {
  const payload = JSON.stringify(options.body ?? { runId: RUN_ID });
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
    origin: listener.origin,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  if (options.csrf !== null) headers["x-moe-csrf"] = options.csrf ?? CSRF;
  if (options.credential !== null) {
    headers["x-moe-session-credential"] = options.credential ?? CREDENTIAL;
  }
  return await readReply(listener, options.method ?? "POST", headers, payload);
}

function portFor(store: SqliteEventStore): BudgetCommitmentReadPort {
  return createBudgetCommitmentReadPort({ projectId: PROJECT_ID, store });
}

describe("the budget commitment read route carries the shared builder's value over HTTP", () => {
  it("answers a finalized run with the commitment the STORE-SIDE builder derives", async () => {
    const store = sealedStore();
    const expected = storeSideCommitment(store);
    const listener = await start(portFor(store));

    const reply = await post(listener);

    expect(reply.status).toBe(200);
    expect(reply.body["outcome"]).toBe("COMMITMENT");
    // Compared against the builder's own output, never a spelled digest: a route that
    // returned a constant would pass a literal and reds here.
    expect(reply.body["ref"]).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is REGISTERED, not merely written — the listener does not answer ROUTE_UNKNOWN", async () => {
    const store = sealedStore();
    const listener = await start(portFor(store));

    const reply = await post(listener);

    // MEASURED, not assumed: before http-listener.ts routed this path the listener answered
    // `LISTENER_ROUTE_UNKNOWN` here with a non-404 status, so an arm asserting `status !== 404`
    // passed while the feature did not exist. Naming the code is what makes this arm bite.
    expect(reply.body["code"]).not.toBe("LISTENER_ROUTE_UNKNOWN");
  });

  it("forwards APPROVAL_RUN_NOT_REVIEWABLE @ APPROVAL_RUN_BINDING before finalization",
    async () => {
      // DIVERGENCE: the run EXISTS, so the missing-prerequisite guard cannot fire; the
      // lifecycle leg (approval-run-binding.ts:151) is the only mechanism left.
      const store = proposedButUnfinalizedStore();
      const listener = await start(portFor(store));

      const reply = await post(listener);

      expect(reply.body["outcome"]).toBe("REFUSED");
      expect(reply.body["code"]).toBe("APPROVAL_RUN_NOT_REVIEWABLE");
      expect(reply.body["layer"]).toBe(RUN_BINDING_LAYER);
    });

  it("forwards BOOTSTRAP_PREREQUISITE_MISSING @ DAEMON_PREREQUISITE for an absent run",
    async () => {
      // DIVERGENCE: a fully sealed store, so no lifecycle or seal leg can fire — the run
      // record is simply not there (approval-intent-sources.ts:109).
      const store = sealedStore();
      const listener = await start(portFor(store));

      const reply = await post(listener, { body: { runId: "run-that-was-never-proposed" } });

      expect(reply.body["outcome"]).toBe("REFUSED");
      expect(reply.body["code"]).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
      expect(reply.body["layer"]).toBe(PREREQUISITE_LAYER);
    });

  it("flips from refusal to commitment on ONE state change, over the SAME store and run",
    async () => {
      // DoD 5. This is the clause the row exists for, so it is deliberately NOT two
      // fixtures compared: one real store, one live listener, one run, and the single
      // durable state change the shipped journey makes before it approves. That is what
      // makes "after finalization" load-bearing rather than incidental — and it is why a
      // fixture helper cannot satisfy it, since the fixture path already migrated while
      // production did not (bootstrap-test-fixtures.ts:532, approval-activation.test.ts:349).
      const store = proposedButUnfinalizedStore();
      const listener = await start(portFor(store));

      const before = await post(listener);
      expect(before.body["outcome"]).toBe("REFUSED");
      expect(before.body["code"]).toBe("APPROVAL_RUN_NOT_REVIEWABLE");
      expect(before.body["layer"]).toBe(RUN_BINDING_LAYER);

      const finalize = bootstrapSequence().find((entry) => entry.commandId === "cmd-finalize");
      if (finalize === undefined) throw new Error("fixture: no finalize envelope in the sequence");
      const finalized = send(store, finalize);
      if (!finalized.ok) throw new Error(`fixture finalize refused: ${finalized.code}`);

      const after = await post(listener);
      expect(after.body["outcome"]).toBe("COMMITMENT");
      // Obtained the way a STORELESS client obtains it — over the route — and compared
      // against the store-side builder's own output for the same run.
      expect(after.body["ref"]).toBe(storeSideCommitment(store));
    });

  it("refuses a caller without PLANNING at the route's OWN layer", async () => {
    const store = sealedStore();
    const listener = await start(portFor(store));

    const reply = await post(listener, { credential: NO_CAPABILITY_CREDENTIAL });

    expect(reply.body["outcome"]).toBe("REFUSED");
    expect(reply.body["code"]).toBe("BUDGET_COMMITMENT_READ_CAPABILITY_DENIED");
    expect(reply.body["layer"]).toBe(READ_LAYER);
  });

  it("refuses a caller bound to another project at the route's OWN layer", async () => {
    const store = sealedStore();
    const listener = await start(portFor(store));

    const reply = await post(listener, { credential: FOREIGN_PROJECT_CREDENTIAL });

    expect(reply.body["outcome"]).toBe("REFUSED");
    expect(reply.body["code"]).toBe("BUDGET_COMMITMENT_READ_PROJECT_MISMATCH");
    expect(reply.body["layer"]).toBe(READ_LAYER);
  });

  it("refuses an unauthenticated caller before the port is asked", async () => {
    const store = sealedStore();
    const listener = await start(portFor(store));

    const reply = await post(listener, { credential: null });

    expect(reply.status).not.toBe(200);
    expect(reply.body["code"]).not.toBe("BUDGET_COMMITMENT_READ_CAPABILITY_DENIED");
  });

  it("refuses every malformed body shape with the listener's request-invalid code", async () => {
    const store = sealedStore();
    const listener = await start(portFor(store));

    // FIVE inputs, not one: a single malformed case cannot distinguish an exact-key fence
    // from a bare `typeof` check. The last one is a different mechanism from the rest —
    // right shape, wrong TYPE — and it is what keeps the route's roster at two codes
    // instead of needing a third for a question the transport already owns.
    const bodies = [
      { runId: RUN_ID, projectId: PROJECT_ID }, // extra key — a smuggled project
      {}, // missing key
      "not-an-object", // non-object
      [RUN_ID], // array
      { runId: 7 }, // right key, non-string value
    ];
    for (const body of bodies) {
      const reply = await post(listener, { body });
      expect(reply.body["code"]).toBe("LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID");
      expect(reply.status).toBe(400);
    }
  });

  it("refuses a non-POST method with the listener's request-invalid code", async () => {
    const store = sealedStore();
    const listener = await start(portFor(store));

    const reply = await post(listener, { method: "GET" });

    expect(reply.body["code"]).toBe("LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID");
  });

  it("answers the listener's unavailable code when the port is not composed", async () => {
    const listener = await start();

    const reply = await post(listener);

    expect(reply.body["code"]).toBe("LISTENER_BUDGET_COMMITMENT_UNAVAILABLE");
    expect(reply.status).toBe(503);
  });

  it("inherits the listener's CSRF guard — a new public path is not a bypass", async () => {
    // ADVERSARIAL: this row adds a NEW public path. Registering it in JSON_ROUTES is what
    // subjects it to the shared transport guards, and nothing in the route module itself
    // would notice if that registration were dropped. A caller with a valid credential but
    // no CSRF header must not reach the derivation.
    const store = sealedStore();
    const listener = await start(portFor(store));

    const reply = await post(listener, { csrf: null });

    expect(reply.body["outcome"]).not.toBe("COMMITMENT");
    expect(reply.body["ref"]).toBeUndefined();
  });

  it("refuses a foreign project BEFORE the body is read, leaking no run", async () => {
    // ADVERSARIAL: guard ORDER, not just guard presence. Project binding is checked before
    // the body fence, so a caller bound elsewhere cannot use malformed-vs-refused replies
    // to probe which runs exist in this project.
    const store = sealedStore();
    const listener = await start(portFor(store));

    const wellFormed = await post(listener, { credential: FOREIGN_PROJECT_CREDENTIAL });
    const malformed = await post(listener, {
      body: { nonsense: true }, credential: FOREIGN_PROJECT_CREDENTIAL,
    });

    // Identical answers: the malformed body never reaches the fence, so the two are
    // indistinguishable to a prober.
    expect(malformed.body["code"]).toBe(wellFormed.body["code"]);
    expect(wellFormed.body["code"]).toBe("BUDGET_COMMITMENT_READ_PROJECT_MISMATCH");
  });

  it("declares exactly two route-local codes, both about the CALLER", () => {
    // A roster arm: adding a third local code — in particular an "unreadable" that would
    // collapse an upstream pair — reds here rather than passing silently.
    expect([...BUDGET_COMMITMENT_READ_CODES]).toStrictEqual([
      "BUDGET_COMMITMENT_READ_CAPABILITY_DENIED",
      "BUDGET_COMMITMENT_READ_PROJECT_MISMATCH",
    ]);
  });
});
