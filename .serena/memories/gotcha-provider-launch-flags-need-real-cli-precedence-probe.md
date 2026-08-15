# Gotcha: verify provider CLI flags and precedence against the real provider

A green pure parser suite can certify an invented CLI.

On task-d23a913f0586431d9dccc0cfd1f66fd5, production froze `--reasoning-effort` and all fixtures/tests used that same constant. Current `claude --help` and Anthropic's official CLI reference name `--effort`. The production verifier therefore rejected provider-correct argv and accepted the invented spelling.

Two mandatory probes for launch-selection work:
1. Run the installed provider's `--help` and compare each frozen flag literally; use official provider docs as a second primary source.
2. Measure precedence, not only spelling. Claude's `CLAUDE_CODE_EFFORT_LEVEL` environment variable overrides the CLI effort flag, so a verifier that checks argv but forwards an unchecked conflicting environment still proves the wrong actual launch.

Tests derived from the production constant cannot discover that the constant itself is wrong. Hand-spell one provider-correct argv positive control, and one known-override negative control, against the production launcher.