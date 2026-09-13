# Reading complete planning inputs over MCP

`design_read` and `product_contract_read` are queries. Their MCP arguments are
`correlationId` and `payload`; command IDs and expected versions do not belong in
the query envelope. Restart existing agent sessions after updating Moe so they
receive the corrected tool schema and paging instructions.

For either tool, begin with:

```json
{"goalRef":"<goal ID>","offset":0,"limit":4096}
```

The response contains ordered JSON text fragments, each with `offset`, `limit`,
`totalLength`, `nextOffset`, `text`, and `contentSha256`. Contract pages use format
`moe-product-contract-json-page/1` and include the approved `gateRef`. Design pages
use `moe-design-json-page/1` and include the selected `version`.

Read every page until `nextOffset` is `null`. Continue with that offset and the
first page's exact `contentSha256`, plus its `gateRef` for contracts or `version`
for designs. Concatenate the decoded `text` values in order and parse the completed
JSON document. Individual fragments may end inside a string or identifier. No
file-read tool is required, and IDs must never be inferred from PRD numbering.

Each serialized page is at most 8,192 UTF-8 bytes, including metadata and escaping.
Offsets and the requested limit count UTF-16 code units; the limit is 1–4,096.
The server may return fewer characters to stay within the byte bound. Continuation
requests require revision and content pins, preventing mixed approvals or design
projections. A `PRODUCT_CONTRACT_READ_REVISION_CHANGED` or
`DESIGN_READ_REVISION_CHANGED` response means discard partial text and restart at
offset zero without pins. Other read refusals retain their existing meaning.

A request without paging fields keeps the original complete response for small
documents and automatically returns the first page for large documents. Complete
contract JSON contains `gateRef` and `revision.requirements/criteria`; complete
design JSON contains `record` and `versions`. Existing explicit design-version
reads still select that historical revision.
