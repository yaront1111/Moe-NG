import { expect, it } from "vitest";

import {
  DOCUMENT_WORK_EVENT_TYPE,
  DOCUMENT_WORK_RECORD_COMMAND_KIND,
} from "./document-work-service.js";

it("pins the non-authoritative document-work vocabulary", () => {
  expect([DOCUMENT_WORK_RECORD_COMMAND_KIND, DOCUMENT_WORK_EVENT_TYPE])
    .toStrictEqual(["document-work.record", "DocumentWorkProposalRecorded"]);
});
