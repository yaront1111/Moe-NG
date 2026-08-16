# task-22cfca91c5134b24aaf3e5734444fb93 — portability shadow gate SPIDR handoff

Architect architect-f956ffe1, 2026-08-17. The monolithic acceptance plan was not submitted. Fresh code probes showed missing durable bytes/public edges plus an unresolved provider-scope contradiction, so the parent is BLOCKED and released. No repository source was edited.

## Measured blockers

1. packages/import/src/import-apply.ts persists canonicalPayload(record), which serializes only record.payload. Durable events omit non-invertible legacyId, sourcePath, and provenance; eventId and command counts/digests cannot reconstruct CLAIM/LINK facts.
2. apps/daemon does not depend on @moe/import and has no production semantic ShadowProjection reader/mapper. BoardProjection contains only aggregates/byType/eventTotal/checkpoint and is not a semantic substitute.
3. Root acceptance dependencies and public production entrypoints are absent: no installed daemon stdio bin, and JetBrains host is not exported as a public subpath. JetBrains has no MCP command translation by design.
4. Provider task d288's accepted Claude dispatch conflicts with its public-root/read-only/no-child-process rails: the Foundation service/reader are not root-exported and a real dispatch writes authority/builds the launcher.
5. The existing exact-SHA receipt for 6cd4c17 (run 31919185835; Linux/Darwin/aggregate green) is historical. task-6cb Foundation dispatch landed later, so final portability evidence must target a new exact descendant SHA.
6. Root test:integration and a real nonempty test:migration already exist; do not edit package.json merely to add/alias them.

## Filed chain

- task-a6775ac56d714da388e6b28343eb806e — versioned canonical import shadow-fact codec/producer (wire/schema regression).
- task-1e44b9b9d50e4cbab57a09d0105fdade — daemon -> @moe/import manifest/lock edge.
- task-80fce1d1d625453098bd526d61c5ddb8 — durable daemon shadow reader/mapper; hard-depends on the preceding two and owns only reader.ts/.js/.test plus daemon index.
- task-049bb927ecee40ac856aa2aa1a99b832 — copied-project projection comparison matrix; hard-depends on task-80fce1.
- task-f33028b5374044bfa84deb5ed979277b — installed daemon stdio entrypoint, JetBrains ./host subpath, and root acceptance dependency edges.
- task-efe5465f9b16426dab617944b9fa57d2 — stdio-vs-HTTP command identity plus separate JetBrains distribution/endpoint/control-room matrix.
- task-d288909ba25a42d98b4d33abf70d185c — provider matrix, retained BACKLOG pending human decision dec-a8923b1e17bf460390742b6b8ddb5eab.

## Provider decision

dec-a8923b1e17bf460390742b6b8ddb5eab asks:
A (recommended): compare Claude and Codex symmetrically through shipped public read-only observe/probe/render/reconcile surfaces; execution stays UNKNOWN here and task-6cb remains the separate dispatch proof.
B: first ship a public sealed Foundation real-dispatch evidence receipt, then read it.
Never deep-import or synthesize a durable dispatch fixture.

## Parent resume/final ownership

After every child is DONE and the provider decision is resolved, re-plan task-22cf as the final hardening task. It must extend the cross-host workflow/evidence contract to run the portability integration and migration lanes on Linux/Darwin, bind all fixtures/handshakes/case digests to one exact final SHA, obtain the authorized external run, run exact-sha-evidence-gate for that SHA, then run pnpm test:integration and pnpm test:migration separately with nonzero counts. It owns the whole-slice adversarial/read-only audit. No imported-state execution, cutover, best-tool claim, old 6cd receipt reuse, or test-built current projection.