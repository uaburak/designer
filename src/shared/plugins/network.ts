/**
 * A plugin's network rules (docs/plugins.md §1 "Network", §3.2, §3.3): the manifest's `networkAccess` as CSP sources
 * for the UI iframe (`toCspSources`, `uiCsp`) and as the check main's `fetch` makes for `code.js` (`allowedUrl`).
 * Figma's rules: blocked by default; `["none"]` blocks everything; `"*"` allows everything; `*.domain` covers its
 * subdomains; optional schemes `http`, `https`, `ws`, `wss`; a path is exact, or covers what is below it with a trailing
 * `/`; `devAllowedDomains` count for development plugins only. A domain without a scheme is reached over `https` / `wss`
 * (the CSP rule for an https page).
 */
import type { PluginManifest } from "./types";

export type NetworkAccess = PluginManifest["networkAccess"];

const SCHEMES = ["http", "https", "ws", "wss"] as const;
/** A source as the manifest may write it: [scheme://]host[:port][/path] — nothing a CSP header could be broken with. */
const SOURCE = /^(?:(https?|wss?):\/\/)?(\*|\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)*|[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::(\d{1,5}|\*))?(\/[^\s;,'"]*)?$/i;

interface Source {
  scheme: string | null;
  host: string;
  port: string | null;
  path: string | null;
}

function parseSource(s: string): Source | null {
  const m = SOURCE.exec(s.trim());
  if (!m) return null;
  return { scheme: m[1]?.toLowerCase() ?? null, host: m[2].toLowerCase(), port: m[3] ?? null, path: m[4] ?? null };
}

/** The domains in force: `allowedDomains`, plus `devAllowedDomains` for a development plugin. */
export function domainsOf(access: NetworkAccess, development: boolean): string[] {
  if (!access) return ["none"];
  const list = [...access.allowedDomains, ...(development ? (access.devAllowedDomains ?? []) : [])];
  // "none" alone blocks; with others listed it is ignored (they are the allowlist).
  const rest = list.filter((d) => d !== "none");
  return rest.length ? rest : ["none"];
}

/** The manifest's domains as CSP sources (`none` → none; `*` → `https: wss:`; a path keeps its path). */
export function toCspSources(access: NetworkAccess, options: { development?: boolean } = {}): string[] {
  const domains = domainsOf(access, !!options.development);
  if (domains.includes("*")) return ["https:", "wss:"];
  const out: string[] = [];
  for (const d of domains) {
    if (d === "none") continue;
    const src = parseSource(d);
    if (!src) continue;
    out.push(`${src.scheme ? `${src.scheme}://` : ""}${src.host}${src.port ? `:${src.port}` : ""}${src.path ?? ""}`);
  }
  return [...new Set(out)];
}

/** The UI document's Content-Security-Policy for these domains (docs/plugins.md §3.2). */
export function uiCsp(access: NetworkAccess, options: { development?: boolean } = {}): string {
  const s = toCspSources(access, options).join(" ");
  const with_ = (base: string) => (s ? `${base} ${s}` : base);
  return [
    `default-src 'none'`,
    with_(`script-src 'unsafe-inline' 'unsafe-eval' blob: data:`),
    with_(`style-src 'unsafe-inline'`) + " https://fonts.googleapis.com",
    with_(`font-src data:`) + " https://fonts.gstatic.com",
    with_(`img-src data: blob:`),
    with_(`media-src data: blob:`),
    s ? `connect-src ${s}` : `connect-src 'none'`,
    s ? `frame-src ${s}` : `frame-src 'none'`,
    `worker-src blob:`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join("; ");
}

const DEFAULT_PORT: Record<string, string> = { http: "80", https: "443", ws: "80", wss: "443" };

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

function pathMatches(pattern: string | null, path: string): boolean {
  if (!pattern || pattern === "/") return true;
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  return path === pattern;
}

/** May a plugin reach `url` under these rules? */
export function allowedUrl(access: NetworkAccess, url: string, options: { development?: boolean } = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!(SCHEMES as readonly string[]).includes(scheme)) return false;
  const domains = domainsOf(access, !!options.development);
  if (domains.includes("*")) return scheme === "https" || scheme === "wss";
  const host = u.hostname.toLowerCase();
  const port = u.port || DEFAULT_PORT[scheme];
  return domains.some((d) => {
    const src = parseSource(d);
    if (!src) return false;
    if (src.scheme ? src.scheme !== scheme : scheme !== "https" && scheme !== "wss") return false;
    if (!hostMatches(src.host, host)) return false;
    const want = src.port ?? (src.scheme ? DEFAULT_PORT[src.scheme] : DEFAULT_PORT[scheme]);
    if (want !== "*" && want !== port) return false;
    return pathMatches(src.path, decodeURIComponent(u.pathname));
  });
}

/** Figma's CSP-style refusal (docs/plugins.md §3.3). */
export const refusedMessage = (url: string) => `Refused to connect to '${url}' because it violates the plugin's networkAccess (manifest.json)`;
