/**
 * DoD 3 of task-e10e1627: two distinct goal briefs submitted through the INSTALLED MCP host
 * with the public client helper, then read back through the production durable catalog.
 *
 * Nothing here is a substitute for production: the host is the installed `moe-mcp-stdio` shim
 * over a real SqliteEventStore, the envelope is built by the shipped
 * `buildGoalBriefCommand`, and the read-back goes through `readGoalCatalog`, the same function
 * the daemon's /goals/read route calls. The only in-process step is the bootstrap seeding, and
 * that store handle is CLOSED before the host spawns.
 */
import { createHash } from "node:crypto";

import { admitGoalBrief } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACTIVATION_WITNESS, OBSERVATION, POLICY_REF, POLICY_SLICE, PROJECT_ID, PROVIDER_OBSERVATION,
  evaluationInput,
} from "../../../apps/daemon/src/bootstrap/bootstrap-test-fixtures.js";
import {
  PREREQUISITE_REFUSAL_CODES, SERVICE_REFUSED_BY,
} from "../../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import {
  HTTP_BOUNDARY_ERROR_CODES, HTTP_REFUSAL_STAGES,
} from "../../../apps/daemon/src/http/http-contract.js";
import { readGoalCatalog } from "../../../apps/daemon/src/http/goal-catalog-read.js";
import type { GoalCatalogReadResult } from "../../../apps/daemon/src/http/goal-catalog-read.js";
import { buildGoalBriefCommand } from "../../../packages/control-room-client/src/index.js";
import { pin } from "./portability-cases.js";
import {
  createWorkspace, readStoreCounts, removeWorkspace, stdioDriver,
} from "./portability-harness.js";
import type { Driver, PortabilityWorkspace, Reply, StoreCounts } from "./portability-harness.js";

const GOAL_TOOL = "goal_create";
const CONTEXT_TOOL = "work_get_context";

/** Every spelling below is pinned against the module that owns it, never written by hand. */
const BYTES_CONFLICT = pin(
  "BOOTSTRAP_COMMAND_BYTES_CONFLICT", PREREQUISITE_REFUSAL_CODES, "@moe/daemon bootstrap ledger",
);
const PREREQUISITE_LAYER = pin(
  "DAEMON_PREREQUISITE", SERVICE_REFUSED_BY, "@moe/daemon bootstrap ledger",
);
const INPUT_INVALID = pin("INPUT_INVALID", HTTP_BOUNDARY_ERROR_CODES, "@moe/daemon http contract");
const PAYLOAD_SHAPE = pin("PAYLOAD_SHAPE", HTTP_REFUSAL_STAGES, "@moe/daemon http contract");

interface GoalBrief {
  readonly instructions: string;
  readonly title: string;
}

/**
 * WHICH LAYER ANSWERED, read from the reply SHAPE rather than from what the arm hoped for.
 * A JSON-RPC error carrying a registry `data.code` can only have come from the MCP adapter;
 * a `result` whose text parses means the DAEMON seam dispatched and answered. An arm that
 * wants a daemon refusal and gets `ADAPTER` is testing the wrong layer.
 */
interface SeamAnswer {
  readonly answerer: "ADAPTER" | "DAEMON_SEAM" | "MCP_SDK";
  readonly code: string | null;
  readonly layer: string | null;
  readonly text: string | null;
}

function seamAnswer({ message }: Reply): SeamAnswer {
  const text = message.result?.content?.[0]?.text ?? null;
  const data = message.error?.data as { code?: string } | undefined;
  if (message.error !== undefined) {
    return data?.code === undefined
      ? { answerer: "MCP_SDK", code: null, layer: null, text: null }
      : { answerer: "ADAPTER", code: data.code, layer: null, text: null };
  }
  if (text === null) return { answerer: "DAEMON_SEAM", code: null, layer: null, text: null };
  const seam = JSON.parse(text) as {
    decision?: { resultCode?: string };
    error?: { code?: string };
    refusal?: { code?: string; layer?: string };
    stage?: string;
  };
  return {
    answerer: "DAEMON_SEAM",
    code: seam.decision?.resultCode ?? seam.refusal?.code ?? seam.error?.code ?? null,
    layer: seam.refusal?.layer ?? seam.stage ?? null,
    text,
  };
}

