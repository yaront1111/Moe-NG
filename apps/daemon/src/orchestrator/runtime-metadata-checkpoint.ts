import { isMoeMetadata, TRACKED_RUNTIME_METADATA_DIRTY } from "../repository/git-landing-port.js";
import type { GitLandingPort, GitTrackedCommitPort } from "../repository/git-landing-port.js";

/**
 * The node runtime's self-heal for ONE narrow class of dirt: tracked Moe runtime
 * metadata (`.moe/`, `.moe-next/`) that is already changed when a node is staffed.
 *
 * MEASURED LIVE 2026-09-17: an operator edit to a tracked `.moe-next/start.ps1`
 * made `observe` refuse TRACKED_RUNTIME_METADATA_DIRTY, so no baseline could be
 * recorded, so every `node.deliver` refused BASELINE_UNAVAILABLE and the wrapper
 * retried on a timer for ~5 minutes until a human committed the one path by hand.
 * Owner direction the same day: the node should checkpoint what it needs rather
 * than park behind a human. Epic rail 3 forbids stash/reset, so the answer is a
 * commit by explicit pathspec, under Moe's identity.
 *
 * The commit is `commitTracked` (`commit --only`, no `add` first), never `commit`.
 * Every hosted project excludes `/.moe-next/` in info/exclude, and under that `git
 * add` of a TRACKED path exits 1 while staging it anyway (measured 2026-09-18), so
 * the first cut of this module failed in every live project. `commit --only` never
 * walks the ignored directory and rolls the real index back when it fails: a FAILED
 * checkpoint leaves HEAD and the operator's index exactly as they were.
 *
 * The commit lands in the OPERATOR'S history, so two layers confine it. This module's
 * fence refuses any path that is not Moe runtime metadata or that git could read as
 * naming something else. The fence alone CANNOT confine git: a pathspec is a glob by
 * default, and `src/product[/.moe-next/]ts` passes every segment check yet, as a glob,
 * also matches `src/product.ts`. An earlier cut of this module committed the operator's
 * product file exactly that way (measured 2026-09-18). The defence against globbing is
 * the port: `commitTracked` sends every path as a `:(literal)` pathspec. Afterwards the
 * module proves the dirt is gone rather than assuming it. Ordinary product dirt is not
 * this module's business and never reaches it.
 *
 * KNOWN CEILING, measured 2026-09-18: on a DETACHED HEAD (including mid-rebase) the
 * checkpoint commits onto the detached head, so `git rebase --abort` would discard it
 * along with the operator's metadata edit — recoverable from the reflog, but not from
 * the branch. `GitLandingPort` exposes no pre-commit head read, so refusing that case
 * needs a new port method; until then the case is disclosed rather than guarded.
 */

export const RUNTIME_METADATA_CHECKPOINTED = "RUNTIME_METADATA_CHECKPOINTED" as const;
export const RUNTIME_METADATA_CHECKPOINT_UNKNOWN_PATHS = "RUNTIME_METADATA_CHECKPOINT_UNKNOWN_PATHS" as const;
export const RUNTIME_METADATA_CHECKPOINT_FAILED = "RUNTIME_METADATA_CHECKPOINT_FAILED" as const;
export const RUNTIME_METADATA_CHECKPOINT_INEFFECTIVE = "RUNTIME_METADATA_CHECKPOINT_INEFFECTIVE" as const;

export type RuntimeMetadataCheckpointOutcome =
  | typeof RUNTIME_METADATA_CHECKPOINTED
  | typeof RUNTIME_METADATA_CHECKPOINT_FAILED
  | typeof RUNTIME_METADATA_CHECKPOINT_INEFFECTIVE
  | typeof RUNTIME_METADATA_CHECKPOINT_UNKNOWN_PATHS;

export interface RuntimeMetadataCheckpointRequest {
  /** Only `commitTracked` and `observe` are used; the lander already holds the whole port. */
  readonly git: GitTrackedCommitPort & Pick<GitLandingPort, "observe">;
  readonly nodeRef: string;
  /** Exactly the dirty set `observe` reported, root-relative, forward-slashed. */
  readonly paths: readonly string[];
  readonly workspace: string;
}

export interface RuntimeMetadataCheckpointReport {
  readonly detail: string;
  readonly ok: boolean;
  readonly outcome: RuntimeMetadataCheckpointOutcome;
}

const DETAIL_PATHS = 4;

const shown = (paths: readonly string[]): string =>
  JSON.stringify(paths.slice(0, DETAIL_PATHS).map((path) => path.slice(0, 120))).slice(0, 350);

