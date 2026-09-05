/**
 * The scripted coder the J1 loop e2e spawns in place of a real `claude`.
 *
 * PLAIN `.mjs` ON PURPOSE. `agent-spawner.ts` invokes MOE_AGENT_COMMAND with claude-shaped
 * argv and no transform flags, so this file must run under bare `node`: node builtins only,
 * no TypeScript, no dependency, and it is deliberately outside the e2e tsconfig.
 *
 * IT LEARNS EVERYTHING FROM THE SPAWNER, NOTHING FROM THE ENVIRONMENT.
 * `agentEnvironment()` scrubs every key outside its allowlist and drops all `MOE_*`, so an
 * env var cannot reach this process at all: the ARM is selected by argv the generated .cmd
 * shim prepends, the mission arrives on STDIN, and the loopback url plus the per-agent scoped
 * bearer are read from the JSON at `--mcp-config`. Reading a flag off argv would NOT prove
 * the spawner passed it, so no flag here is treated as evidence of anything.
 *
 * Its stdout is the WRAPPER's stdout (`stdio: ["pipe", "inherit", "inherit"]`), which is where
 * the e2e harvests the pid line and any refusal body.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, cwd, pid, stdin, stdout } from "node:process";

const PROTOCOL_VERSION = "2025-06-18";
const ACCEPT = "application/json, text/event-stream";
const SUBMIT_KIND = "review.submit";
const SUBMIT_HINT_MARKER = "Suggested review.submit payload shape: ";

const say = (line) => { stdout.write(`fake-agent: ${line}\n`); };

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
 * The two identities the mission states. They are parsed rather than guessed because the
 * daemon mints one offer per subject and picking the wrong one would submit against a node
 * this agent never claimed.
 */
function parseMission(mission) {
  const nodeRef = /code node "([^"]+)"/u.exec(mission)?.[1] ?? null;
  const workItemId = /work item "([^"]+)"/u.exec(mission)?.[1] ?? null;
  const marker = mission.indexOf(SUBMIT_HINT_MARKER);
  const hint = marker === -1 ? null : mission.slice(marker + SUBMIT_HINT_MARKER.length).trim();
  return { hint: hint === null ? null : JSON.parse(hint), nodeRef, workItemId };
}

/** The scoped credential and loopback origin the wrapper minted for THIS agent. */
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

/**
 * A forged bearer of the SAME SHAPE as the minted one: same length and charset, different
 * bytes. A malformed header would be refused by the transport before the authenticator is
 * ever consulted, which would prove nothing about authentication.
 */
function forge(authorization) {
  const [scheme, credential] = authorization.split(" ");
  const forged = credential.replace(/./gu, (character, index) =>
    index < credential.length - 8 ? character : "0123456789abcdef"[index % 16]);
  return `${scheme} ${forged === credential ? `${credential}f` : forged}`;
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
  const text = await response.text();
  return { headers: response.headers, status: response.status, text };
}

