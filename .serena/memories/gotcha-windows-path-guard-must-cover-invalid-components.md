# Windows path guards must cover invalid components

Drive-absolute + no traversal + no colon is not a complete Windows local-path guard. Component names containing `< > " | ? *`, ASCII controls 1-31, and special device names such as `CONIN$` / `CONOUT$` can pass a narrow segment check and reach process creation even though the task promised malformed/device refusal before spawn.

Use a generated nonzero case table in both executable and cwd positions. Each failure must assert its exact PROCESS_BOUNDARY code and `WINDOWS_PROCESS_REQUEST` layer, and the production boundary must prove an empty resolve/spawn log. Include positive controls so the guard does not reject ordinary names merely containing reserved substrings.