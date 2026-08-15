# Decision: distinguish child startup admission from bounded lifetime

For Node ChildProcess launch APIs, synchronous `spawn()` return/pid is not the truthful admission boundary. Resolve startup admission only on the ChildProcess `spawn` event; failed OS spawning emits `error` instead.

Expose two facts:
1. a start result that can refuse a known typed preflight or accept on `spawn`;
2. a separate lifetime/exit promise for later cleanup/slot release.

Keep the old lifetime-returning adapter as composition over the new starter when callers depend on timeout behavior.

Rules:
- Typed catches are scoped to the exact authority call; error-message/structural lookalikes and unknown child errors reject unchanged.
- Attach spawn/error/exit listeners before stdin/timers.
- Guard settlement because error may be followed by exit.
- Pre-admission terminal paths must reject start, never hang.
- Post-admission failures settle lifetime without retroactively relabeling admission.
- When `shell:true`, spawn admits the shell, not inner-command readiness.
- If timeout frees the slot before OS death is proven, document the lifetime promise as bounded settlement, not physical-exit evidence.

Applied in task-d4329e8d; consumer task-912567934d54419683d1518d60059409.