# Never share a version literal across incompatible record schemas

Two packages currently declare incompatible `ProviderRunRecord` keysets under `moe-provider-run-record/1`. A codec that checks only the version and generic JSON canonicality can accept one package's record, cast it as the other package's type, and produce apparently authentic durable bytes.

Before adapting one public record into another:
- compare exact keysets and nested refusal unions;
- ensure the codec validates the complete schema, not just a version discriminator;
- preserve every upstream code and layer in separately typed fields;
- allocate a new durable-envelope version when the schema changes;
- embed/alias the authoritative producer object instead of remapping its decisions.
A TypeScript cast or canonical JSON round-trip is not runtime schema validation.