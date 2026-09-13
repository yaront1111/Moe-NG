import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import { deliverEnvironment } from "../environment/environment-delivery.js";
import { probeProcessAlive } from "../orchestrator/process-runner-lifecycle.js";
import { killTree, runtimeEnvironment, type PreviewProcessOptions } from "./preview-process.js";

export interface PreviewPreparationResult { readonly ok: boolean; readonly alive: () => boolean }

/** A bounded setup command; output stays private and never becomes a receipt or exception text. */
export async function runPreviewPreparation(
  command: string, workspace: string, options: PreviewProcessOptions,
): Promise<PreviewPreparationResult> {
  const spawn = options.spawn ?? nodeSpawn;
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  let child: ChildProcess;
  try {
    child = spawn(command, [], { cwd: workspace, detached: platform !== "win32", shell: true,
      env: deliverEnvironment(runtimeEnvironment(environment), options.delivered).environment,
      stdio: "ignore", windowsHide: true });
  } catch { return { ok: false, alive: () => false }; }
  const alive = (): boolean => {
    if (child.pid === undefined) return false;
    try { return probeProcessAlive(child.pid); } catch { return true; }
  };
  const completed = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), options.startTimeoutMs ?? 1_800_000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", code => { clearTimeout(timer); resolve(code === 0); });
  });
  if (!completed) {
    const root = Object.entries(environment).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
    await killTree(child, platform, options.killProcessGroup ?? process.kill.bind(process), spawn,
      root !== undefined && win32.isAbsolute(root) ? root : null, options.killGraceMs ?? 5_000);
  }
  return { ok: completed, alive };
}
