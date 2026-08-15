# An injected fake port makes every host-module mutation drill vacuous

Found on task-eff945fc (recovery key provider), drill (f), 2026-08-10.

## The shape

Pure logic in `x.ts`, host code in `x.node.ts`, port injected. The pure suite drives every refusal
through a FAKE port, which is exactly right for the pure suite — every branch reachable, no filesystem.

Then the mutation drill says "make the read-back verification a no-op, the UNVERIFIABLE case must
redden". Delete all five verification checks in `x.node.ts` and **nothing goes red**. Every arm asserting
that code was answered by a hand-written fake that still returns the refusal. The production guard was
never under test at all, and the suite reads as full coverage of it.

This is invisible by inspection: the test names say UNVERIFIABLE, the codes are asserted exactly, the
layer is asserted, the sweep is non-vacuous. Only the drill exposes it.

## The fix is a case that reaches the REAL host tool

Needed: an input the apply step ACCEPTS while the read-back disagrees. On win32:

```ts
mkdirSync(join(root, "child"));
const result = await port.protect(join(root, "*"));   // icacls exits 0 after processing the children
expect(result.code).toBe("RECOVERY_KEY_PROTECTION_UNVERIFIABLE");
```

`icacls <dir>\*` applies successfully, but the re-read echoes `<dir>\child`, which does not start with
the requested path, so the parser refuses. That is precisely the property being claimed — *the exit code
does not prove the intended object was protected* — driven end to end through the real tool.

The same input also proves argument-injection safety: a path icacls would reinterpret (a wildcard, or a
leading `/` it parses as an option) fails CLOSED, because the read-back stops echoing the request.

## Generalisation

For every `.node.ts` guard, ask: **which test fails if I delete this line?** If the honest answer is
"one that uses a fake port", the guard is undefended. Find one real input whose host call succeeds and
whose verification must still refuse. Cross-platform, state it rather than skip it:

```ts
if (process.platform !== "win32") {
  expect(EXPECTED_MECHANISM).not.toBe("WIN32_DACL_EXPLICIT_OWNER_ONLY");
  return;
}
```
so the case asserts something on every host instead of silently not being generated.

Related: `mem:gotcha-empty-absent-unreadable-need-three-answers`,
`mem:refusal-test-answered-by-earlier-guard`.
