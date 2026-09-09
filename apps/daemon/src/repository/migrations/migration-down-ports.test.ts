import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nodeMigrationDownPorts } from "./migration-down-ports.js";

const roots: string[] = [];
const ORIGINAL = "1700000000001_original.js";
const FOREIGN = "1700000000002_foreign.js";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The real production child imports offline modules representing two migration actors.
 * A competing actor appends a newer batch whenever the tail check holds no advisory lock.
 * No PostgreSQL connection, credential, or real schema is used. */
function fixture(mode: "race" | "foreign-tail" | "false-report" | "shadow-table" = "race"): string {
  const root = mkdtempSync(join(tmpdir(), "moe-migration-down-port-")); roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "state.mjs"), `
import { writeFileSync } from 'node:fs';
export const state = { rows: ${JSON.stringify(mode === "foreign-tail" || mode === "shadow-table" ? [ORIGINAL, FOREIGN] : [ORIGINAL])},
  removed: [], guardLocked: false, sharedClient: false, calls: 0, locked: false };
export const save = () => writeFileSync('result.json', JSON.stringify(state));
`);
  for (const name of ["pg", "node-pg-migrate"]) {
    mkdirSync(join(root, "node_modules", name), { recursive: true });
    writeFileSync(join(root, "node_modules", name, "package.json"),
      JSON.stringify({ name, type: "module", exports: "./index.mjs" }));
  }
  writeFileSync(join(root, "node_modules", "pg", "index.mjs"), `
import { state, save } from '../../state.mjs';
export default { Client: class {
  ended = false;
  async connect() {}
  async query(text, values) {
    if (text.includes('pg_try_advisory_lock')) { state.locked = true; return { rows: [{ lockObtained: true }] }; }
    if (text.includes('pg_advisory_unlock')) { state.locked = false; return { rows: [{ lockReleased: true }] }; }
    if (!text.includes('SELECT name')) throw new Error('UNEXPECTED_FIXTURE_QUERY');
    state.guardLocked = state.locked;
    const visible = ${JSON.stringify(mode === "shadow-table")} && !text.includes('public.pgmigrations')
      ? [${JSON.stringify(ORIGINAL)}] : state.rows;
    const rows = visible.slice(-values[0]).reverse().map(name => ({ name: name.slice(0, name.lastIndexOf('.')) }));
    if (!state.locked && ${JSON.stringify(mode === "race")}) state.rows.push(${JSON.stringify(FOREIGN)});
    return { rows };
  }
  async end() { this.ended = true; state.locked = false; save(); }
} };
`);
  writeFileSync(join(root, "node_modules", "node-pg-migrate", "index.mjs"), `
import { state, save } from '../../state.mjs';
export const PG_MIGRATE_LOCK_ID = 7241865325823964;
export async function runner(options) {
  state.calls += 1;
  state.sharedClient = options.dbClient !== undefined && !options.dbClient.ended;
  state.removed = state.rows.splice(-options.count).reverse();
  save();
  return ${JSON.stringify(mode === "false-report")} ? [{ path: ${JSON.stringify(FOREIGN)} }]
    : state.removed.map(path => ({ path }));
}
`);
  return root;
}

it("keeps a competing migration out between the named-tail check and the actual revert", async () => {
  const root = fixture();
  const reverted = await nodeMigrationDownPorts().revert(root, "postgres://fixture.invalid/offline", [ORIGINAL]);
  const observed = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  expect(reverted).toEqual([ORIGINAL]);
  expect(observed).toMatchObject({ removed: [ORIGINAL], rows: [], guardLocked: true, sharedClient: true, calls: 1 });
}, 30_000);

it("refuses a foreign tail before executing any migration", async () => {
  const root = fixture("foreign-tail");
  await expect(nodeMigrationDownPorts().revert(root, "postgres://fixture.invalid/offline", [ORIGINAL]))
    .rejects.toMatchObject({ code: "NOT_LAST_BATCH" });
  const observed = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  expect(observed).toMatchObject({ removed: [], rows: [ORIGINAL, FOREIGN], calls: 0 });
}, 30_000);

it("refuses a successful-looking child report for another migration with the same count", async () => {
  const root = fixture("false-report");
  await expect(nodeMigrationDownPorts().revert(root, "postgres://fixture.invalid/offline", [ORIGINAL]))
    .rejects.toMatchObject({ code: "REVERT_FAILED" });
}, 30_000);

it("checks the runner's actual public history when search_path shadows pgmigrations", async () => {
  const root = fixture("shadow-table");
  await expect(nodeMigrationDownPorts().revert(root, "postgres://fixture.invalid/offline", [ORIGINAL]))
    .rejects.toMatchObject({ code: "NOT_LAST_BATCH" });
  const observed = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  expect(observed).toMatchObject({ removed: [], rows: [ORIGINAL, FOREIGN], calls: 0 });
}, 30_000);
