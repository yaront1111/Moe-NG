import { expect, it } from "vitest";

import * as controlRoomModel from "@moe/control-room-model";

it("exports the truth presentation API only from the package root", () => {
  expect(Object.keys(controlRoomModel).sort()).toEqual(["describeTruthClass"]);
});