async function openSession(url, authorization) {
  const session = { authorization, id: null, nextId: 2, url };
  const response = await post(session, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "moe-e2e-fake-agent", version: "0.0.0" },
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

function offerFor(surface, nodeRef) {
  const offers = (surface?.nextAllowedCommands ?? [])
    .filter((offer) => offer.commandKind === SUBMIT_KIND
      && (nodeRef === null || offer.targetAggregateId === nodeRef));
  if (offers.length !== 1) {
    throw new Error(`expected exactly one ${SUBMIT_KIND} offer for ${nodeRef}, saw ${offers.length}`);
  }
  return offers[0];
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The review package this agent submits.
 *
 * It is BUILT, never lifted from the mission's "Suggested review.submit payload shape" hint:
 * that hint comes from the control room's DEV table, and the wrapper cannot load that table at
 * all right now (`live-dispatch.ts` imports a `live-effort-edge.js` bridge that does not exist
 * and the loader swallows the ERR_MODULE_NOT_FOUND), so every mission this e2e observed
 * arrived with `hint=none`. An agent depending on it would pass or fail on a dev-only module.
 *
 * `SUBMITTED_BYTES` digests the bytes this agent actually wrote. The other kinds are
 * host-owned facts a coder has no source for, and the daemon validates them for SHAPE only
 * (64-hex, content-addressed), so each is derived from a self-describing label instead of
 * being dressed up as a measurement it is not. `DAEMON_RECEIPT` is required: buildReviewPackage
 * refuses a stored round that carries none.
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

/**
 * The deliverable. The daemon's verifier - not this agent - decides whether it passes.
 *
 * The `fail-verify` arm writes a deliverable that is WRONG but well-formed: it imports, it
 * exports both names, and `multiply` returns a sum. So the node's test fails on behaviour
 * rather than on a syntax error, and the agent below still reports a clean round - which is
 * exactly the disagreement J4 needs. An agent that reported its own failure would be testing
 * the agent's honesty instead of the daemon's verdict.
 */
function implement(target, arm) {
  const multiply = arm === "fail-verify"
    ? "export const multiply = (left, right) => left + right;"
    : "export const multiply = (left, right) => left * right;";
  writeFileSync(target, [
    "export const add = (left, right) => left + right;",
    multiply,
    "",
  ].join("\n"), "utf8");
  say(`wrote ${target}${arm === "fail-verify" ? " (arm=fail-verify: multiply is wrong)" : ""}`);
  return readFileSync(target, "utf8");
}

/**
 * Where this agent announces its pid.
 *
 * `--pidfile` is ONE path and is what every single-agent arm is handed. A pass that staffs two
 * nodes at once runs two of these processes concurrently, and two of them writing one path
 * races (on Windows the loser can take an EPERM and die reporting nothing about the journey),
 * so a parallel arm is handed `--pid-dir` instead and each child owns `agent-<pid>.pid`. The
 * choice is the SHIM's, made in `writeAgentShim`; this function only obeys the argv it got.
 */
function pidPath() {
  const directory = flagValue("--pid-dir");
  return directory === null
    ? flagValue("--pidfile") ?? "fake-agent.pid"
    : join(directory, `agent-${pid}.pid`);
}

async function main() {
  const arm = flagValue("--arm") ?? "complete";
  const configPath = flagValue("--mcp-config");
  writeFileSync(pidPath(), String(pid), "utf8");
  say(`pid=${pid} arm=${arm} cwd=${cwd()}`);
  if (configPath === null) throw new Error("the spawner passed no --mcp-config");

  const mission = await readMission();
  const { hint, nodeRef, workItemId } = parseMission(mission);
  say(`mission node=${nodeRef} item=${workItemId} hint=${
    hint === null ? "none" : Object.keys(hint).sort().join(",")}`);
  if (nodeRef === null && arm !== "forge-credential") {
    // This agent implements CODE nodes. A chain-step mission is another agent's job, and
    // guessing at one would submit against a subject it never claimed.
    say("no code node in this mission; nothing to do");
    return 0;
  }
  const server = await readServer(configPath);
  const authorization = arm === "forge-credential"
    ? forge(server.authorization)
    : server.authorization;

  const opened = await openSession(server.url, authorization);
  if (opened.session === null) {
    // Verbatim, never summarised: the e2e asserts the daemon's own code and layer.
    say(`REFUSED status=${opened.refusal.status} body=${opened.refusal.body}`);
    if (arm !== "forge-credential") throw new Error("the wrapper refused a minted credential");
    say("arm=forge-credential refused as designed");
    return 3;
  }
  if (arm === "forge-credential") throw new Error("a forged bearer opened a session");

  const context = await callTool(opened.session, "work_get_context", {
    correlationId: `fake-agent-${nodeRef ?? "node"}`, payload: {},
  });
  if (context.refusal !== null) {
    say(`REFUSED status=${context.refusal.status} body=${context.refusal.body}`);
    throw new Error("work_get_context was refused");
  }
  const offer = offerFor(context.daemon, nodeRef);
  say(`offer commandId=${offer.commandId} expectedVersion=${offer.expectedVersion}`);

  const submittedBytes = implement(flagValue("--implement") ?? "math.mjs", arm);

  if (arm === "skip-review") {
    // The negative control: everything except the durable submission, and a CLEAN exit, so a
    // COMMITTED assertion reading process exit codes instead of the ledger goes green here.
    say("arm=skip-review exiting 0 without review_submit");
    return 0;
  }

  const payload = {
    findings: [],
    packageItems: packageItems(offer.targetAggregateId, submittedBytes),
    round: offer.expectedVersion + 1,
    subjectRef: offer.targetAggregateId,
  };
  say(`review_submit payload keys=${Object.keys(payload).sort().join(",")}`);
  const submitted = await callTool(opened.session, "review_submit", {
    commandId: offer.commandId,
    correlationId: `fake-agent-submit-${offer.commandId}`,
    expectedVersion: offer.expectedVersion,
    payload,
    targetAggregateId: offer.targetAggregateId,
  });
  if (submitted.refusal !== null) {
    say(`REFUSED status=${submitted.refusal.status} body=${submitted.refusal.body}`);
    throw new Error("review_submit was refused");
  }
  say(`review_submit answered ${JSON.stringify(submitted.daemon)}`);
  if (submitted.daemon?.ok !== true) throw new Error("review_submit did not commit");

  if (workItemId !== null) {
    const released = await callTool(opened.session, "work_release", {
      commandId: `fake-agent-release-${workItemId}`,
      correlationId: `fake-agent-release-${workItemId}`,
      expectedVersion: 1,
      payload: { workItemId },
      targetAggregateId: workItemId,
    });
    say(`work_release answered ${JSON.stringify(released.daemon ?? released.refusal)}`);
  }
  return 0;
}

/**
 * `process.exitCode` rather than `exit()`: calling `exit()` while the stdin pipe and an
 * undici socket are still open aborts the process with a libuv assertion
 * (`!(handle->flags & UV_HANDLE_CLOSING)`, exit 3221226505 on Windows), which the wrapper
 * then reports as AGENT_PROCESS_FAILED and hides whatever actually happened.
 */
main().then((code) => { process.exitCode = code; }).catch((error) => {
  say(`FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
