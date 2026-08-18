/**
 * The transport/host portability matrix.
 *
 * TWO SHIPPED BOUNDARIES, without inventing a third:
 *  - the installed `moe-mcp-stdio` and `moe-mcp-http` executables, compared for
 *    command-decision IDENTITY rather than for agreement;
 *  - the public `@moe/jetbrains-adapter/host` subpath, exercised for its real
 *    distribution/probe/start/endpoint/reconnect/uninstall surface only.
 *
 * NOTHING HERE REACHES A SUBJECT BY SOURCE PATH. Transport cases go through
 * `node_modules/.bin`; the JetBrains case goes through a bare public specifier in
 * a real child Node process. The neighbouring control-room suite imports its
 * subjects by deep relative path, and that is deliberately not copied here.
 *
 * MCP COMMAND TRANSLATION FOR JETBRAINS IS UNKNOWN, structurally: `JetBrainsHost`
 * publishes exactly {endpoint, reconnect, start, uninstall}. The matrix asserts
 * that closed four-key surface, so the UNKNOWN is measured rather than untested.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CASES, CODES, CONFLICT_TOOL_LABEL, CONTROL_TOOL_LABEL, JETBRAINS_ARMS, JETBRAINS_EXPECTED,
  JETBRAINS_HOST_KEYS, JETBRAINS_MCP_TRANSLATION, LAYERS, SESSION_TOOL_LABEL, STAGES, SUBJECTS,
  TRANSPORT_ARMS, TRANSPORT_SUBJECTS, TRUNCATED_NO_WRITE, UNKNOWN_TOOL_LABEL,
  jetBrainsProbeSource, pin, registerArguments, sessionArguments, toolEntryExists,
} from "./portability-cases.js";
import type { Answerer, TransportSubject } from "./portability-cases.js";
import {
  createWorkspace, environmentFor, httpDriver, portIsFree, rawPost, readStoreCounts,
  killTree, removeWorkspace, runNodeChild, stdioClient, stdioDriver, truncateHttpBody,
} from "./portability-harness.js";
import type {
  Driver, JsonRpcMessage, PortabilityWorkspace, Reply, StoreCounts,
} from "./portability-harness.js";

/** Captured ONCE. Every recorded digest on both halves binds to this checkout. */
const SOURCE_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const SCOPED_SECRET = "portability-scoped-session-secret";
const PROJECT_ID = "proj-portability";
const IDE_OWNER = "@moe/ide-adapter-contract";

interface Answer {
  readonly answerer: Answerer;
  readonly code: string | null;
  /** Daemon bytes with all framing removed, or null when it never dispatched. */
  readonly payload: string | null;
  readonly stage: string | null;
}

interface RunRecord {
  readonly answers: Record<string, Answer>;
  readonly counts: Record<string, StoreCounts>;
  readonly digests: Record<string, string>;
  readonly httpPort: number;
}

/**
 * Classifies which layer answered from the SHAPE of the reply, never from what the
 * case hoped for. A non-200 HTTP status can only come from the pre-transport
 * screen; a JSON-RPC error carrying a registry `data.code` can only come from the
 * MCP adapter; a bare code with no data is the SDK's own method table; a `result`
 * means the daemon seam dispatched and answered.
 */
function classify({ message, status }: Reply): Answer {
  const at = (answerer: Answerer, code: string | null, payload: string | null = null,
    stage: string | null = null): Answer => ({ answerer, code, payload, stage });
  const payload = message.result?.content?.[0]?.text ?? null;
  const data = message.error?.data as { code?: string } | undefined;
  if (status !== null && status !== 200) return at("HTTP_SESSION_SCREEN", data?.code ?? null);
  if (message.error !== undefined) {
    if (data?.code === undefined) return at("MCP_SDK", null);
    const auth = data.code === CODES.authenticationFailed;
    return at(auth ? "ADAPTER_AUTH" : "ADAPTER_DECODE", data.code);
  }
  if (payload === null) return at("DAEMON_SEAM", null);
  const seam = JSON.parse(payload) as {
    decision?: { resultCode?: string };
    error?: { code?: string };
    refusal?: { code?: string; layer?: string };
    stage?: string;
  };
  const code = seam.decision?.resultCode ?? seam.refusal?.code ?? seam.error?.code ?? null;
  return at("DAEMON_SEAM", code, payload, seam.refusal?.layer ?? seam.stage ?? null);
}

