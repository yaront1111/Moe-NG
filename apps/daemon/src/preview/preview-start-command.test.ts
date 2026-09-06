/**
 * `preview.start` DRIVEN OVER THE REAL REGISTRY/ASYNC EDGE.
 *
 * WHAT "REAL" MEANS HERE, precisely. The registry is the production one
 * (`createDaemonCommandPorts`), the dispatch is the production async door
 * (`handleAsyncCommandRequest`), the store is a REAL bootstrap world whose landings are written
 * by the lander's own writer, and the supervisor is the PRODUCTION `createPreviewSupervisor`
 * wrapped in a counting spy — so an arm that asserts the injected port was called is asserting
 * about the object the daemon composes, not about a stub. The product is a real http server in
 * a real temp workspace that really binds a port. The only injected seams are the clock, the
 * browser capture, and the authenticator (an INPUT fixture: it maps a credential to a principal
 * id, and re-implements no boundary rule).
 *
 * WHY EVERY REFUSAL ARM MAKES EVERY OTHER GATE PASSABLE. Four layers can refuse a start
 * (DAEMON_INGRESS at payload shape, DAEMON_AUTHORIZATION at the operator fence, REQUEST at the
 * decoder, then GOAL_AUTHORITY/RUNNER inside the runner) and they answer in a fixed order. An
 * arm asserting merely "it refused" is one added layer away from vacuous, so each arm below
 * satisfies every gate above the one it names and asserts the CODE together with the LAYER
 * `PREVIEW_CODE_LAYERS` maps it to. Each is paired with a positive control over the same world.
 *
 * WHY THE RECEIPT IS READ BACK RATHER THAN TAKEN FROM THE ANSWER. The command answers a
 * `DurableDecision` — `{commandId, disposition, effectId, resultCode}` — which carries no url,
 * no pid and no screenshots. An arm asserting on it would prove only that the function
 * returned. Every receipt assertion below goes through `readPreviewReceipt`, the production
 * read surface the operator's screen uses.
 */
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, closeStores, driveThrough, openStore }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { commandFamilyFacts } from "../daemon-command-families.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS } from "../daemon-command-vocabulary.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import type {
  AuthenticationResult, Authenticator, CommandAdapterDeps,
} from "../http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "../mcp-tool-allowlist.js";
import { HUMAN_ONLY_STEPS } from "../orchestrator/agent-spawn-contract.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import {
  PREVIEW_CODE_LAYERS, PREVIEW_DECIDE_COMMAND_KIND, PREVIEW_START_COMMAND_KIND,
  PREVIEW_START_PAYLOAD_KEYS, decodePreviewStartPayload, previewRefusal,
} from "./preview-contracts.js";
import { readPreviewReceipt } from "./preview-ledger.js";
import { PREVIEW_RECEIPT_COMMAND_KIND, previewReceiptId } from "./preview-receipt-contracts.js";
import type { PreviewScreenshot } from "./preview-receipt-contracts.js";
import type { PreviewCapturePort } from "./preview-runner.js";
import { createPreviewSupervisor } from "./preview-supervisor.js";
import type { PreviewSupervisor } from "./preview-supervisor.js";
import { LISTENING_SERVER, cleanupFixtureWorkspaces, fixtureWorkspace }
  from "./preview-test-fixtures.js";

type Store = ReturnType<typeof openStore>;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-06T12:00:00.000Z";
const OPERATOR = "operator-preview-start";
const AGENT = "agent-preview-start";
const OPERATOR_CREDENTIAL = "cred-operator";
const AGENT_CREDENTIAL = "cred-agent";
const REVIEW = "review.write";
const SHOT: PreviewScreenshot = {
  journeyRef: "home", path: `.moe-next/previews/${GOAL_ID}/${SHA}/home.png`,
};

/**
 * THE INDEPENDENT SIDE of the wrapper-fence comparison: every SERVED kind the wrapper refuses to
 * staff, transcribed by hand. Deriving it from `HUMAN_ONLY_STEPS` would make the assertion
 * `set.has(x) for x in set` -- a tautology that a deletion shrinks its way out of.
 */
