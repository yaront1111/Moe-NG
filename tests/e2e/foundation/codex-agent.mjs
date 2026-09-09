/**
 * The scripted CODEX seat the codex journey spawns in place of a real `codex exec`.
 *
 * PLAIN `.mjs` ON PURPOSE, for the same reason `fake-agent.mjs` and `j5-compiler-agent.mjs`
 * are: the spawner invokes MOE_AGENT_COMMAND with provider-shaped argv and no transform flags,
 * so this file must run under bare `node` - node builtins only, no TypeScript, no dependency.
 * It stays out of `tests/e2e/foundation/tsconfig.json` by CONSTRUCTION, not by omission: that
 * config's include is `["./*.ts"]`, so a `.mjs` is outside the type program. Do not add it.
 *
 * THE CREDENTIAL PATH IS INVERTED, AND THAT INVERSION IS WHY THIS IS A THIRD DOUBLE RATHER
 * THAN AN ARM ON THE OTHER TWO. Measured at `agent-spawner.ts` / `agent-provider-resolve.ts`:
 *
 *   claude seat -> one JSON file at `--mcp-config` carrying BOTH origin and bearer.
 *   codex seat  -> NEITHER. The bearer arrives in this process's OWN environment under
 *                  MOE_AGENT_MCP_BEARER (`CODEX_BEARER_VARIABLE`, injected AFTER the
 *                  `agentEnvironment()` scrub), and the origin arrives as the argv pair
 *                  `-c mcp_servers.moe-next.url=<origin>`.
 *
 * `fake-agent.mjs`'s header states it treats argv flags as NON-EVIDENCE and learns everything
 * from the spawner's config file; this double must do the exact inverse - read its bearer from
 * the environment and PARSE ITS ORIGIN OFF ARGV. Folding the two together would make both stop
 * proving what they were written to prove, so they stay separate and neither is edited.
 *
 * IT MUST BE INVOKED THROUGH A SHIM WHOSE BASENAME IS EXACTLY `codex.cmd` / `codex.sh`. The
 * provider is selected by `isCodexCommand` (agent-provider-resolve.ts), whose regex is
 * `/(?:^|[\\/])codex(?:\.[a-z]+)?$/iu` - "codex" must follow start-of-string or a path
 * separator, so `agent-codex.cmd` does NOT match and would silently run the CLAUDE branch.
 * `codex-journey-harness.ts` writes that shim; this file records the argv and the credential
 * source it actually saw so the journey can assert the SPAWN SURFACE rather than a filename.
 *
 * BOTH LANES LIVE HERE, branching on the mission the way the wrapper does: the PLANNING lane
 * (`planning_submit_decomposition`) and the CODE lane (`review_submit`). What makes this double
 * codex-specific is the credential inversion, which both lanes need identically; two codex
 * doubles would duplicate that inversion and give it two places to drift.
 *
 * IT NEVER TOUCHES THE STORE. Every fact it changes it changes through a real MCP session over
 * HTTP with the scoped bearer - otherwise the journey would prove the fixture, not the product.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, cwd, env, pid, stdin, stdout } from "node:process";

const PROTOCOL_VERSION = "2025-06-18";
const ACCEPT = "application/json, text/event-stream";
/** The env var name the spawner pins; this double reads the bearer from nowhere else. */
const BEARER_VARIABLE = "MOE_AGENT_MCP_BEARER";
/** The `-c` key the origin rides on, exactly as the spawner spells it. */
const ORIGIN_KEY = "mcp_servers.moe-next.url=";
const REVIEW_KIND = "review.submit";
const PLANNING_KIND = "planning.submit_decomposition";
const PLANNING_TOOL = "planning_submit_decomposition";
const REVIEW_TOOL = "review_submit";
const CONTEXT_TOOL = "work_get_context";
const RELEASE_TOOL = "work_release";
const CONTRACT_READ_TOOL = "product_contract_read";

const say = (line) => { stdout.write(`codex-agent: ${line}\n`); };