function decisionOf(answer: Answer | undefined): Record<string, string> {
  return (JSON.parse(answer?.payload ?? "{}") as { decision?: Record<string, string> })
    .decision ?? {};
}

/** Binds a recorded observation to the checkout it was produced from. */
function digestOf(commit: string, caseId: string, body: string): string {
  return createHash("sha256").update(`${commit}|${caseId}|${body}`).digest("hex");
}

/** A real scoped session, minted through the production `session.open` command. */
async function mintScopedSession(workspace: PortabilityWorkspace): Promise<void> {
  const driver = await stdioDriver(workspace, workspace.credential);
  try {
    const answer = classify(await driver.call(SESSION_TOOL_LABEL, sessionArguments(
      "portability-open-session",
      "portability-scoped-session",
      createHash("sha256").update(SCOPED_SECRET).digest("hex"),
    )));
    if (answer.code !== "EFFECTS_COMMITTED") {
      throw new Error(`scoped session was not minted: ${String(answer.payload)}`);
    }
  } finally {
    await driver.stop();
  }
}

/**
 * Drives every transport arm once in one fresh workspace and RECORDS what each
 * layer answered plus the store counts around it. Recording rather than asserting
 * is what lets the whole matrix run twice and be compared.
 */
async function runTransports(): Promise<RunRecord> {
  const workspace = createWorkspace(PROJECT_ID);
  const answers: Record<string, Answer> = {};
  const counts: Record<string, StoreCounts> = {};
  const digests: Record<string, string> = {};
  const record = (caseId: string, answer: Answer): void => {
    answers[caseId] = answer;
    digests[caseId] = digestOf(SOURCE_COMMIT, caseId, answer.payload ?? `~${answer.answerer}`);
  };
  const snapshot = async (label: string): Promise<void> => {
    counts[label] = await readStoreCounts(workspace.storePath);
  };

  try {
    await mintScopedSession(workspace);
    await snapshot("seeded");
    const stdio = await stdioDriver(workspace, workspace.credential);
    const http = await httpDriver(workspace, workspace.credential);
    try {
      // ACCEPTED CONTROLS, one per installed executable, sharing ONE commandId so
      // the identity claim below is a real replay rather than a coincidence.
      const shared = registerArguments("portability-shared-command", PROJECT_ID);
      record("STDIO:accepted-control", classify(await stdio.call(CONTROL_TOOL_LABEL, shared)));
      await snapshot("afterStdioAccept");
      record("HTTP:accepted-control", classify(await http.call(CONTROL_TOOL_LABEL, shared)));
      await snapshot("afterHttpReplay");
      // A third call back through stdio: its REPLAYED bytes and the HTTP REPLAYED
      // bytes above must be byte-identical, with no field excluded.
      record("STDIO:replayed-echo", classify(await stdio.call(CONTROL_TOOL_LABEL, shared)));

      // Reversed, so the replay cannot be an artifact of which transport led. It
      // uses a fresh session aggregate because the project aggregate has already
      // moved past version 0 and a second register would be refused as stale.
      const reversed = sessionArguments(
        "portability-reversed-command",
        "portability-reversed-session",
        createHash("sha256").update("portability-reversed-secret").digest("hex"),
      );
      record("HTTP:reversed-first", classify(await http.call(SESSION_TOOL_LABEL, reversed)));
      record("STDIO:reversed-second", classify(await stdio.call(SESSION_TOOL_LABEL, reversed)));
      await snapshot("afterReversedPair");

      const drivers: Readonly<Record<TransportSubject, Driver>> = { HTTP: http, STDIO: stdio };
      for (const subject of TRANSPORT_SUBJECTS) {
        const driver = drivers[subject];
        record(`${subject}:malformed-envelope`, classify(await driver.call(CONTROL_TOOL_LABEL, {
          ...registerArguments(`${subject}-malformed`, PROJECT_ID),
          unexpectedKey: 1,
        })));
        record(`${subject}:unknown-tool-label`, classify(await driver.call(UNKNOWN_TOOL_LABEL, {})));
        record(`${subject}:unsupported-method`, classify(await driver.raw("resources/list", {})));
        // Same commandId, different command entirely: it must refuse rather than
        // hand back authority for a command that was never decided.
        record(`${subject}:replay-conflict`, classify(await driver.call(CONFLICT_TOOL_LABEL, {
          commandId: "portability-shared-command",
          correlationId: `corr-conflict-${subject}`,
          expectedVersion: 1,
          payload: { observation: {} },
          targetAggregateId: PROJECT_ID,
        })));
      }

      // Capability scope: a real minted session holding work.write only, driven at
      // a command that requires project.admin.
      const scoped: Readonly<Record<TransportSubject, Driver>> = {
        HTTP: await httpDriver(workspace, SCOPED_SECRET),
        STDIO: await stdioDriver(workspace, SCOPED_SECRET),
      };
      try {
        for (const subject of TRANSPORT_SUBJECTS) {
          record(`${subject}:capability-scope-denied`, classify(
            await scoped[subject].call(
              CONTROL_TOOL_LABEL,
              registerArguments(`${subject}-scoped`, PROJECT_ID),
            ),
          ));
        }
      } finally {
        await scoped.STDIO.stop();
        await scoped.HTTP.stop();
      }

      // Wrong credential. The stdio server holds its credential in CLOSURE and
      // writes the envelope field last, so this arm can ONLY be driven by starting
      // a child with a different MOE_SESSION_CREDENTIAL.
      const badStdio = await stdioDriver(workspace, "not-the-credential");
      try {
        record("STDIO:wrong-credential", classify(await badStdio.call(
          CONTROL_TOOL_LABEL,
          registerArguments("stdio-bad-credential", PROJECT_ID),
        )));
        record("STDIO:wrong-credential-and-malformed", classify(await badStdio.call(
          CONTROL_TOOL_LABEL,
          { ...registerArguments("stdio-bad-both", PROJECT_ID), unexpectedKey: 1 },
        )));
      } finally {
        await badStdio.stop();
      }

      // TRUNCATION, driven rather than declared: half a frame with no terminator,
      // then stdin closed under it. Silence AND an untouched store is the claim.
      const cut = stdioClient(
        "moe-mcp-stdio",
        environmentFor(workspace, { MOE_SESSION_CREDENTIAL: workspace.credential }),
      );
      try {
        await cut.initialize();
        const before = await readStoreCounts(workspace.storePath);
        cut.writeRaw('{"jsonrpc":"2.0","id":99,"method":"tools/');
        cut.child.stdin.end();
        const exited = await cut.waitForExit(8_000);
        const after = await readStoreCounts(workspace.storePath);
        const clean = exited && after.decisions === before.decisions
          && after.events === before.events;
        record("STDIO:truncation-disconnect", { answerer: "NO_ANSWER", code: null, payload: null,
          stage: clean ? TRUNCATED_NO_WRITE : "TRUNCATED_BUT_DIRTY" });
      } finally {
        await killTree(cut.child);
      }

      const wrong = await rawPost(http.port, "nope", '{"jsonrpc":"2.0"}');
      record("HTTP:wrong-credential", classify({
        message: JSON.parse(wrong.body) as JsonRpcMessage, status: wrong.status,
      }));
      const both = await rawPost(http.port, "nope", "{not json");
      record("HTTP:wrong-credential-and-malformed", classify({
        message: JSON.parse(both.body) as JsonRpcMessage, status: both.status,
      }));
      // Truncation: a declared body that never arrives. The listener must neither
      // answer it nor wedge, and must have written nothing.
      const httpBefore = await readStoreCounts(workspace.storePath);
      await truncateHttpBody(http.port, workspace.credential);
      const alive = await http.raw("tools/list", {});
      const httpAfter = await readStoreCounts(workspace.storePath);
      const served = alive.status === 200 && alive.message.error === undefined
        && httpAfter.decisions === httpBefore.decisions && httpAfter.events === httpBefore.events;
      record("HTTP:truncation-disconnect", { answerer: "NO_ANSWER", code: null, payload: null,
        stage: served ? TRUNCATED_NO_WRITE : "TRUNCATED_BUT_DIRTY" });

      await snapshot("final");
      return { answers, counts, digests, httpPort: http.port };
    } finally {
      await stdio.stop();
      await http.stop();
    }
  } finally {
    removeWorkspace(workspace);
  }
}

