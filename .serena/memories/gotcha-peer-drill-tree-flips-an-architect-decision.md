# A peer's mid-drill working tree can flip an ARCHITECT's decision, not just redden a gate

Known shared-worktree hazards (`mem:peer-write-during-test-run-fakes-a-red`,
`mem:mutations-drills-in-shared-worktree`) are framed as *test-time* problems: a peer's write makes
your suite go red for a reason you did not cause. This is the **planning-time** form, and it is
worse, because it produces no error at all — just a confident plan built on a false premise.

## What happened (task-6f58ca42, architect)

The task was a genuine either/or: WIRE an unused accessor, or REMOVE it. The premise deciding it
was whether the MCP adapter already releases daemon-side session bindings at `close()`.

`cat packages/mcp/src/http/http-shutdown.ts` showed the sweep open-coding
`registry.delete(entry.sessionId)` and **never** calling `port.closeSession` — with a docstring two
lines above loudly claiming "THE DAEMON RELEASE GOES THROUGH `closeDaemonSession` AND NOT AROUND
IT." That reads exactly like a real, freshly-discovered defect: comment asserts an obligation, code
does not discharge it. It is also the *same defect shape the task was about*, which made it feel
like a confirming find rather than an anomaly.

Re-reading the same file minutes later showed `closeDaemonSession(registry, port, entry.sessionId)`
at :104 and a different mutation at :113 (`failedSessionIds.length < 0` — a dead guard). Two
different bytes, one session, no commit between. A peer was walking mutations through the file.

`git show HEAD:<path>` was stable and correct throughout: the adapter DOES release.

Had the working tree been trusted, the plan would have chosen WIRE on a premise that was never
true — and the wiring would have been a **double release**, which the task's own rails forbid.

## The tell

An unused import or a docstring contradicting the code three lines below it, in a file **outside
your task's scope**, that you did not expect to find. A landed commit rarely ships that; a drill in
flight does, constantly. Surprise convenience is the signal — the "defect" arrived exactly when it
was decision-relevant.

## Rule

When a plan's premise depends on code **outside the task's owned paths**, read it with
`git show HEAD:<path>`, never `cat` / Read / a plain grep of the tree. Working-tree bytes in a
foreign package are a peer's scratch state, not evidence, and nothing warns you.

Corollaries:
- Record the premise in `planningNotes.codebaseInsights` **as the `git show` command**, so a worker
  or QA re-measuring reproduces the committed bytes rather than whatever the tree holds then.
- One read is not a measurement in a shared worktree. A second read of a surprising find is cheap;
  it is what separated a correct plan from an inverted one here.
- `git diff` / `git status` do NOT flag this — the peer's file may be tracked and modified, but you
  are not looking at status, you are looking at content, and content is what lied.

Related: `mem:head-moves-mid-verification`, `mem:foreign-commit-can-revert-your-landed-deliverable`,
`mem:gotcha-repo-wide-red-attributed-by-untracked-peer-files`.
