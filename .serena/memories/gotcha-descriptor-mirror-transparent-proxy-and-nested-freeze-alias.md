# Gotcha: descriptor-safe mirrors can still accept transparent Proxies, and shallow alias tests miss deep-freeze input mutation

A parser that uses `Object.getPrototypeOf`, `Reflect.ownKeys`, and own data descriptors can safely avoid `get` traps but still accepts `new Proxy(validRecord,{})` unless it explicitly detects proxies (for Node, `node:util` `types.isProxy`). Hostile-proxy tests using only lying/throwing traps do not prove that proxies are categorically refused; include transparent proxies at every promised boundary.

Likewise, `JSON.stringify(input)` before/after cannot detect descriptor-state mutation such as `Object.freeze`. A result may copy its top-level record yet retain a nested reference to caller authority; a later deep-freeze then freezes the caller's object. Test with fresh mutable nested objects, record their descriptors/frozen states, and recursively assert no object identity from the successor graph occurs in the caller graph.
