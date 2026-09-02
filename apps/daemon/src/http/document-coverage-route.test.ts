/**
 * The coverage route's transport contract, exercised PURELY (no listener): the capability
 * gate, the absent-port refusal, the project fence, the exact one-key body, and that a
 * well-formed selector reaches the port verbatim and its answer travels back untouched.
 */
import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type {
  DocumentCoverageReadPort, DocumentCoverageSelector,
} from "./document-coverage-contract.js";
import { coverageSelectorOf, handleDocumentCoverageReadRequest } from "./document-coverage-route.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";

const encoder = new TextEncoder();
const body = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const SHA = "a".repeat(64);
const REFUSAL = Object.freeze({
  code: "DOCUMENT_COVERAGE_READ_MALFORMED", layer: "DOCUMENT_COVERAGE_READ",
  outcome: "REFUSED" as const,
});

function portFor(boundProjectId: string, seen: DocumentCoverageSelector[]): DocumentCoverageReadPort {
  return { boundProjectId, readCoverage: (selector) => { seen.push(selector); return REFUSAL; } };
}

function request(requestBody: unknown) {
  return { body: requestBody, credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION };
}

describe("coverageSelectorOf", () => {
  it("admits exactly one string-valued selector key and nothing else", () => {
    expect(coverageSelectorOf(body({ contentSha256: SHA }))).toEqual({ contentSha256: SHA });
    expect(coverageSelectorOf(body({ goalRef: "goal-1" }))).toEqual({ goalRef: "goal-1" });
    for (const malformed of [
      body({}), body({ contentSha256: 7 }), body({ goalRef: null }),
      body({ contentSha256: SHA, goalRef: "goal-1" }), body({ goalRef: "goal-1", projectId: "p" }),
      body({ runId: "run-1" }), body([SHA]), body("goal-1"), encoder.encode("{not json"),
    ]) {
      expect(coverageSelectorOf(malformed)).toBeNull();
    }
  });
});

describe("handleDocumentCoverageReadRequest", () => {
  it("refuses a principal without the goal capability before touching the port", () => {
    const seen: DocumentCoverageSelector[] = [];
    const dispatch = handleDocumentCoverageReadRequest({
      authenticator: authenticator([CAPABILITIES.PLANNING]),
      documentCoverage: portFor("proj-0001", seen),
    }, request(body({ goalRef: "goal-1" })));
    expect(dispatch).toEqual({
      body: { code: "DOCUMENT_COVERAGE_READ_CAPABILITY_DENIED", layer: "DOCUMENT_COVERAGE_READ",
        outcome: "REFUSED" },
      httpStatus: 200, kind: "REPLY",
    });
    expect(seen).toEqual([]);
  });

  it("refuses at the listener when no port is composed", () => {
    expect(handleDocumentCoverageReadRequest(
      { authenticator: authenticator([CAPABILITIES.GOAL]) }, request(body({ goalRef: "goal-1" })),
    )).toEqual({ code: "LISTENER_DOCUMENT_COVERAGE_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  });

  it("fences a port bound to another project", () => {
    const seen: DocumentCoverageSelector[] = [];
    const dispatch = handleDocumentCoverageReadRequest({
      authenticator: authenticator([CAPABILITIES.GOAL]),
      documentCoverage: portFor("proj-elsewhere", seen),
    }, request(body({ contentSha256: SHA })));
    expect(dispatch).toMatchObject({
      body: { code: "DOCUMENT_COVERAGE_READ_PROJECT_MISMATCH" }, httpStatus: 200, kind: "REPLY",
    });
    expect(seen).toEqual([]);
  });

  it("refuses a body that is not exactly one selector, without asking the port", () => {
    const seen: DocumentCoverageSelector[] = [];
    const dependencies = {
      authenticator: authenticator([CAPABILITIES.GOAL]), documentCoverage: portFor("proj-0001", seen),
    };
    for (const malformed of [body({}), body({ contentSha256: SHA, goalRef: "g" }), body({ goalRef: 1 })]) {
      expect(handleDocumentCoverageReadRequest(dependencies, request(malformed)))
        .toEqual({ code: "LISTENER_DOCUMENT_COVERAGE_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
    }
    expect(seen).toEqual([]);
  });

  it("forwards either selector verbatim and replies with the port's own answer", () => {
    const seen: DocumentCoverageSelector[] = [];
    const dependencies = {
      authenticator: authenticator([CAPABILITIES.GOAL]), documentCoverage: portFor("proj-0001", seen),
    };
    expect(handleDocumentCoverageReadRequest(dependencies, request(body({ goalRef: "goal-1" }))))
      .toEqual({ body: REFUSAL, httpStatus: 200, kind: "REPLY" });
    expect(handleDocumentCoverageReadRequest(dependencies, request(body({ contentSha256: SHA }))))
      .toEqual({ body: REFUSAL, httpStatus: 200, kind: "REPLY" });
    expect(seen).toEqual([{ goalRef: "goal-1" }, { contentSha256: SHA }]);
  });

  it("carries an authentication refusal out at the adapter's own status", () => {
    const dispatch = handleDocumentCoverageReadRequest(
      { authenticator: authenticator([CAPABILITIES.GOAL]) },
      { body: body({ goalRef: "goal-1" }), credential: null, protocolVersion: WIRE_PROTOCOL_VERSION },
    );
    expect(dispatch.kind).toBe("REPLY");
    if (dispatch.kind === "REPLY") expect(dispatch.httpStatus).toBeGreaterThanOrEqual(400);
  });
});
