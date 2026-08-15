# "Wired through the package" is not "called by anyone"

2026-08-15, task-e19074f8. A governor re-measured a prerequisite before unblocking its parent and reported:
*"`installInitialRecoveryBinding` is defined at packages/store/src/recovery-initial-install.ts:72 and wired
through the ledger interface and delegate at packages/store/src/decision-ledger.ts:57 and :115."* True, and
careful work — they also checked committed blob shas rather than the working tree.

But the consumer grep was never run. `grep -rn installInitialRecoveryBinding apps/ packages/` returns hits
**only inside the producing package** — interface, delegate, facade. The daemon that was supposed to consume
it still called the older replacing API. The prerequisite had landed a primitive nothing imported, and the
parent's whole remaining value was the composition edge.

**The check that separates the two, and it is one command:**
```
grep -rn <symbol> --include=*.ts apps/ packages/ | grep -v <producing-package-path>
```
Empty output means published-not-composed, regardless of how many barrels, interfaces and delegates the
symbol passes through inside its own package. Global rail CLAUSE 1 says exactly this — "Exports the symbols"
is not composition — but the failure mode is subtle because the internal plumbing *looks* like adoption:
interface entry, delegate entry, facade method, three files, all real.

Corollary for architects re-measuring a DONE prerequisite: verify the CALL SITE, not the export chain. A
DONE flag plus a definition line plus a delegate line still proves nothing about adoption.

Related: `mem:deps-done-is-not-deps-reachable`, `mem:type-only-export-invisible-to-count-test`,
`mem:qa-untracked-deliverable-passes-every-habitual-check`.
