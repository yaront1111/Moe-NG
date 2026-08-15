# Independent canonical-byte and digest guards need disjoint comparisons

When a sealed format carries `canonical body || digest tail`, a digest guard and a canonical re-encode guard are NOT independently mutation-testable if the re-encode guard compares the entire sealed envelope. Changing only the tail is then caught by both guards, so deleting the digest comparison leaves its test green.

Keep the authorities disjoint:
- Guard A recomputes the semantic/reduced-domain digest and compares it to the carried tail.
- Guard B re-encodes and compares canonical BODY bytes to received BODY bytes.
- Header/framing are validated separately.

This lets a tail-only forgery exercise only A, while a reordered/noncanonical body with the authentic digest exercises only B. Mutate each guard separately and require its named test to accept/refuse incorrectly.