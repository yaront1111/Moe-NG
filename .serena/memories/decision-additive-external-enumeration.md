# Additive external enumeration compatibility

When extending a widely implemented observer/port with a read-only enumeration capability:
- Keep the low-level interface method optional if existing caller-supplied structural fakes would otherwise break; require the shipped production factory to implement it and make the higher-level consumer fail closed with an exact UNAVAILABLE code/layer when absent.
- Return a frozen observation carrying deterministic digest/count, not a bare empty array. Missing directory, successful-empty observation, unreadable entry, and overflow are distinct facts.
- Bound at the OS iterator (incremental read, fail at N+1), close handles on every path, expose basenames rather than raw paths/errors, and sort with a code-unit comparator rather than localeCompare.
- Tests must invoke the shipped production factory/store surface, pin exact code and refusing layer, assert generated case count >0 and exact executed-set equality, and mutation-kill the production parser/classifier.
- For Git `for-each-ref`, Git does not offer `-z`: use NUL-delimited fields and validate the emitted LF record delimiter exactly; never add a shell/second parser just to claim pure-NUL framing.