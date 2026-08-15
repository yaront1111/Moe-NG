# Gotcha: probing the 1 MiB body limit with one big string measures the wrong limit

`decodeBoundedJsonBytes` enforces three independent caps: `MAX_JSON_BODY_BYTES` 1048576,
`MAX_JSON_STRING_UTF8_BYTES` 262144, `MAX_JSON_DEPTH` 64. They are checked in that
internal order but the **string cap fires first** for a naive body-limit probe.

Padding a request to exactly 1 MiB with a single `"z".repeat(over)` value returns
`JSON_STRING_LIMIT_EXCEEDED`, never `JSON_BODY_LIMIT_EXCEEDED`. A QA probe written that
way reports a false "N is rejected" failure against correct code.

Correct: split the padding across several keys, each under 262144 bytes, then trim the
last chunk to land on the exact byte count.

```js
const keys = ["a", "b", "c", "d", "e"];
const fill = totalBytes - encode({ ...base, payload: blank }).byteLength;
const each = Math.floor(fill / keys.length);
const payload = Object.fromEntries(
  keys.map((k, i) => [k, "x".repeat(i === keys.length - 1 ? fill - each * (keys.length - 1) : each)]),
);
```

`packages/contracts/src/runtime/runtime-envelope.test.ts:69` (`paddedCommandBytes`) is the
reference implementation — reuse its shape rather than re-deriving it.

## Depth probe off-by-two

Depth counts the whole document, not just the payload. For a command envelope the root
object is 1 and `payload` is 2, so the deepest legal extra nesting under `payload` is
`MAX_JSON_DEPTH - 2` levels. `nest(MAX_JSON_DEPTH - 2)` passes, `nest(MAX_JSON_DEPTH - 1)`
returns `INPUT_LIMIT_EXCEEDED`.

Related: `mem:task-task-12e18265f7a84c7eacdf79a3bef2bdf3-handoff`.
