# Benchmark specification hash divergence — resolution record

- **Date:** 2026-08-09
- **Status:** `AWAITING_HUMAN_RATIFICATION`
- **Authority:** none. This note records measurements and an escalation. It does not
  ratify a revision, record a freeze, or upgrade any artifact's authority.
- **Escalation:** general channel message `msg-75308a367d0e4ab5a13b9f3cf6c9a742`.
- **Scope:** creates only this file. The external design and benchmark artifacts in
  `D:/projexts/moes` are read-only under epic rail 1 and were not edited.

## The divergence

The authoritative design pins the benchmark specification at one revision; the only
benchmark artifact that exists on disk is a later one.

| Artifact | Declared revision | SHA-256 |
| --- | --- | --- |
| `moes/docs/plans/2026-08-05-moe-rebuild-design.md` (read-only authority) | — | `1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191` |
| …its pin of the benchmark, design line 12 | Fable **Revision 3** | `F8B84716BFC1FAAB051D698AA9BE353F0D780142D709B7D14496D0B7B65C8885` |
| `moes/docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md` (on disk) | Fable **Revision 4** | `A62B90436CC0B911FB28526AF7B7E0F2D1370F6F93DB91C26077F6E2956A589C` |
| `docs/plans/2026-08-07-fable-fairness-aging-reference.md:14` (this repo) | pins A62 | — |

Measured 2026-08-09 with `Get-FileHash -Algorithm SHA256` on both external files. The
design's own hash equals the epic rail pin exactly, so the design side is unmodified —
the divergence is not local drift or a corrupted checkout.

## What is measurable, and what is not

**Revision 4 is the only benchmark artifact that exists.** Its header declares
`Revision 4`, describes itself as a narrow correction pass that "builds on Revision 3's
design reconciliation", and enumerates the Revision 3 defects it fixes. It is internally
consistent with being the successor.

**Revision 3's bytes are absent.** `grep -rl F8B84716` over `moes/docs` returns exactly
one file — the design that pins it. No copy of the artifact hashing to `F8B8…` exists
anywhere reachable, so the design's pin cannot be verified against anything; it can only
be observed to not match the file that is present.

**No Git lineage proves the transition.** The benchmark file is **untracked** in the
external checkout:

```
$ git -C D:/projexts/moes status --porcelain -- docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md
?? docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md

$ git -C D:/projexts/moes ls-files --error-unmatch docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md
error: pathspec '...' did not match any file(s) known to git
```

So Revision 4 is **current working-tree bytes with no recorded history**, not a committed
successor. Nothing distinguishes it, by evidence available here, from an
in-progress edit. That is the specific reason this note stops at an escalation.

For symmetry, and so this is not read as a claim about the benchmark alone: the design is
untracked in that checkout too. **Neither external document has Git lineage.** The
difference is that the design's bytes are anchored by an independent pin — epic rail 1
names SHA-256 `1D9D1EC9…`, and the file still hashes to exactly that — whereas nothing
outside the benchmark file itself vouches for `A62B…`.

## Why this is structural, not a stale-hash typo

The two documents disagree about whether reciprocal hash pinning should exist at all.

**Revision 4 deliberately dropped it.** Its design-compatibility provenance names the
design it actually reviewed — SHA-256 `5E608D6EFD14488AA3FCE4B4B8AE1C765417636C01CBC747C40C202E820A2507` —
and qualifies it verbatim as "retained only as the predecessor actually reviewed, not as
a requirement that current design bytes still equal it (no reciprocal-hash churn)". It
then states that "final design ↔ benchmark compatibility is bound externally by the
Phase-0 evidence manifest", which records the exact design and benchmark hashes accepted
together at freeze.

**The design still hard-pins one revision.** Line 12 names Revision 3 / `F8B8…` as
normative for comparative-evidence estimators, decision rules, and permitted public
claims.

The consequence: the design's pin goes stale **by construction** on every benchmark
revision, because the benchmark no longer re-pins in the other direction. Re-pointing the
design at `A62B…` would buy one revision of agreement and then diverge again. Note also
that `5E608D6E…` ≠ the current design `1D9D1EC9…`, so the design has itself moved since
the Revision 3 review. Both sides moved; only one side still claims a fixed counterpart.

The binding authority Revision 4 names — the Phase-0 evidence manifest — is **not
recorded**. The repository README states the six-document Phase 0 manifest and the
independent `FREEZE_READY` decision have not been recorded. So the mechanism that is
supposed to resolve this pair does not exist yet, which is why no agent can close it.

## Resolution

`AWAITING_HUMAN_RATIFICATION`. A human must do one of:

1. **Reconcile the design's pin** — update design line 12 to the ratified benchmark
   revision and hash. Requires editing the external read-only design, which no
   implementation task may do.
2. **Ratify the successor in authoritative freeze evidence** — record Revision 4 / `A62B…`
   in the Phase-0 evidence manifest as the benchmark artifact accepted together with the
   design bytes, which is the mechanism Revision 4 itself names.
3. **Confirm Revision 3 is still normative** and produce the `F8B8…` bytes, which are not
   currently on disk.

Choosing between (1) and (2) is a real decision about whether design↔benchmark
compatibility is pinned in the documents or in the manifest. It is recorded here as open
rather than resolved by default.

## Binding until ratified

- **No freeze and no authority upgrade is inferred from these measurements.** Revision 4
  being the only artifact present makes it the only one usable; it does not make it
  normative.
- **`docs/plans/2026-08-07-fable-fairness-aging-reference.md` correctly pins `A62B…`** and
  should not be "corrected" back to `F8B8…`. It pins the only artifact that exists;
  repointing it at absent bytes would make the local note unverifiable.
- **Any comparative or "best tool" claim derived from either revision stays `UNKNOWN`.**
  Neither revision is ratified, so neither confers permitted-public-claim authority. This
  is unchanged by the divergence — the README already makes no comparative claim.
- **Do not edit the external design or benchmark files** to close the gap.
