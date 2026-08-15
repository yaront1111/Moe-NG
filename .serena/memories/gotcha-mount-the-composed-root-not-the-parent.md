# A test that mounts your component's PARENT stops covering it the moment someone moves it

## The failure

You land a component and compose it into a parent. You write the composition test against
that parent, because that is the file you just edited. A later refactor by another agent
extracts a new intermediate (`frame.tsx` -> `shell-chrome.tsx`) and relocates your render.

Your composition test now covers a file that no longer composes your component. It stays
**green** — it is testing the wrong tree, and nothing reports that.

Worse: `git status` on YOUR files is clean, `sha256 head == worktree` on every one of
them, and your own step notes still name the old line number. Every check you habitually
run says nothing moved.

## Concrete instance (moe-next, task-ddb3bf77, 2026-08-09)

`<CircuitBreakerBanner>` was mounted at `frame.tsx:150`, a sibling of `<Banners>` (which
early-returns exactly ONE banner) so a circuit-broken lagging view shows both. A staged
foreign refactor moved the render to `shell-chrome.tsx:90`.

The coexistence guarantee survived **only because** the test did this:

```tsx
render(<ShellFrame affordance={frame} breaker={breakerFact()} />);
expect(screen.getByTestId("cr.banner.lag")).toBeTruthy();
expect(screen.getByTestId("cr.banner.circuitbreaker")).toBeTruthy();
```

It mounts the **composed root the app actually renders**, and asserts by test id over the
resulting tree. Where the banner physically lives is not encoded anywhere. Had it mounted
`<ShellChrome>`'s predecessor directly, or asserted on frame.tsx's own output, the
relocation would have silently retired the guarantee.

## Rule

For a **composition** guarantee — "A renders ALONGSIDE B", "A is reachable from the app
shell" — mount the **outermost root a user actually gets** and assert by stable test id.
Mount the immediate parent only when the guarantee is genuinely about that parent's own
behaviour.

## Detection, when you suspect it already happened

Do not trust `git status` on your own paths — the move is in someone ELSE's file.

```sh
grep -rn "YourComponent" <package>/src --include=*.tsx   # who imports/renders it NOW
git show HEAD:<the file you thought mounts it> | grep -n YourComponent  # vs. then
```

A hit in an unexpected file with **zero** hits in the file your step note names is exactly
this. Related: `mem:gotcha-hop-count-scan-roots-narrow-silently` — same family, an
assertion quietly detaching from its subject while staying green.