/** The offer the daemon minted for `kind` on THIS read of the affordance surface. */
async function offerFor(
  driver: Driver, kind: string, correlationId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const answer = seamAnswer(await driver.call(CONTEXT_TOOL, { correlationId, payload: {} }));
  if (answer.text === null) throw new Error(`affordance surface unavailable: ${answer.code}`);
  const surface = JSON.parse(answer.text) as {
    nextAllowedCommands?: readonly Readonly<Record<string, unknown>>[];
  };
  const offer = (surface.nextAllowedCommands ?? [])
    .find((candidate) => candidate["commandKind"] === kind);
  if (offer === undefined) throw new Error(`the surface offered no ${kind} affordance`);
  return offer;
}

/**
 * The chain a fresh store must walk before `goal.create` has a READY project to bind to. The
 * daemon REFUSES to start against a store that already carries history
 * (`GENESIS_INSTALL_REFUSED (RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT)`), so the seeding cannot
 * be done in-process first — every one of these goes through the installed host as well, with
 * its identity taken from the daemon's own affordance and only its body supplied here.
 */
function withoutActor(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { actor: _actor, ...rest } = input;
  return Object.freeze(rest);
}

const BOOTSTRAP_CHAIN: readonly {
  readonly kind: string; readonly payload: Readonly<Record<string, unknown>>;
}[] = Object.freeze([
  { kind: "project.register", payload: { owner: "owner-1" } },
  { kind: "project.bind_repository", payload: { observation: OBSERVATION } },
  { kind: "provider.probe", payload: { observation: PROVIDER_OBSERVATION } },
  { kind: "policy.install", payload: { slice: POLICY_SLICE } },
  // `actor` is deliberately NOT sent: the daemon binds the evaluation to the AUTHENTICATED
  // principal and refuses BOOTSTRAP_POLICY_ACTOR_UNBOUND when a caller names a different one
  // (bootstrap-policy-services.ts:130). The in-process fixture can name `principal-1`; a real
  // MCP session cannot, and must not.
  { kind: "policy.validate", payload: { input: withoutActor(evaluationInput(POLICY_REF)) } },
  { kind: "project.activate", payload: { witness: ACTIVATION_WITNESS } },
]);

async function driveChainThroughHost(driver: Driver): Promise<void> {
  for (const step of BOOTSTRAP_CHAIN) {
    const correlationId = `corr-seed-${step.kind}`;
    const offer = await offerFor(driver, step.kind, correlationId);
    const answer = seamAnswer(await driver.call(step.kind.replaceAll(".", "_"), {
      commandId: offer["commandId"],
      correlationId,
      expectedVersion: offer["expectedVersion"],
      payload: step.payload,
      targetAggregateId: offer["targetAggregateId"],
    }));
    if (answer.code !== "EFFECTS_COMMITTED") {
      throw new Error(`seeding refused at ${step.kind}: ${String(answer.text)}`);
    }
  }
}

function digestOf(brief: GoalBrief): string {
  const admitted = admitGoalBrief(brief);
  if (!admitted.ok) throw new Error("the suite's own brief did not admit");
  return createHash("sha256").update(JSON.stringify(admitted.brief)).digest("hex");
}

function normalizedOf(brief: GoalBrief): GoalBrief {
  const admitted = admitGoalBrief(brief);
  if (!admitted.ok) throw new Error("the suite's own brief did not admit");
  return admitted.brief;
}

/**
 * Two briefs that are NOT their own normalized form: each carries surrounding whitespace and a
 * CRLF the contract folds, plus decomposed (NFD) marks and a 4-byte code point the contract
 * must carry through UNCHANGED. A reader that echoed the caller's raw prose, or that folded
 * the astral characters away, cannot satisfy both halves.
 */
const SUBMITTED: readonly { readonly brief: GoalBrief; readonly name: string }[] = Object.freeze([
  {
    brief: {
      instructions: "  Ship the café slice.\r\nThen measure it. \u{1F680}  ",
      title: "  Café rollout \u{1F680}  ",
    },
    name: "first",
  },
  {
    brief: {
      instructions: "\r\n  Retire the legacy readback.\r\n  ",
      title: " Legacy retirement \u{1F9EA} ",
    },
    name: "second",
  },
]);

