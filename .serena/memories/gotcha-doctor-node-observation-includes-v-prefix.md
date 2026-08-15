# Doctor runtime Node observation includes the v prefix

`collectDoctorVersionReport()` ultimately records the Node runtime from `process.version`, not `process.versions.node`.

Therefore the observed value is shaped like `v24.16.0`, while `process.versions.node` is `24.16.0`. A root-surface test that compares against `process.versions.node` fails even though the collector is correctly reporting its existing contract. When proving executing-host truth, compare `report.observed.node` to `{ known: true, value: process.version }`.

Found during task `task-f6ef0a45f52c45c7bb54f250170aa223`.