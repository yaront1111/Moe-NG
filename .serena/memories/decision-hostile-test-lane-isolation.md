# Decision: hostile fault/security lanes use dedicated strict roots

Use dedicated root scripts plus lane-local TypeScript and Vitest configs for hostile `*.fault.ts` and `*.security.ts`; never broaden the ordinary root Vitest include. Preserve existing Foundation `*.test.ts` as ordinary regression evidence.

Each lane must:
- run `tsc -p <lane>/tsconfig.json` before Vitest;
- set an explicit lane root derived from `import.meta.url`;
- spread `configDefaults.exclude` before opposite-lane exclusions;
- set `passWithNoTests:false`, `allowOnly:false`, no retry, strict unhandled-error behavior;
- set `fileParallelism:false` and `maxConcurrency:1`;
- use a locale-independent stable sequencer over slash-normalized relative module paths;
- retain a non-authority smoke that inspects the actual config/package surface;
- mutation-prove zero discovery and type errors exit nonzero, restoring exact bytes.

The portable root scripts are:
- `test:fault = tsc -p tests/fault/tsconfig.json && vitest run --config tests/fault/vitest.config.ts`
- `test:security = tsc -p tests/security/tsconfig.json && vitest run --config tests/security/vitest.config.ts`

Forward-slash paths and pnpm's cmd/sh `&&` behavior are cross-platform; do not add POSIX-only env assignment, glob expansion, grep/rm, or piped gates. This infrastructure certifies collection/typechecking/execution only, never product security/fault authority.