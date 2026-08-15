# A bad perl delimiter voids the whole drill and prints nothing useful

Sibling of `mem:gotcha-perl-brace-delimiter-fakes-a-surviving-mutant`. Same class,
different trigger, and worth its own note because the failure is *louder* but just
as easy to skim past when seven mutants scroll by.

`perl -0pi -e "s\a\Q$from\E\a$to\ag" file` — using `\a` as the `s///` delimiter —
is not a delimiter at all. Perl reports:

```
Backslash found where operator expected (Missing operator before "\"?)
Unknown regexp modifier "/E"
```

and exits without touching the file. In a loop over several mutants that scrolls
off screen, the run looks busy and every subsequent `pnpm test` is GREEN — which
reads exactly like "all mutants survived", the opposite of the truth.

Two habits that make this self-detecting, both cheap:

1. **Hash-gate every mutation.** Capture `git hash-object` before and after; if it
   did not change, print `!! MUTANT NOT APPLIED` and skip the test run. That is what
   caught this — the drill reported seven not-applied lines instead of seven fake
   survivors.
2. **Stop using perl for this.** In this repo the reliable mutator is a four-line
   node script doing a literal `split(from).join(to)` with a hard exit when the
   anchor is absent:

```js
const text = readFileSync(file, "utf8");
if (!text.includes(from)) { console.error("ANCHOR NOT FOUND"); process.exit(2); }
writeFileSync(file, text.split(from).join(to), "utf8");
```

No regex metacharacter escaping, no delimiter choice, no `\Q\E`, and multi-line
anchors work as-is — which matters because a one-line anchor like
`locator: finding.subject.locator` often appears in two functions, and a global
replace then mutates a second guard and reddens a test you were not aiming at.
Pick an anchor that spans enough lines to be unique.
