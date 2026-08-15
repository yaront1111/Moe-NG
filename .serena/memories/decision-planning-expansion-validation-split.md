# Planning expansion validation split and bridge reachability

When a planning contract needs new validation but `planning-validation.ts` is at the directory's hard 250-line sweep limit:
- do not evade the guard with long lines and do not churn legacy hostile-input validators merely to manufacture headroom;
- add a focused expansion-validation leaf and compose the existing legacy production predicates through a base-state projection;
- keep the legacy validator byte-stable so INITIAL behavior remains isolated;
- remember core's runtime-entrypoint audit is exact: every .js bridge must correspond to a module reachable from `packages/core/src/index.ts`, and every reachable production module needs a bridge;
- therefore either defer the bridge until a consumer makes the leaf reachable, or, when the validator is part of the current public deliverable and index has measured headroom, add the exact LF bridge plus compact curated root exports in the same task;
- reason-coded validation inspection should pin both stable code and exact target layer; boolean predicates alone are insufficient evidence for malformed/refusal cases under the board rail.

Applied to `task-fcad40b6d26243439cd19fd3e49c924d`: new validation leaf + bridge + root publication, with index measured at 237 and required to remain <=250.