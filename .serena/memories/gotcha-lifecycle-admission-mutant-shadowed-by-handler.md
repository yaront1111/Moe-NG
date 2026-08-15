# Lifecycle admission mutants can be shadowed by handler guards

A reducer-result test may stay green after adding an illegal lifecycle to a transition table when a later handler guard refuses the same command with the same stable code and layer.

On the goal epoch advance, admitting `DRAFT` still hit the predecessor check because valid DRAFT state has `activeGraphRevisionRef: null` while a valid command predecessor is a non-empty ref. Both paths returned `ILLEGAL_TRANSITION` at layer `GOAL`, so the outcome assertion could not identify the admission defect.

Pin lifecycle fences against the production admission surface itself:
`expect(GOAL_TRANSITIONS["goal.advance_graph_epoch"]).toEqual(["EXECUTION_ENABLED"])`.
Keep the reducer refusal assertion too. Mutating the table to include DRAFT must then fail on the exact table assertion. This is not a test helper reimplementation; it asserts the production authority directly.