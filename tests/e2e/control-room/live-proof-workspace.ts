/**
 * THE FRESH PRODUCT'S OWN CODE SURFACE, for the epic-final live proof's landing leg.
 *
 * WHAT LIVES HERE AND WHY IT IS SPLIT OUT. `live-proof-landing.ts` owns the wrapper chain; this
 * module owns the bytes that chain operates on: the workspace baseline the daemon's verifier
 * runs, the per-criterion checks the criterion service later runs, and the seat double the
 * wrapper spawns. Two files rather than one because the project rail caps a source at 250
 * physical lines and the chain plus its fixtures is comfortably over that.
 *
 * NOTHING HERE IS AUTHORITY. The baseline is committed into the product repository the BROWSER
 * bootstrapped (task rail 3 forbids a scratchpad script standing in for a step the product
 * claims to do itself) and every assertion below is derived from the PRD's own criteria in
 * `live-proof-prd.ts`, so a check that passes is a check against the recorded contract rather
 * than against something written to be easy. The seat is the ONE double, for the reason
 * `lane-landing.ts` gives: a real provider seat cannot be asked to produce a specific edit on
 * cue, and this row certifies the LOOP, not provider behaviour. Everything downstream of the
 * seat's exit -- verifier, lander, git -- is the shipped daemon.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { landingSeatClaim } from "./lane-landing.js";

/** Stated, not inherited, exactly as `daemon-ports.ts` states it: no host identity needed. */
const IDENTITY = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local",
  "-c", "commit.gpgsign=false"];

/** GIT_* stripped so a parent shell's GIT_DIR cannot redirect this into the developer's tree. */
function productGit(workspace: string, args: readonly string[]): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return execFileSync("git", [...args], {
    cwd: workspace, encoding: "utf8", env, shell: false, timeout: 30_000, windowsHide: true,
  }).trim();
}

/**
 * Which node owns which criterion, and the assertion each criterion's check makes.
 *
 * THE SPLIT IS THE PLAN'S, NOT THIS FILE'S: `live-proof-prd.spec.ts`'s `PLAN_NODES` gives
 * node-auth-api A1/A2/A3, node-entries A4/A5/A7 and the completion node node-integration A6/A8,
 * and the compiled graph the browser sealed carries exactly that. `moduleKey` names the module a
 * check MEASURES, which for A6/A8 is the integration surface rather than either parent. A check
 * whose module is absent THROWS -- criteria are verified after every node has landed, so an
 * absent module is a real failure and never a skip.
 */
export const CRITERION_CHECKS: readonly {
  readonly assertion: string; readonly criterionId: string; readonly moduleKey: string;
}[] = Object.freeze([
  { assertion: 'if (m.signIn("dana@team.test", "correct-horse").screen !== "TODAY") fail("A1");',
    criterionId: "crit-a1", moduleKey: "node-auth-api" },
  { assertion: 'if (m.signIn("dana@team.test", "wrong").error !== m.signIn("nobody@team.test", "correct-horse").error) fail("A2");',
    criterionId: "crit-a2", moduleKey: "node-auth-api" },
  { assertion: 'const r = m.getEntries(null, "2026-09-09"); if (r.status !== 401 || r.body.entries !== undefined) fail("A3");',
    criterionId: "crit-a3", moduleKey: "node-auth-api" },
  { assertion: 'const r = m.getEntries({ email: "dana@team.test" }, "not-a-date"); if (r.status !== 400 || r.body.code !== "ENTRY_DATE_INVALID") fail("A6");',
    criterionId: "crit-a6", moduleKey: "node-integration" },
  { assertion: 'let rows = []; rows = m.upsert(rows, { author_email: "dana@team.test", entry_date: "2026-09-09", today: "one" }).rows; rows = m.upsert(rows, { author_email: "dana@team.test", entry_date: "2026-09-09", today: "two" }).rows; if (rows.length !== 1 || rows[0].today !== "two") fail("A4");',
    criterionId: "crit-a4", moduleKey: "node-entries" },
  { assertion: 'const rows = [{ author_email: "dana@team.test", entry_date: "2026-09-09", today: "one" }]; const direct = m.insertDirect(rows, { author_email: "dana@team.test", entry_date: "2026-09-09", today: "two" }); if (direct.ok !== false || direct.constraint !== "standup_entry_author_email_entry_date_key") fail("A5");',
    criterionId: "crit-a5", moduleKey: "node-entries" },
  { assertion: 'const view = m.history([], "2026-09-01"); if (view.state !== "EMPTY") fail("A7");',
    criterionId: "crit-a7", moduleKey: "node-entries" },
  { assertion: 'const saved = m.upsert([], { author_email: "dana@team.test", entry_date: "2026-09-09", today: "one", blockers: "" }); if (saved.rows[0].blockers !== "" || m.render(saved.rows[0]).includes("Blockers")) fail("A8");',
    criterionId: "crit-a8", moduleKey: "node-integration" },
]);

