# Binding payload must match its verified envelope

Recomputing an identity only from decoded payload fields proves internal consistency, not consistency with the durable binding envelope. A digest-valid binding can carry outer incarnation/key-epoch columns that differ from a self-consistent payload; inspection must not publish INSTALLED or repeated-resume authority in that state.

After decoding, cross-check every duplicated fence field against the verified outer binding. Refuse with the exact unreadable/tamper code and layer. Test by installing through the production store codec with mismatched outer and inner fence fields.