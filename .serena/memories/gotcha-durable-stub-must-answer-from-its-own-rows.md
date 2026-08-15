# A durable-port stub that echoes the caller's bytes tests nothing

When you inject a durable compare-and-set port in place of a pure function, the
obvious stub delegates to the same pure function on the SAME arguments the
launcher passed. That stub makes the delegation untestable: the default port,
handed the identical request, produces the identical answer, so deleting the
delegation entirely leaves every test green.

## The fix: the stub owns rows, and the presented bytes only SELECT a row

    consumeGrantDurably(grant, wrapperIdentity) {
      const presented = parseActivationGrant(grant);       // production parser
      const row = rows.get(presented.grantId);             // durable lookup
      if (!row) return refuse(<a code the default cannot emit>);
      const outcome = consumeActivationGrant(row, wrapperIdentity);  // over the ROW
      if (outcome.kind === "CONSUMED") rows.set(..., outcome.grant); // the CAS
      return outcome;
    }

Now each scenario is a divergence between the row and the presented bytes:

- **replay** — row is CONSUMED, caller presents its committed UNUSED grant.
  Default would SUCCEED; delegated refuses GRANT_ALREADY_CONSUMED at GRANT.
- **wrapper drift** — row is bound to another wrapper while the presented grant
  and wrapperIdentity agree with each other. Default would SUCCEED.
- **forgery** — grantId absent from the store. Pick a code+layer the default
  port CANNOT emit at that phase (here ACTIVATION_COMMIT_INCOHERENT at
  ACTIVATION, where the default only ever emits EFFECT_GRANT_MALFORMED/KERNEL,
  GRANT_WRAPPER_MISMATCH/GRANT, GRANT_ALREADY_CONSUMED/GRANT). Delegation is
  then provable from the code alone, with no drill needed.

## Do not put the drift in the presented record

In moe-next, tampering with a grant's own `wrapperIdentity` changes the derived
grantId, so `validateActivationCommit` refuses ACTIVATION_COMMIT_INCOHERENT
UPSTREAM and the injected port is never reached — the test would pass while
testing an earlier guard. See `mem:refusal-test-answered-by-earlier-guard`.

## Still drill it

Replace the delegation with the default port and confirm the replay case
reddens on an OUTCOME ("expected failure, received OBSERVED"), not on a call
count. A call-count assertion alone would also redden, but it does not prove
the durable layer ANSWERED.
