import { sameVerifiedWorkspace } from "../repository/verified-workspace-contracts.js";
import type { VerifiedWorkspaceBinding, VerifiedWorkspacePort, VerifiedWorkspaceRefusal } from "../repository/verified-workspace-contracts.js";
import type { NodeMission } from "./agent-wrapper.js";
import type { VerifierRunCapture } from "./node-verifier.js";

type CapturePort = Pick<VerifiedWorkspacePort, "capture"> | undefined;
const refusal = (code: string, detail: string): VerifiedWorkspaceRefusal => ({ code, detail, ok: false });

export async function checkVerifiedWorkspace(
  brief: NodeMission, binding: VerifiedWorkspaceBinding | undefined, port: CapturePort,
): Promise<VerifiedWorkspaceRefusal | null> {
  if (port === undefined) return refusal("VERIFIER_WORKSPACE_UNCONFIGURED", "workspace capture port unavailable");
  if (binding === undefined) return refusal("VERIFIER_WORKSPACE_BINDING_MISSING", "legacy receipt has no tested workspace binding");
  const current = await port.capture(brief.workspace);
  if (!current.ok) return current;
  return sameVerifiedWorkspace(binding, current.binding) ? null
    : refusal("VERIFIER_WORKSPACE_CHANGED", "workspace changed after verification");
}

export async function runBoundVerification(
  brief: NodeMission, runTest: (brief: NodeMission) => Promise<VerifierRunCapture>, port: CapturePort,
): Promise<{ readonly ok: true; readonly capture: VerifierRunCapture; readonly binding: VerifiedWorkspaceBinding } | VerifiedWorkspaceRefusal> {
  if (port === undefined) return refusal("VERIFIER_WORKSPACE_UNCONFIGURED", "workspace capture port unavailable");
  const before = await port.capture(brief.workspace);
  if (!before.ok) return before;
  const capture = await runTest(brief);
  const after = await port.capture(brief.workspace);
  if (!after.ok) return after;
  if (!sameVerifiedWorkspace(before.binding, after.binding)) return refusal("VERIFIER_WORKSPACE_CHANGED", "workspace changed during verification");
  return { binding: before.binding, capture, ok: true };
}
