# A `::1` listener with strict Host validation is bound but unreachable

Building the expected `Host` authority as `` `${host}:${port}` `` yields `::1:port` for an
IPv6 loopback bind. RFC 3986 requires the literal bracketed — every real client sends
`[::1]:port` — so strict Host validation refuses **every** request while the listener
reports itself healthy with a bound port.

```ts
host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
```

Two related traps in the same guard:

- **A hostname is not a loopback address.** `"localhost"` resolves via the hosts file and
  DNS, so admitting it moves the security decision off the guard and onto the resolver.
  Allow-list literals only: `["127.0.0.1", "::1"]`.
- **Testing it needs a matching connect host.** A helper hardcoding
  `host: "127.0.0.1"` in `http.request` cannot reach a `::1` listener; parameterize it.

Also, and separately: `undici`/`fetch` treats `Host` as a forbidden header and drops it
silently, so a Host-validation test written with `fetch` never reaches the guard and proves
nothing. Use `node:http` with `setHost: false`. `Origin` *does* pass through undici.

Related: [[task-task-318379eac8b54e688eadf7130b88f78e-handoff]]
