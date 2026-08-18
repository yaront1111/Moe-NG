import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "moe-probe-http-"));
const storePath = join(dir, "store.db");
const CRED = "probe-operator-credential";
const PROJECT = "proj-probe";
const bin = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "moe-mcp-http.CMD" : "moe-mcp-http");
const child = spawn(bin, [], {
  env: { ...process.env, MOE_STORE_PATH: storePath, MOE_PROJECT_ID: PROJECT, MOE_DAEMON_CREDENTIAL: CRED },
  shell: process.platform === "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
let err = "", out = "";
child.stderr.on("data", (c) => { err += c.toString(); });
const origin = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no origin, stderr=" + err)), 20000);
  child.stdout.on("data", (c) => {
    out += c.toString();
    const i = out.indexOf("\n");
    if (i !== -1) { clearTimeout(t); resolve(out.slice(0, i).replace(/\r$/, "")); }
  });
});
console.log("ORIGIN", origin);

let sessionId = null;
let nextId = 1;
async function rpc(method, params, extraHeaders = {}) {
  const id = nextId++;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${CRED}`, ...extraHeaders };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  return { status: res.status, ct: res.headers.get("content-type"), text };
}
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
  console.log("INIT", init.status, init.ct, init.text.slice(0, 300));
  console.log("SESSION", sessionId);
  const payload = { owner: "operator-local" };
  const args = { commandId: "cmd-probe-http", correlationId: "corr-h1", expectedVersion: 0, payload, targetAggregateId: PROJECT };
  const call = await rpc("tools/call", { name: "project_register", arguments: args });
  console.log("CALL", call.status, call.ct, call.text.slice(0, 700));
} catch (e) { console.log("ERR", e.message, err.slice(0,500)); }
finally {
  child.kill();
  await new Promise(r => setTimeout(r, 500));
  try {
    const db = new DatabaseSync(storePath);
    console.log("TABLES", db.prepare("select name from sqlite_master where type='table' order by name").all().map(r=>r.name).join(","));
    db.close();
  } catch (e) { console.log("DBERR", e.message); }
  try { rmSync(dir, { force: true, recursive: true }); } catch {}
  console.log("STDERR", err.slice(0, 500));
}
