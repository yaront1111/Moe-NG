# Gotcha: replaying a receipt is not validating the presented state

Replaying `creationReceipt.command` proves what the reducer would have produced, but not that the caller-presented state equals that result. If code returns the replayed state without comparing it to the presented record, altered authority bytes are silently accepted and discarded.

Require a descriptor-safe canonical equality/digest comparison between the exact presented state and reducer output, then perturb every authority-relevant field and pin one exact refusal code/layer.