/** The module each node's seat delivers. Small, but it is what every check above measures. */
export const NODE_MODULES: Readonly<Record<string, string>> = Object.freeze({
  "node-auth-api": [
    'const ACCOUNTS = { "dana@team.test": "correct-horse" };',
    '// A2: ONE string for both misses, so an attacker cannot enumerate emails.',
    'const SIGN_IN_ERROR = "Email or password is incorrect.";',
    'export function signIn(email, password) {',
    '  return ACCOUNTS[email] === password',
    '    ? { screen: "TODAY", session: { email } } : { error: SIGN_IN_ERROR, screen: "SIGN IN" };',
    '}',
    'export function getEntries(session, date) {',
    '  if (session === null || session === undefined) return { body: { code: "SESSION_REQUIRED" }, status: 401 };',
    '  if (!/^\\d{4}-\\d{2}-\\d{2}$/u.test(date)) return { body: { code: "ENTRY_DATE_INVALID" }, status: 400 };',
    '  return { body: { entries: [] }, status: 200 };',
    '}',
    '',
  ].join("\n"),
  "node-entries": [
    '// A5: the name the DATABASE constraint carries, not an application check.',
    'const UNIQUE = "standup_entry_author_email_entry_date_key";',
    'const keyOf = (row) => `${row.author_email}\\u0000${row.entry_date}`;',
    'export function upsert(rows, entry) {',
    '  const kept = rows.filter((row) => keyOf(row) !== keyOf(entry));',
    '  return { rows: [...kept, { blockers: "", ...entry }] };',
    '}',
    'export function insertDirect(rows, entry) {',
    '  return rows.some((row) => keyOf(row) === keyOf(entry))',
    '    ? { constraint: UNIQUE, ok: false } : { ok: true, rows: [...rows, entry] };',
    '}',
    'export function history(rows, date) {',
    '  const day = rows.filter((row) => row.entry_date === date);',
    '  return day.length === 0 ? { entries: [], state: "EMPTY" } : { entries: day, state: "LOADED" };',
    '}',
    'export function render(row) {',
    '  return row.blockers === "" ? `${row.today}` : `${row.today}\\nBlockers\\n${row.blockers}`;',
    '}',
    '',
  ].join("\n"),
  // THE COMPLETION NODE'S OWN SURFACE. It depends on both work nodes, so the graph withholds it
  // until they are ACCEPTED -- and A6/A8 are checked THROUGH it, so what this node delivers is
  // measured rather than assumed present.
  "node-integration": [
    'export * from "../node-auth-api/module.mjs";',
    'export * from "../node-entries/module.mjs";',
    '',
  ].join("\n"),
});

/** Where a node's delivered module lives, relative to the product repository root. */
export const modulePath = (nodeKey: string): string => `${nodeKey}/module.mjs`;

/**
 * Commits the baseline the daemon's verifier and the criterion service both run.
 *
 * `verify.mjs` is TOLERANT of an absent module and STRICT about a present one, because the
 * daemon runs it as `MOE_NODE_TEST_COMMAND` for BOTH nodes: the first node to land does so with
 * the second node's module still missing, and a baseline that demanded both would fail the very
 * landing it is meant to verify. `checks/*.mjs` are strict for the opposite reason -- they run
 * after both landings, so an absent module there is a genuine miss.
 */
export function prepareLiveProductWorkspace(workspace: string): readonly string[] {
  const paths: string[] = ["verify.mjs"];
  const keys = Object.keys(NODE_MODULES);
  writeFileSync(join(workspace, "verify.mjs"), [
    'import { existsSync } from "node:fs";',
    `const keys = ${JSON.stringify(keys)};`,
    "let ran = 0;",
    "for (const key of keys) {",
    "  const href = new URL(`./${key}/module.mjs`, import.meta.url);",
    "  if (!existsSync(href)) continue;",
    "  const module = await import(href.href);",
    "  if (Object.keys(module).length === 0) throw new Error(`${key} exports nothing`);",
    "  ran += 1;",
    "}",
    'console.log(`verify.mjs checked ${ran} of ${keys.length} modules`);',
    "",
  ].join("\n"), "utf8");
  mkdirSync(join(workspace, "checks"), { recursive: true });
  for (const row of CRITERION_CHECKS) {
    const file = `checks/${row.criterionId}.mjs`;
    writeFileSync(join(workspace, file), [
      `import * as m from "../${row.moduleKey}/module.mjs";`,
      'const fail = (id) => { throw new Error(`${id} FAILED`); };',
      row.assertion,
      `console.log("${row.criterionId} VERIFIED");`,
      "",
    ].join("\n"), "utf8");
    paths.push(file);
  }
  productGit(workspace, ["add", "--", ...paths]);
  productGit(workspace, [...IDENTITY, "commit", "--quiet", "--message",
    "Acceptance checks for the recorded PRD criteria"]);
  return Object.freeze(paths);
}


