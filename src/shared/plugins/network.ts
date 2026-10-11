import type { PluginManifest } from "./types";

/**
 * A plugin's `networkAccess` (docs/plugins.md §1 "Network", §3.2, §3.3), Figma's rules [P-man]:
 * - `["none"]` blocks everything; `"*"` allows every `https:` / `wss:` URL (ours: the contract's `https: wss:`);
 * - `example.com` — that host (no subdomains); `*.example.com` — its subdomains (not itself), as CSP host sources;
 * - an optional scheme `http`, `https`, `ws`, `wss`; without one, `https` and `wss` (the CSP rule for a page on
 *   https, which Figma's plugin iframes are — ours sits on `plugin:`, so the sources are written with their schemes);
 * - an optional port (else the scheme's default) and path: a path ending in `/` covers what is below it, otherwise
 *   that exact path.
 *
 * Pure (no Electron, no Node), one copy for main (its fetch `fetch.ts`, the UI's CSP `protocol.ts`, the runs
 * `runs.ts`) and the editor (the plugin host's fetch check before main's, the browser build's srcdoc CSP). Main checks
 * again whatever a view sends (an entry is a CSP source: it must not be able to add a directive).
 */

export type Scheme = "http" | "https" | "ws" | "wss";

export interface DomainRule {
  /** The schemes it covers */
  schemes: Scheme[];
  /** `*` (any host), `*.example.com` or `example.com`, lower case */
  host: string;
  /** null: the scheme's default port */
  port: number | null;
  /** null: any path; ends in `/`: a prefix; otherwise that path */
  path: string | null;
}

