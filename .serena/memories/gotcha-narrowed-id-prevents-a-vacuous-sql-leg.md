# A nullable field re-read inside a guard turns a SQL leg silently vacuous

## The shape
An early check proves a field non-null, then a helper deeper in the call re-reads it from `this` and binds it:

    if (this.projectId === null || !this.writeProjectAsserted) return SCOPE_REQUIRED;
    ...
    private readGuard() {
      const row = this.database.prepare(
        "SELECT EXISTS (SELECT 1 FROM command_decisions WHERE project_id = ?) AS present"
      ).get(this.projectId);        // typed string | null
    }

Bound as NULL, `WHERE project_id = NULL` is never true in SQL — NULL comparison yields NULL, not a match. The
leg does not error. It returns false. The guard quietly stops guarding and the suite stays green, because every
test reaches it through the path where the early check already ran.

TypeScript will not flag it: node:sqlite's `.get()` accepts null bindings happily.

## The fix, and why it is worth the three lines
Capture the narrowed value at the check and thread it down as `string`:

    const projectId = this.projectId;
    if (projectId === null || !this.writeProjectAsserted) return SCOPE_REQUIRED;
    return this.runTransaction(encoded, projectId);   // -> readGuard(projectId: string)

Now the vacuous binding is unrepresentable rather than merely unreachable. "Unreachable today" is one
reordering away from live, and this is exactly the failure mode epic rail 6 names: a sweep that silently
produces zero cases passes while testing nothing.

## How to spot it in review
Grep any guard's SQL parameters for a field whose declared type includes `null`. If the non-null proof lives in
a DIFFERENT method than the binding, the compiler is not carrying the proof — only the call order is, and call
order is not a type.

Found on task-1615065497f0489097a4bbc11cea9d6b (packages/store/src/recovery-initial-install.ts).
Related: `mem:guard-premise-detaches-while-green`, `mem:layered-validator-sweep-goes-vacuous`.
