# Proving 'close' vs 'exit' matters: payload size does NOT do it on Windows

Testing that a child-process wrapper resolves on `'close'` rather than `'exit'` by having the
child write a large buffer and exit is a WEAK assertion. Mutation-drilled on Windows:

- child writes 256 KiB then exits -> test still GREEN with the `'exit'` mutation live
- child writes 900 KiB then exits -> test still GREEN

Reason: the child blocks on the pipe until the parent drains it, so by the time the child
exits there is nothing left in flight. The assertion looked meaningful and tested nothing.

## What actually works

Make something OTHER than the child hold the pipe open, so `'exit'` fires while bytes are
still coming:

```js
// child: hand stdout to a detached grandchild, then exit immediately
const {spawn} = require('node:child_process');
const c = spawn(process.execPath, ['-e', "setTimeout(()=>process.stdout.write('tail'),300)"],
  {stdio: ['ignore', 'inherit', 'ignore'], detached: true});
c.unref();
process.stdout.write('head');
```

Assert the capture equals `"headtail"`. With `'exit'` resolution it is `"head"` — red,
deterministically, on both platforms.

Generalisation: when a drill fails to turn a test red, the test is the defect, not the drill.
Strengthen the assertion rather than concluding the behaviour is untestable.