const WRAPPER_FENCED_SERVED_KINDS: readonly string[] = Object.freeze([
  "approval.decide", "approval.decide_intent",
  "criterion_check.approve", "criterion_check.verify",
  "deployment.deploy", "deployment.set_target",
  "environment.set_variable", "environment.unset_variable",
  "goal.close", "goal.create", "goal.create_with_source",
  // BOTH halves of the preview act, and the subject of this row.
  "preview.decide", "preview.start",
  "release.decide", "repository.bootstrap", "repository.publish", "repository.recover",
]);

const live: PreviewSupervisor[] = [];

afterEach(async () => {
  // No arm may leave a dev server behind for the next arm's port to collide with.
  while (live.length > 0) await live.pop()?.close();
  closeStores();
  cleanupFixtureWorkspaces();
});

/**
 * An INPUT fixture, not a rule: it maps two credentials to two principal ids, both holding
 * REVIEW, so the capability stage never answers first and the ONLY thing that can distinguish
 * them is the operator fence under test.
 */
const auth: Authenticator = {
  authenticate(credential: string | null): AuthenticationResult {
    if (credential === OPERATOR_CREDENTIAL) {
      return {
        principal: { capabilities: [REVIEW], principalId: OPERATOR, projectId: PROJECT_ID },
        verdict: "AUTHENTICATED",
      };
    }
    if (credential === AGENT_CREDENTIAL) {
      return {
        principal: { capabilities: [REVIEW], principalId: AGENT, projectId: PROJECT_ID },
        verdict: "AUTHENTICATED",
      };
    }
    return { verdict: "UNAUTHENTICATED" };
  },
};

/** The seed world at EXECUTION_ENABLED. Its one execution-bearing node is NOT landed. */
function enabledWorld(): Store {
  const store = openStore();
  driveThrough(store, "goal.close");
  return store;
}

/** The same world with its node landed as a real commit, through the lander's own writer. */
function landedWorld(): Store {
  const store = enabledWorld();
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((plan) =>
    plan.goalRef === GOAL_ID && plan.content.snapshot.nodes.some((n) => n.nodeKey === "node-a"));
  const nodeRef = graph === undefined
    ? "node-a" : compiledExecutionRef(PROJECT_ID, graph, "node-a");
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, "COMMITTED");
  return store;
}

/** A workspace that really serves html on a real ephemeral port. */
function servingWorkspace(): string {
  return fixtureWorkspace({
    files: { "server.mjs": LISTENING_SERVER },
    scripts: { preview: "node server.mjs" },
  });
}

interface Spy {
  readonly calls: { count: number; last: unknown };
  readonly supervisor: PreviewSupervisor;
}

/** The PRODUCTION supervisor behind a counting facade, so "the injected port was used" is a
 *  claim about the composed object rather than about a stand-in. */
function spySupervisor(store: Store, capture: PreviewCapturePort): Spy {
  const inner = createPreviewSupervisor({
    capture, clock: (): string => DECIDED_AT, projectId: PROJECT_ID, store,
  });
  live.push(inner);
  const calls = { count: 0, last: null as unknown };
  return {
    calls,
    supervisor: Object.freeze({
      active: inner.active,
      close: inner.close,
      decide: inner.decide,
      start: async (request: Parameters<PreviewSupervisor["start"]>[0]) => {
        calls.count += 1;
        calls.last = request;
        return await inner.start(request);
      },
    }),
  };
}

interface EdgeOverrides {
  readonly supervisor?: PreviewSupervisor;
  readonly workspace?: string | null;
}

/** The production registry and the production async door over one store. */
function edgeFor(store: Store, overrides: EdgeOverrides = {}): CommandAdapterDeps {
  const ports = createDaemonCommandPorts({
    clock: (): string => DECIDED_AT,
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
    store,
    ...(overrides.supervisor === undefined ? {} : { previewSupervisor: overrides.supervisor }),
    ...(overrides.workspace === undefined ? {} : { previewWorkspace: overrides.workspace }),
  });
  return { authenticator: auth, decisions: ports.decisions, registry: ports.registry };
}

