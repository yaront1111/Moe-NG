# Cursor progress does not prove a paged scan terminates

For a pager that takes a new snapshot per call, these guards are insufficient:
- the page is nonempty when hasMore is true;
- nextCursor strictly exceeds the prior cursor.

A legitimate concurrently growing stream can satisfy both forever. An unbounded synchronous loop then blocks its daemon thread rather than failing closed.

A completeness scan needs a stable finite horizon captured before traversal, an indexed finite query, or another explicit bounded contract. Test the moving-stream case in a child process or worker so the regression is externally time-bounded; assert its stable refusal code and layer. Never treat an arbitrary page cap as completeness, and never return on the first hit when uniqueness must be proved.