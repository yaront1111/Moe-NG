# Gotcha: narrowing a field from `unknown` to an interface breaks `as Record<string, unknown>` in every consumer

A task whose deliverable is "stop typing this field as `unknown`" silently pulls in every call site that
widened it back out with a bare `as Record<string, unknown>` assertion. Interfaces get no implicit index
signature, so the assertion stops being a legal conversion:

```
error TS2352: Conversion of type 'EffectIntent' to type 'Record<string, unknown>' may be a mistake because
neither type sufficiently overlaps with the other.
  Index signature for type 'string' is missing in type 'EffectIntent'.
```

Type ALIASES of object literal types do get an implicit index signature; interfaces do not. So the same
edit can be free for one shape and a compile error for another — do not generalise from one call site.

Cheap pre-measurement, before you commit to a plan or a file list: grep the consumers
(`grep -rn "\.successors" --include=*.ts`) and typecheck the exact shape in a throwaway dir outside the repo:

```bash
mkdir -p /tmp/tsprobe && cat > /tmp/tsprobe/p.ts <<'EOF'
interface Shape { readonly a: string }
declare const s: { readonly f: Shape }
const r = s.f as Record<string, unknown>
export { r }
EOF
(cd /tmp/tsprobe && npx -p typescript@5 tsc --strict --noEmit p.ts)
```

Exit 2 means your five-file plan is really a six-file plan. Fix is `as unknown as Record<string, unknown>`
at the consumer, which is a forced out-of-plan edit — prove it forced by reverting just that hunk and
showing the package typecheck redden (`mem:qa-prove-an-out-of-plan-edit-was-forced`).

Found on task-311adb23 (`ClaimSuccessors.effectIntent`: `unknown` -> `EffectIntent`), consumer
`apps/daemon/src/work/work-race-world.ts`.