const DEFAULT_PORT: Record<Scheme, number> = { http: 80, https: 443, ws: 80, wss: 443 };
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** CSP path characters we accept (no `;`, `,`, spaces or quotes — they would end the source or the directive) */
const PATH = /^\/[A-Za-z0-9\-._~!$&'()*+=:@%/]*$/;

function validHost(host: string): boolean {
  if (host === "localhost") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split(".").every((n) => Number(n) <= 255);
  if (/^\[[0-9a-f:.]+\]$/.test(host)) return true;
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  const labels = bare.split(".");
  return labels.length >= 1 && labels.every((l) => HOST_LABEL.test(l));
}

/** One `allowedDomains` entry, or null when it isn't one (an entry we can't read is never allowed). `"none"` → null. */
export function parseDomain(entry: unknown): DomainRule | null {
  if (typeof entry !== "string") return null;
  const raw = entry.trim();
  if (!raw || raw === "none" || raw.length > 2048 || /[\s;,"]/.test(raw)) return null;
  if (raw === "*") return { schemes: ["https", "wss"], host: "*", port: null, path: null };
  const m = /^(?:([a-z]+):\/\/)?(\*\.[^/:?#]+|\[[^\]]+\]|[^/:?#*]+)(?::(\d{1,5}))?(\/[^?#]*)?$/i.exec(raw);
  if (!m) return null;
  const scheme = m[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https" && scheme !== "ws" && scheme !== "wss") return null;
  const host = m[2].toLowerCase();
  if (!validHost(host)) return null;
  const port = m[3] === undefined ? null : Number(m[3]);
  if (port !== null && (port < 1 || port > 65535)) return null;
  const path = m[4] === undefined || m[4] === "/" ? null : m[4];
  if (path !== null && !PATH.test(path)) return null;
  return { schemes: scheme ? [scheme as Scheme] : ["https", "wss"], host, port, path };
}

/** Is the entry one Figma asks a `reasoning` for (`*`, localhost)? */
export function needsReasoning(entry: string): boolean {
  const rule = parseDomain(entry);
  return !!rule && (rule.host === "*" || rule.host === "localhost" || rule.host === "127.0.0.1" || rule.host === "[::1]");
}

/** The entries a run may reach: the manifest's `allowedDomains`, plus `devAllowedDomains` for a development plugin. */
export function effectiveDomains(allowedDomains: readonly unknown[], devAllowedDomains: readonly unknown[] | undefined, dev: boolean): string[] {
  const list = [...allowedDomains, ...(dev ? (devAllowedDomains ?? []) : [])].filter((d): d is string => typeof d === "string");
  // "none" means nothing — unless a development plugin adds its own development domains.
  return list.filter((d) => d.trim() !== "none");
}

function hostMatches(rule: string, host: string): boolean {
  if (rule === "*") return true;
  if (rule.startsWith("*.")) return host.endsWith(rule.slice(1)) && host.length > rule.length - 1;
  return host === rule;
}

/** Does one rule cover the URL? */
export function ruleAllows(rule: DomainRule, url: URL): boolean {
  const scheme = url.protocol.slice(0, -1) as Scheme;
  if (!rule.schemes.includes(scheme)) return false;
  // URL hosts are lower case (and IPv6 in brackets) already.
  if (!hostMatches(rule.host, url.hostname)) return false;
  const port = url.port === "" ? DEFAULT_PORT[scheme] : Number(url.port);
  if (port !== (rule.port ?? DEFAULT_PORT[scheme])) return false;
  if (rule.path === null) return true;
  const path = decodeURIComponentSafe(url.pathname);
  const want = decodeURIComponentSafe(rule.path);
  return want.endsWith("/") ? path.startsWith(want) : path === want;
}

const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** May a run with these entries reach `url`? (Only http(s) and ws(s) URLs, no credentials in the URL.) */
export function domainsAllow(entries: readonly string[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol) || u.username || u.password) return false;
  return entries.some((e) => {
    const rule = parseDomain(e);
    return !!rule && ruleAllows(rule, u);
  });
}

/** The entries as CSP sources (`none` → nothing; `*` → `https: wss:`; each scheme written out; a path keeps its path). */
export function cspSourcesOf(entries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    const rule = parseDomain(e);
    if (!rule) continue;
    if (rule.host === "*") {
      for (const s of rule.schemes) out.add(`${s}:`);
      continue;
    }
    for (const s of rule.schemes) out.add(`${s}://${rule.host}${rule.port === null ? "" : `:${rule.port}`}${rule.path ?? ""}`);
  }
  return [...out];
}

/** The UI document's CSP (docs/plugins.md §3.2's header, `<S>` = the sources). */
export function pluginUiCsp(entries: readonly string[]): string {
  const s = cspSourcesOf(entries);
  const src = (...base: string[]) => [...base, ...s].join(" ") || "'none'";
  return [
    "default-src 'none'",
    `script-src ${src("'unsafe-inline'", "'unsafe-eval'", "blob:", "data:")}`,
    `style-src ${src("'unsafe-inline'", "https://fonts.googleapis.com")}`,
    `font-src ${src("data:", "https://fonts.gstatic.com")}`,
    `img-src ${src("data:", "blob:")}`,
    `media-src ${src("data:", "blob:")}`,
    `connect-src ${src()}`,
    `frame-src ${src()}`,
    "worker-src blob:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

// ---- The editor's side: a manifest's networkAccess as a whole --------------------------------------------------------


export type NetworkAccess = PluginManifest["networkAccess"];

/** The entries in force for a run (no networkAccess: blocked, Figma's default). */
export function domainsOf(access: NetworkAccess, development: boolean): string[] {
  if (!access) return [];
  return effectiveDomains(access.allowedDomains, access.devAllowedDomains, development);
}

/** May a plugin with this networkAccess reach `url`? */
export function allowedUrl(access: NetworkAccess, url: string, options: { development?: boolean } = {}): boolean {
  return domainsAllow(domainsOf(access, !!options.development), url);
}

/** The manifest's domains as CSP sources. */
export function toCspSources(access: NetworkAccess, options: { development?: boolean } = {}): string[] {
  return cspSourcesOf(domainsOf(access, !!options.development));
}

/** The UI document's Content-Security-Policy (docs/plugins.md §3.2). */
export function uiCsp(access: NetworkAccess, options: { development?: boolean } = {}): string {
  return pluginUiCsp(domainsOf(access, !!options.development));
}

/** Figma's CSP-style refusal (docs/plugins.md §3.3). */
export const refusedMessage = (url: string) => `Refused to connect to '${url}' because it violates the plugin's networkAccess (manifest.json)`;
