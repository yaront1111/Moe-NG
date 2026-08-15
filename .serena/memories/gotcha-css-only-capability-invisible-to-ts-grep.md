# A capability can live entirely in CSS, invisible to a .ts/.tsx grep

Cost me two false ABSENT claims on 2026-08-09 while measuring control-room gaps.
Both were caught only by an adversarial refutation pass.

## What happened

I grepped for narrow-window and reduced-motion machinery with
`--include=*.ts --include=*.tsx`, got zero hits, and reported both capabilities
as absent. Both were **present**, implemented entirely in the one stylesheet:

```
apps/control-room/src/board/board-layout.css:50  @media (max-width: 959px)
apps/control-room/src/board/board-layout.css:68  @media (prefers-reduced-motion: reduce)
```

The repo has exactly **one** `.css` file, `className` count is **0**, and there
is no CSS-in-JS dependency — so it is easy to assume styling isn't a thing here
and skip it. That assumption is precisely what makes the miss likely.

## Why the miss is expensive

An ABSENT claim is not a neutral observation. Under project rail 4 clause 2 it
*mandates creating prerequisite production tasks*. A false absent therefore
manufactures work to build something that already exists, and the task
description carries the false claim forward as if it were measured fact.

## Rule

Before declaring any presentation-layer capability absent — layout, responsive
behavior, motion, focus ring, theming, contrast — the search must cover **every
file type that can carry it**, not just the language you expect:

```bash
grep -rniE "<pattern>" \
  --include=*.ts --include=*.tsx --include=*.js --include=*.mjs \
  --include=*.css --include=*.scss --include=*.html --include=*.json \
  apps packages | grep -v node_modules | grep -v /dist/
```

Cheaper and safer for a small repo: **drop `--include` entirely** and filter
noise afterwards. An unfiltered sweep cannot miss a file type you failed to
predict.

Then confirm the negative from the other direction — enumerate what *does*
exist rather than trusting one pattern to be absent:

```bash
find . -path '*/node_modules' -prune -o -name '*.css' -print   # 1 file — read it
```

If the surface area is that small, **read the file** instead of grepping it.

## Corollary

Delegating the same search to an adversarial verifier whose only job is to
*refute* the absence is what caught this. For any ABSENT claim that will
generate a task, spend the extra pass.

Related: `mem:decision-control-room-a11y-bars`,
`mem:task-task-ab8c9489ab6446c384e977a3e1cc8063-handoff`