async function start(
  deps: CommandAdapterDeps,
  commandId: string,
  payload: Readonly<Record<string, unknown>>,
  credential: string = OPERATOR_CREDENTIAL,
): Promise<Awaited<ReturnType<typeof handleAsyncCommandRequest>>> {
  return await handleAsyncCommandRequest(deps, {
    body: new TextEncoder().encode(JSON.stringify({
      commandId, commandKind: PREVIEW_START_COMMAND_KIND, correlationId: "corr-preview-start",
      expectedVersion: 0, payload, requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: credential,
      targetAggregateId: `preview:${GOAL_ID}`,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

/** How many receipt rows the ledger really holds for this revision. Paged, because the store
 *  caps a single read at 1000 and a truncated walk would under-count a double write. */
function receiptRows(store: Store, receiptId: string): number {
  let cursor = 0n;
  let rows = 0;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 500);
    for (const decision of page.items) {
      if (decision.commandKind === PREVIEW_RECEIPT_COMMAND_KIND
        && decision.key.commandId === receiptId) rows += 1;
    }
    if (!page.hasMore || page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
}

describe("preview.start writes and answers from the durable receipt", () => {
  it("(A) records STARTED with url, pid and screenshots, read back through the ledger", async () => {
    const store = landedWorld();
    const spy = spySupervisor(store, async () => [SHOT]);
    const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: servingWorkspace() });

    const answered = await start(deps, "cmd-start-ok", { goalId: GOAL_ID, sha: SHA });

    expect(answered).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "PREVIEW_STARTED" },
      outcome: "ACCEPTED",
    });
    // THE PRODUCTION READ SURFACE, not the handler's return value.
    const receiptId = previewReceiptId(PROJECT_ID, GOAL_ID, SHA);
    const read = readPreviewReceipt(store, PROJECT_ID, receiptId);
    if (!read.ok) throw new Error(`expected a readable receipt, got ${read.code}`);
    expect(read.receipt.outcome).toBe("STARTED");
    expect(read.receipt.code).toBeNull();
    expect(read.receipt.goalId).toBe(GOAL_ID);
    expect(read.receipt.sha).toBe(SHA);
    expect(read.receipt.screenshots).toStrictEqual([SHOT]);
    // VALUES, not merely presence: a live preview has an origin and a pid the operator can act on.
    expect(read.receipt.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/u);
    expect(typeof read.receipt.pid).toBe("number");
    expect(read.receipt.pid).toBeGreaterThan(0);
    // The answer's effectId names the receipt the read above returned.
    expect(answered.outcome === "ACCEPTED" ? answered.decision.effectId : null).toBe(receiptId);
  });

  it("(D) calls the INJECTED port and leaves exactly ONE ledger row for the revision", async () => {
    const store = landedWorld();
    const spy = spySupervisor(store, async () => [SHOT]);
    const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: servingWorkspace() });

    await start(deps, "cmd-start-once", { goalId: GOAL_ID, sha: SHA });

    // The composed port was used — no second supervisor was constructed inside the handler.
    expect(spy.calls.count).toBe(1);
    expect(spy.calls.last).toStrictEqual({
      goalId: GOAL_ID, sha: SHA, workspace: expect.any(String) as unknown as string,
    });
    // EXACTLY ONE receipt row. A second `recordPreviewReceipt` in the handler would be absorbed
    // by the ledger's idempotence and answer `replayed: true`, so a naive read cannot see it —
    // only counting the rows can.
    expect(receiptRows(store, previewReceiptId(PROJECT_ID, GOAL_ID, SHA))).toBe(1);
  });

  it("(B) records REFUSED CARRYING ITS CODE when the workspace names no preview command",
    async () => {
      const store = landedWorld();
      const spy = spySupervisor(store, async () => []);
      // Every gate above the runner is PASSABLE: landed goal, operator principal, exact payload,
      // wired supervisor, configured workspace. Only the command resolution fails.
      const deps = edgeFor(store, {
        supervisor: spy.supervisor,
        workspace: fixtureWorkspace({ scripts: { build: "tsc" } }),
      });

      const answered = await start(deps, "cmd-start-nocmd", { goalId: GOAL_ID, sha: SHA });

      expect(answered).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: "PREVIEW_COMMAND_MISSING", layer: "RUNNER" },
      });
      // AN ABSENT RECEIPT AND A REFUSED ONE ARE DIFFERENT OPERATOR-VISIBLE STATES: the receipt
      // exists, and it carries the code, read back through the production surface.
      const read = readPreviewReceipt(
        store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL_ID, SHA),
      );
      if (!read.ok) throw new Error(`expected a REFUSED receipt, got ${read.code}`);
      expect(read.receipt.outcome).toBe("REFUSED");
      expect(read.receipt.code).toBe("PREVIEW_COMMAND_MISSING");
      expect(read.receipt.url).toBeNull();
      expect(read.receipt.pid).toBeNull();
      expect(spy.calls.count).toBe(1);
    });
});

