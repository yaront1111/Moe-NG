import { captureVerifiedWorkspace } from "./git-verified-workspace-capture.js";
import { commitVerifiedWorkspace } from "./git-verified-workspace-commit.js";
import { failVerifiedGit, verifiedGitRefusal, withVerifiedGit } from "./git-verified-workspace-runtime.js";
import { decodeVerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";
import type { VerifiedWorkspacePort } from "./verified-workspace-contracts.js";

export function createVerifiedWorkspacePort(): VerifiedWorkspacePort {
  return Object.freeze<VerifiedWorkspacePort>({
    async capture(workspace) {
      try { return { ok: true, binding: await withVerifiedGit(workspace, captureVerifiedWorkspace) }; }
      catch (error) { return verifiedGitRefusal(error); }
    },
    async commit(workspace, paths, message, binding) {
      try {
        const decoded = decodeVerifiedWorkspaceBinding(binding);
        if (decoded === null) failVerifiedGit("VERIFIED_WORKSPACE_BINDING_INVALID");
        return { ok: true, receipt: await withVerifiedGit(workspace, (context) => commitVerifiedWorkspace(context, paths, message, decoded)) };
      } catch (error) { return verifiedGitRefusal(error); }
    },
  });
}
