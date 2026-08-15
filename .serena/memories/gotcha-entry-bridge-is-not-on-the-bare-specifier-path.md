# Renaming the ENTRY `.js` bridge proves nothing — it is not on the bare specifier's path

Found 2026-08-11 on task-8ce8b35c. The approved plan's drill 3 was, verbatim, "temporarily
rename `src/index.js` -> the plain-Node probe must go RED while vitest stays green". It does
not. The probe stays green: **5 passed**.

## Why

`packages/mcp/package.json` has `"exports": { ".": "./src/index.ts" }`. Node resolves
`import("@moe/mcp")` straight to `src/index.ts` and never looks at `src/index.js`. The entry
bridge exists only to satisfy the repo's bridge audit ("every non-test module has a sibling
`.js`"), not to serve any resolution.

Bridges matter for the RELATIVE `.js` specifiers that the entry module then follows. Under
`--experimental-strip-types` Node does not do TypeScript's `.js` -> `.ts` rewrite, so
`export ... from "./http/http-server.js"` needs `http/http-server.js` to exist on disk.

## The drill that actually works

Rename the bridge the NEW specifier needs — here `http/http-server.js`. Then ONLY the
child-process test reddens while all four vitest-resolved tests stay green, which is the
whole justification for having a plain-Node probe at all:

```
+   "code": "ERR_MODULE_NOT_FOUND",
+   "outcome": "FAILED",
+   "specifier": "file:///D:/projexts/moe-next/packages/mcp/src/http/http-server.js",
```

Make the probe report `code` and `specifier` on the failure branch, not just a typeof. A
probe asserting only `typeof x === "function"` reddens with `undefined` and tells you nothing
about which bridge is missing.

## Why it is dangerous rather than merely wrong

A green drill reads as "restored cleanly, drill complete". Recording "drill 3 green" certifies
a probe that was never tested — the exact failure `mem:mutation-drill-can-hang-instead-of-failing`
describes, arrived at from the other direction: there the drill never finished, here it
finished having changed nothing.

RULE: before drilling a bridge/barrel, ask which specifier the RESOLVER actually follows.
Read the `exports` map first. If the map points at the `.ts` entry, the entry's `.js` sibling
is inert and drilling it is a no-op.

Related: `mem:core-js-bridge-requires-index-reachability`,
`mem:mutation-drill-green-may-indict-the-mutation`.
