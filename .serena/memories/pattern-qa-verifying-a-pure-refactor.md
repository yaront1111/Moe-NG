# Pattern: how to actually verify a refactor-only task

From QA on task-5a95354855304c24a6af27538ab9e131 (Graph revision reducer decomposition,
commit f406c47). A green suite proves nothing on its own for a refactor — the suite was
green before the change too. Two mechanical checks turn "looks like a move" into proof.

## 1. Byte-containment against the pre-split blob

For each moved declaration, pull it out of the NEW file, strip whatever the move
legitimately added (usually a leading `export `), and test that the remainder is a
substring of `git show <commit>^:<old path>`. Then test the same string is ABSENT from
the post-split file.

```powershell
$old = (git show <sha>^:path/to/old.ts) -join "`n"
$m = [regex]::Match($new, "(?ms)^export function $name\(.*?^\}")
$body = $m.Value -replace '^export ',''
$old.Contains($body)      # verbatim move
$newOld.Contains($body)   # must be false — not duplicated back
```

Containment in the old file plus absence from the new one proves, in one shot, that
nothing was retyped, nothing was dropped, and nothing was silently duplicated. That
single check subsumes reviewing stable error codes, deep-freeze calls, detail payloads,
and type-level exclusions one at a time — they all hold by byte identity.

Then read the diff of the file that KEPT the orchestration and confirm its only changes
are import lines. A refactor whose non-import diff is empty cannot have reordered a
check or changed precedence.

## 2. Mutate to prove the held-out tests still bite

"Existing tests pass unchanged" is only meaningful if those tests would fail on a real
regression in the code that MOVED. Verify the tests are byte-unchanged first
(`git diff <sha>^ HEAD -- <test path>` empty — that is the claim, check it, don't take
it), then break the moved file on purpose:

- replace the first `deepFreeze` with an identity passthrough -> 12 tests failed
- change one stable code string (`ILLEGAL_TRANSITION` -> `UNKNOWN_ERROR`) -> 9 failed

Pick mutations that map onto the DoD items you are signing off. Restore with
`git checkout -- <single owned path>` (safe only if that path was clean first — check),
then confirm `git status --porcelain` is empty and re-run the full suite green before
approving. Leaving a mutation behind in a shared tree would be worse than not checking.

## Cheap structural checks worth keeping in the list

- new module must not import the old one (cycle)
- extracted helpers must not be re-exported from the module or the package root — grep
  for `export {` / `export *` in the keeper and for the new file name in `index.ts`
- count lines with `text -split "\r\n|\r|\n"` so LF/CRLF/CR agree; `wc -l` is Unix-only
  and disagrees on a missing trailing newline

See `mem:gotcha-policy-slice-relaxation` for the complementary lesson on tests that pass
vacuously because a generator never reaches the shape under test.
