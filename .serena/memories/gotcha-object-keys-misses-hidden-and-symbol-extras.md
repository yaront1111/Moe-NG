# Object.keys is not an exact authentication shape check

`Object.keys(value)` sees only enumerable string keys. An input carrying non-enumerable or symbol own properties can therefore pass an "exact key count" validator even when accessor reads are otherwise avoided.

At authentication boundaries:
- compare `Reflect.ownKeys(value)` against the entire allowed key universe;
- reject symbols, hidden extras, missing keys, and non-enumerable required keys;
- require every permitted property to be an own enumerable data descriptor before reading `descriptor.value`;
- apply the same rule to array snapshots, not only records.

Pin the production authorization surface to the exact stable refusal code and layer. A factory-only null assertion is insufficient: verify structurally spoofed Session/Credential/CapabilityGrant/current-binding/list inputs reach `AUTHENTICATION_FAILED/BINDING` and cause zero proof/replay/business observations.