/**
 * THE SCOPE FENCE, enforced in production rather than trusted from the caller.
 *
 * `isMoeMetadata` is imported from the port, never reimplemented, so the fence and
 * the observer that produced these paths can never disagree about what counts.
 * The rest are ways a path that CONTAINS a `.moe-next` segment names something else
 * once git reads it as a pathspec, each measured committing product code (2026-09-18):
 * a `..` segment (`.moe-next/../src/app.ts`), a `\` (Git for Windows reads it as a
 * separator, so `.moe-next/..\src\app.ts` is a traversal too), a leading `:` (pathspec
 * magic: `:!x/.moe-next/y` excludes one path and so means the whole tree), and a NUL
 * (the port NUL-delimits pathspecs, so one path becomes two; here git happens to refuse
 * it only because this message lists the paths). An absolute path is not a root-relative
 * pathspec at all. On Windows the observer never reports any of these; a POSIX file name
 * that legally holds a `\` or a leading `:` is refused too, with this distinct code,
 * rather than trusted to git's pathspec parser.
 *
 * GLOBS PASS THIS FENCE. A `.moe-next` segment inside a bracket (`keep[/.moe-next/]txt`,
 * a legal tracked name that observe reports as metadata) satisfies every clause here, and
 * as a glob it matches `keep.txt`. Confinement against `[`, `*` and `?` is the port's
 * `:(literal)` pathspecs, not this function. The other clauses stay even so: Git for
 * Windows still resolves `.moe-next/..\src\app.ts` to `src/app.ts` under literal pathspecs
 * (measured 2026-09-18), a NUL still splits one path in two and only the first half would
 * carry `:(literal)`, and a leading `:` is refused here rather than left to the port.
 */
function isConfinedMetadata(path: string): boolean {
  if (/[\0\\]/u.test(path) || path.startsWith(":") || path.startsWith("/") || /^[a-z]:/iu.test(path)) return false;
  return !path.split("/").includes("..") && isMoeMetadata(path);
}

/**
 * Checkpoint dirty tracked runtime metadata so a node can be staffed, or refuse
 * with a distinct reason code. Never throws for a git failure; never touches a
 * path outside the metadata classification; never stashes or resets.
 */
export async function checkpointRuntimeMetadata(
  request: RuntimeMetadataCheckpointRequest,
): Promise<RuntimeMetadataCheckpointReport> {
  const { git, nodeRef, paths, workspace } = request;
  const foreign = paths.filter((path) => !isConfinedMetadata(path));
  if (paths.length === 0 || foreign.length > 0) {
    return {
      detail: paths.length === 0
        ? "no dirty runtime metadata paths were supplied, so there is nothing to checkpoint"
        : `${String(foreign.length)} of ${String(paths.length)} path(s) are not Moe runtime metadata: ${shown(foreign)}. Only .moe/ and .moe-next/ paths may be checkpointed; product changes stay the operator's.`,
      ok: false,
      outcome: RUNTIME_METADATA_CHECKPOINT_UNKNOWN_PATHS,
    };
  }
  // Plain words and the node's name: this commit is read in the operator's own log
  // and must be self-explaining and revertable with one `git revert`.
  const message = `chore(moe): checkpoint runtime metadata before staffing ${nodeRef}\n\n`
    + `These ${String(paths.length)} Moe runtime metadata file(s) were already changed when ${nodeRef} was staffed:\n`
    + `${paths.map((path) => `  ${path}`).join("\n")}\n\n`
    + "A node cannot record a landing baseline while tracked runtime metadata is dirty, so Moe\n"
    + "checkpointed these files itself instead of waiting for a human. Only .moe/ and .moe-next/\n"
    + "paths are ever checkpointed this way; product changes are left untouched. Safe to revert.\n";
  const committed = await git.commitTracked(workspace, paths, message);
  if (!committed.ok) {
    return {
      detail: `git could not commit ${String(paths.length)} runtime metadata path(s) ${shown(paths)}: ${committed.detail}`,
      ok: false,
      outcome: RUNTIME_METADATA_CHECKPOINT_FAILED,
    };
  }
  // Proven, not assumed. A commit that returned 0 while leaving the class dirty would
  // send the caller straight back into the retry loop this module exists to end, so an
  // unprovable outcome is reported as ineffective rather than claimed as success.
  const observed = await git.observe(workspace);
  if (!observed.ok) {
    return {
      detail: observed.code === TRACKED_RUNTIME_METADATA_DIRTY
        ? `committed ${committed.receipt.sha} but tracked runtime metadata is still dirty: ${observed.detail}`
        : `committed ${committed.receipt.sha} but the checkpoint could not be confirmed (${observed.code}): ${observed.detail}`,
      ok: false,
      outcome: RUNTIME_METADATA_CHECKPOINT_INEFFECTIVE,
    };
  }
  return {
    detail: `checkpointed ${String(paths.length)} runtime metadata path(s) ${shown(paths)} as ${committed.receipt.sha} on ${committed.receipt.branch}`,
    ok: true,
    outcome: RUNTIME_METADATA_CHECKPOINTED,
  };
}
