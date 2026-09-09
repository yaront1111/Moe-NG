/** The capture port needs no DOM types. Keep Playwright's browser-only declarations
 * outside Node-only consumers that transitively import the daemon. */
export interface PreviewPage {
  goto(url: string, options: { readonly timeout: number; readonly waitUntil: "load" }): Promise<unknown>;
  screenshot(options: { readonly path: string; readonly type: "png" }): Promise<unknown>;
  close(): Promise<void>;
}
export interface PreviewBrowserContext {
  newPage(): Promise<PreviewPage>;
  close(): Promise<void>;
}
export interface PreviewBrowser {
  newContext(options: { readonly viewport: { readonly height: number; readonly width: number } }): Promise<PreviewBrowserContext>;
  close(): Promise<void>;
}

export async function launchPreviewBrowser(): Promise<PreviewBrowser> {
  // Runtime dependency is pinned by apps/daemon/package.json. A nonliteral import
  // deliberately avoids importing Playwright's full DOM declaration graph into Node.
  const packageName: string = "playwright";
  const loaded: unknown = await import(packageName);
  return (loaded as { chromium: { launch(): Promise<PreviewBrowser> } }).chromium.launch();
}