interface Submitted {
  readonly answer: SeamAnswer;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly brief: GoalBrief;
  readonly commandId: string;
  readonly name: string;
  readonly normalized: GoalBrief;
  readonly offer: Readonly<Record<string, unknown>>;
}

/** One post-acceptance probe: what answered, and whether the durable store moved at all. */
interface Probe {
  readonly after: StoreCounts;
  readonly answer: SeamAnswer;
  readonly before: StoreCounts;
}

let workspace: PortabilityWorkspace;
let catalog: GoalCatalogReadResult;
let seededCounts: StoreCounts;
let afterSubmissionCounts: StoreCounts;
let pinnedTarget: Submitted | undefined;
const submitted: Submitted[] = [];
const probes: Record<string, Probe> = {};

function first(): Submitted {
  const entry = submitted[0];
  if (entry === undefined) throw new Error("no brief was submitted");
  return entry;
}

/** Calls the tool and brackets it with store counts, so "no durable decision" is measured. */
async function probeThroughHost(
  driver: Driver, id: string, args: Readonly<Record<string, unknown>>,
): Promise<void> {
  const before = await readStoreCounts(workspace.storePath);
  const answer = seamAnswer(await driver.call(GOAL_TOOL, args));
  probes[id] = Object.freeze({
    after: await readStoreCounts(workspace.storePath), answer, before,
  });
}

/** The SAME command identity as the first submission, carrying different brief bytes. */
function conflictingArguments(): Readonly<Record<string, unknown>> {
  const entry = first();
  const built = buildGoalBriefCommand({
    affordance: entry.offer as never,
    correlationId: String(entry.arguments["correlationId"]),
    instructions: entry.brief.instructions,
    requestDigest: digestOf({ instructions: entry.brief.instructions, title: "Changed title" }),
    sessionCredential: workspace.credential,
    title: "Changed title",
  });
  if (!built.ok) throw new Error("the client helper refused the conflicting rebuild");
  return Object.freeze({
    commandId: entry.arguments["commandId"],
    correlationId: entry.arguments["correlationId"],
    expectedVersion: entry.arguments["expectedVersion"],
    payload: built.envelope.payload,
    targetAggregateId: entry.arguments["targetAggregateId"],
  });
}

/** Builds the tool arguments through the SHIPPED helper; identity comes only from the offer. */
async function submitBrief(
  driver: Driver, entry: { readonly brief: GoalBrief; readonly name: string },
  overrideTargetAggregateId?: string,
): Promise<Submitted> {
  const correlationId = `corr-goal-brief-${entry.name}`;
  const minted = await offerFor(driver, "goal.create", correlationId);
  const offer = overrideTargetAggregateId === undefined
    ? minted
    : { ...minted, targetAggregateId: overrideTargetAggregateId };
  const built = buildGoalBriefCommand({
    affordance: offer as never,
    correlationId,
    instructions: entry.brief.instructions,
    requestDigest: digestOf(entry.brief),
    sessionCredential: workspace.credential,
    title: entry.brief.title,
  });
  if (!built.ok) throw new Error(`the client helper refused: ${JSON.stringify(built)}`);
  const { envelope } = built;
  const args = Object.freeze({
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    expectedVersion: envelope.expectedVersion,
    payload: envelope.payload,
    targetAggregateId: envelope.targetAggregateId,
  });
  return Object.freeze({
    answer: seamAnswer(await driver.call(GOAL_TOOL, args)),
    arguments: args,
    brief: entry.brief,
    commandId: envelope.commandId,
    name: entry.name,
    normalized: normalizedOf(entry.brief),
    offer,
  });
}

/**
 * THE FOUR AUTHORITY KEYS a caller once supplied. Sent as RAW tool arguments on purpose: the
 * client helper refuses them itself, so routing them through it would prove the helper rather
 * than the daemon seam this DoD is about.
 */
const AUTHORITY_EXTRAS: readonly { readonly key: string; readonly value: unknown }[] =
  Object.freeze([
    { key: "goalId", value: "goal-caller-chosen" },
    { key: "budgetAccountRef", value: "budget-account-caller-chosen" },
    { key: "planningRunRef", value: "run-caller-chosen" },
    { key: "witness", value: { projectReadyRef: "ready-caller", truthClass: "HUMAN_APPROVED" } },
  ]);

