# `--config package.json` can discard the jsdom environment and fake a red suite

Hit 2026-08-09 verifying task-4b274fadc in `apps/control-room`.

## Symptom

A focused run reports a wall of failures that look like real, damning defects:

```
ReferenceError: document is not defined
 ❯ render .../@testing-library/react/dist/pure.js:256:5
 Test Files  1 failed | 1 passed (2)
      Tests  16 failed | 14 passed (30)
```

The `.ts` file passes, the `.tsx` file fails every DOM test. Reads exactly like a worker
who forgot to set up the render environment. It is not.

## Cause

The invocation, not the code:

```bash
# FALSE RED — overrides the real config, loses environment: jsdom
pnpm --filter @moe/control-room exec vitest run --root . --config package.json <file>

# CORRECT
pnpm --filter @moe/control-room exec vitest run <file>
```

`apps/control-room` has **no `vitest.config.*` file** — the environment is supplied
elsewhere, and pointing `--config` at `package.json` (which has no `vitest` key beyond the
devDependency version) silently replaces it with a default Node environment.

## How to tell false red from real red in ten seconds

Check whether the *pre-existing, known-passing* test files in the same package declare the
environment themselves:

```bash
head -5 <package>/src/**/existing.test.tsx | grep -c '@vitest-environment'
```

Zero hits across every `.tsx` in the package means the environment is config-supplied, so
any run that bypasses the config will fail them all. If the failing file is the *only* one
without a docblock, that's a genuine defect.

Corroborating tell: `Duration ... environment 0ms` on the failing run versus
`environment 941ms` on the correct one. Zero setup time means no environment was built.

## Correction to prior memory

`mem:vitest-focused-run-config-path-doubles` recommends `--config package.json` as the
focused-run form. **That is package-specific and wrong here.** It works only where the
vitest config genuinely lives in `package.json`. Check for a `vitest.config.*` first; when
none exists, plain `vitest run <file>` is the safe form. Confirm the `Test Files` count
actually shrank either way.

## Why it matters beyond one bad command

I nearly reported a correct worker's delivery as broken during review. A false red is more
dangerous than a false green in review specifically, because it is *actionable* — it
invites a rejection with convincing evidence attached. Re-run with the package's own
documented command (`pnpm --filter X test`) before believing a focused failure.
