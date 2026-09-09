import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { VERIFIED_WORKSPACE_VERSION } from "./verified-workspace-contracts.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";
import { failVerifiedGit, gitHead, objectId, verifiedGit } from "./git-verified-workspace-runtime.js";
import type { VerifiedGitContext } from "./git-verified-workspace-runtime.js";

interface TreeEntry { readonly mode: string; readonly oid: string; readonly path: string }
export function parseVerifiedTree(output: string): readonly TreeEntry[] {
  return output.split("\0").filter(Boolean).map((entry) => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([\s\S]+)$/u.exec(entry);
    if (match === null) return failVerifiedGit("VERIFIED_WORKSPACE_UNKNOWN");
    if (match[1] === "160000") failVerifiedGit("VERIFIED_WORKSPACE_SUBMODULE_UNSUPPORTED");
    return { mode: match[1] as string, oid: match[3] as string, path: match[4] as string };
  });
}

async function rejectFilters(context: VerifiedGitContext, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const output = await verifiedGit(context, ["check-attr", "-z", "--stdin", "filter"], undefined, `${paths.join("\0")}\0`);
  const fields = output.split("\0"); fields.pop();
  if (fields.length !== paths.length * 3) failVerifiedGit("VERIFIED_WORKSPACE_UNKNOWN");
  for (let i = 2; i < fields.length; i += 3) {
    if (fields[i] !== "unspecified" && fields[i] !== "unset") failVerifiedGit("VERIFIED_WORKSPACE_FILTER_UNSUPPORTED");
  }
}

/** Raw dirty bytes accompany the canonical Git tree; these are working-copy tests, not a hermetic checkout. */
function dirtyDigest(context: VerifiedGitContext, status: string, entries: readonly TreeEntry[]): string {
  const tree = new Map(entries.map((entry) => [entry.path, entry]));
  const dirty = status.split("\0").filter(Boolean).map((record) => {
    if (record.length < 4) return failVerifiedGit("VERIFIED_WORKSPACE_UNKNOWN");
    const path = record.slice(3); const entry = tree.get(path);
    let rawSha256: string | null = null;
    if (entry !== undefined) {
      const absolute = join(context.root, path); const stat = lstatSync(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) failVerifiedGit("VERIFIED_WORKSPACE_UNKNOWN");
      const bytes = stat.isSymbolicLink() ? readlinkSync(absolute, { encoding: "buffer" }) : readFileSync(absolute);
      rawSha256 = createHash("sha256").update(bytes).digest("hex");
    }
    return { path, kind: record.startsWith("??") ? "UNTRACKED" : "TRACKED", mode: entry?.mode ?? "DELETED", oid: entry?.oid ?? "DELETED", rawSha256 };
  }).toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(dirty)).digest("hex");
}

export async function captureVerifiedWorkspace(context: VerifiedGitContext): Promise<VerifiedWorkspaceBinding> {
  if ((await verifiedGit(context, ["rev-parse", "--show-ref-format"])).replace(/\r?\n$/u, "") !== "files") {
    failVerifiedGit("VERIFIED_WORKSPACE_REF_BACKEND_UNSUPPORTED");
  }
  const head = await gitHead(context);
  // Include tracked metadata and every nonignored untracked file. A partial scope cannot claim the complete tree.
  const names = (await verifiedGit(context, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  await rejectFilters(context, [...new Set(names)]);
  await verifiedGit(context, head.headSha === null ? ["read-tree", "--empty"] : ["read-tree", head.headSha], context.index);
  await verifiedGit(context, ["add", "--all", "--", "."], context.index);
  const treeSha = (await verifiedGit(context, ["write-tree"], context.index)).trim();
  if (!objectId(treeSha)) failVerifiedGit("VERIFIED_WORKSPACE_UNKNOWN");
  const entries = parseVerifiedTree(await verifiedGit(context, ["ls-tree", "-r", "-z", "--full-tree", treeSha]));
  const status = await verifiedGit(context, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  const dirtySha256 = dirtyDigest(context, status, entries);
  const finalHead = await gitHead(context);
  if (head.headSha !== finalHead.headSha || head.branchRef !== finalHead.branchRef) failVerifiedGit("VERIFIED_WORKSPACE_DRIFT");
  return Object.freeze({ version: VERIFIED_WORKSPACE_VERSION, root: context.root, ...head, treeSha, dirtySha256 });
}
