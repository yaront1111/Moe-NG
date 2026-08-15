# Gotcha: bounded event arrays can still overflow argument spread

In provider stream anomaly analysis, do not compute a range with `Math.max(...sequences)` / `Math.min(...sequences)` when the allowed event count is large. With `MAX_FRAMED_LINES = 262_144`, V8 raises `RangeError: Maximum call stack size exceeded` even though the input satisfies the documented bound.

Use an O(n) min/max fold over the `Set<number>` instead. Pin it with a production-surface test that passes exactly `MAX_FRAMED_LINES` parsed lines to the analyzer. Task task-a0fa6da4024647d69c25d273b217eaeb observed RED at codex-stream-anomalies.ts range spread, then GREEN 13/13 after the fold. The proven Claude adapter still has the same spread shape and should be repaired only in a task that owns its path.