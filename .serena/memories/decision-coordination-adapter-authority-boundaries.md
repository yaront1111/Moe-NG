# Coordination adapter authority dependencies

A daemon coordination adapter must not satisfy `@moe/coordination`'s injected `authenticate`, `resolveRecipient`, or `resolveEffectBinding` ports with test callbacks or caller-provided positive facts. It needs real durable production readers.

Core command authentication is not a generic transport authenticator: it consumes `RuntimeCommandEnvelope` and closed `RuntimeCommandKind`, while coordination endpoints/capability strings use a different vocabulary. Extract/reuse the session/credential/PoP/replay decision, then apply coordination scopes separately; never fabricate runtime commands.

Treat `CURSOR_GAP` as the current production typed read outcome, with exact cursor fields, not as a refusal code/layer. If acceptance requires a refusal vocabulary, change the coordination contract in a separately owned task rather than adding an adapter-local code.

Prerequisite chain recorded in `mem:task-task-4afcb06422ed4adb89430b7ea9758d7f-handoff`.