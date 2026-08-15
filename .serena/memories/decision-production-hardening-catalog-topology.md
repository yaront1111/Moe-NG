# Production hardening catalog topology

Use this decision for exhaustive security/fault acceptance work.

- A test-authored whole-system boundary list is not authority and cannot certify exhaustiveness.
- Shared contracts may define only a dependency-free, bounded, versioned descriptor/catalog codec plus canonical bytes.
- Every production subsystem publishes a frozen local catalog beside the real public entry point/handler/protocol registry and locally asserts exact-set equality against that production surface.
- Distribution packaging computes SHA-256 over canonical local catalogs, binds the aggregate digest into the signed installed-component manifest, and startup recomputes/verifies it before request or effect authority.
- Acceptance tests load catalogs only through public production package roots and assert component set = catalog set = generated case set = executed result set, all non-empty.
- Descriptor rows carry stable production identity, operation, phases, applicable fault classes, code/layer vocabulary, host observability, and evidence-owner class. Governance task IDs stay in planning/evidence, not production bytes. The digest belongs to the catalog envelope, never inside its own rows.
- Canonical identity excludes checkout paths, platform separators, timestamps, random IDs and seeds.
- A central catalog in tests, testkit, or tools is rejected because it can drift independently and stay green.
- Hostile suites use dedicated `*.security.ts`/`*.fault.ts` configs so ordinary root Vitest does not silently count them as regression evidence.
