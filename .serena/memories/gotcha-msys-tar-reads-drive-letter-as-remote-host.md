# `pnpm test:integration` fails in Git Bash and passes in PowerShell

Measured 2026-08-10 on task-9fd52b41. The gate reports a plausible PRODUCTION refusal:

    {"code":"RELEASE_SUPPLY_CHAIN_REFUSED","ok":false,"reason":"SOURCE_ARCHIVE_FAILED",
     "refusedBy":"RELEASE_SUPPLY_CHAIN"}

Nothing about that names a shell, so it reads as a real repo red — and the obvious next move
(bisecting your own diff) is wasted work.

## The actual error, only visible by replicating the spawn
`scripts/release/supply-chain.mjs` swallows stderr into an exit code. Replicating its
`promisify(execFile)` calls by hand prints:

    tar: Cannot connect to C: resolve failed

MSYS/Git **GNU tar** parses `C:\Users\...` as `host:path` (the rmt/remote-archive syntax) and tries
to resolve `C` as a hostname. The script extracts into `mkdtempSync(join(tmpdir(), ...))`, which on
Windows is ALWAYS a drive-letter path, so it can never succeed under that tar.

From PowerShell, `(Get-Command tar).Source` is `C:\Windows\system32\tar.exe` (bsdtar), which handles
drive letters — same commit, same tree, `pnpm test:integration` exits 0 with 41/41.

## Why a manual check can wrongly clear it
Testing `tar -xf /tmp/x.tar -C /tmp/out` by hand in Git Bash SUCCEEDS: POSIX-style paths have no
drive letter, so GNU tar never enters remote-host parsing. The failure only appears with the
Windows-style path Node hands it. Reproduce with the real shape or not at all.

## Rule
Run `pnpm test:integration` (and anything else spawning `tar`) from PowerShell. When a gate that
shells out fails with a generic refusal code, replicate its child-process invocation and read the
real stderr before attributing the red to a diff.

Related: `mem:gotcha-bash-tool-heredoc-on-windows`, `mem:gotcha-pnpm-typecheck-from-a-subdirectory-is-not-repo-wide`.
