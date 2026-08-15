# Under jsdom, `new URL(".", import.meta.url)` returns an http URL, not a file URL

In `apps/control-room` (vitest `environment: "jsdom"`), the global `URL` is jsdom's
whatwg-url. Resolving a RELATIVE specifier against `import.meta.url` goes to the jsdom
document base instead of the module's file URL:

```js
import.meta.url                          // "file:///D:/…/src/data/x.test.ts"   (correct)
new URL(".", import.meta.url).href       // "http://localhost:3000/src/data"    (!!)
fileURLToPath(new URL(".", import.meta.url))
// TypeError: The URL must be of scheme file
```

`.href` does not help — the value is already wrong before `fileURLToPath` sees it.

## Fix

Convert `import.meta.url` DIRECTLY, with no relative-URL step:

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
readFileSync(join(DIRECTORY, name), "utf8");
```

## Why it looks like it should work

`apps/control-room/src/scaffold.test.tsx` uses
`readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), "utf8")` and passes, so
the pattern reads as blessed. Do not copy it for a DIRECTORY lookup — the failure is
specific to resolving a relative specifier and then converting it.

Matters for any static-source-scan test (import-ban, file-set assertion) placed in a
jsdom app package. Observed 2026-08-09 on task-2d1f94f91da24.

Debugging note: `console.log` is swallowed in that suite; `throw new Error("X=" + value)`
surfaces the value in the failure output.
