# A closed enum with `pub const ALL: [T; N]` makes every sibling sweep a file you must edit

Found planning task-a02496 (Win32 Job native crate), 2026-08-09.

## The pattern

The moe-next native crates use a deliberately closed op enum plus a frozen
coverage array:

```rust
pub enum NativeOp { CreateJobObject, SetInformation, /* ... */ }
impl NativeOp { pub const ALL: [NativeOp; 6] = [ /* every variant */ ]; }
```

and a sweep that cross-checks produced ops against the production enum rather
than against its own case list — which is correct, and is exactly what the epic
rail on generated tables demands:

```rust
let all: BTreeSet<NativeOp> = NativeOp::ALL.iter().copied().collect();
assert_eq!(produced, all, "sweep did not reach every NativeOp");
```

## The consequence architects miss

**Adding one variant to that enum breaks every existing sweep that cross-checks
against `ALL`.** The follow-on task's file list must therefore include the
*previous* task's test file, even though nothing about the new feature is in it.
On task-a02496 this was the difference between the 6 files the description named
and the 10 files the work actually needed — which is what pushed it over the
daemon's plan-shape ceiling and forced a SPIDR split.

Two knock-on effects to plan for:

1. `[NativeOp; 6]` is a **fixed-size array type**. Adding a variant changes the
   type annotation too, not just the literal — so it is a compile error, not a
   silent pass. That part is good design working as intended.
2. The tempting repair is to soften `assert_eq!(produced, all)` into a subset or
   containment check so the old sweep tolerates the new variants. **That guts
   the test**: it then passes while a job arm is entirely unreached. The correct
   repair keeps an exact equality against the subset of ops that sweep actually
   owns, and fails when one of its own arms goes dead. Verify the repair by
   deleting one entry from the case array and confirming the test goes red.

## Generalization

Any "closed vocabulary + frozen ALL array + cross-checking sweep" trio couples
each new consumer to every existing consumer's test. Before sizing a task that
extends such an enum, grep for `::ALL` and add every hit to the file count.

Related: `mem:qa-generated-table-cannot-police-its-own-generator` (the opposite
failure — a table that *does* derive from the production const and so cannot
detect a deletion).

## Second, smaller trap from the same task

A landed file's own doc comment about its size is **not** a measurement.
`src/win32.rs` documented "sits at 246 of its 250-line target" while
`grep -c ''` reported **252** — the file had grown past its own stated budget
before it shipped, and a DoD saying "every production source is <=250 lines"
was therefore already violated by inherited code on day one. Measure incoming
files against your own DoD before planning; you can inherit a violation.
