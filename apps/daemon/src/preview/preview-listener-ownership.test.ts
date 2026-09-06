import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { startPreviewProcess } from "./preview-process.js";
import type { PreviewProcessHandle } from "./preview-process.js";
const children: PreviewProcessHandle[] = [];
afterEach(async () => { await Promise.all(children.splice(0).map(child => child.stop())); });

it.each([true, false])("refuses another process's listener with stated port %s", async stated => {
  const foreign = createServer((_request, response) => response.end("foreign service"));
  await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
  try {
    const address = foreign.address();
    if (address === null || typeof address === "string") throw new Error("listener missing");
    const result = await startPreviewProcess({
      command: `"${process.execPath}" -e "console.log('http://127.0.0.1:${address.port}');setInterval(()=>{},1000)"`,
      port: stated ? address.port : null, workspace: process.cwd(),
    }, { startTimeoutMs: 500 });
    if ("ok" in result && result.ok) children.push(result.handle);
    expect("ok" in result && result.ok).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("foreign service");
  } finally { await new Promise<void>(resolve => foreign.close(() => resolve())); }
}, 20_000);
