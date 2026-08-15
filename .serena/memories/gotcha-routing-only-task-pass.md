# Gotcha: the "routing-only" task pass — reopened purely to reach a legal transition

Moe has no BLOCKED -> REVIEW transition. When a human approves an exception that unblocks a
task whose work is **already landed and already QA-verified**, the governor must route it
BLOCKED -> PLANNING -> WORKING -> REVIEW. That reopen is *not* a request to redo the work.

Observed on `task-1ade51c0dc104181a67adde741295fd5` (2026-08-07): human approved a one-time
historical size exception for commit `bcdc2f6`; the reopenReason said in capitals not to
re-plan or re-implement. Architect submitted a 2-step evidence-only plan; worker authored
zero bytes.

## How to recognise one

- `reopenCount > 0` **and** the reopenReason says the implementation is landed/verified.
- `rejectionDetails` items are mostly marked PASS with `file:line`, with exactly one blocking
  item that a rail proposal now covers.
- The plan's steps say "ZERO code changes" / "confirm" / "run the gate".

## How to execute it

1. Prove the landed state is intact — do not take the reopenReason's word for it:
   `git merge-base --is-ancestor <sha> HEAD` (exit 0) and an EMPTY
   `git status --porcelain -- <owned subtree>` plus EMPTY `git diff` on owned paths.
2. Run the plan's named verification FRESH anyway. `complete_task` hard-rejects a non-zero
   exit code, and a stale pass from the previous session is not evidence.
3. Re-read the claimed DoD `file:line` sites cold. QA's prior PASS is a strong prior, not
   proof, and re-reading costs seconds. (Reading is allowed; the ban is on *rewriting*.)
4. **Do not commit.** Zero modified bytes means no pathspec commit — and under the shared-tree
   rail a bare commit would capture a sibling's staged files.
5. `adversarial-self-review` degenerates to nothing when `git diff` is empty; say so in the
   step note rather than silently skipping the skill.
6. In the completion summary, state the exception id and that it is **scoped to that one
   commit**, so QA does not re-reject on the excepted issue and does not read the exception as
   repealing the permanent rule.

## The trap

The strongest pull is to "improve" the landed code while you are in there — split a long file,
tidy a helper. That perturbs work other in-flight children depend on and re-opens a settled
review. Zero bytes means zero.

See `mem:gotcha-core-aggregate-loc-bar`, `mem:gotcha-shared-tree-repo-gate`.
