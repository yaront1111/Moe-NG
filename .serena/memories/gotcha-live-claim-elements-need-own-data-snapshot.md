# LiveClaims table safety includes its element records

Checking only the array descriptors and whether each element is a Proxy is insufficient. If the boundary forwards an ordinary element by reference, downstream code like `claim["dimension"]` invokes caller getters and reads inherited prototype fields.

QA probe: use a valid claim payload whose `liveClaims` contains an ordinary object with an enumerable getter for `dimension` returning a non-default dimension, plus data `state` and `slotRef`. A vulnerable boundary executes the getter and may grant because the record counts as zero default slots.

At an authority boundary, snapshot/validate each array element too: ordinary/null prototype, exact own enumerable data fields, no symbols/extras/accessors/proxies. Use the same recursive detacher as every other section; a proxy-only or one-level array copier recreates the hole at the next depth. Keep structural and content faults distinct when attribution matters: a structural element fault may invalidate outer routing, while an otherwise data-only element with an extra field can reach the owning slot-ceiling validator.

Assert the getter hit count BEFORE decoding the refusal. Otherwise a mutant that executes the getter and grants throws inside a refusal helper first, hiding the decisive nonzero hit. Also mechanically enumerate object/array paths from a non-empty valid fixture and pin the discovered paths/count against a hand-written list; hand-listed targets and empty arrays silently omit element depth.
