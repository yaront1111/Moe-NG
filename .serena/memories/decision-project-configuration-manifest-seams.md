# Decision: split path-neutral project configuration identity by package seam

For the M5 benchmark configuration identity, keep three responsibilities separate:

1. `@moe/contracts`: browser-safe closed V1 types/vocabularies and descriptor-safe immutable parsing only. It must not root-export a module that statically imports `node:crypto`; the contracts root has browser consumers and existing bounded JSON deliberately avoids node:* imports.
2. `@moe/core`: Node/domain canonical encoding and domain-separated SHA-256. `settingsDigest` hashes canonical bytes of every settings field except itself; the full stored manifest including digest has one canonical byte representation. Compose `decodeBoundedJsonBytes` and the manifest parser through the bare `@moe/contracts` root.
3. `@moe/daemon`: one fixed project-scoped event/decision aggregate for selection and a bounded stable-tail current reader. Persist identical canonical manifest bytes in event and decision result, verify event/decision/project/request/result agreement, then compare the freshly decoded digest to the required expected digest. Missing, stale, conflict, or unreadable remains UNKNOWN/NONE.

Do not add configuration to `ProjectState`: that expands reducers/bootstrap/restore for unrelated currentness. Do not use an open JSON settings map: it cannot prove complete authority coverage. Do not add normalized SQLite schema when the generic event+decision ledger already provides atomic CAS/replay/reopen for one current-selection aggregate. Never substitute session `profileRevisionId` or a physical path for `settingsDigest` or orchestration source identity.

Tasks establishing the seam: `task-0c21ba2f07cc4f4a829e475bbd7f0562` (contract), `task-bcea70569f714367b2e50c1734433631` (core codec), `task-5dfc98fc3e7f4035a8012bd9ba032de3` (daemon integration). Eventual real consumer: benchmark harness `task-b937811e8b72459ea169e5fff1238ce1`.
