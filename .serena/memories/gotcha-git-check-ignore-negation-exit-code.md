# Gotcha: `git check-ignore -v` exits 0 on a NEGATION match

Verifying a `.gitignore` by branching on `git check-ignore -v`'s exit code
silently misreports any path protected by a `!` rule.

With `-v`, check-ignore exits `0` whenever **any** pattern matches — including a
negative one — and prints the matching rule with a leading `!`:

```
$ git check-ignore -v --no-index .env.example
.gitignore:9:!.env.example	.env.example
$ echo $?
0
```

So this test is WRONG and will claim a protected file is ignored:

```sh
git check-ignore -v --no-index "$p" >/dev/null 2>&1 \
  && echo "IGNORED" || echo "not ignored"
```

I hit this while adding the `.moe` hygiene block and briefly concluded I had
broken `!.env.example`. Nothing was broken.

## Correct forms

Drop `-v` — negated paths are excluded from output entirely, so the exit code
is then trustworthy:

```sh
git check-ignore --no-index "$p"    # exit 0 = genuinely ignored, 1 = not
```

Or keep `-v` and **read the printed rule** rather than the exit status:
a leading `!` in the rule means the path is NOT ignored.

Verified on git 2.54.0.windows.1: `.env` -> exit 0 IGNORED,
`.env.local` -> exit 0 IGNORED, `.env.example` -> exit 1 NOT-IGNORED.

## Related

`--no-index` cannot stat the filesystem, so a trailing-slash directory rule
(`cache/`) cannot be confirmed against a path that does not exist on disk.
Such a probe reports "visible" for reasons unrelated to the rule. Do not read
that as proof the file-form of the name stays visible.
