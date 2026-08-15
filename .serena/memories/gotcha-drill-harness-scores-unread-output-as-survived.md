# A mutation drill that cannot read its own output reports every mutant SURVIVED

Observed 2026-08-09 on task-2d1f94f91da24. A Python drill driver ran 22 mutants and
printed `SURVIVED` for **all 22**. Nothing had actually been measured.

## What happened

`subprocess.run(..., text=True)` on Windows decodes with cp1252. Vitest prints
box-drawing characters, so every capture raised
`UnicodeDecodeError: 'charmap' codec can't decode byte 0x9d`. The summary parser then
returned `"?"` for the pass/fail lines, and the verdict line was:

```python
red = ("failed" in f) or ("failed" in t)     # f == t == "?"  ->  False
results.append((name, "KILLED" if red else "SURVIVED", f, t))
```

`False` means "no failures found" means SURVIVED. **A harness that cannot read the result
defaults to the most alarming possible verdict, which reads as a real finding.** The
inverse is worse: the same bug with the polarity flipped prints KILLED for everything and
certifies an untested suite.

## Fix, both halves

```python
p = subprocess.run(cmd, cwd=cwd, capture_output=True, shell=True)   # bytes, no text=True
out = ((p.stdout or b"") + (p.stderr or b"")).decode("utf-8", errors="replace")
...
if f == "?" or t == "?": red = None                                  # third state
results.append((name, "UNREADABLE" if red is None else ("KILLED" if red else "SURVIVED"), f, t))
```

Never let unparsed output collapse into a boolean. Add an explicit `UNREADABLE` verdict so
a broken run is visibly broken instead of silently scored.

## The companion guard

Assert the mutation anchor occurs **exactly once** before editing, and abort otherwise:

```python
if src.count(old) != 1:
    results.append((name, "ABORT", f"anchor found {n} times, not 1", "")); continue
```

A mis-anchored edit writes an unchanged file, the suite stays green, and the mutant reads
as SURVIVED. Same failure shape as the decode bug — see
`mem:gotcha-perl-delimiter-choice-silently-voids-a-drill` and
`mem:gotcha-perl-brace-delimiter-fakes-a-surviving-mutant`, which are the perl-flavoured
version of this.

## How to notice

**Every mutant surviving is not a finding, it is a broken harness.** Real suites kill
most mutants. If the whole board comes back one colour, distrust the instrument before
the code. Sanity-check by reading one raw run's output by hand.

Path note for Windows: `cat > /tmp/x.py` in Git Bash and `python /tmp/x.py` agree, because
Git Bash rewrites POSIX paths in ARGUMENTS. A path written inside a heredoc body is NOT
rewritten, so `io.open("/tmp/x.py")` from a `python - <<EOF` heredoc raises
`FileNotFoundError`. Patch such files with `sed` from bash, not from inside Python.