describe("every refusal preview.start can raise, with the layer that answered it", () => {
  it("(C1) OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION: the ASYNC ENTRY fences ITSELF",
    async () => {
      // THE MOST LOAD-BEARING ARM IN THE FILE. `entryOf` returns the async entry BEFORE the
      // registry's synchronous operator check, so this refusal can only come from the handler's
      // own entry fence. The session holds REVIEW, so the capability stage cannot answer first,
      // and every other gate is passable — the POSITIVE CONTROL below runs the same world with
      // the same bytes as the operator and is ACCEPTED.
      const store = landedWorld();
      const spy = spySupervisor(store, async () => [SHOT]);
      const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: servingWorkspace() });

      const refused = await start(
        deps, "cmd-start-agent", { goalId: GOAL_ID, sha: SHA }, AGENT_CREDENTIAL,
      );

      expect(refused).toMatchObject({
        httpStatus: 403,
        outcome: "PORT_REFUSED",
        refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" },
        stage: "DISPATCH",
      });
      // FENCED BEFORE ANY EFFECT: no supervisor call, and no receipt for the revision.
      expect(spy.calls.count).toBe(0);
      expect(readPreviewReceipt(
        store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL_ID, SHA),
      ).ok).toBe(false);

      const control = await start(deps, "cmd-start-operator", { goalId: GOAL_ID, sha: SHA });
      expect(control).toMatchObject({
        decision: { resultCode: "PREVIEW_STARTED" }, outcome: "ACCEPTED",
      });
    });

  it("(C2) PREVIEW_START_PAYLOAD_INVALID @ REQUEST: the decoder, above the runner", async () => {
    const store = landedWorld();
    const spy = spySupervisor(store, async () => [SHOT]);
    const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: servingWorkspace() });

    // Every OTHER gate is passable: operator principal, landed goal, wired supervisor,
    // configured workspace. The keys are the roster's own, so the ingress allow-list admits the
    // payload and the DECODER is what refuses the empty `sha`.
    const refused = await start(deps, "cmd-start-empty-sha", { goalId: GOAL_ID, sha: "" });

    expect(refused).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: {
        code: "PREVIEW_START_PAYLOAD_INVALID",
        layer: PREVIEW_CODE_LAYERS.PREVIEW_START_PAYLOAD_INVALID,
      },
      stage: "DISPATCH",
    });
    expect(refused).toMatchObject({ refusal: { layer: "REQUEST" } });
    expect(spy.calls.count).toBe(0);
  });

  it("(C3) PREVIEW_START_PAYLOAD_INVALID @ REQUEST for a traversal-shaped sha", async () => {
    const store = landedWorld();
    const spy = spySupervisor(store, async () => [SHOT]);
    const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: servingWorkspace() });

    // The runner has its OWN containment check one layer down, so this arm names WHICH gate
    // answered: the decoder refuses at REQUEST, and the supervisor is never reached at all.
    const refused = await start(deps, "cmd-start-escape", { goalId: GOAL_ID, sha: "../escape" });

    expect(refused).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "PREVIEW_START_PAYLOAD_INVALID", layer: "REQUEST" },
    });
    expect(spy.calls.count).toBe(0);
  });

  it("(C4) PREVIEW_COMMAND_MISSING @ RUNNER when NO supervisor is composed", async () => {
    const store = landedWorld();
    // Served but unwired: the kind is still on the roster, and the dispatch fails CLOSED.
    const deps = edgeFor(store, { workspace: servingWorkspace() });
    expect(deps.registry.has(PREVIEW_START_COMMAND_KIND)).toBe(true);

    const refused = await start(deps, "cmd-start-unwired", { goalId: GOAL_ID, sha: SHA });

    expect(refused).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: {
        code: "PREVIEW_COMMAND_MISSING",
        layer: PREVIEW_CODE_LAYERS.PREVIEW_COMMAND_MISSING,
      },
    });
    expect(refused).toMatchObject({ refusal: { layer: "RUNNER" } });
  });

  it("(C5) PREVIEW_COMMAND_MISSING @ RUNNER when the daemon has NO configured workspace",
    async () => {
      const store = landedWorld();
      const spy = spySupervisor(store, async () => [SHOT]);
      // The supervisor IS wired, so this refusal is the unconfigured workspace and nothing else.
      // No workspace is invented and no default is guessed.
      const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: null });

      const refused = await start(deps, "cmd-start-noworkspace", { goalId: GOAL_ID, sha: SHA });

      expect(refused).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: "PREVIEW_COMMAND_MISSING", layer: "RUNNER" },
      });
      expect(spy.calls.count).toBe(0);
    });

  it("(C6) PREVIEW_GOAL_NOT_LANDED @ GOAL_AUTHORITY for a goal with no landed revision",
    async () => {
      // EVERY OTHER GATE PASSABLE — operator principal, exact payload, wired supervisor, a
      // workspace that really serves — so the only thing left to refuse is the landing gate.
      const store = enabledWorld();
      const spy = spySupervisor(store, async () => [SHOT]);
      const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: servingWorkspace() });

      const refused = await start(deps, "cmd-start-unlanded", { goalId: GOAL_ID, sha: SHA });

      expect(refused).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: {
          code: "PREVIEW_GOAL_NOT_LANDED",
          layer: PREVIEW_CODE_LAYERS.PREVIEW_GOAL_NOT_LANDED,
        },
      });
      expect(refused).toMatchObject({ refusal: { layer: "GOAL_AUTHORITY" } });
      // The runner recorded the refusal, so the operator's screen can say WHY there is nothing.
      const read = readPreviewReceipt(
        store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL_ID, SHA),
      );
      if (!read.ok) throw new Error(`expected a REFUSED receipt, got ${read.code}`);
      expect(read.receipt.outcome).toBe("REFUSED");
      expect(read.receipt.code).toBe("PREVIEW_GOAL_NOT_LANDED");
    });
});

