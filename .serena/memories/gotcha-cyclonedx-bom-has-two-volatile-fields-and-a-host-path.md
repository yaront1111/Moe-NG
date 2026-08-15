# A CycloneDX BOM is not byte-reproducible without three normalizations

Comparing two cdxgen 12.8.2 BOMs for reproducibility, the obvious pair of
volatile fields is not enough. Measured by generating two BOMs from ONE
unchanged tree seconds apart, and by scanning two different copies:

| what drifts | where | why |
|---|---|---|
| `/serialNumber` | top level | fresh urn:uuid per run |
| `/metadata/timestamp` | top level | generation time |
| **`/annotations/*/timestamp`** | annotations block | a SECOND generation time, easy to miss |
| **absolute path of the scanned tree** | `components[].properties[].value` etc. | BOM embeds the root it scanned |

The last two are the traps.

1. **The annotation timestamp.** Stripping only serialNumber + metadata
   .timestamp still leaves two same-tree BOMs unequal. Both blocks were the
   same LENGTH (828 bytes here), so a length or size check reads as identical.
   Strip `timestamp` per annotation entry rather than deleting the whole
   `annotations` array — the cdxgen tool identity beside it is worth comparing.

2. **The embedded scan root.** Any pipeline that builds twice in two temp
   directories gets different BOM bytes for identical content. Normalize
   THAT BUILD'S OWN root to a fixed token, in BOTH separator forms — cdxgen
   emits `D:\a\b` and `D:/a/b` in different fields:

```js
[JSON.stringify(sourceRoot).slice(1, -1), sourceRoot.split("\\").join("/")]
  .reduce((text, path) => text.split(path).join("<SOURCE_ROOT>"), canonical(value))
```
   `JSON.stringify(...).slice(1,-1)` matters: after canonicalization the path
   is JSON-escaped (`D:\\a\\b`), so the raw string never matches.

Keep the rewrite narrow and DISCLOSE it in the emitted record. A rule broad
enough to swallow `components` makes real dependency drift invisible while
the gate still reads green — drill it from both sides:
a path outside the build root, and annotation text other than the timestamp,
must still refuse.

Measured on task-9449ce65, 2026-08-09.
