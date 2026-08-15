# A pointer from `Vec::as_ptr` used as an FFI WRITE destination is UB, and no test can see it

Found by QA on task-885a46e9 (Win32 Job/process crate), 2026-08-09, in code that
was otherwise flawless: 7/7 DoD items met, 19/19 green, four mutation drills all
biting.

## The trap

```rust
fn as_ptr(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
    self.buffer.as_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST   // <- *const, from &self
}
...
fn set_job_list(list: &mut OwnedAttributeList, ...) {
    let target = list.as_ptr();                 // &mut reborrowed as SHARED
    unsafe { UpdateProcThreadAttribute(target, ...) };   // <- WRITES through it
}
```

`Vec::as_ptr`'s contract: *"the memory the pointer points to is never written to
using this pointer or any pointer derived from it. If you need to mutate ... use
`as_mut_ptr`."* Writing through it is UB under Stacked/Tree Borrows, and for a
`Freeze` element type LLVM is entitled to `noalias`/`readonly` reasoning across
the opaque FFI call.

The caller already had `&mut`. Nothing forced the shared reborrow; the accessor
signature silently downgraded it.

## Why it survives every gate

Injected-call-table suites are structurally blind to it — the test double
dereferences nothing, so the real impl is only ever COMPILED, never executed.
It survives clippy, the release build, and any number of mutation drills.
Only reading the code, or Miri on a non-FFI reduction, finds it.

## What to check, in any unsafe FFI boundary

For each raw pointer handed across: does the callee WRITE through it? If yes,
its provenance must come from `&mut` / `as_mut_ptr`. Grep for the asymmetry —
here `initialize()` and `delete()` already used `as_mut_ptr` correctly while the
two `Update*` sites did not, and that inconsistency inside one file is the
cheapest tell.

Do NOT over-correct: a `*mut`-typed parameter the OS only READS (here
`CreateProcessW`'s `lpAttributeList`, and the attribute VALUE pointers that
`UpdateProcThreadAttribute` merely stores) is fine from a shared reference. The
distinction is who writes, not how the parameter is typed.

## QA note

This is not a DoD item and not a rail on that board — it is an adversarial
finding. The QA skill forbids approving "with notes", so it is a reject even
when all seven DoD items pass with drill-verified evidence. Keep the reject
scoped: name the two bad sites AND the sites that are already correct, or the
fix round widens into a refactor.

Related: `mem:task-task-885a46e9fb274a94b12faa826ba580dc-qa-verdict`,
`mem:gotcha-restore-untracked-mutation-drill-by-byte-compare`.