describe("workspace is not accepted from the payload", () => {
  it("(E1) the INGRESS allow-list refuses it at PAYLOAD_SHAPE, before any handler runs",
    async () => {
      const store = landedWorld();
      const spy = spySupervisor(store, async () => [SHOT]);
      const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: servingWorkspace() });

      const refused = await start(deps, "cmd-start-smuggled", {
        goalId: GOAL_ID, sha: SHA, workspace: "C:/attacker/tree",
      });

      expect(refused).toMatchObject({
        error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false,
        outcome: "REFUSED", stage: "PAYLOAD_SHAPE",
      });
      expect(spy.calls.count).toBe(0);
      // The advertised roster is what makes that true, and it is exactly two keys.
      expect(PAYLOAD_KEYS[PREVIEW_START_COMMAND_KIND]).toStrictEqual(["goalId", "sha"]);
      expect(PREVIEW_START_PAYLOAD_KEYS).not.toContain("workspace");
    });

  it("(E2) the DECODER refuses it too, at REQUEST, so the second gate is not the only one", () => {
    // The ingress arm above proves the OUTER fence. This one proves the decoder would refuse the
    // same bytes on its own, so widening the advertised roster alone could not admit a
    // caller-chosen workspace.
    const decoded = decodePreviewStartPayload({
      goalId: GOAL_ID, sha: SHA, workspace: "C:/attacker/tree",
    });
    expect(decoded).toMatchObject({
      code: "PREVIEW_START_PAYLOAD_INVALID", layer: "REQUEST", ok: false,
    });
    // The POSITIVE CONTROL: the same decoder accepts the exact two-key shape, so the arm above
    // is not green because the decoder refuses everything.
    expect(decodePreviewStartPayload({ goalId: GOAL_ID, sha: SHA })).toMatchObject({
      ok: true, payload: { goalId: GOAL_ID, sha: SHA },
    });
  });
});