/** Reads a `--name value` pair, ignoring every flag this agent does not own. */
function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

/**
 * The origin, parsed off the CODEX argv rather than read from a config file that does not
 * exist for this seat.
 *
 * The pair is searched for by VALUE PREFIX across the whole argv rather than by the index of
 * its `-c`, so it survives the roster `-c` pairs being added, removed or reordered around it.
 */
function originFromArgv() {
  for (const entry of argv) {
    if (typeof entry === "string" && entry.startsWith(ORIGIN_KEY)) {
      return entry.slice(ORIGIN_KEY.length);
    }
  }
  return null;
}

/** The scoped bearer, from this process's OWN environment. Absent is LOUD, never a skip. */
function bearerFromEnvironment() {
  const value = env[BEARER_VARIABLE];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`the spawner injected no ${BEARER_VARIABLE}: this is not a codex seat`);
  }
  return `Bearer ${value}`;
}

async function readMission() {
  stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text;
}

/**
 * Claims one numbered slot under a directory, atomically.
 *
 * A wrapper pass staffs SEVERAL seats at once, so two of these processes can read the same
 * listing and pick the same ordinal - one record would then silently overwrite the other while
 * every count assertion stayed green. `wx` fails on an existing path, so the loser re-counts
 * and takes the next slot. The bound is a SEAT COUNT, not a deadline: nothing here reads a clock.
 */
