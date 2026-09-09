/** The scripted multi-node seat chooses only the criterion explicitly present in its mission. */
import { readFileSync, writeFileSync } from "node:fs";
export function implementMultiNode(mission) {
  const node = /\[crit-(alpha|beta|omega)\]/u.exec(mission)?.[1];
  if (node === undefined) throw new Error("multi-node mission carries no criterion");
  const path = `node-${node}/math.mjs`;
  const source = node === "omega" ? [
    'import {add} from "../node-alpha/math.mjs";',
    'import {multiply} from "../node-beta/math.mjs";',
    'export {add};',
    'export const multiplyIntegrated = multiply;',
    'export {multiply};',
  ].join("\n") : [
    'export const add = (left, right) => left + right;',
    'export const multiply = (left, right) => left * right;',
  ].join("\n");
  writeFileSync(path, `${source}\n`, "utf8");
  return readFileSync(path, "utf8");
}
