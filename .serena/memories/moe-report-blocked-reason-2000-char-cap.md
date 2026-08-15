# report_blocked caps `reason` at 2000 chars

`moe.report_blocked` rejects with `[INVALID_INPUT] Invalid reason: too long (N chars). Maximum 2000
characters allowed.` Same cap as `qa_approve`/`qa_reject` summaries (`mem:moe-qa-approve-summary-2000-char-cap`).

The cap is on the **raw string**, and trimming by eye overshoots repeatedly — three attempts at 2994 → 2360
→ 2242 → 2091 → 2003 wasted four round-trips. Do this instead:

1. Post the FULL measured evidence to a chat channel first (`moe.chat_send`, 10KB limit).
2. Put the returned `msg-...` id in the first line of the block reason, then write a ~1800-char summary.

Never paraphrase the measurement down to fit — a block is routed on its evidence, and a governor who cannot
see the exact symbol/line that is missing will re-serve the task to the next architect, who re-measures from
zero. Naming the file, the line and the frozen-vocabulary member is what stops the third attempt at the same
wall.

Related: `mem:moe-complete-task-verification-command-500-char-cap`, `mem:moe-qa-approve-summary-2000-char-cap`.
