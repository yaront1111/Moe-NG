# Gotcha: argv can name the model AND still not prove it

A launch-selection gate that compares `--model`/`--effort` against a frozen
selection proves the REQUEST, not the LAUNCH, if argv also attaches the run to a
prior conversation. A resumed session keeps the transcript's model regardless of
the `--model` on the current command line, so `--print --resume s1 --model X
--effort high` passed the verifier as `ok:true` while the process could launch a
different model entirely.

Measured on task-d23a913f (reopen #2). Fixed with a dedicated code
`CLAUDE_LAUNCH_SESSION_RESUMED` at layer `TELEMETRY_CONFIGURATION`, refused
AHEAD of both arms — a resume defeats model and effort together, so answering
`MODEL_MISMATCH` would name a comparison that is not what went wrong.

**Spellings, from the installed `claude --help` (never invent these):**
`-r, --resume [value]`, `-c, --continue`, `--from-pr [value]` ("Resume a session
linked to a PR"), `--cloud [description|session_id|url]` ("attach to an existing
one by session ID"). `--fork-session` is NOT one — its help says it only works
WITH `--resume`/`--continue`, so refusing it would refuse launches that do start
a fresh session the `--model` applies to.

**Why `--cloud` is refused anyway:** argv cannot tell "create with description"
from "attach by session id". Unprovable stays unproven (epic rail 4).

**How to apply:** match the flag as a WHOLE element or `--flag=value` — never as
a substring, or a prompt containing the word gets refused. Then drill BOTH
directions: neutering the guard must redden the refusals, and widening it to
`includes()` must redden a negative control (`--append-system-prompt "please
--resume the review"`, `--name continue-the-work`). Without the second drill a
blanket-deny guard passes every refusal case.

Related: `mem:gotcha-provider-launch-flags-need-real-cli-precedence-probe`,
`mem:gotcha-late-hostile-input-guard-is-not-a-guard`,
`mem:gotcha-over-narrowed-matcher-passes-every-gate`.
