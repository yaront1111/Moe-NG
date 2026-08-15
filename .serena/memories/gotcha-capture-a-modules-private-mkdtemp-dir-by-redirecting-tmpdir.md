# Capture a module's private mkdtemp dir by redirecting tmpdir(), not by guessing

A module that does `mkdtempSync(join(tmpdir(), "prefix-"))` at construction time and never exposes
the path defeats a filesystem assertion: the test cannot name the directory it must inspect.

Two bad answers: hardcoding a temp path (passes for the wrong reason — it asserts on a directory
nobody wrote to), and diffing `readdirSync(tmpdir())` before/after (races any other process using
the same prefix; in moe-next a live wrapper daemon does exactly that).

## The answer

Point `os.tmpdir()` at a private sandbox for the duration of the CONSTRUCTION call only. Node
resolves tmpdir() from `TMPDIR` / `TMP` / `TEMP`, so move all three and restore in a `finally`:

```ts
const sandbox = mkdtempSync(join(tmpdir(), "my-case-"));
const keys = ["TMPDIR", "TMP", "TEMP"] as const;
const saved = keys.map((k) => [k, process.env[k]] as const);
for (const k of keys) process.env[k] = sandbox;
try { thing = build(); }
finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
const entries = readdirSync(sandbox);
if (entries.length !== 1 || entries[0] === undefined) throw new Error(`expected one dir, got [${entries}]`);
```

**The count check is the point, not defensive noise.** If the construction minted its directory
somewhere else, every later filesystem assertion inspects an empty sandbox and passes vacuously.
The throw converts that into a loud failure.

Bonus: the sandbox is self-cleaning (`rmSync` it in `afterAll`), so the case leaves no litter even
when the module's own `process.once("exit")` sweep never fires — under vitest workers it often
does not. In moe-next, `agent-spawner.test.ts`'s five pre-existing cases had left 230 empty
`moe-wrapper-*` dirs in the real tmpdir for exactly that reason.

Used in `mem:task-task-89071eb1ea0d4ccd8015f61d10cd89f6-handoff`.
