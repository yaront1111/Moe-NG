# moe.complete_task verification.command has a 500-character cap

Measured 2026-08-28: `moe.complete_task` rejected the approved step's literal Node eight-leg wrapper with `INVALID_INPUT Invalid verification.command: too long (max 500 chars)`. The wrapper itself had already run fresh and passed.

Safe pattern: architects should prefer a committed verification launcher or an equivalent foreground command whose literal is <=500 characters. Workers must still run the plan's exact command and keep its output on a durable comment; if the evidence field cannot carry it, run a compact semantically equivalent argv-array launcher fresh and submit that exact <=500-character command. Preserve `spawnSync`, argv arrays, default/explicit shell:false, stop on spawn/nonzero failure, real compiler echoes, and nonzero test counts. Do not truncate the field and pretend the truncated string ran.
