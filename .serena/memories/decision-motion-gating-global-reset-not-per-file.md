# A reduced-motion guard must accept a global reset, not demand per-file gates

**Area:** control-room accessibility guards / spec §11.1. Established
2026-08-09 on task-4b274fadc69b457abb1f68512853c41e.

## The shape of the mistake

A DoD (and then a governor's correction of that DoD) required that every motion
declaration be neutralised "within a `@media (prefers-reduced-motion: reduce)` block **in
the same stylesheet**". That reads as the obviously-correct tightening. It is wrong
whenever the codebase uses the standard global reset instead:

```css
/* styles/responsive.css:155 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

`!important` beats cascade order, so one such block covers every stylesheet in the
bundle. Demanding a per-file block then goes **red on correct code** (here: chrome.css,
shell.css, surfaces.css) and can only be satisfied by adding redundant production CSS.

## Why it matters beyond CSS

Two failure modes, both worth checking whenever a guard is specified by mechanism rather
than by property:

1. **The guard specifies the wrong mechanism.** The property is "motion is suppressed for
   users who ask". "Each file has its own block" is one implementation of that, not the
   property. Guards written against an implementation rot the moment the codebase picks a
   different valid one.
2. **A correction can be as stale as what it corrects.** The governor's note fixed the
   original "ban all motion" error but was measured against only one of the five motion
   sites. Re-measure the *correction*, not just the original claim.

## The guard that actually holds

Assert the property, and assert the sweep is live:

- discovered file set non-empty **and** contains specific named files (a scan root that
  narrows silently still passes every assertion over the smaller set);
- motion-declaration count **non-zero** before asserting anything about gating;
- the reset exists, uses a universal selector, and carries every neutralising declaration;
- the reset is **actually `@import`ed** — an unreferenced stylesheet is dead code and the
  guarantee is fake;
- **JS-driven motion is zero**, because a CSS reset cannot reach `requestAnimationFrame`,
  `element.animate()`, framer-motion or react-spring. This is the arm that makes the guard
  load-bearing rather than decorative.

## Do not over-ban

Two near-misses that would each force the guard to be weakened later:

- `setTimeout` / `setInterval` are **not** animation markers. Feed reconnect and poll
  backoff use them legitimately (`live/live-board-feed.ts`, `live/live-event-feed.ts`).
- `scroll-snap-type` / `scroll-snap-align` are layout, not motion, and are already
  neutralised by `scroll-behavior: auto`.

A guard that must be weakened the first time someone writes correct code was never a
guard. Related: `mem:task-task-4b274fadc69b457abb1f68512853c41e-handoff`
