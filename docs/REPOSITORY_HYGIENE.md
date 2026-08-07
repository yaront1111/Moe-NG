# Repository hygiene policy

Scope: the repository-root `.moe/` directory, which mixes **durable project
metadata** with **regenerable daemon scaffolding**. This document defines the
boundary between the two and the only approved procedure for removing
regenerable bytes.

This policy is descriptive and preventive. **Applying it performed no cleanup
and deleted nothing.** It added ignore rules and this file.

## Why the boundary needs writing down

No source in `moe-next` writes `.moe/`. A search for the runtime path names
(`activity.log`, `daemon.lock`, `workers`, `teams`, `proposals`, …) across every
`.ts`/`.js` file in the repository returns zero matches. The producer is the
external transitional Moe daemon.

Two consequences follow, and they drive every rule below:

1. **Future leaf names cannot be predicted from this repository.** A blanket
   `.moe/` or `.moe/**` ignore rule would silently hide any new record class the
   daemon starts writing — including a durable one. That is a fail-open design.
2. **The classification below is the only authority.** It cannot be re-derived
   from code, so it must be maintained by hand when the daemon changes.

## Classification

### Durable — tracked, committed, never ignored

These are project and control records. Losing them loses work.

| Path | Contents |
| --- | --- |
| `.moe/project.json` | Project identity, rails, settings |
| `.moe/epics/` | Epic definitions, rails, architecture notes |
| `.moe/tasks/` | Task records: plans, steps, DoD, verification evidence |
| `.moe/channels/` | Channel definitions |
| `.moe/messages/` | Channel history (`.jsonl`) |
| `.moe/roles/` | Role definitions and prompts |
| `.moe/agents/` | Agent definitions |
| `.moe/skills/` | Skill bundles |

### Regenerable — ignored, safe to delete when the daemon is stopped

These are rebuilt by the daemon on restart. Losing them loses nothing durable.

| Path | Contents |
| --- | --- |
| `.moe/daemon.json` | Live daemon process state |
| `.moe/daemon.lock` | Single-instance lock |
| `.moe/activity.log`, `.moe/activity.log.*` | Activity log and its rotations |
| `.moe/workers/` | Ephemeral worker registrations |
| `.moe/teams/` | Ephemeral team membership |
| `.moe/proposals/` | Transient rail proposals |
| `.moe/sessions/` | Session scaffolding |
| `.moe/cache/` | Derived cache |
| `.moe/debug/` | Debug output |
| `.moe/tmp/`, `.moe/scratch/` | Temporary and scratch output |

One entry is provisional. `.moe/sessions/` is classified regenerable because
today it holds transitional-daemon scaffolding, but this epic also plans a
durable **session coordination fabric**. If that fabric ever persists records
under `.moe/sessions/` rather than in the store, this rule would hide them —
re-check this row before that work lands, and move it to the durable table if
the contents become authoritative.

### Unclassified — treat as durable

Anything under `.moe/` not named above is **not** ignored and **must not be
deleted**. It will appear in `git status` as untracked. That noise is
deliberate: it is the signal that a human needs to classify a new category and
update both this table and `.gitignore`. Never silence it with a broad rule.

## How the rules are written

The ignore block lives in the root `.gitignore`. Two properties are
load-bearing:

- **Root-anchored.** Every pattern starts with `/`, so `/.moe/cache/` binds only
  to the repository-root `.moe/`. Without the anchor it would also match
  `packages/testkit/fixtures/.moe/cache/` and could hide evidence fixtures.
- **Leaf-by-leaf.** Individual paths are named; no blanket rule is used.

`.moe/.gitignore` separately ignores `daemon.json`, `daemon.lock`, `workers/`,
`teams/`, and `proposals/`. As the deeper file it takes precedence for those
five. The root rules duplicate them on purpose, so the whole boundary is
readable in one place and survives if the nested file is removed.

## Ignoring is not deleting, and not untracking

Three distinct states, routinely confused:

| State | Meaning |
| --- | --- |
| **Ignored** | Git will not offer to add it. Says nothing about the file existing or being tracked. |
| **Tracked** | Already in the index. **An ignore rule has no effect on it** — it keeps showing modifications forever. |
| **Deleted** | Bytes removed from disk. No ignore rule ever does this. |

If a file is already tracked, adding an ignore rule does nothing. Untracking it
requires `git rm --cached -- <path>`, which is a deliberate change to repository
contents and **out of scope for this policy** — raise it as its own task.

## Prohibited

- **`git clean` in any broad form** — `-x`, `-X`, `-d`, or `.moe` as the target.
  It cannot distinguish a durable untracked record from scratch output.
- **Recursive deletion of `.moe/`** or of any directory in the durable table.
- **Deleting anything while the daemon or any agent session is running.** Live
  workers, sessions, leases, and locks are held open; removing them mid-flight
  corrupts fleet state rather than cleaning it.
- **Hand-editing task, epic, channel, message, role, agent, or skill JSON.**
  These are daemon-owned. Mutate them only through the supported Moe tools —
  a hand edit can desynchronise task state from message history with no error.
- **Deleting any path not named in the regenerable table**, including anything
  you believe is obviously junk.

## Approved cleanup procedure

Fail-closed: every step either proves a path is regenerable or stops. If any
step surprises you, **stop and escalate** rather than continuing.

1. **Stop the fleet through supported controls.** Let in-flight tasks reach a
   terminal state; do not kill processes to force a window. Confirm no agent
   session is live before touching disk.
2. **List candidates.**
   ```
   git status --short --ignored -- .moe
   ```
   `!!` rows are ignored, `??` rows are untracked-but-visible. **`??` rows are
   never cleanup candidates** — they are unclassified, which means durable
   until a human says otherwise.
3. **Confirm each candidate individually.**
   ```
   git check-ignore -v -- .moe/<leaf>
   ```
   Proceed only if this prints a rule that matches an entry in the regenerable
   table. No output means not ignored — stop.

   Note the trap: with `-v`, `git check-ignore` also exits `0` for a **negation**
   match and prints the rule with a leading `!`. Read the printed rule; do not
   branch on the exit code alone.
4. **Verify it is not tracked.**
   ```
   git ls-files --error-unmatch -- .moe/<leaf>
   ```
   Success means the path **is** tracked — stop, deleting it is a repository
   change, not cleanup.
5. **Dry-run, then delete one leaf at a time.** Name the exact path. Never a
   glob, never a parent directory, never two leaves in one command.
6. **Restart and verify health.** Confirm the daemon comes up, the project
   loads, and epics/tasks/messages are intact. Then repeat from step 2 for the
   next leaf.

Stop and escalate on: any path not in the regenerable table; any tracked
candidate; a symlink (`.moe` or a leaf resolving outside the repository — follow
it and inspect the target before any deletion, as removal follows the link); a
running daemon that will not stop cleanly; or a durable directory that looks
empty or truncated after restart.

## Windows notes

Patterns use forward slashes, which are Git-native and behave identically on
Windows, macOS, and Linux — do not rewrite them with backslashes.

On Windows, Git is typically configured with `core.ignorecase=true`, so
`.moe/Cache/` and `.moe/cache/` match the same rule. Do not rely on case to
distinguish two categories; on Linux they are different paths.
