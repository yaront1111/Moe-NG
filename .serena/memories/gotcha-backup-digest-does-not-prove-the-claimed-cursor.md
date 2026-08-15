# A matching BackupGeneration digest does not prove a separately claimed cursor

A restore can durably bind a verified signed generation digest while a later reconciliation record independently accepts `backupCursor`. If completion only compares generation digests and hashes the record's cursor, it can approve a cursor that never belonged to the installed generation.

This occurred in R3 completion: the production harness built the signed manifest at the real store cursor, but the positive completion fixture supplied hard-coded cursor 42 and succeeded. The approval digest was exact over the wrong claim.

Rule: persist/read the verified manifest cursor (or an authoritative installed-generation record containing it) and compare it to reconciliation before constructing the approval digest. A field being hashed proves only that approval covered the field, not that the field came from the authoritative producer. Test with a real signed generation and a different reconciliation cursor, asserting code, refusing layer, and zero writes.