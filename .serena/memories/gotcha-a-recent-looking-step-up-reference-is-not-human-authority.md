# A recent-looking step-up reference is not authenticated human authority

Checking `prefix + ISO timestamp + hex64` establishes only string shape and recency. If the suffix is not recomputed/verified against digest, project, incarnation and a durable human authentication record, any caller can mint it.

The dangerous combination is a caller-supplied approval record with `actorKind: "HUMAN"` plus a caller-supplied decide command. Core approval reducers validate record shape and lifecycle; they do not authenticate who authored the bytes. If an AGENT can hold the route capability, shape checks do not make a route human-only.

Rule: the command consumes a durable/authenticated human decision or authorization context, verifies a step-up binding over the exact protected subject, and binds that immutable approval to the recovery evidence. Positive tests must derive the reference from production authority; negative tests alter digest, project, incarnation, principal kind and step-up token independently and pin code/layer.