interface IdeOutcome { readonly code: string; readonly layer: string; readonly outcome: string }
interface Refusal { readonly code: string; readonly reason: string; readonly refusedBy: string }

interface JetBrainsReport {
  readonly assetsMissing: IdeOutcome;
  readonly emptyRoot: Refusal;
  readonly endpointAfterStartRefused: string | null;
  readonly endpointAfterUninstall: string | null;
  readonly endpointLive: string | null;
  readonly hostKeys: readonly string[];
  readonly ideLayers: readonly string[];
  readonly ideReasonCodes: readonly string[];
  readonly mismatch: Refusal;
  readonly openedAfterPostUninstall: number;
  readonly openedAfterReconnect: number;
  readonly postUninstall: { readonly code: string };
  readonly reconnect: { readonly code: string; readonly outcome: string };
  readonly startDead: IdeOutcome;
}

let runA: RunRecord;
let runB: RunRecord;
let jetbrains: JetBrainsReport;

describe("portability: daemon transport and JetBrains host matrix", () => {
  beforeAll(async () => {
    runA = await runTransports();
    runB = await runTransports();
    const [host, vocabulary] = await Promise.all([
      runNodeChild(process.cwd(), jetBrainsProbeSource()),
      runNodeChild(
        "adapters/ide-contract",
        `const m = await import("${IDE_OWNER}");process.stdout.write(JSON.stringify(` +
          "{ideLayers: m.IDE_ADAPTER_LAYERS, ideReasonCodes: m.IDE_ADAPTER_REASON_CODES}));",
      ),
    ]);
    jetbrains = {
      ...(JSON.parse(host) as Omit<JetBrainsReport, "ideLayers" | "ideReasonCodes">),
      ...(JSON.parse(vocabulary) as Pick<JetBrainsReport, "ideLayers" | "ideReasonCodes">),
    };
  }, 900_000);

  afterAll(async () => {
    // No listening port survives teardown, on either run.
    expect(await portIsFree(runA.httpPort)).toBe(true);
    expect(await portIsFree(runB.httpPort)).toBe(true);
  });

  it("generates a positive subject-by-case matrix covering every declared subject", () => {
    expect(CASES.length).toBeGreaterThan(0);
    expect(CASES.length).toBe(
      TRANSPORT_SUBJECTS.length * TRANSPORT_ARMS.length + JETBRAINS_ARMS.length,
    );
    for (const subject of SUBJECTS) {
      expect(CASES.filter((entry) => entry.subject === subject).length).toBeGreaterThan(0);
    }
    expect(toolEntryExists(CONTROL_TOOL_LABEL)).toBe(true);
    expect(toolEntryExists(UNKNOWN_TOOL_LABEL)).toBe(false);
  });

  it("preserves ONE command-decision identity across both transports, in both orders", () => {
    // ACCEPTED CONTROLS: without a case that can succeed, a suite where nothing
    // can ever succeed would still report every refusal below correctly.
    for (const caseId of ["STDIO:accepted-control", "HTTP:accepted-control"]) {
      expect(runA.answers[caseId], caseId).toMatchObject({
        answerer: "DAEMON_SEAM", code: "EFFECTS_COMMITTED",
      });
    }
    const first = decisionOf(runA.answers["STDIO:accepted-control"]);
    const second = decisionOf(runA.answers["HTTP:accepted-control"]);
    expect(first.disposition).toBe("DECIDED");
    expect(second.disposition).toBe("REPLAYED");
    expect(second.effectId).toBe(first.effectId);
    expect(second.resultCode).toBe(first.resultCode);

    // The part a return-value comparison cannot see: two independent pipelines
    // computing equal answers would add TWO rows and still compare equal.
    const seeded = runA.counts["seeded"];
    const afterStdio = runA.counts["afterStdioAccept"];
    const afterHttp = runA.counts["afterHttpReplay"];
    expect((afterStdio?.decisions ?? 0) - (seeded?.decisions ?? 0)).toBe(1);
    expect(afterHttp?.decisions).toBe(afterStdio?.decisions);
    expect(afterHttp?.events).toBe(afterStdio?.events);

    const led = decisionOf(runA.answers["HTTP:reversed-first"]);
    const followed = decisionOf(runA.answers["STDIO:reversed-second"]);
    expect(led.disposition).toBe("DECIDED");
    expect(followed.disposition).toBe("REPLAYED");
    expect(followed.effectId).toBe(led.effectId);
    expect((runA.counts["afterReversedPair"]?.decisions ?? 0) - (afterHttp?.decisions ?? 0)).toBe(1);
  });

  it("produces byte-identical results once framing is removed, with no field excluded", () => {
    const viaHttp = Buffer.from(runA.answers["HTTP:accepted-control"]?.payload ?? "", "utf8");
    const viaStdio = Buffer.from(runA.answers["STDIO:replayed-echo"]?.payload ?? "", "utf8");
    expect(viaHttp.byteLength).toBeGreaterThan(0);
    expect(viaStdio.equals(viaHttp)).toBe(true);
  });

  it("answers every generated refusal arm with the exact code, at the exact layer", () => {
    let asserted = 0;
    for (const subject of TRANSPORT_SUBJECTS) {
      for (const arm of TRANSPORT_ARMS) {
        if (arm.armId === "accepted-control") continue;
        const observed = runA.answers[`${subject}:${arm.armId}`];
        expect(observed, `${subject}:${arm.armId} was never driven`).toBeDefined();
        expect(observed?.answerer, `${subject}:${arm.armId} answerer`).toBe(
          arm.expectedAnswerer[subject],
        );
        const expected = arm.expectedCodeBySubject?.[subject] ?? arm.expectedCode;
        if (expected !== null) expect(observed?.code, `${subject}:${arm.armId}`).toBe(expected);
        asserted += 1;
      }
    }
    // A sweep that silently produced zero cases would otherwise pass.
    expect(asserted).toBe(TRANSPORT_SUBJECTS.length * (TRANSPORT_ARMS.length - 1));
  });

  it("names the layer that really answered on both refusals that have two candidates", () => {
    for (const subject of TRANSPORT_SUBJECTS) {
      const conflict = runA.answers[`${subject}:replay-conflict`];
      expect(conflict?.code).toBe(CODES.commandIdReused);
      expect(conflict?.stage).toBe(LAYERS.daemonPrerequisite);
      // The store's own conflict code exists and is NOT what answered: the daemon
      // ledger short-circuits before the store's request-bytes guard is consulted.
      expect(conflict?.code).not.toBe(CODES.storeIdempotencyConflict);
      expect(conflict?.stage).not.toBe(LAYERS.durableStore);
      // Capability scope is refused AFTER authentication has already passed.
      const denied = runA.answers[`${subject}:capability-scope-denied`];
      expect(denied?.code).toBe(CODES.capabilityDenied);
      expect(denied?.stage).toBe(STAGES.authorize);
      expect(denied?.stage).not.toBe(STAGES.dispatch);
    }
  });

  it("answers a doubly-invalid request at the layer each transport really screens first", () => {
    // Measured, and it DIFFERS by transport: stdio decodes the envelope it built
    // before it authenticates, while HTTP screens the bearer before reading a byte
    // of body. Same hostile input, two different first fences.
    expect(runA.answers["STDIO:wrong-credential-and-malformed"]?.code).toBe(CODES.inputInvalid);
    expect(runA.answers["HTTP:wrong-credential-and-malformed"]?.code)
      .toBe(CODES.authenticationFailed);
    expect(runA.answers["STDIO:wrong-credential"]?.answerer).toBe("ADAPTER_AUTH");
    expect(runA.answers["HTTP:wrong-credential"]?.answerer).toBe("HTTP_SESSION_SCREEN");
  });

  it("answers a truncated frame with silence, on both transports, writing nothing", () => {
    for (const subject of TRANSPORT_SUBJECTS) {
      const observed = runA.answers[`${subject}:truncation-disconnect`];
      expect(observed?.answerer).toBe("NO_ANSWER");
      expect(observed?.stage, `${subject} truncation`).toBe(TRUNCATED_NO_WRITE);
    }
  });

  it("leaves event and decision counts untouched across every refusal arm", () => {
    const before = runA.counts["afterReversedPair"];
    expect(runA.counts["final"]?.decisions).toBe(before?.decisions);
    expect(runA.counts["final"]?.events).toBe(before?.events);
  });

  it("exposes exactly four JetBrains host keys and therefore no command method", () => {
    expect([...jetbrains.hostKeys].sort()).toEqual([...JETBRAINS_HOST_KEYS].sort());
    expect(jetbrains.hostKeys).not.toContain("command");
    expect(JETBRAINS_MCP_TRANSLATION).toBe("UNKNOWN");
  });

  it("refuses an incompatible distribution with the contract's exact refusal", () => {
    expect(jetbrains.mismatch).toEqual({ code: CODES.distributionMismatch, ok: false,
      reason: "API_RANGE_MISMATCH", refusedBy: "DISTRIBUTION_STARTUP" });
    expect(jetbrains.emptyRoot).toMatchObject({ code: CODES.distributionMismatch,
      reason: "COMPONENT_SET_INCOMPLETE", refusedBy: "DISTRIBUTION_STARTUP" });
  });

  it("answers each JetBrains port arm with an exact IDE-layer code the contract publishes", () => {
    const arms = [
      { arm: "daemon-start" as const, observed: jetbrains.startDead },
      { arm: "control-room-assets-missing" as const, observed: jetbrains.assetsMissing },
    ];
    for (const { arm, observed } of arms) {
      const wanted = JETBRAINS_EXPECTED[arm];
      expect(observed.code).toBe(pin(wanted.code, jetbrains.ideReasonCodes, IDE_OWNER));
      expect(observed.layer).toBe(pin(wanted.layer, jetbrains.ideLayers, IDE_OWNER));
      expect(observed.outcome).toBe(wanted.outcome);
    }
    // A start that was REFUSED must publish no endpoint at all.
    expect(jetbrains.endpointAfterStartRefused).toBeNull();
  });

  it("reconnects to a listening daemon, opens the control room, and drops the session", () => {
    const reconnect = JETBRAINS_EXPECTED.reconnect;
    expect(jetbrains.reconnect.code).toBe(pin(reconnect.code, jetbrains.ideReasonCodes, IDE_OWNER));
    expect(jetbrains.reconnect.outcome).toBe(reconnect.outcome);
    expect(jetbrains.endpointLive).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(jetbrains.openedAfterReconnect).toBe(1);
    // Uninstall is proven by ABSENCE, then by the ports firing AGAIN: a session
    // that survived teardown would answer from its cached endpoint without
    // re-opening, so the second opener call is what proves the drop.
    expect(jetbrains.endpointAfterUninstall).toBeNull();
    expect(jetbrains.openedAfterPostUninstall).toBe(2);
    expect(jetbrains.postUninstall.code).toBe(reconnect.code);
  });

  it("binds every recorded observation to one checkout commit, and repeats byte-identically", () => {
    expect(SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    for (const [caseId, answer] of Object.entries(runA.answers)) {
      const body = answer.payload ?? `~${answer.answerer}`;
      expect(runA.digests[caseId]).toBe(digestOf(SOURCE_COMMIT, caseId, body));
      // The commit is load-bearing rather than decorative: a different tree yields
      // a different digest for the same observation.
      expect(runA.digests[caseId]).not.toBe(digestOf(`${SOURCE_COMMIT}x`, caseId, body));
    }
    expect(Object.keys(runB.answers).sort()).toEqual(Object.keys(runA.answers).sort());
    expect(runB.digests).toEqual(runA.digests);
  });
});
