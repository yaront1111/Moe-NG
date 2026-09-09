/**
 * THE FRESH PRODUCT'S OWN CODE SURFACE, for the epic-final live proof's landing leg.
 *
 * WHAT LIVES HERE AND WHY IT IS SPLIT OUT. `live-proof-landing.ts` owns the wrapper chain; this
 * module owns the bytes that chain operates on: the workspace baseline the daemon's verifier
 * runs and the per-criterion checks the criterion service later runs. The seats that write the
 * product's own modules live in `live-proof-seat.ts` and are REAL PROVIDER SEATS.
 *
 * THERE IS NO SEAT DOUBLE ANY MORE. Round 1 of this row kept each node's source in a literal
 * table here and had a scripted seat write it out, disclosed as "the ONE double". QA rejected
 * that (comment-b8cb1fc1 item 2) because governor-608c8a78 had refused the waiver twice, and a
 * truthful disclosure is not an authorization. Nothing in this file now contains, or can
 * produce, a line of the product's code.
 *
 * NOTHING HERE IS AUTHORITY. The baseline is committed into the product repository the BROWSER
 * bootstrapped (task rail 3 forbids a scratchpad script standing in for a step the product
 * claims to do itself) and every assertion below is derived from the PRD's own criteria in
 * `live-proof-prd.ts`, so a check that passes is a check against the recorded contract rather
 * than against something written to be easy.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeDeployableSurface } from "./live-proof-image.js";

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


/**
 * The nodes the compiled plan carries, in the order the plan declares them.
 *
 * A ROSTER, NOT A TABLE OF BODIES. Round 1 of this row held each node's SOURCE here and had a
 * seat double write it out; QA rejected that as an unauthorized substitution and it was right
 * to. The bytes are now a real provider's, so what remains here is the list of nodes and the
 * derivation of what each one is judged by -- which is read off `CRITERION_CHECKS` above,
 * itself derived from the browser-approved contract.
 */
export const NODE_KEYS: readonly string[] = Object.freeze([
  "node-auth-api", "node-entries", "node-integration",
]);

/**
 * The PRD's own table, as a migration the PRODUCT runs at deploy time.
 *
 * The stamp is fixed rather than generated: `checkOrder: true` orders migrations by filename and a
 * clock-derived name would make two runs of this drive order differently. It sorts AFTER the
 * scaffold's own `1700000000000-initial.js`, which is where it belongs.
 */
export const MIGRATION_FILE = "migrations/1700000000001-standup-entry.js";

/** Where a node's delivered module lives, relative to the product repository root. */
export const modulePath = (nodeKey: string): string => `${nodeKey}/module.mjs`;

/** The check files whose assertions one node's module must satisfy, in criterion order. */
export const checksFor = (nodeKey: string): readonly string[] =>
  Object.freeze(CRITERION_CHECKS
    .filter((row) => row.moduleKey === nodeKey)
    .map((row) => `checks/${row.criterionId}.mjs`));

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
  const keys = NODE_KEYS;
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
  // THE SCHEMA THE PRD ASKS FOR, AS THE PRODUCT'S OWN MIGRATION. `deployment.deploy` runs the
  // migrations committed AT THE DEPLOYED SHA through the product's own `node-pg-migrate`
  // (migration-ports.ts), so this file is what makes the deploy's migration real rather than a
  // side script: the daemon extracts `migrations/` at that sha and applies it. The filename must
  // match the engine's own `^\d{13,17}[-_][A-Za-z0-9_-]+\.(js|cjs|mjs|sql)$`, and the constraint
  // is NAMED rather than left to PostgreSQL so the read-back asserts a name the DDL chose.
  mkdirSync(join(workspace, "migrations"), { recursive: true });
  writeFileSync(join(workspace, MIGRATION_FILE), [
    '/** @param {import("node-pg-migrate").MigrationBuilder} pgm */',
    "export function up(pgm) {",
    '  pgm.createTable("standup_entry", {',
    '    id: { type: "bigserial", primaryKey: true },',
    '    author_email: { type: "text", notNull: true },',
    '    entry_date: { type: "date", notNull: true },',
    '    yesterday: { type: "text", notNull: true },',
    '    today: { type: "text", notNull: true },',
    '    blockers: { type: "text" },',
    "  });",
    '  pgm.addConstraint("standup_entry", "standup_entry_author_email_entry_date_key",',
    '    { unique: ["author_email", "entry_date"] });',
    "}",
    "",
    '/** @param {import("node-pg-migrate").MigrationBuilder} pgm */',
    "export function down(pgm) {",
    '  pgm.dropTable("standup_entry");',
    "}",
    "",
  ].join("\n"), "utf8");
  paths.push(MIGRATION_FILE);
  // THE DEPLOYABLE SURFACE RIDES THE SAME COMMIT. `docker build` is fed by `git archive <sha>`
  // (deploy-image-build.ts:63), so a Dockerfile added later than the landed sha is invisible to
  // the deploy; it has to be an ancestor of every sha this product will ever deploy.
  paths.push(...writeDeployableSurface(workspace));
  productGit(workspace, ["add", "--", ...paths]);
  productGit(workspace, [...IDENTITY, "commit", "--quiet", "--message",
    "Acceptance checks for the recorded PRD criteria, and the deployable surface"]);
  return Object.freeze(paths);
}
