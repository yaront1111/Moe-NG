# `node -e "src" -- a b c` puts the first user arg at argv[1], not argv[2]

Measured on task-eff945fc, 2026-08-10, while building a real-process-death test.

```
node --experimental-strip-types --input-type=module -e 'console.log(JSON.stringify(process.argv))' -- /tmp/x aaa bbb
["C:\\Program Files\\nodejs\\node.exe","C:/Users/.../x","aaa","bbb"]
```

With `-e` there is no script path, so `argv[1]` is the FIRST user argument and the `--` is consumed.
The habitual `process.argv.slice(2)` silently drops one argument and shifts every destructured name by
one. The child then fails somewhere far from the cause — in my case a store opened at the wrong path,
surfacing only as a generic `THREW` from the child's own catch.

## Do this instead

Pass child inputs through the ENVIRONMENT, not argv:

```ts
await execFileAsync(process.execPath,
  ["--experimental-strip-types", "--input-type=module", "-e", SRC],
  { cwd: PACKAGE_ROOT, env: { ...process.env, MOE_STORE_PATH: p, MOE_LABEL: label } });
```

The index stops being a Node implementation detail, and each value is named at both ends.

## The guard that located it in one run

Every child case begins:

```ts
expect([first.outcome, first.message]).toEqual(["OPENED", undefined]);
```

so a child that died reports ITS OWN message instead of surfacing later as a mystifying `undefined`
comparison. This turned an opaque failure into `['THREW','THREW','THREW']` plus the message, and the
wiring bug was obvious. Always assert the child's outcome-and-message pair before asserting its payload.

Bare-specifier imports (`@moe/store`) DO resolve inside `-e` when `cwd` is the package root, so no
`.mjs` worker file is needed — `doctor-version.node.test.ts:345` is the precedent in moe-next.
