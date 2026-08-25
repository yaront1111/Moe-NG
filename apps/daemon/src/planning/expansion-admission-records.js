// Runtime bridge: Node's type-stripping loader does not rewrite a `./x.js` specifier
// to `./x.ts`, so every runtime-tier module under apps/daemon/src needs this sibling.
export * from "./expansion-admission-records.ts";
