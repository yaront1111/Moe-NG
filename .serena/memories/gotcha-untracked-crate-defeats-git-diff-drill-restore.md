# `git diff` cannot verify a mutation-drill restore on UNTRACKED files

The standard drill-restore check on this board is:

    git diff -- <path>    # empty => restored

That check is VACUOUS while the files are untracked — a brand-new package,
crate or directory that has not been committed yet. `git diff` only reports
changes to TRACKED content, so on an untracked path it returns empty
**always**: before the drill, during the drill with the mutation still sitting
in the file, and after. It reads as a clean restore in every one of those
states.

Verify the premise before trusting the check:

    git ls-files <path>    # empty => untracked => git diff is blind here

## Use checksums instead

    sha256sum <files> > /tmp/baseline.sha     # BEFORE any drill
    cp -r <src> <tests> "$(mktemp -d)"        # pristine copies OUTSIDE the repo
    ... drill, run, restore from the copies ...
    sha256sum -c /tmp/baseline.sha            # every line must say OK

Keep the pristine copies outside the working tree. Epic rail 5 forbids probe or
scratch files in commits, and a foreign completion hook sweeping the tree can
commit anything left inside it.

**Why it matters:** this fails in the direction of "everything is fine" — the
same family as [[gotcha-hop-count-scan-roots-narrow-silently]] and
`mem:powershell-measure-line-undercounts-blank-lines`. A surviving mutation in
production source plus a restore check that cannot see it is how a drill edit
reaches a commit.

Surfaced on task-a24cb925 (first Rust crate in the monorepo, entirely
untracked until its final commit). The task plan itself specified the
`git diff` check, so this is a trap that survives review — the plan is not
wrong for tracked files, only for new ones.

Related: `mem:mutation-drills-in-shared-worktree` (foreign hook commits your
drill edit, `git status` then lies) — same failure, opposite cause. Together:
neither `git status` nor `git diff` is a sufficient restore check in this repo.
