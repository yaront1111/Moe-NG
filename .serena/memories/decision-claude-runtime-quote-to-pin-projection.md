# Claude runtime quote-to-pin projection

A launch quote names the installed/source runtime closure, while the prepared runtime observation must name the content-addressed pinned closure. Do not make raw source and destination absolute paths artificially equal and do not ignore path fields.

The safe sequence is:
1. Recompute/validate the quote digest and require a PROVEN, nonempty, supported pinning claim.
2. Canonicalize and stream-hash the installed closure, re-observe current platform/version/capability facts, and compare that source observation with the quote on every authority field; ignore only freshness and its derived observation digest.
3. Derive a deterministic aggregate manifest/digest from kind + canonical source-relative path + file digest.
4. Copy to the private digest root, verify destination bytes, and rehash the sources.
5. Deterministically map source-relative entries to pinned canonical paths and use the production observation builder for the fresh CONTENT_ADDRESSED_COPY observation.
6. Bind both quote and fresh observation digests plus aggregate closure digest, executable path, and pin-root identity in the immutable prepared result.

This preserves exact quote equality without confusing installed paths with pinned paths and avoids trusting caller-supplied "fresh" facts.
