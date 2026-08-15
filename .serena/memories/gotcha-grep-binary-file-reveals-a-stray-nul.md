# `grep: Binary file ... matches` is a stray NUL in your source

Writing `"\x00"` (or any literal NUL) into a TypeScript string makes the file
BINARY. Nothing in the normal toolchain notices:

- `tsc` is green — a NUL is a legal string character.
- `vitest` is green — the tests pass, the value is just an unusual byte.
- The Read tool and most editors render it as a space.
- `grep -c ''` still counts lines correctly, so a line-cap check passes.

The ONLY cheap signals:
- `grep -n <pattern> file` answers `Binary file <path> matches` instead of the
  matching lines. **Treat that as a defect report, not as grep being unhelpful.**
- Byte count: `python -c "import io,sys; print(io.open(sys.argv[1],'rb').read().count(b'\x00'))" FILE`

Locate it with the raw line:
```python
b = io.open(p, "rb").read(); i = b.find(b"\x00")
print(b[:i].count(b"\n") + 1, repr(b[b.rfind(b"\n",0,i)+1 : b.find(b"\n",i)]))
```

Found live in `apps/daemon/src/recovery/recovery-completion-digest.ts`: the
author intended a single-space marker, wrote `frame("\x00")`, and the module's
OWN header forbade NUL separators because the store's `requireIdentifier`
rejects them. It survived tsc, 22 green tests, and a foreign whole-tree commit.

Sweep every file you authored before committing, not just the one grep flagged.
Related: `mem:written-file-can-carry-a-stray-nul-byte`.
