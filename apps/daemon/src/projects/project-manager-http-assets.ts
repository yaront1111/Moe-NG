import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  assetIsUnchanged,
  locateControlRoomAsset,
  readControlRoomAssetBytes,
} from "../http/static-asset-host.js";
import type { ControlRoomAssetRoot } from "../http/static-asset-host.js";
import type { ProjectManagerHttpCode } from "./project-manager-http-contract.js";

export function serveProjectManagerAsset(
  request: IncomingMessage,
  response: ServerResponse,
  assets: ControlRoomAssetRoot,
  authority: string,
  path: string,
  refuse: (response: ServerResponse, code: ProjectManagerHttpCode) => void,
): void {
  if (request.headers.host !== authority) {
    refuse(response, "PROJECT_MANAGER_HOST_INVALID");
    return;
  }
  const located = locateControlRoomAsset(assets, request.method ?? "", path);
  if (located.kind === "LISTENER_REFUSAL") {
    refuse(response, located.code);
    return;
  }
  const headers = { ...CONTROL_ROOM_ASSET_RESPONSE_HEADERS, "content-type": located.contentType,
    etag: located.etag };
  if (request.method === "HEAD") {
    response.writeHead(200, { ...headers, "content-length": located.size });
    response.end();
    return;
  }
  if (assetIsUnchanged(located, request.headers["if-none-match"])) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const bytes = readControlRoomAssetBytes(located);
  if (!(bytes instanceof Uint8Array)) {
    refuse(response, bytes.code);
    return;
  }
  response.writeHead(200, { ...headers, "content-length": bytes.byteLength });
  response.end(bytes);
}