describe("the human-only fence is bidirectional over the served set", () => {
  it("asserts SET-EQUALITY between served operator kinds and the two advertised fences", () => {
    // THE SERVED SET IS ENUMERATED FROM THE DISPATCH SEAM, never from a roster constant: a test
    // that iterates the roster shrinks its own iteration when an entry is deleted and stays
    // green while a served capability silently loses its fence.
    const store = openStore();
    const deps = edgeFor(store);
    const served = new Set<string>([...deps.registry.keys()]);
    const servedOperatorKinds = [...served]
      .filter((kind) => OPERATOR_PRINCIPAL_KINDS.has(kind as never)).sort();

    // Direction 1: nothing is fenced off MCP that the seam does not actually serve.
    expect([...MCP_EXCLUDED_COMMAND_KINDS].filter((kind) => !served.has(kind))).toStrictEqual([]);
    // Direction 2: every SERVED operator kind is off the advertised MCP roster. Set-equality
    // against the exclusion list plus its one documented exception, not a subset check.
    expect(servedOperatorKinds)
      .toStrictEqual([...MCP_EXCLUDED_COMMAND_KINDS, "session.open"].sort());

    // The subject, named on both halves. The set assertions above shrink with a wholesale
    // removal; these do not, so deleting the kind from either side reddens here.
    expect(served.has(PREVIEW_START_COMMAND_KIND)).toBe(true);
    expect(MCP_EXCLUDED_COMMAND_KINDS).toContain(PREVIEW_START_COMMAND_KIND);
    expect(wiredMcpToolKinds()).not.toContain(PREVIEW_START_COMMAND_KIND);
    // SERVED BY THE ASYNC ENTRY, not by the generic synchronous fallback: `entryOf` answers any
    // vocabulary kind, so membership alone cannot tell "registered" from "served by its own
    // service" — a deleted async entry would leave the key in place and every set arm green.
    expect(deps.registry.get(PREVIEW_START_COMMAND_KIND)?.asyncHandler).toBeDefined();

    // The WRAPPER's half of the fence, which the MCP half does not imply.
    // SET-EQUALITY, not a subset, and MEASURED FROM THE SEAM. A subset filter here would be
    // BLIND to a deletion: removing a kind from `HUMAN_ONLY_STEPS` only SHRINKS the filtered
    // set, so a `filter(...).toStrictEqual([])` stays empty and the arm stays green. Mutation
    // drill 5 found exactly that, so this became an equality against a hand transcription.
    const wrapperFenced = [...served].filter((kind) => HUMAN_ONLY_STEPS.has(kind)).sort();
    expect(wrapperFenced).toStrictEqual(WRAPPER_FENCED_SERVED_KINDS);
    // The subject, named LAST so the set arm above is what catches a deletion first.
    expect(HUMAN_ONLY_STEPS.has(PREVIEW_START_COMMAND_KIND)).toBe(true);
  });
});

/**
 * THE READ-BACK IS THE SUBJECT, and these two arms are the ONLY ones that can see it.
 *
 * MEASURED, not assumed. A mutation drill that rewrote the handler to answer from
 * `result.started.receipt` instead of `readPreviewReceipt` left arms (A) and (B) GREEN: the
 * runner's `record()` already reads its own write back through the decoder, so on the happy path
 * the two values are byte-identical and no arm above could tell them apart. An arm that cannot
 * distinguish the design from its opposite is not testing the design.
 *
 * Both arms below inject a supervisor whose ANSWER DISAGREES WITH THE LEDGER, which is exactly
 * the condition the read-back exists for: a writer that says a preview started when nothing
 * durable says so, and a writer whose refusal code differs from the one actually recorded.
 */
