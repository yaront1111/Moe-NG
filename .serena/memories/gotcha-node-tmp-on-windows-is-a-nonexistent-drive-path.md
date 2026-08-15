# Node's `/tmp` on Windows resolves to `D:\tmp`, which does not exist

Found 2026-08-11 on task-b6e3dd2a while running mutation drills.

A drill script did its work and then wrote a restore note:

```js
fs.writeFileSync(target, mutated);              // succeeded
fs.writeFileSync("/tmp/drills/bs-restore.json", ...);  // threw
```

```
Error: ENOENT: no such file or directory, open 'D:\tmp\drills\bs-restore.json'
```

Node resolves a POSIX-absolute `/tmp` against the CURRENT DRIVE, so from a repo
on `D:` it becomes `D:\tmp`. Git Bash happily creates and reads `/tmp` (it maps
to the MSYS root), so **the same path works in a Bash tool call and throws in a
`node -e` call.** Mixing the two in one drill harness is what makes this bite.

**Why it is dangerous rather than merely annoying:** the mutation had ALREADY
been written when the script died. The process exited non-zero, which reads like
"the drill did not run", but the file on disk was mutated. Only the
`git hash-object` check caught it. A subsequent drill would have run dirty and
its result would have read as extra coverage.

**How to apply:**
- In `node -e`, never use `/tmp`. Use `os.tmpdir()`, or keep scratch state in the
  shell rather than in Node.
- Order the harness so the LAST thing it does is the risky write, and always
  hash-verify the target after every drill regardless of the script's exit code.
- Never infer "the mutation was not applied" from a non-zero exit.

Related: `mem:gotcha-restore-untracked-mutation-drill-by-byte-compare`,
`mem:gotcha-a-restore-anchor-can-go-ambiguous-after-the-mutation`,
`mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.