function claimSlot(directory, prefix, suffix, contents) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const taken = readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix));
    const path = join(directory, `${prefix}${String(taken.length + 1 + attempt)}${suffix}`);
    try {
      writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not claim a slot under ${directory}`);
}

/**
 * THE SPAWN-SURFACE RECORD, written BEFORE anything can refuse.
 *
 * What the spawner COMPOSED and what this process RECEIVED are different claims: the invocation
 * crosses a process boundary and cmd.exe's own quoting. Only the receiving end can settle the
 * second one, and a seat that dies before it records anything would leave the journey unable to
 * tell "the claude branch ran" from "the codex branch failed". So this is the first write.
 */
function recordSpawn(directory, bearerPresent) {
  return claimSlot(directory, "spawn-", ".json", `${JSON.stringify({
    argv: argv.slice(2),
    bearerFromEnvironment: bearerPresent,
    cwd: cwd(),
    mcpConfigFlagPresent: argv.includes("--mcp-config"),
    originFromArgv: originFromArgv(),
    pid,
  }, null, 2)}\n`);
}

/** The identities a mission states. Parsed, never guessed: the daemon mints one offer each. */
function parseMission(mission) {
  return {
    goalRef: /goal "([^"]+)"/u.exec(mission)?.[1] ?? null,
    nodeRef: /code node "([^"]+)"/u.exec(mission)?.[1] ?? null,
    planning: mission.includes(`(command kind ${PLANNING_KIND})`),
    workItemId: /work item\s*\n?\s*"([^"]+)"/u.exec(mission)?.[1] ?? null,
  };
}

/** One JSON-RPC frame, out of either an SSE stream or a plain JSON body. */
function framePayload(text) {
  if (!text.startsWith("event:") && !text.startsWith("data:")) return JSON.parse(text);
  const line = text.split("\n").find((candidate) => candidate.startsWith("data:"));
  return JSON.parse((line ?? "data:{}").slice("data:".length));
}

async function post(session, body) {
  const headers = {
    accept: ACCEPT,
    authorization: session.authorization,
    "content-type": "application/json",
  };
  if (session.id !== null) {
    headers["mcp-session-id"] = session.id;
    headers["mcp-protocol-version"] = PROTOCOL_VERSION;
  }
  const response = await fetch(session.url, { body: JSON.stringify(body), headers, method: "POST" });
  return { headers: response.headers, status: response.status, text: await response.text() };
}

async function openSession(url, authorization) {
  const session = { authorization, id: null, nextId: 2, url };
  const response = await post(session, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "moe-e2e-codex-agent", version: "0.0.0" },
      protocolVersion: PROTOCOL_VERSION,
    },
  });
  const id = response.headers.get("mcp-session-id");
  if (id === null) {
    return { refusal: { body: response.text, status: response.status }, session: null };
  }
  return { refusal: null, session: { ...session, id } };
}

/** Calls one wired tool and returns the daemon's response, which the bridge passes verbatim. */
async function callTool(session, name, args) {
  const id = session.nextId;
  session.nextId += 1;
  const response = await post(session, {
    id, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name },
  });
  if (response.status !== 200) {
    return { daemon: null, refusal: { body: response.text, status: response.status } };
  }
  const payload = framePayload(response.text);
  if (payload.error !== undefined) {
    return { daemon: null, refusal: { body: response.text, status: response.status } };
  }
  const text = payload.result?.content?.[0]?.text ?? "";
  return { daemon: text === "" ? null : JSON.parse(text), refusal: null };
}

/**
 * THIS SEAT'S OWN WORK ITEM, read with the payload form of `work_get_context`.
 *
 * The payload-less form answers the WHOLE surface; naming the item answers `step` (and with it
 * `claimAggregateVersion`) for this seat alone. That version is what a first-try release needs,
 * so reading the surface and guessing a version would be the slow way to a conflict.
 */
async function readOwnItem(session, workItemId) {
  const context = await callTool(session, CONTEXT_TOOL, {
    correlationId: `codex-context-${workItemId}`, payload: { workItemId },
  });
  if (context.refusal !== null) {
    say(`REFUSED status=${context.refusal.status} body=${context.refusal.body}`);
    throw new Error(`${CONTEXT_TOOL} was refused`);
  }
  return context.daemon;
}

/** The single offer for this seat's own subject; anything else is refused loudly. */
function offerFor(surface, kind, subject) {
  const offers = (surface?.nextAllowedCommands ?? [])
    .filter((offer) => offer.commandKind === kind
      && (subject === null || offer.targetAggregateId === subject));
  if (offers.length !== 1) {
    throw new Error(`expected exactly one ${kind} offer for ${subject}, saw ${offers.length}`);
  }
  return offers[0];
}

const versionOf = (surface) => {
  const version = surface?.step?.claimAggregateVersion;
  return typeof version === "number" ? version : null;
};

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The review package this seat submits, built rather than lifted from the mission's hint, for
 * the reason `fake-agent.mjs` records: the hint comes from a dev-only table the wrapper cannot
 * load, so an agent depending on it would pass or fail on a module that is not in this journey.
 */
function packageItems(subjectRef, submittedBytes) {
  const derived = [
    "CRITERION", "DAEMON_RECEIPT", "GRAPH_HASH", "INTEGRATED_TREE", "PLAN_HASH", "RUBRIC",
  ];
  return [
    ...derived.map((kind) => ({
      digest: sha256(`${kind}:${subjectRef}`),
      kind,
      locator: `${kind.toLowerCase().replaceAll("_", "-")}-${subjectRef}`,
    })),
    { digest: sha256(submittedBytes), kind: "SUBMITTED_BYTES", locator: `submitted-${subjectRef}` },
  ];
}

/** The deliverable. The DAEMON's verifier - never this agent - decides whether it passes. */
function implement(target) {
  writeFileSync(target, [
    "export const add = (left, right) => left + right;",
    "export const multiply = (left, right) => left * right;",
    "",
  ].join("\n"), "utf8");
  say(`wrote ${target}`);
  return readFileSync(target, "utf8");
}

/**
 * The criterion roster this plan must bind, read from the DAEMON's own approved revision.
 *
 * A roster hard-coded here would keep binding ids the contract no longer carries, and the
 * compiler's "every criterion bound exactly once" rule would then be grading this file's memory
 * instead of the contract.
 */
async function approvedContract(session, goalRef) {
  const read = await callTool(session, CONTRACT_READ_TOOL, {
    correlationId: `codex-contract-${goalRef}`, payload: { goalRef },
  });
  if (read.refusal !== null) throw new Error(`${CONTRACT_READ_TOOL} refused: ${read.refusal.body}`);
  if (read.daemon?.ok !== true) {
    throw new Error(`${CONTRACT_READ_TOOL} refused: ${JSON.stringify(read.daemon)}`);
  }
  const criterionIds = (read.daemon.revision?.criteria ?? [])
    .map((criterion) => criterion.criterionId)
    .filter((id) => typeof id === "string")
    .sort();
  if (criterionIds.length === 0) {
    throw new Error(`the approved revision states no criteria: ${JSON.stringify(read.daemon)}`);
  }
  return { criterionIds, gateRef: read.daemon.gateRef };
}

/**
 * ONE execution-bearing node binding every criterion.
 *
 * The KEY arrives on the shim's argv rather than being invented here: it has to name a module
 * directory that exists in the journey's repository, which is WORLD knowledge the harness owns.
 * This file owns PROVIDER knowledge and nothing else.
 */
function structureFor(nodeKey, criterionIds) {
  return {
    completionNodeKey: nodeKey,
    nodes: [{
      criterionIds: [...criterionIds],
      dependsOn: [],
      nodeKey,
      objective: "Deliver the whole goal behind one node, from a codex seat.",
    }],
  };
}

/** The planning lane: read the contract, submit the decomposition. */
async function planningLane(session, parsed, surface, arm) {
  const offer = offerFor(surface, PLANNING_KIND, parsed.goalRef);
  say(`planning offer commandId=${offer.commandId} expectedVersion=${offer.expectedVersion}`);
  if (arm === "skip-submit") {
    say("arm=skip-submit exiting without planning_submit_decomposition");
    return;
  }
  const nodeKey = flagValue("--node-key");
  if (nodeKey === null) throw new Error("the shim passed no --node-key");
  const contract = await approvedContract(session, parsed.goalRef);
  const submitted = await callTool(session, PLANNING_TOOL, {
    commandId: offer.commandId,
    correlationId: `codex-submit-${offer.commandId}`,
    expectedVersion: offer.expectedVersion,
    payload: {
      gateRef: contract.gateRef,
      goalRef: parsed.goalRef,
      structure: structureFor(nodeKey, contract.criterionIds),
    },
    targetAggregateId: offer.targetAggregateId,
  });
  if (submitted.refusal !== null) {
    say(`REFUSED status=${submitted.refusal.status} body=${submitted.refusal.body}`);
    throw new Error(`${PLANNING_TOOL} was refused`);
  }
  say(`${PLANNING_TOOL} answered ${JSON.stringify(submitted.daemon)}`);
  if (submitted.daemon?.ok !== true) throw new Error(`${PLANNING_TOOL} did not commit`);
}

/** The code lane: write the deliverable, submit the review package. */
async function codeLane(session, parsed, surface, arm) {
  const offer = offerFor(surface, REVIEW_KIND, parsed.nodeRef);
  say(`review offer commandId=${offer.commandId} expectedVersion=${offer.expectedVersion}`);
  const submittedBytes = implement(flagValue("--implement") ?? "math.mjs");
  if (arm === "skip-submit") {
    say("arm=skip-submit exiting without review_submit");
    return;
  }
  const submitted = await callTool(session, REVIEW_TOOL, {
    commandId: offer.commandId,
    correlationId: `codex-review-${offer.commandId}`,
    expectedVersion: offer.expectedVersion,
    payload: {
      findings: [],
      packageItems: packageItems(offer.targetAggregateId, submittedBytes),
      round: offer.expectedVersion + 1,
      subjectRef: offer.targetAggregateId,
    },
    targetAggregateId: offer.targetAggregateId,
  });
  if (submitted.refusal !== null) {
    say(`REFUSED status=${submitted.refusal.status} body=${submitted.refusal.body}`);
    throw new Error(`${REVIEW_TOOL} was refused`);
  }
  say(`${REVIEW_TOOL} answered ${JSON.stringify(submitted.daemon)}`);
  if (submitted.daemon?.ok !== true) throw new Error(`${REVIEW_TOOL} did not commit`);
}

/**
 * THE RELEASE, ON THE FIRST TRY.
 *
 * The version is re-read right before releasing, exactly as the mission brief instructs; when
 * that re-read answers WORK_ITEM_UNKNOWN because an accepted submit moved the step off the
 * surface, the LAST successful read's version is used - a submit never moves the claim's own
 * version. Both paths release once. A second attempt at another version would be the conflict
 * sweep this whole disclosure exists to prevent.
 */
async function releaseOnce(session, workItemId, fallbackVersion) {
  const reread = await callTool(session, CONTEXT_TOOL, {
    correlationId: `codex-release-read-${workItemId}`, payload: { workItemId },
  });
  const expectedVersion = versionOf(reread.daemon) ?? fallbackVersion;
  if (expectedVersion === null) throw new Error("no claimAggregateVersion to release at");
  const released = await callTool(session, RELEASE_TOOL, {
    commandId: `codex-release-${workItemId}`,
    correlationId: `codex-release-${workItemId}`,
    expectedVersion,
    payload: { workItemId },
    targetAggregateId: workItemId,
  });
  if (released.refusal !== null) {
    say(`REFUSED status=${released.refusal.status} body=${released.refusal.body}`);
    throw new Error(`${RELEASE_TOOL} was refused`);
  }
  say(`${RELEASE_TOOL} at expectedVersion=${expectedVersion} answered ${
    JSON.stringify(released.daemon)}`);
}

async function main() {
  const arm = flagValue("--arm") ?? "complete";
  const echoDir = flagValue("--echo-dir");
  if (echoDir === null) throw new Error("the shim passed no --echo-dir");
  // FIRST, before anything can refuse: an unreachable daemon is still evidence of WHICH branch
  // spawned this process, which is the one thing no later failure can reconstruct.
  const bearerPresent = typeof env[BEARER_VARIABLE] === "string" && env[BEARER_VARIABLE] !== "";
  say(`spawn record ${recordSpawn(echoDir, bearerPresent)} arm=${arm}`);

  const mission = await readMission();
  claimSlot(echoDir, "mission-", ".txt", mission);
  const parsed = parseMission(mission);
  say(`mission goal=${parsed.goalRef} node=${parsed.nodeRef} item=${parsed.workItemId}`);
  if (parsed.workItemId === null || (parsed.goalRef === null && parsed.nodeRef === null)) {
    // Neither lane. Another seat's mission; guessing at one would submit against a subject
    // this process never claimed.
    say("no codex lane in this mission; nothing to do");
    return 0;
  }

  const url = originFromArgv();
  if (url === null) throw new Error(`the spawner passed no ${ORIGIN_KEY}<origin> pair`);
  const opened = await openSession(url, bearerFromEnvironment());
  if (opened.session === null) {
    say(`REFUSED status=${opened.refusal.status} body=${opened.refusal.body}`);
    throw new Error("the wrapper refused a minted codex credential");
  }
  const session = opened.session;

  const surface = await readOwnItem(session, parsed.workItemId);
  const claimVersion = versionOf(surface);
  say(`own item claimAggregateVersion=${String(claimVersion)}`);
  if (parsed.planning && parsed.goalRef !== null) {
    await planningLane(session, parsed, surface, arm);
  } else if (parsed.nodeRef !== null) {
    await codeLane(session, parsed, surface, arm);
  } else {
    say("this mission names a goal but not the planning kind; nothing to do");
    return 0;
  }
  await releaseOnce(session, parsed.workItemId, claimVersion);
  return 0;
}

/**
 * `process.exitCode` rather than `exit()`: calling `exit()` while the stdin pipe and an undici
 * socket are still open aborts the process with a libuv assertion, which the wrapper then
 * reports as AGENT_PROCESS_FAILED and hides whatever actually happened.
 */
main().then((code) => { process.exitCode = code; }).catch((error) => {
  say(`FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