describe("the answer comes from the ledger, never from the writer's own account", () => {
  it("refuses PREVIEW_START_TIMEOUT @ RUNNER when the writer claims a start the store never holds",
    async () => {
      const store = landedWorld();
      const receiptId = previewReceiptId(PROJECT_ID, GOAL_ID, SHA);
      // A supervisor that reports success and records NOTHING. Production must not take its
      // word for it; a handler answering from the return value would report PREVIEW_STARTED for
      // a preview the operator's screen could never load.
      const lying: PreviewSupervisor = Object.freeze({
        active: () => [],
        close: async () => undefined,
        decide: async () => false,
        start: async () => ({
          ok: true as const,
          started: {
            handle: { origin: "http://127.0.0.1:1/", pid: 4242, port: 1,
              stop: async () => undefined } as never,
            receipt: {
              code: null, decidedAt: DECIDED_AT, goalId: GOAL_ID, outcome: "STARTED" as const,
              pid: 4242, projectId: PROJECT_ID, receiptId, screenshots: [SHOT], sha: SHA,
              url: "http://127.0.0.1:1/", version: "moe-preview-receipt/1" as const,
            },
          },
        }),
      });
      const deps = edgeFor(store, { supervisor: lying, workspace: servingWorkspace() });

      const answered = await start(deps, "cmd-start-lying", { goalId: GOAL_ID, sha: SHA });

      expect(answered).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: {
          code: "PREVIEW_START_TIMEOUT", layer: PREVIEW_CODE_LAYERS.PREVIEW_START_TIMEOUT,
        },
      });
      expect(answered).toMatchObject({ refusal: { layer: "RUNNER" } });
      // The premise, asserted rather than assumed: nothing durable exists for this revision, so
      // the arm is about the read-back and not about a receipt that happened to differ.
      expect(readPreviewReceipt(store, PROJECT_ID, receiptId).ok).toBe(false);
    });

  it("answers the RECORDED refusal code, not the code the writer handed back", async () => {
    const store = landedWorld();
    const spy = spySupervisor(store, async () => []);
    // The REAL runner records PREVIEW_COMMAND_MISSING for this workspace. The facade reports a
    // DIFFERENT code, so the two can be told apart: production answers what the ledger holds.
    const workspace = fixtureWorkspace({ scripts: { build: "tsc" } });
    const disagreeing: PreviewSupervisor = Object.freeze({
      active: spy.supervisor.active,
      close: spy.supervisor.close,
      decide: spy.supervisor.decide,
      start: async (request: Parameters<PreviewSupervisor["start"]>[0]) => {
        const real = await spy.supervisor.start(request);
        return real.ok
          ? real
          : { ok: false as const, receipt: real.receipt, refusal: previewRefusal("PREVIEW_START_TIMEOUT") };
      },
    });
    const deps = edgeFor(store, { supervisor: disagreeing, workspace });

    const answered = await start(deps, "cmd-start-disagree", { goalId: GOAL_ID, sha: SHA });

    const read = readPreviewReceipt(store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL_ID, SHA));
    if (!read.ok) throw new Error(`expected a REFUSED receipt, got ${read.code}`);
    expect(read.receipt.code).toBe("PREVIEW_COMMAND_MISSING");
    // The RECORDED code wins over the returned one, with its own mapped layer.
    expect(answered).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "PREVIEW_COMMAND_MISSING", layer: "RUNNER" },
    });
  });
});