beforeAll(async () => {
  workspace = createWorkspace(PROJECT_ID);
  const driver = await stdioDriver(workspace, workspace.credential);
  try {
    await driveChainThroughHost(driver);
    seededCounts = await readStoreCounts(workspace.storePath);
    for (const entry of SUBMITTED) submitted.push(await submitBrief(driver, entry));
    afterSubmissionCounts = await readStoreCounts(workspace.storePath);
    // A THIRD brief whose envelope reuses the FIRST submission's targetAggregateId. That is
    // the shape a daemon offering one fixed goal subject would produce, so this arm measures
    // whether the proof above survives a checkout where the affordance is not repeatable.
    pinnedTarget = await submitBrief(
      driver,
      { brief: { instructions: "Pinned-target probe.", title: "Pinned target" }, name: "pinned" },
      String(submitted[0]?.arguments["targetAggregateId"]),
    );
    await probeThroughHost(driver, "replay", first().arguments);
    await probeThroughHost(driver, "conflict", conflictingArguments());
    for (const extra of AUTHORITY_EXTRAS) {
      const offer = await offerFor(driver, "goal.create", `corr-extras-${extra.key}`);
      await probeThroughHost(driver, `extras:${extra.key}`, {
        commandId: offer["commandId"],
        correlationId: `corr-extras-${extra.key}`,
        expectedVersion: offer["expectedVersion"],
        payload: {
          instructions: "Caller-chosen authority must not reach the store.",
          title: "Authority extras",
          [extra.key]: extra.value,
        },
        targetAggregateId: offer["targetAggregateId"],
      });
    }
  } finally {
    await driver.stop();
  }
  const store = SqliteEventStore.openForProject(workspace.storePath, PROJECT_ID);
  try {
    catalog = readGoalCatalog(store, PROJECT_ID);
  } finally {
    store.close();
  }
}, 180_000);

afterAll(async () => {
  await removeWorkspace(workspace);
});

