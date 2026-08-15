# Gotcha: a hostile-input guard after normalization is not a production guard

A direct verifier may correctly reject Proxy operands while the public production surface still accepts them if an earlier request snapshot reflects over the Proxy and copies it into a plain array/record first.

On Claude launch selection, `verifyLaunchSelection` called `types.isProxy` before reflection, and its direct tests asserted zero traps. But `launchClaude` first called `snapshotClaudeLaunchRequest`; that module's independent argv/environment snapshotters used `Array.isArray`, `Object.keys`, and descriptors without the proxy check. The verifier then received only the sanitized copy. A trapping Proxy argv executed 15 traps and the launch completed `OBSERVED`.

For hostile-input work:
- test the public production surface, not only the downstream helper;
- put the rejection before the first reflection/coercion anywhere on the call path;
- assert exact refusal code/layer, zero trap executions, and zero downstream effects;
- mutation-check the earliest snapshot guard, because mutating a later guard can leave a helper test red while production remains permissive.