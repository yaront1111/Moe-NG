/**
 * The scripted PLANNING seat the J5 journey spawns in place of a real `claude`.
 *
 * PLAIN `.mjs` ON PURPOSE, for the same reason `fake-agent.mjs` is: `agent-spawner.ts` invokes
 * MOE_AGENT_COMMAND with claude-shaped argv and no transform flags, so this file must run under
 * bare `node` - node builtins only, no TypeScript, no dependency, and deliberately outside the
 * e2e tsconfig (`include: ["./*.ts"]`) and outside the harness determinism scan, which reads
 * only non-test `.ts`.
 *
 * WHY NOT AN ARM ON `fake-agent.mjs`. That agent implements CODE nodes: it bails on any mission
 * with no `code node "..."` in it, and every one of its paths ends in `review_submit`. The
 * planning lane submits a DECOMPOSITION against a GOAL. Bolting a second lane onto a file five
 * other journeys depend on would put their arms one edit away from this one; a separate double
 * leaves them byte-identical.
 *
 * IT ECHOES ITS MISSION TO A FILE, WHICH IS THE POINT. What the daemon COMPOSED and what the
 * SEAT RECEIVED are different claims - the mission crosses a process boundary, a stdin pipe and
 * the spawner's argv quoting - and only the receiving end can settle the second one. The echo
 * is written BEFORE anything can fail, so a mission that arrives and then refuses is still
 * readable by the test.
 *
 * IT LEARNS EVERYTHING FROM THE SPAWNER. `agentEnvironment()` scrubs every key outside its
 * allowlist and drops all `MOE_*`, so no env var can reach this process: the echo directory
 * arrives on argv from the generated shim, the mission on STDIN, and the loopback url plus the
 * per-agent scoped bearer from the JSON at `--mcp-config`. It NEVER touches the store.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, pid, stdin, stdout } from "node:process";

const PROTOCOL_VERSION = "2025-06-18";
const ACCEPT = "application/json, text/event-stream";
const SUBMIT_KIND = "planning.submit_decomposition";
const SUBMIT_TOOL = "planning_submit_decomposition";
const CONTRACT_READ_TOOL = "product_contract_read";
const CONTEXT_TOOL = "work_get_context";
const RELEASE_TOOL = "work_release";
/** The sentence this whole row exists to put in front of a re-staffed seat. */
const REJECTED_MARKER = "PLAN REJECTED by the operator:";

const say = (line) => { stdout.write(`j5-compiler: ${line}\n`); };

/** Reads a `--name value` pair, ignoring every flag this agent does not own. */
function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

async function readMission() {
  stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text;
}

/**
 * Writes the mission this process ACTUALLY received, numbered by how many are already there.
 *
 * The ordinal is derived from the directory rather than kept in a variable because each wrapper
 * pass is a NEW process: pass 1 finds none and writes `mission-1.txt`, the re-staffed pass finds
 * one and writes `mission-2.txt`, so the test can name the re-staffing without guessing a pid.
 *
 * `wx` MAKES THE ALLOCATION ATOMIC, and it is not decorative: a pass staffs SEVERAL seats at
 * once, so two of these processes can read the same directory listing and both claim the same
 * ordinal - one mission would then overwrite the other and simply vanish from the evidence. `wx`
 * fails on an existing path, so the loser re-counts and takes the next slot instead. The bound
 * is a seat count, not a deadline, so nothing here reads a clock.
 */
