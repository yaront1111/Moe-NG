import { existsSync } from "node:fs";
const keys = ["node-alpha-e2e-proj-xmgpnb","node-beta-e2e-proj-xmgpnb","node-omega-e2e-proj-xmgpnb"];
let tested = 0; for (const key of keys) {
if (!existsSync(new URL(`./${key}/math.mjs`, import.meta.url))) continue;
await import(`./${key}/test.mjs`); tested++; }
if (tested === 0) throw new Error("no module was implemented");