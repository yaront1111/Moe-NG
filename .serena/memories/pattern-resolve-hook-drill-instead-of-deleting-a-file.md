# Prove a test is non-vacuous without touching a tracked file

Problem: the standard mutation drill — delete or corrupt the production file, confirm the test goes red, restore — is unsafe in this repo. All agents share one working directory and another agent's whole-tree completion hook can commit your drill edit mid-window (`mem:mutation-drills-in-shared-worktree`, `mem:gotcha-wrapper-whole-tree-commit-mislabels-task-ownership`). Deleting a tracked file is the worst case: the hook commits the deletion.

Fix: mutate the *resolution*, not the file. Node 22.15+/24 has synchronous `registerHooks` from `node:module`.

```js
// hook.mjs
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("context-contract.js")) {
      const err = new Error("QA drill"); err.code = "ERR_MODULE_NOT_FOUND"; throw err;
    }
    return nextResolve(specifier, context);
  },
});
```

Run the child twice, with and without `--import file:///<abs>/hook.mjs`. Drill must FAIL where control IMPORTS. Used on task-b7049554 to prove the `.js` bridges are load-bearing: control `{"outcome":"IMPORTED","probe":"function"}`, drill `{"outcome":"FAILED","code":"ERR_MODULE_NOT_FOUND"}`. Zero repo files touched.

Generalises past bridges: throw from `resolve` to simulate a missing dependency, or override `load` to inject a corrupted module body, for any test whose subject is module loading.

## Two traps that cost me a rerun

**1. `--import` needs an absolute Windows file URL.** `file:///tmp/hook.mjs` dies with `ERR_INVALID_FILE_URL_PATH: File URL path must be absolute` — git-bash `/tmp` is not a Windows path. Use `file:///$(cygpath -m /tmp/hook.mjs)`.

**2. A bare specifier resolves node_modules from the IMPORTING MODULE's directory, not cwd.** A probe script parked in the OS temp dir reports `ERR_MODULE_NOT_FOUND` for `@moe/context` even when the package is perfectly fine — a false defect indistinguishable from the real one. Anchor at cwd with `node --input-type=module -e '<probe>'` run from the package/repo root, or put the probe file inside the tree. This is the same class as the bare-package-name probe that once reported all ten packages broken.

Also: the Bash tool mangles `$'\r'` (`mem:gotcha-bash-tool-mangles-dollar-quoted-cr-pattern`), so `grep -c $'\r'` reports a CRLF hit on every clean LF file. For line endings compare hex: `git show HEAD:<path> | xxd -p | tr -d '\n'`, then check for `0d` and a trailing `0a`. Heredocs also collapse `\\` to `\`, which breaks inline `replace(/\\/g, "/")` — use `pathToFileURL` instead.
