# Request scope snapshot must not return the original

A port scope guard that snapshots an unknown request, checks `snapshot.projectId`, then returns the original object reopens hostile accessors and proxies. A stateful getter can name the bound project during scope validation and a foreign project when the downstream command snapshots again.

Reject accessors/custom iteration at the initial shape boundary, snapshot exact own data descriptors and bounded arrays once, freeze them, and pass only that snapshot through every downstream layer. Test the production port with a stateful projectId getter and require the exact request-shape code/layer before any foreign-scope lookup.