describe("task-e10e1627 goal briefs through the installed MCP host", () => {
  it("submits a nonzero roster of distinct briefs", () => {
    expect(SUBMITTED.length).toBeGreaterThan(0);
    expect(submitted).toHaveLength(2);
    expect(submitted[0]?.brief.title).not.toBe(submitted[1]?.brief.title);
  });

  it("commits each brief through the daemon seam, not the adapter", () => {
    for (const entry of submitted) {
      expect([entry.name, entry.answer.answerer]).toStrictEqual([entry.name, "DAEMON_SEAM"]);
      expect([entry.name, entry.answer.code]).toStrictEqual([entry.name, "EFFECTS_COMMITTED"]);
    }
    expect(afterSubmissionCounts.decisions - seededCounts.decisions).toBe(2);
  });

  it("reads back the exact normalized brief content for every submitted goal", () => {
    if (catalog.outcome !== "GOALS") throw new Error(`catalog refused: ${catalog.code}`);
    for (const entry of submitted) {
      const found = catalog.goals.find((goal) => goal.goalId === `goal-${entry.commandId}`);
      expect([entry.name, found?.brief]).toStrictEqual([entry.name, entry.normalized]);
      expect([entry.name, found?.planningRunRef])
        .toStrictEqual([entry.name, `run-${entry.commandId}`]);
    }
  });

  it("proves the read-back brief is the NORMALIZED prose, never the caller's raw bytes", () => {
    if (catalog.outcome !== "GOALS") throw new Error(`catalog refused: ${catalog.code}`);
    for (const entry of submitted) {
      const found = catalog.goals.find((goal) => goal.goalId === `goal-${entry.commandId}`);
      expect([entry.name, found?.brief?.title]).not.toStrictEqual([entry.name, entry.brief.title]);
      expect([entry.name, found?.brief?.instructions])
        .not.toStrictEqual([entry.name, entry.brief.instructions]);
      // The astral code point survives: normalization folds whitespace, never characters.
      expect(found?.brief?.title.codePointAt(found.brief.title.length - 2))
        .toBeGreaterThan(0xffff);
    }
  });

  /**
   * The goal a brief creates is derived from the AUTHENTICATED COMMAND IDENTITY
   * (`goal-${commandId}`), never from the offer's advisory target. This arm sends a third brief
   * whose envelope reuses the first submission's targetAggregateId — the shape a daemon that
   * offers one fixed goal subject produces — and shows the durable goal is still its own.
   */
  it("derives the goal from the command identity, not the offer's target aggregate", () => {
    if (catalog.outcome !== "GOALS") throw new Error(`catalog refused: ${catalog.code}`);
    expect(pinnedTarget?.answer.answerer).toBe("DAEMON_SEAM");
    expect(pinnedTarget?.answer.code).toBe("EFFECTS_COMMITTED");
    expect(pinnedTarget?.arguments["targetAggregateId"])
      .toBe(submitted[0]?.arguments["targetAggregateId"]);
    expect(pinnedTarget?.commandId).not.toBe(submitted[0]?.commandId);
    const found = catalog.goals.find((goal) => goal.goalId === `goal-${pinnedTarget?.commandId}`);
    expect(found?.brief).toStrictEqual(pinnedTarget?.normalized);
  });

  /**
   * The replay is answered FROM the stored decision, and says so: production returns the same
   * commandId, effectId and resultCode with `disposition` moving DECIDED -> REPLAYED. Asserting
   * byte-identical text would pin the opposite of the shipped behaviour, so this pins the
   * effect identity plus the disposition pair, and proves nothing new was written.
   */
  it("answers an identical replay from the durable decision, writing nothing new", () => {
    const replay = probes["replay"];
    expect(replay?.answer.answerer).toBe("DAEMON_SEAM");
    const original = JSON.parse(first().answer.text ?? "{}") as { decision?: Record<string, unknown> };
    const replayed = JSON.parse(replay?.answer.text ?? "{}") as { decision?: Record<string, unknown> };
    expect(replayed.decision?.["commandId"]).toBe(original.decision?.["commandId"]);
    expect(replayed.decision?.["effectId"]).toBe(original.decision?.["effectId"]);
    expect(replayed.decision?.["resultCode"]).toBe("EFFECTS_COMMITTED");
    expect([original.decision?.["disposition"], replayed.decision?.["disposition"]])
      .toStrictEqual(["DECIDED", "REPLAYED"]);
    expect(replay?.after).toStrictEqual(replay?.before);
  });

  it(`refuses a same-identity changed brief ${BYTES_CONFLICT} at ${PREREQUISITE_LAYER}`, () => {
    const conflict = probes["conflict"];
    expect(conflict?.answer.answerer).toBe("DAEMON_SEAM");
    expect(conflict?.answer.code).toBe(BYTES_CONFLICT);
    expect(conflict?.answer.layer).toBe(PREREQUISITE_LAYER);
    expect(conflict?.after).toStrictEqual(conflict?.before);
  });

  it("names a nonzero authority-extras roster", () => {
    expect(AUTHORITY_EXTRAS.length).toBeGreaterThan(0);
    expect(Object.keys(probes).filter((id) => id.startsWith("extras:")))
      .toHaveLength(AUTHORITY_EXTRAS.length);
  });

  it.each(AUTHORITY_EXTRAS)(
    `refuses a raw payload naming $key with ${INPUT_INVALID} at ${PAYLOAD_SHAPE}, unmutated`,
    ({ key }) => {
      const probe = probes[`extras:${key}`];
      expect([key, probe?.answer.answerer]).toStrictEqual([key, "DAEMON_SEAM"]);
      expect([key, probe?.answer.code]).toStrictEqual([key, INPUT_INVALID]);
      expect([key, probe?.answer.layer]).toStrictEqual([key, PAYLOAD_SHAPE]);
      expect([key, probe?.after]).toStrictEqual([key, probe?.before]);
    },
  );

  it("binds each brief to its own durable goal and planning run", () => {
    if (catalog.outcome !== "GOALS") throw new Error(`catalog refused: ${catalog.code}`);
    const goalIds = submitted.map((entry) => `goal-${entry.commandId}`);
    expect(new Set(goalIds).size).toBe(2);
    const runs = catalog.goals
      .filter((goal) => goalIds.includes(goal.goalId))
      .map((goal) => goal.planningRunRef);
    expect(runs).toHaveLength(2);
    expect(new Set(runs).size).toBe(2);
  });
});
