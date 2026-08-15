# A binding fence after an authority write leaves residue

A service that activates/commits first and checks the durable session/node binding afterward can correctly return a binding-mismatch refusal while still leaving an activation event. This violates zero-residue fail-closed behavior.

Decode and compare the durable aggregate's selected session/node and supplied binding before any mutation. Tests must inspect raw persisted events/decisions, not only the returned refusal.