# cdxgen `-o -` is not a stdout selector

`@cyclonedx/cdxgen` 12.8.2 does NOT treat `-o -` as "write the BOM to
stdout". It writes the document to its default `bom.json` in cwd and prints
an unrelated **`SECURE MODE: Environment audit`** ASCII table to stdout.

So this pattern silently never works:

```js
const run = await command(node, [cdxgen, "-t", "js", "-o", "-", root], root);
const sbom = JSON.parse(run.stdout);   // always throws -> undefined
```

The exit code is **0**, stderr is **empty**, and stdout is non-empty — every
cheap health signal looks fine. Only a downstream "components === 0" check
catches it, and it surfaces as a misleading `SBOM_REPORT_INVALID` that reads
like a malformed dependency graph rather than a CLI-flag mistake.

Do instead: pass a real path, then read it back and treat a missing file as
a coded failure.

```js
const output = join(root, "node_modules", ".release-bom.json");
const run = await command(node, [cdxgen, "-t", "js", "-o", output, root], root);
return run.exitCode !== 0 ? run
  : existsSync(output) ? { exitCode: 0, stderr: run.stderr, stdout: readFileSync(output, "utf8") }
  : { exitCode: 1, stderr: "sbom output missing", stdout: "" };
```

## Why it survived a full test suite

`generateSbom` is a real-process port, so every fast test replaces it with a
fake returning well-formed JSON on `stdout`. The fakes encoded the ASSUMED
contract, not the observed one. Only an end-to-end run of the actual CLI
touches the real function — see
`mem:gotcha-real-process-ports-are-invisible-to-injected-port-suites`.

Measured on task-9449ce65 (release supply-chain gate), 2026-08-09.
