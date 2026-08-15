# Decision: distribution compatibility is enforced by a packaging wrapper, not copied into every component

When component source paths are outside the distribution task's ownership and a future IDE adapter depends on the packaging contract, put signed-manifest construction and startup admission at the packaging boundary.

## Rules
1. The artifact container embeds a signed canonical manifest; the production startup wrapper decodes it, rehashes embedded assets, verifies Ed25519 against an injected trusted key map, checks an external trusted expectation, and invokes the launch port only after admission.
2. Do not copy lifecycle or API compatibility policy into every adapter. Compose the existing live control-room/daemon pins; a distribution verifier owns authenticity, installed-byte integrity, exact component-set completeness, and stale-set rejection.
3. Agreement among artifacts is insufficient: an entirely stale set can agree. Trusted startup expectations must pin source SHA/object format, schema hash/API pins, expected component IDs, built-in skill/template identities, and trusted key IDs. Missing/unverifiable evidence fails closed.
4. A future artifact that depends on this contract is named rather than fabricated. For M4, `task-9fd52b41f3ea4aad8c0c07bbe6fd3025` is the real JetBrains consumer; generic IDE packaging tests cannot be reported as a built JetBrains binary.
5. Deterministic rebuild identity excludes time, absolute/temp paths, locale, enumeration order, and platform separators. Normalize logical paths and sign only canonical unsigned bytes.
6. Built-in skill bundles are validated through the production skill-manifest surface and embedded by ID/version/digest. Runtime/user/project skills remain external provenance inputs and cannot substitute for a built-in entry.
7. Failure tests pin `DISTRIBUTION_MISMATCH`, a stable reason, and the refusing layer; inventory sweeps pin exact non-zero counts/sets so zero generated cases cannot pass.