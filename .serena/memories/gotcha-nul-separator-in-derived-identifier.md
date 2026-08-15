# A NUL framing separator makes every store call refuse

Building a derived aggregate/entity id, a raw `\0` is the tempting delimiter — it cannot appear in
human text, so it reads like the safest separator available. It is not.

`packages/store/src/store-input-primitives.ts:24` `requireIdentifier` rejects
`value.includes("\0")` outright. Any id carrying one is refused with `STORE_INPUT_INVALID` at the
store boundary, so **every** commit/read using that id fails.

## Why it survives the whole test pyramid

- **tsc is green.** A NUL inside a template literal is a legal string.
- **A pure injectivity/round-trip suite is green.** NUL-separated ids are still perfectly
  *distinct*, so a collision table over `('a','bc')` vs `('ab','c')` passes. The separator was
  never what carried injectivity — the length prefixes were.
- **`Read`/editor shows a space.** Only `file` (reports `data`, not `UTF-8 text`) and `grep`
  (reports `Binary file … matches`) reveal it. `cat -v` renders it `^@`.
- `grep -qP '\x00'` did **not** detect it here; `tr -dc '\000' < f | wc -c` and `xxd` did.

Only a **real** file-backed store catches this. A fake/in-memory double has no `requireIdentifier`,
so it accepts the id and the suite proves only that the shapes line up. This is the concrete
argument for the "no fake store" rule in durable-persistence tasks.

## Second trap: the refusal map hides it

Mapping `STORE_INPUT_INVALID` / `STORE_LIMIT_EXCEEDED` onto an availability code
(`…_STORE_UNAVAILABLE`) makes the diagnosis much harder — the store is healthy and rejecting a
malformed input, while the adapter reports it as unavailable and tells callers to retry something
that can never succeed. Give input faults their own code and preserve the store's code verbatim.
The real cause was only visible in the stack trace (`requireIdentifier`), not in the refusal.

## Rule

Use a printable ASCII separator (`|`). Let **length prefixes** carry injectivity; the separator is
readability only. After writing any source with a non-obvious literal, run
`file <path>` — anything but `UTF-8 text` means a stray byte landed.

Related: `mem:written-file-can-carry-a-stray-nul-byte`
