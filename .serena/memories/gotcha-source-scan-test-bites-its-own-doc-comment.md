# A source scan banning words catches the header that forbids them

Wrote a test banning authority words (`score|verdict|threshold|acceptab|
benchmark|budget`) from the effort modules' source. First run failed — on my own
module header:

```
+ " * 4. OBSERVATIONAL ONLY. Nothing here produces a duration, a score, a threshold or a"
```

The ban is on CODE reaching for authority; prose that names the ban in order to
state it is the opposite of a violation. Fix: strip comments before scanning.

```ts
source.replace(/\/\*[\s\S]*?\*\//gu, "")
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.trim().startsWith("//"));
```

**The trap is the fix itself.** A stripper is a silent-zero generator: strip too
much and the scan reports clean while seeing nothing. Police it in the same test:

- assert the stripped set is non-empty per module (`> 30` lines here);
- assert the module's ANCHOR survives stripping, so it is real code that remains;
- assert `codeLinesOf("/** a score */\nconst kept = 1;\n// a verdict\n")` equals
  exactly `["const kept = 1;"]` — proving it drops prose AND keeps code.

Same family as `mem:qa-positive-control-on-an-empty-grep` and
`mem:qa-generated-table-cannot-police-its-own-generator`: any filter placed in
front of an assertion needs its own proof that it did not filter everything.
