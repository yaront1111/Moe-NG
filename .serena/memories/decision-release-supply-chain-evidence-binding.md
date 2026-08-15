# Decision: release evidence uses one frozen commit and layered raw/canonical digests

For release supply-chain tasks in moe-next:

1. Freeze the implementation commit before generating evidence. Any code/config/lockfile edit changes the source SHA and invalidates all prior release evidence.
2. Build twice on each supported OS. Store both raw artifact hashes. Compare exact manifests/assets and a normalized digest that may omit only an enumerated exact JSON pointer or byte path with a non-empty platform-specific reason.
3. Never make normalization a broad glob, regex, or caller-controlled ignore list. An undeclared difference is `BUILD_NON_REPRODUCIBLE_UNDECLARED`; an absent OS receipt is `SUPPORTED_OS_EVIDENCE_MISSING` and remains UNKNOWN.
4. Cross-OS aggregation requires one Windows, one Linux, and one macOS receipt with the same source SHA; raw package hashes need not match across different OS targets.
5. Consume signature and doctor compatibility through production package-root/root-script seams. Test-tier release manifests and helper reimplementations are not authority.
6. Bind the source SHA, lockfile/tool identities, raw/normalized package digests, SBOM, dependency/license/audit reports, signature verification, doctor compatibility, commands/exits, and runner OS/image/arch facts in the final record.
7. Generated evidence lives outside the repository and is uploaded as an artifact; implementation tasks do not commit it or publish a release.
8. The exact verification command must be the command recorded for completion, run without a pipeline that hides the real exit status.
