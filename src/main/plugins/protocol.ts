import { protocol, type WebContents } from "electron";
import { domainsAllow, pluginUiCsp } from "./network";
import { pluginRuns, RUN_ID, type PluginRun, type PluginRuns } from "./runs";

/**
 * The `plugin:` scheme (docs/plugins.md §3.2): `plugin://<runId>/ui.html` is a run's UI document, as the editor
 * registered it with `plugins:open-ui`. The editor shows it in an iframe sandboxed without `allow-same-origin` (an
 * opaque origin: no storage, no reach into the editor), and every response carries the run's own CSP — its manifest's
 * `allowedDomains` as sources — with COEP `credentialless` (the editor is cross-origin isolated, so the frame needs a
 * COEP of its own; `credentialless` lets a plugin UI show outside pictures that send no CORP) and CORP `cross-origin`.
 * Nothing else is served; a run's document is gone once its UI closes.
 */

export const PLUGIN_SCHEME = "plugin";

/** Registered with the app's scheme, before `ready` (src/main/protocol.ts registerScheme: one call registers both). */
export const PLUGIN_SCHEME_PRIVILEGES = { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } };

export interface PluginResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const notFound = (): PluginResponse => ({ status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" }, body: "Not found" });

/** The answer to a `plugin:` request (pure, for the tests and the handler). */
export function pluginResponse(url: string, method: string, runs: Pick<PluginRuns, "get"> = pluginRuns): PluginResponse {
  if (method !== "GET" && method !== "HEAD") return { ...notFound(), status: 405, body: "Not allowed" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return notFound();
  }
  if (u.protocol !== `${PLUGIN_SCHEME}:` || !RUN_ID.test(u.hostname) || u.pathname !== "/ui.html") return notFound();
  const run = runs.get(u.hostname);
  if (!run || run.html === null) return notFound();
  return {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": pluginUiCsp(run.domains),
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
    body: method === "HEAD" ? "" : run.html,
  };
}

/** After `ready`. */
export function handlePluginScheme() {
  protocol.handle(PLUGIN_SCHEME, (request) => {
    const r = pluginResponse(request.url, request.method);
    return new Response(r.body || null, { status: r.status, headers: r.headers });
  });
}

/**
 * Where a frame inside a view may go (§3.2 "Navigation"): a plugin UI of one of the view's runs, the `https:` URLs
 * that run's manifest allows (Figma's "navigated to a custom URL"), and `about:blank` / `about:srcdoc` (frames a plugin
 * UI makes itself). Anything else is cancelled; `window.open` already goes to the browser (views.ts).
 */
export function frameMayNavigate(url: string, runs: readonly PluginRun[]): boolean {
  if (url === "about:blank" || url === "about:srcdoc") return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === `${PLUGIN_SCHEME}:`) return runs.some((r) => r.runId === u.hostname && r.html !== null);
  if (u.protocol !== "https:") return false;
  return runs.some((r) => domainsAllow(r.domains, url));
}

/** views.ts: a view's subframes navigate only as frameMayNavigate says; its runs end with it. */
export function guardPluginFrames(contents: WebContents) {
  const id = contents.id;
  contents.on("will-frame-navigate", (e) => {
    if (e.isMainFrame) return;
    if (!frameMayNavigate(e.url, pluginRuns.of(id))) e.preventDefault();
  });
  contents.once("destroyed", () => pluginRuns.endAll(id));
  // A reload starts the page over: the runs it had are gone.
  contents.on("did-start-navigation", (e) => {
    if (e.isMainFrame && !e.isSameDocument) pluginRuns.endAll(id);
  });
}
