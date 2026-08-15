# A surface can exist as a file and still be unreachable in a browser

Found 2026-08-10 on `task-667b1085` (Control-room journey gate). A governor had
cleared three scenario ids as "now exist" by naming their production files. All three
files were real. **None of the three could be reached by a browser journey.**

## The three shapes of "exists but unreachable"

| id | file | why unreachable |
|---|---|---|
| `cr.runs` | `runs/runs-surface.tsx` | `RunsSurface` imported by **no** production module |
| `cr.resources` | `resources/resources-surface.tsx` | same — never mounted |
| `cr.banner.circuitbreaker` | `shell/circuit-breaker-banner.tsx` | **is** mounted, but returns `null`: the preview passes no `breaker` prop and the component fails closed |

The third is the nastiest: grep finds the id, the import graph finds the mount, and it
*still* renders nothing.

## Why the obvious guard does not catch it

The natural ledger check is *"every case marked COVERED resolves to a production file
on disk"* — and it **passes for all three**. `existsSync` is not reachability.

The served bundle mounts `ControlRoomScaffold` → `ControlRoomPreview`, which renders
its own hand-written `cr.surface.runs` / `cr.surface.resources` panels. Different ids,
different components. `AppComposition` (the module that *does* mount `ActionBar`) is
not the browser entry at all. See `mem:gotcha-mount-the-composed-root-not-the-parent`.

## Measure it, do not infer it

Static reading nearly fooled me. What settled it was building the bundle and
enumerating the real DOM — a throwaway probe in the **gitignored**
`tests/e2e/control-room/test-results/` dir (so it can never reach a commit), deleted
after the run. 115 reachable `cr.*` ids across six workspaces; `cr.runs*` = 0.

## Guard both halves, and both must be able to rot loudly

```ts
// existence — necessary, nowhere near sufficient
expect(existsSync(join(root, file))).toBe(true);
// reachability — an import SPECIFIER match, not a text match, so a comment
// naming the module does not read as a composition
const spec = new RegExp(`from\\s+["'][^"']*${moduleName}[^"']*["']`, "u");
expect(SOURCES.filter(p => spec.test(read(p))).map(rel)).toEqual([]);
```

Both drills fire: adding the import reddens the reachability test; adding the id to
any production source reddens the absence test. Pin the corpus size too
(`SOURCES.length > 400`) or a moved scan root scans nothing and every absence
assertion passes — `mem:gotcha-hop-count-scan-roots-narrow-silently`.

## The classification that matters

Do **not** collapse these into one "not covered" bucket. `SURFACE_ABSENT`,
`SURFACE_NOT_COMPOSED` and `NO_DAEMON_BACKED_BROWSER_LANE` have different owners and
different fixes; the middle one is invisible to every habitual check.

Related: `mem:gotcha-an-archived-dependency-can-never-satisfy-itself`,
`mem:gotcha-vacuous-set-membership-clears-everyone`.
