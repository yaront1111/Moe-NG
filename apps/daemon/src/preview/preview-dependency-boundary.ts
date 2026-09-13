import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PreviewSource } from "./preview-source.js";

function contained(root: string, path: string): boolean {
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path) === normalize(root) || normalize(path).startsWith(`${normalize(root)}${sep}`);
}
function localPath(root: string, base: string, raw: string, glob = false): boolean {
  try {
    const path = decodeURIComponent(raw).replaceAll("\\", "/");
    if (path === "" || isAbsolute(path) || /[:\u0000-\u001f]/u.test(path)) return false;
    const target = resolve(base, path);
    return contained(root, target) && (glob || contained(root, realpathSync(target)));
  } catch { return false; }
}
function jsonInputs(root: string, base: string, value: unknown): boolean {
  if (typeof value === "string") {
    const local = /^(?:file|link):(.*)$/u.exec(value);
    if (local !== null) return localPath(root, base, local[1]!);
    if (/^workspace:[./\\]/u.test(value)) return localPath(root, base, value.slice(10));
    return true;
  }
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(item => jsonInputs(root, base, item));
  const record = value as Record<string, unknown>;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = record[key];
    if (dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      for (const dependency of Object.values(dependencies)) {
        if (typeof dependency === "string" && /^(?:[./\\~]|[A-Za-z]:)/u.test(dependency)
          && !localPath(root, base, dependency)) return false;
      }
    }
  }
  if (record["type"] === "directory" && (typeof record["directory"] !== "string"
    || !localPath(root, base, record["directory"]))) return false;
  if (record["link"] === true && typeof record["resolved"] === "string"
    && !localPath(root, base, record["resolved"])) return false;
  const workspaceConfig = record["workspaces"];
  const workspaces = workspaceConfig !== null && typeof workspaceConfig === "object" && !Array.isArray(workspaceConfig)
    ? (workspaceConfig as Record<string, unknown>)["packages"] : workspaceConfig;
  if (Array.isArray(workspaces) && !workspaces.every(item => typeof item === "string"
    && localPath(root, base, item.replace(/^!/u, ""), true))) return false;
  return Object.values(record).every(item => jsonInputs(root, base, item));
}

function yamlInputs(root: string, base: string, name: string, text: string): boolean {
  const parsed: unknown = parseYaml(text, { maxAliasCount: 0, uniqueKeys: true, logLevel: "silent" });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const document = parsed as Record<string, unknown>;
  if (name === "pnpm-workspace.yaml") {
    const packages = document["packages"];
    if (packages !== undefined && (!Array.isArray(packages) || !packages.every(item =>
      typeof item === "string" && localPath(root, base, item.replace(/^!/u, ""), true)))) return false;
  }
  const { importers, ...rest } = document;
  if (!jsonInputs(root, base, rest)) return false;
  if (importers !== undefined) {
    if (importers === null || typeof importers !== "object" || Array.isArray(importers)) return false;
    for (const [importer, value] of Object.entries(importers)) {
      if (!localPath(root, base, importer) || !jsonInputs(root, resolve(base, importer), value)) return false;
    }
  }
  return true;
}

/** Parse committed manifests and locks before package managers can read local inputs. */
export function previewDependencyInputsContained(source: PreviewSource): boolean {
  try {
    for (const relative of source.files) {
      const name = basename(relative);
      if (!["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(name)) continue;
      const path = join(source.directory, relative); const text = readFileSync(path, "utf8");
      if (name.endsWith(".json")) {
        const parsed: unknown = JSON.parse(text);
        if (!jsonInputs(source.directory, dirname(path), parsed)) return false;
        if (name !== "package.json" && parsed !== null && typeof parsed === "object" && "packages" in parsed) {
          const packages = (parsed as Record<string, unknown>)["packages"];
          if (packages === null || typeof packages !== "object" || Array.isArray(packages)) return false;
          for (const location of Object.keys(packages)) {
            if (!localPath(source.directory, dirname(path), location || ".", true)) return false;
          }
        }
      } else if (!yamlInputs(source.directory, dirname(path), name, text)) return false;
    }
    return true;
  } catch { return false; }
}

/** Package-manager links may resolve only into this extracted source and its generated dependencies. */
export function previewDependencyLinksContained(source: PreviewSource): boolean {
  try {
    const pending = [join(source.directory, "node_modules"), ...source.files.filter(file => basename(file) === "package.json")
      .map(file => join(source.directory, dirname(file), "node_modules"))].filter(existsSync);
    const visited = new Set<string>();
    while (pending.length > 0) {
      const path = pending.pop()!; const target = realpathSync(path);
      if (!contained(source.directory, target)) return false;
      if (!statSync(path).isDirectory() || visited.has(target)) continue;
      visited.add(target);
      for (const entry of readdirSync(path)) pending.push(join(path, entry));
    }
    return true;
  } catch { return false; }
}
