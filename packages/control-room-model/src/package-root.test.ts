import { expect, it } from "vitest";

import * as controlRoomModel from "@moe/control-room-model";

it("exports the truth and product presentation APIs from the package root", () => {
  expect(Object.keys(controlRoomModel).sort()).toEqual([
    "buildProductRequirements", "describeTruthClass", "sameProductContract", "sameProductScope", "selectProductArtifact",
  ]);
});
