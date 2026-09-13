import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewCommandPlan } from "./preview-command-resolution.js";
import { previewRefusal, type PreviewRefusal } from "./preview-contracts.js";
import type { PreviewProcessOptions } from "./preview-process.js";
import { runPreviewPreparation } from "./preview-preparation-process.js";
import type { PreviewSource } from "./preview-source.js";
import { previewDependencyInputsContained, previewDependencyLinksContained } from "./preview-dependency-boundary.js";

/** Explicit contract commands own their preparation. Default scripts get a committed lockfile install. */
function commands(source: PreviewSource, plan: PreviewCommandPlan,
  scripts: Readonly<Record<string, unknown>> | null): readonly string[] | PreviewRefusal {
  if (plan.source === "CONTRACT") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(source.directory, "package.json"), "utf8")); }
  catch { return previewRefusal("PREVIEW_COMMAND_MISSING"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return previewRefusal("PREVIEW_COMMAND_MISSING");
  const manifest = parsed as Record<string, unknown>;
  const dependencies = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "workspaces"].some(key => {
    const value = manifest[key]; return value !== null && typeof value === "object" && Object.keys(value).length > 0;
  }) || existsSync(join(source.directory, "pnpm-workspace.yaml"));
  const result: string[] = [];
  if (dependencies) {
    if (!previewDependencyInputsContained(source)) return previewRefusal("PREVIEW_COMMAND_MISSING");
    const npm = existsSync(join(source.directory, "package-lock.json")) || existsSync(join(source.directory, "npm-shrinkwrap.json"));
    const pnpm = existsSync(join(source.directory, "pnpm-lock.yaml"));
    const manager = manifest["packageManager"];
    if (npm === pnpm || (typeof manager === "string" &&
      !(npm ? /^npm@/u : /^pnpm@/u).test(manager))) return previewRefusal("PREVIEW_COMMAND_MISSING");
    result.push(pnpm
      ? "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir .moe-preview-cache"
        + " --modules-dir node_modules --virtual-store-dir node_modules/.pnpm"
      : "npm ci --ignore-scripts --no-audit --no-fund --cache .moe-preview-cache");
  }
  if (plan.source === "SCRIPT:preview" && typeof scripts?.["build"] === "string" && scripts["build"].trim() !== "") {
    result.push("npm run build");
  }
  return result;
}

export async function preparePreviewRuntime(source: PreviewSource, plan: PreviewCommandPlan,
  scripts: Readonly<Record<string, unknown>> | null, options: PreviewProcessOptions,
  observe: (alive: () => boolean) => void): Promise<PreviewRefusal | null> {
  const preparation = commands(source, plan, scripts);
  if (!Array.isArray(preparation)) return preparation as PreviewRefusal;
  for (const command of preparation) {
    const result = await runPreviewPreparation(command, source.directory, options); observe(result.alive);
    if (!result.ok) return previewRefusal("PREVIEW_START_TIMEOUT");
    if (!previewDependencyLinksContained(source)) return previewRefusal("PREVIEW_START_TIMEOUT");
  }
  return source.verify() ? null : previewRefusal("PREVIEW_START_TIMEOUT");
}
