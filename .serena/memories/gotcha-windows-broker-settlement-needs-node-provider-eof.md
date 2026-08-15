# Windows broker settlement needs Node provider EOF

When a Node facade owns fd3/fd4/fd5 peers for the Rust Windows Job broker, ending only fd0 is insufficient during cancel/close/timeout. The broker proves terminal stream settlement and cannot observe provider stdout/stderr EOF while Node still holds the peer endpoints open; it then waits its native settlement bound and the facade may kill it before a terminal frame arrives.

Required lifecycle:
1. On cancel/close/timeout, end broker control and close the Node provider-side endpoints.
2. Give the broker an outer kill grace longer than its native settlement bound (current facade 15 seconds versus native 5 seconds).
3. On natural COMPLETED, do not destroy provider outputs early; keep them readable until broker close.
4. Resolve completion on the child `close` event, not merely `exit`, and only then dispose handles.

A real close/cancel/timeout detached-grandchild smoke caught this; mocked status frames did not.