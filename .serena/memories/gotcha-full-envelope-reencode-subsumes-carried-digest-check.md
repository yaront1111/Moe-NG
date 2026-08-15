# Full-envelope re-encode makes a carried-digest guard mutation-indistinguishable

Found while reviewing the provider-run codec slice. If a canonical record is framed as `header | body | carriedDigest`, and decode does both:

1. recompute the semantic digest and compare it with `carriedDigest`; and
2. re-encode the record and compare the **entire sealed envelope** with the input,

then guard 2 already compares the recomputed digest bytes in the tail. Mutating only the carried digest is rejected by both guards. Deleting guard 1 leaves the test green, so a requirement that each guard be independently mutation-proven cannot be met.

To make the defenses non-overlapping, split the envelope domains:

- digest guard compares recomputed digest to the carried tail;
- canonicality guard compares the re-encoded **body** to the input body (header is checked separately).

Then a tail-only mutation passes body canonicality and is caught only by the digest guard, while a reordered/whitespace body with unchanged semantic value and digest passes the digest guard and is caught only by body re-encoding. Together the checks still cover the whole envelope.

This is distinct from an external expected digest: an unkeyed digest carried in the same bytes is integrity framing, not authenticity, and an attacker who changes both canonical content and its digest can produce a new internally valid record.

Related: `mem:gotcha-canonical-json-needs-digest-and-reencode-both`, `mem:gotcha-layered-digests-defeat-mutation-drills`.