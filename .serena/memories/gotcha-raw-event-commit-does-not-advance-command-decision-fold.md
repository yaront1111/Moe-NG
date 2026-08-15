# Raw event commit does not advance a command-decision lifecycle fold

If the canonical daemon aggregate fold reads only EFFECTS_COMMITTED command-decision results, writing a raw aggregate event with `commitWithApply` is not enough to advance lifecycle authority. The event and side-table row may both be durable while the production fold still reports the previous lifecycle.

QA guard:
1. Run the production composition.
2. Reopen or refold through the exact production read path.
3. Assert lifecycle/recoveryRequired and the side binding together.
4. A success result's transient reducer state is not durable proof.

When event + command-decision projection + side-table update must be atomic, a dedicated expected-version-decision-with-apply store seam is needed. Hand-writing command_decisions from a daemon callback duplicates store authority.