/**
 * The seat double: it reads its mission, delivers ONE node's module, and marks its window.
 *
 * IT READS ITS MISSION for the reason `landingSeatDouble` does: the wrapper staffs every ready
 * item through the same command, so a seat that ignored stdin would deliver a node on behalf of
 * a mission that never claimed it. The claim clause comes from PRODUCTION
 * (`agent-mission-text.ts`'s `codeMission`, re-exported by `lane-landing.ts`), so a mission that
 * merely quotes a ref does not match.
 */
export function liveSeatDouble(
  dir: string, workspace: string, refs: Readonly<Record<string, string>>,
  rendezvous: readonly string[],
): { command: string } {
  // THE PEER SET IS THE CONCURRENT PAIR, not "every other node". A completion node depends on
  // its parents and is deliberately withheld until they are ACCEPTED, so asking it to see a
  // live peer would time out on correct behaviour; and it would see its parents' persisted
  // start markers anyway, which proves nothing. Only the nodes named here wait for each other.
  const claims = Object.entries(refs).map(([key, ref]) => ({
    claim: landingSeatClaim(ref), key,
    peers: rendezvous.includes(key) ? rendezvous.filter((row) => row !== key) : [],
    target: join(workspace, modulePath(key)).replaceAll("\\", "/"),
  }));
  const jsPath = join(dir, "live-proof-seat.js");
  writeFileSync(jsPath, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const CLAIMS = ${JSON.stringify(claims)};`,
    `const BODIES = ${JSON.stringify(NODE_MODULES)};`,
    `const MARKS = ${JSON.stringify(dir.replaceAll("\\", "/"))};`,

    "const chunks = [];",
    'process.stdin.on("error", function () { process.exit(0); });',
    'process.stdin.on("data", function (chunk) { chunks.push(chunk); });',
    'process.stdin.on("end", function () {',
    '  const mission = Buffer.concat(chunks).toString("utf8");',
    "  const mine = CLAIMS.find(function (row) { return mission.indexOf(row.claim) !== -1; });",
    "  if (mine === undefined) process.exit(0);",
    "  const startedAt = Date.now();",
    '  const mark = function (suffix, body) {',
    '    fs.writeFileSync(path.join(MARKS, "seat-" + mine.key + suffix), JSON.stringify(body));',
    "  };",
    '  mark(".start", { startedAt: startedAt });',
    "  // PEERS ARE OBSERVED, NEVER WAITED FOR. A rendezvous here DEADLOCKS against a",
    "  // designed product invariant: the repository delivery coordinator admits ONE checkout",
    "  // owner per repository root, so a seat that blocked until its peer was also delivering",
    "  // would hold the reservation the peer is refused on -- measured 2026-09-09 as",
    "  // REPOSITORY_EXECUTION_BUSY (REPOSITORY_DELIVERY) on every pass until the budget spent.",
    "  const peerSeen = mine.peers.every(function (key) {",
    '    return fs.existsSync(path.join(MARKS, "seat-" + key + ".start"));',
    "  });",
    "  try {",
    "    fs.mkdirSync(path.dirname(mine.target), { recursive: true });",
    "    fs.writeFileSync(mine.target, BODIES[mine.key]);",
    "  } catch (error) {",
    '    process.stderr.write("SEAT_WRITE_FAILED " + String(error) + "\\n");',
    "    process.exit(1);",
    "  }",
    '  mark(".end", { endedAt: Date.now(), peerSeen: peerSeen, startedAt: startedAt });',
    "  process.exit(0);",
    "});",
    "",
  ].join("\n"), "utf8");
  const cmdPath = join(dir, "live-proof-seat.cmd");
  const shPath = join(dir, "live-proof-seat.sh");
  writeFileSync(cmdPath,
    `@echo off\r\n"${process.execPath}" "%~dp0live-proof-seat.js"\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  writeFileSync(shPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/live-proof-seat.js"\n`, "utf8");
  chmodSync(shPath, 0o755);
  return { command: process.platform === "win32" ? cmdPath : shPath };
}