/**
 * THE FAMILY MEMBERSHIP, GUARDED DIRECTLY. `daemon-command-families.ts` states it as an
 * EQUALITY (`kind === DECIDE || kind === START`), not a set membership, so narrowing it back to
 * the decide kind still COMPILES.
 *
 * MEASURED: mutation drill 6 narrowed it and the only thing that reddened was an UNRELATED
 * kind's arm in `daemon-command-registry.test.ts` -- `deployment.set_target` answered
 * BOOTSTRAP_PREREQUISITE_MISSING instead of BOOTSTRAP_COMMAND_UNKNOWN, because a mis-familied
 * `preview.start` drove a bootstrap command into the shared store ahead of it. Something watched
 * the flag, but nothing named THIS kind, and an indirect catch through shared test-order state
 * is not a guard. This arm is.
 */
describe("preview.start's command family", () => {
  it("is PREVIEW at REVIEW, with both controls", () => {
    const facts = commandFamilyFacts(PREVIEW_START_COMMAND_KIND);
    expect(facts.preview).toBe(true);
    expect(facts.requiredCapability).toBe(REVIEW);
    // POSITIVE CONTROL: its twin agrees, so the arm is about the widened equality and not about
    // a default that happens to answer true.
    expect(commandFamilyFacts(PREVIEW_DECIDE_COMMAND_KIND).preview).toBe(true);
    // NEGATIVE CONTROL: an unrelated kind is NOT in the family, so `preview` is not simply true.
    expect(commandFamilyFacts("project.register").preview).toBe(false);
  });
});

/**
 * REPEAT STARTS FOR THE SAME REVISION, found by the step-9 adversarial pass rather than by a
 * failing arm.
 *
 * The supervisor de-duplicates starts that are IN FLIGHT together, but a SECOND command
 * arriving after the first has finished finds that map empty and reaches `runPreview`, which
 * SPAWNS before it records. The ledger is idempotent by receipt id, so the second run records
 * nothing new and the supervisor then evicts the FIRST handle from its live roster with the
 * second one. The first process would never be stopped -- not by `preview.decide`, not by
 * shutdown -- and would hold its port for the life of the host. This row made that reachable,
 * because before it nothing in production called `supervisor.start`.
 */
describe("a repeat start for the same revision", () => {
  it("REPLAYS the existing receipt and spawns NO second server", async () => {
    const store = landedWorld();
    const spy = spySupervisor(store, async () => [SHOT]);
    const deps = edgeFor(store, { supervisor: spy.supervisor, workspace: servingWorkspace() });

    const first = await start(deps, "cmd-repeat-1", { goalId: GOAL_ID, sha: SHA });
    expect(first).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "PREVIEW_STARTED" }, outcome: "ACCEPTED",
    });
    const second = await start(deps, "cmd-repeat-2", { goalId: GOAL_ID, sha: SHA });

    const receiptId = previewReceiptId(PROJECT_ID, GOAL_ID, SHA);
    expect(second).toMatchObject({
      decision: { disposition: "REPLAYED", effectId: receiptId, resultCode: "PREVIEW_STARTED" },
      outcome: "ACCEPTED",
    });
    // THE POINT OF THE ARM: the supervisor was reached ONCE, so exactly one process exists and
    // the live roster still holds the handle that can stop it.
    expect(spy.calls.count).toBe(1);
    expect(receiptRows(store, receiptId)).toBe(1);
  });

  it("does NOT short-circuit a REFUSED receipt, because a refusal is retryable", async () => {
    // The workspace names no preview command, so the first attempt records REFUSED. Fixing the
    // condition is exactly what an operator would do next, so the second attempt must reach the
    // runner again rather than replay the refusal for ever.
    const store = landedWorld();
    const spy = spySupervisor(store, async () => []);
    const deps = edgeFor(store, {
      supervisor: spy.supervisor, workspace: fixtureWorkspace({ scripts: { build: "tsc" } }),
    });

    await start(deps, "cmd-retry-1", { goalId: GOAL_ID, sha: SHA });
    const read = readPreviewReceipt(store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL_ID, SHA));
    if (!read.ok) throw new Error(`expected a REFUSED receipt, got ${read.code}`);
    expect(read.receipt.outcome).toBe("REFUSED");

    await start(deps, "cmd-retry-2", { goalId: GOAL_ID, sha: SHA });

    expect(spy.calls.count).toBe(2);
  });
});
