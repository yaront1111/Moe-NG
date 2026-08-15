# The benchmark/design hash divergence is structural — do not "fix" it with a hash bump

Recorded 2026-08-09 by `task-51d05520`. Full record:
`docs/plans/2026-08-09-benchmark-spec-hash-resolution.md`, status
`AWAITING_HUMAN_RATIFICATION`. Escalation `msg-75308a367d0e4ab5a13b9f3cf6c9a742`.

## The measurement

| Artifact | Revision | SHA-256 |
| --- | --- | --- |
| external design (read-only) | — | `1D9D1EC9…83191` (equals epic rail 1 pin) |
| …its pin of the benchmark, design line 12 | **Rev 3** | `F8B84716…C8885` |
| external benchmark on disk | **Rev 4** | `A62B9043…A589C` |
| `docs/plans/2026-08-07-fable-fairness-aging-reference.md:14` | pins A62 | — |

## Why it is not a stale-hash typo

**Revision 4 deliberately dropped reciprocal pinning.** Its header names the design it
reviewed (`5E608D6E…`) and qualifies it verbatim as "retained only as the predecessor
actually reviewed, not as a requirement that current design bytes still equal it (no
reciprocal-hash churn)", then defers final compatibility to the **Phase-0 evidence
manifest**. The design still hard-pins one benchmark revision. So the design's pin goes
stale BY CONSTRUCTION on every benchmark revision — repointing it at A62 buys one revision
of agreement and then diverges again. Also `5E608D6E` != current `1D9D1EC9`: both sides
moved; only one still claims a fixed counterpart. And the manifest that is supposed to
bind them **is not recorded**, so the resolving mechanism does not exist yet.

## Three traps for the next agent

1. **Do not repoint the fairness reference back to F8.** `grep -rl F8B84716` over
   `moes/docs` returns exactly one file — the design that pins it. **Revision 3's bytes
   exist nowhere.** A62 is the only artifact that exists, so pinning F8 would make the
   local note unverifiable rather than correct.
2. **Do not treat A62 as frozen or normative.** Both external documents are UNTRACKED in
   that checkout — neither has Git lineage. The design's authority comes from the epic
   rail hash pin, not from git; nothing outside the benchmark file vouches for A62. This
   is the "converting measured working-tree bytes into authority" trap the governor named
   at 14:43. Being the only artifact present makes it the only one usable, not normative.
3. **Do not edit the external design or benchmark.** Epic rail 1, and they live outside
   the repo at `D:/projexts/moes`.

Any comparative or "best tool" claim from either revision stays `UNKNOWN` until a human
ratifies. Related: `mem:pattern-a-pinned-value-is-only-a-decision-if-another-was-representable`.
