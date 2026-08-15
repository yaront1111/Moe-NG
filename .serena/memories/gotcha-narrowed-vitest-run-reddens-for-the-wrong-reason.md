# A narrowed vitest run can go red for the wrong reason, and a mutation drill reads that as proof

**Area:** QA mutation drills / focused vitest runs. Hit live 2026-08-09 while verifying
task-4b274fadc69b457abb1f68512853c41e in `apps/control-room`.

## What happened

The fast-iteration incantation

```
pnpm --filter @moe/control-room exec vitest run --root . --config package.json <file>
```

**drops the package's `vite.config.ts`**, and with it the jsdom environment. Every
`@testing-library/react` `render()` then throws:

```
ReferenceError: document is not defined
  ❯ render node_modules/.../@testing-library/react/dist/pure.js:256:5
```

`apps/control-room` has no `vitest.config.*` at all — the environment lives in
`vite.config.ts`, and `--config package.json` replaces it. Correct focused form here:

```
pnpm --filter @moe/control-room exec vitest run src/a11y/colour-independence.test.tsx
```

## Why this is a QA trap specifically, not just an ergonomics bug

I was running a mutation drill: blank one `CARD_FACTS` label, expect exactly the
dedicated board arm to redden. The broken-environment run reported **16 of 18 failed,
including all 15 fixture surfaces**. That is a *plausible* result — it reads as "the
shared fixture sweep does cover card overlays after all, so the extra arm is redundant."
Wrong on both counts. Under the correct config exactly **1 test** failed, with the
expected `INDICATOR_COLOUR_ONLY` / `cr.fact.node.colour-node.suspect`, and the 15
fixtures stayed green — the opposite structural conclusion.

A mutation drill only proves anything if the test goes red **for the reason you
mutated**. Green-to-red is not the signal; green-to-*your-assertion-failing* is.

## The rule

1. Always read the failure MESSAGE, never just the pass/fail count. A drill that reddens
   without naming your reason code has proved nothing.
2. Suspect the harness when a drill reddens *more* than you predicted. Over-reddening is
   the signature of an environment or config fault, not of a strong guard.
3. Before trusting a focused run, confirm both that the Test Files count shrank AND that
   the file still passes unmutated under that same command.

Related: `mem:task-task-4b274fadc69b457abb1f68512853c41e-qa-verdict`.
