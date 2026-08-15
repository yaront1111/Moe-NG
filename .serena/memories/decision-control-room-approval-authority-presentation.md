# Decision: approval UI keeps daemon authority separate from presentation context

For the control-room approval surface, `nextAllowedCommands` remains the only existing command authority. A supplied @moe/core `{ policy, gate }` context is additional truth that the resolver evaluates defensively with `decideApprovalAuthority`; when it refuses, the UI nulls the command ID and displays the exact code and canonical layer. When authority context has not yet been wired by the daemon consumer task, the UI must not invent a policy, gate, grant, code, or layer.

Keep three concepts distinct:
1. stable refusal code from APPROVAL_AUTHORITY_CODES;
2. canonical refusing layer from APPROVAL_AUTHORITY_LAYERS;
3. local client guard ID explaining which record-integrity check ran.

The first two are operator-visible contract facts. The third is diagnostics and cannot substitute for the layer. No control-room code may mint a HumanAuthorityGrant or offer a force/grant button.