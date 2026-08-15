# Historical @moe/runner QA snapshots need the native dist edge

When the shared tree has foreign in-progress runner changes, verify an earlier task commit from a temporary `git archive` snapshot rather than resetting/stashing the shared tree. A plain archive does not contain ignored native build output, so the full runner suite will fail four Windows Job tests:
- three smoke cases cannot create below `dist/windows-job-native/release`;
- deterministic broker resolution returns null.

For an exact historical run, expose both the existing workspace dependency tree and the existing root `dist` to the snapshot (junctions are sufficient), then invoke the real `tsc` and `vitest` binaries directly against the snapshot. Do not let pnpm auto-install through a junction: its modules purge can target the shared dependency tree. Remove junctions before recursively deleting the verified fixed snapshot path.