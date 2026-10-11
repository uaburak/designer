/**
 * Main's own HTTP (the account, the sign-in's code exchange, shared fonts, Google Fonts; docs/desktop.md §12.5):
 * Node's `fetch` normally; Electron's `net.fetch` — Chromium's network stack, which the `proxy-server` switch
 * reaches — when the deployment keys set a `ProxyUrl`. Called after `ready` only (net.fetch needs it).
 */
import * as electron from "electron";

let useChromium = false;

/** index.ts, before `ready`: whether a proxy is set (policy.ts `proxied`) */
export function setMainFetchProxied(on: boolean): void {
  useChromium = on;
}

export const mainFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  useChromium ? electron.net.fetch(input instanceof URL ? input.toString() : input, init) : fetch(input, init);