function echoMission(directory, mission) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const taken = readdirSync(directory)
      .filter((name) => name.startsWith("mission-") && name.endsWith(".txt"));
    const path = join(directory, `mission-${String(taken.length + 1 + attempt)}.txt`);
    try {
      writeFileSync(path, mission, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not claim a mission slot under ${directory}`);
}

/** The identities the compiler mission states; parsed, never guessed. */
function parseMission(mission) {
  const goalRef = /goal "([^"]+)"/u.exec(mission)?.[1] ?? null;
  const workItemId = /work item\s*\n?\s*"([^"]+)"/u.exec(mission)?.[1] ?? null;
  const gateRef = /gateRef (\{[^}]*\})\./u.exec(mission)?.[1] ?? null;
  return {
    gateRef: gateRef === null ? null : JSON.parse(gateRef),
    goalRef,
    rejected: mission.includes(REJECTED_MARKER),
    workItemId,
  };
}

/** The scoped credential and loopback origin the WRAPPER minted for THIS agent. */
async function readServer(configPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const server = config?.mcpServers?.["moe-next"];
  const url = server?.url;
  const authorization = server?.headers?.Authorization;
  if (typeof url !== "string" || typeof authorization !== "string") {
    throw new Error(`--mcp-config names no moe-next server: ${configPath}`);
  }
  return { authorization, url };
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
      clientInfo: { name: "moe-e2e-j5-compiler", version: "0.0.0" },
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

/** The offer for this seat's own step, refused loudly when the surface names anything else. */
function offerFor(surface, goalRef) {
  const offers = (surface?.nextAllowedCommands ?? [])
    .filter((offer) => offer.commandKind === SUBMIT_KIND && offer.targetAggregateId === goalRef);
  if (offers.length !== 1) {
    throw new Error(`expected exactly one ${SUBMIT_KIND} offer for ${goalRef}, saw ${offers.length}`);
  }
  return offers[0];
}

/**
 * The gateRef and the criterion ids this plan must bind, read from the DAEMON's own approved
 * revision rather than from constants here - and rather than from the mission, whose embedded
 * gateRef `agent-mission-text.ts` itself calls "convenience, not authority". A hard-coded roster
 * would keep binding ids the contract no longer carries, and the compiler's "every criterion
 * bound exactly once" rule would then be grading this agent's memory instead of the contract.
 */
async function approvedContract(session, goalRef) {
  const read = await callTool(session, CONTRACT_READ_TOOL, {
    correlationId: `j5-contract-${goalRef}`, payload: { goalRef },
  });
  if (read.refusal !== null) {
    throw new Error(`${CONTRACT_READ_TOOL} refused: ${read.refusal.body}`);
  }
  if (read.daemon?.ok !== true) {
    throw new Error(`${CONTRACT_READ_TOOL} refused: ${JSON.stringify(read.daemon)}`);
  }
  const criteria = read.daemon.revision?.criteria ?? [];
  const criterionIds = criteria
    .map((criterion) => criterion.criterionId)
    .filter((id) => typeof id === "string")
    .sort();
  if (criterionIds.length === 0) {
    throw new Error(`the approved revision states no criteria: ${JSON.stringify(read.daemon)}`);
  }
  return { criterionIds, gateRef: read.daemon.gateRef };
}

/**
 * ONE node binding every criterion. The KEY is the whole point of the journey: a seat that read
 * the operator's rejection plans a DIFFERENT decomposition, and a different node key is the
 * smallest difference the compiler can actually see.
 */
function structureFor(rejected, criterionIds) {
  const nodeKey = rejected ? "node-second-attempt" : "node-first-attempt";
  return {
    completionNodeKey: nodeKey,
    nodes: [{
      criterionIds: [...criterionIds],
      dependsOn: [],
      nodeKey,
      objective: rejected
        ? "Re-planned after the operator rejected the first decomposition."
        : "Deliver the whole goal behind one node.",
    }],
  };
}

async function main() {
  const configPath = flagValue("--mcp-config");
  const missionDir = flagValue("--mission-dir");
  say(`pid=${pid}`);
  if (configPath === null) throw new Error("the spawner passed no --mcp-config");
  if (missionDir === null) throw new Error("the shim passed no --mission-dir");

  const mission = await readMission();
  // FIRST, before anything can refuse: an unreadable mission is still evidence.
  const echoed = echoMission(missionDir, mission);
  const parsed = parseMission(mission);
  say(`mission goal=${parsed.goalRef} item=${parsed.workItemId} rejected=${String(parsed.rejected)} echo=${echoed}`);
  if (parsed.goalRef === null) {
    say("no goal in this mission; nothing to plan");
    return 0;
  }

  const server = await readServer(configPath);
  const opened = await openSession(server.url, server.authorization);
  if (opened.session === null) {
    say(`REFUSED status=${opened.refusal.status} body=${opened.refusal.body}`);
    throw new Error("the wrapper refused a minted credential");
  }
  const session = opened.session;

  const context = await callTool(session, CONTEXT_TOOL, {
    correlationId: `j5-context-${parsed.goalRef}`, payload: {},
  });
  if (context.refusal !== null) {
    say(`REFUSED status=${context.refusal.status} body=${context.refusal.body}`);
    throw new Error(`${CONTEXT_TOOL} was refused`);
  }
  const offer = offerFor(context.daemon, parsed.goalRef);
  say(`offer commandId=${offer.commandId} expectedVersion=${offer.expectedVersion}`);

  const contract = await approvedContract(session, parsed.goalRef);
  const structure = structureFor(parsed.rejected, contract.criterionIds);
  say(`submitting nodeKey=${structure.completionNodeKey} criteria=${contract.criterionIds.join(",")}`);
  const submitted = await callTool(session, SUBMIT_TOOL, {
    commandId: offer.commandId,
    correlationId: `j5-submit-${offer.commandId}`,
    expectedVersion: offer.expectedVersion,
    payload: { gateRef: contract.gateRef, goalRef: parsed.goalRef, structure },
    targetAggregateId: offer.targetAggregateId,
  });
  if (submitted.refusal !== null) {
    say(`REFUSED status=${submitted.refusal.status} body=${submitted.refusal.body}`);
    throw new Error(`${SUBMIT_TOOL} was refused`);
  }
  say(`${SUBMIT_TOOL} answered ${JSON.stringify(submitted.daemon)}`);
  if (submitted.daemon?.ok !== true) throw new Error(`${SUBMIT_TOOL} did not commit`);

  if (parsed.workItemId !== null) {
    const released = await callTool(session, RELEASE_TOOL, {
      commandId: `j5-release-${offer.commandId}`,
      correlationId: `j5-release-${offer.commandId}`,
      expectedVersion: 1,
      payload: { workItemId: parsed.workItemId },
      targetAggregateId: parsed.workItemId,
    });
    // Reported, never thrown on: the submit is what this seat is graded by, and a release that
    // races the step off the surface is the daemon's answer rather than this agent's failure.
    say(`${RELEASE_TOOL} answered ${JSON.stringify(released.daemon ?? released.refusal)}`);
  }
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
