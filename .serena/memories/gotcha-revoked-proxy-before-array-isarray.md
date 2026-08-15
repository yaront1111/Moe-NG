# Hostile proxies must be contained before ordinary JS reflection

`Array.isArray(revokedProxy)`, `Object.keys(proxy)`, and prototype/descriptor reflection can throw. An ingress decoder that calls them outside a containment boundary leaks raw exceptions rather than returning its stable malformed-request code/layer.

Put every reflection operation inside a guarded decoder (including fulfilled dependency results), reject proxies where appropriate before reflective handling, and test both a revoked proxy and an `ownKeys` trap that throws.