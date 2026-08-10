#!/usr/bin/env bash
# Mutation drill harness. Temporary; removed before any commit.
set -u
ROOT=/d/projexts/moe-next
REG=$ROOT/apps/daemon/src/coordination/recipient-registry.ts
REC=$ROOT/apps/daemon/src/coordination/recipient-registry-records.ts
BK=/tmp/registry-backup

restore() {
  cp "$BK/recipient-registry.ts" "$REG"
  cp "$BK/recipient-registry-records.ts" "$REC"
}

run() {
  cd "$ROOT/apps/daemon" || exit 1
  npx vitest run --root . --config package.json src/coordination 2>&1 \
    | grep -E "^ (FAIL|✓|×)|Tests  |AssertionError|expected .* to (be|deeply|match)" | head -25
}

drill() {
  echo "=================== DRILL $1: $2"
  run
  restore
  cd "$ROOT" || exit 1
  echo "--- restored hashes:"
  git hash-object "$REG" "$REC"
}

restore

# 1 - active-session check removed: accept ANY authority record, not just an active one.
perl -pi -e 's/sessions\.readActiveSession\(sessionId\)/sessions.readSessionAuthority(sessionId)/' "$REG"
drill 1 "writer accepts a non-active session"

# 2 - role validation widened to accept any string.
perl -0pi -e 's/(if \(!isRecipientIdentifier\(sessionId\)\) return null;\n  if \(typeof role !== "string")[^\n]*/$1) return null;/' "$REC"
drill 2 "role vocabulary widened in readRecipientAddress"

# 3 - project scoping dropped from the resolver.
perl -pi -e 's/if \(record\.revoked \|\| record\.projectId !== projectId\) return NOT_KNOWN;/if (record.revoked) return NOT_KNOWN;/' "$REG"
drill 3 "resolver project scoping dropped"

# 4 - revocation made runtime-only: the fold no longer marks the record revoked.
perl -pi -e 's/return \{ \.\.\.previous, revoked: true, version \};/return { ...previous, revoked: false, version };/' "$REC"
drill 4 "revocation not durable in the fold"

# 5 - idempotence broken: the decision key varies per attempt, so a replay commits again.
perl -pi -e 's/const key: CommandDecisionKey = \{ commandId, principalId: plan\.principalId, projectId \};/const key: CommandDecisionKey = { commandId: `${commandId}\/${plan.expectedVersion}`, principalId: plan.principalId, projectId };/' "$REG"
drill 5 "decision key varies so a replay appends a second event"

# 6a - positive answer returned unfrozen.
perl -pi -e 's/return Object\.freeze\(\{ known: true as const, role: record\.role \}\);/return { known: true as const, role: record.role };/' "$REG"
drill 6a "positive answer unfrozen"

# 6b - frozen, exact keys, right facts, but an exotic prototype the consumer rejects.
perl -pi -e 's/return Object\.freeze\(\{ known: true as const, role: record\.role \}\);/return Object.freeze(Object.assign(Object.create({}), { known: true as const, role: record.role }));/' "$REG"
drill 6b "exotic prototype only the consumer gate can see"

echo "=================== FINAL"
cd "$ROOT" || exit 1
git hash-object "$REG" "$REC" "$ROOT/apps/daemon/src/coordination/recipient-registry.test.ts"
