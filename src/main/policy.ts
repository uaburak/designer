/**
 * Managed deployment keys (docs/desktop.md §12.5; Figma's names `DisableUpdater`, `AllowedOriginHosts`, `ProxyUrl`):
 * read once, synchronously, before `app.whenReady()` — the proxy has to be a command-line switch by then.
 *
 * macOS: `/Library/Managed Preferences/<appId>.plist` (configuration profiles), `/Library/Preferences/<appId>.plist`
 * (all users), then the user's domain (`defaults export`, so a fresh `defaults write` counts). Windows:
 * `HKLM\SOFTWARE\DesignerV2` (Figma's place, under our name), then `HKCU\SOFTWARE\DesignerV2`. The first source that
 * has a key wins (an admin's value can't be changed by the user). A missing file / key / command is simply absent;
 * each command gets 2 seconds.
 *
 * The parsers and the merge are pure (policy.test.ts); `readPolicy` takes the command runner.
 */
import { execFileSync } from "node:child_process";
import { NO_POLICY, originAllowed, type DesktopPolicy } from "../shared/desktopPolicy";
import { DEFAULT_SERVER } from "../shared/account";

export { originAllowed };

/** The macOS preferences domain: our appId (electron-builder.yml) */
export const MAC_DOMAIN = "net.burakkoc.designer";
/** The Windows key, under HKLM (Figma's) and HKCU (ours, for machines nobody manages) */
export const WIN_KEY = "SOFTWARE\\DesignerV2";

type Key = keyof DesktopPolicy["sources"];
const KEYS: readonly Key[] = ["DisableUpdater", "AllowedOriginHosts", "ProxyUrl"];

/** One source's values, as found (absent keys left out) */
export interface PolicyValues {
  DisableUpdater?: boolean;
  AllowedOriginHosts?: string[];
  ProxyUrl?: string;
}

const strings = (v: unknown): string[] | undefined => {
  if (typeof v === "string") v = v.split(/\r?\n|,/);
  if (!Array.isArray(v)) return undefined;
  return v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
};
const bool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(1|true|yes)$/i.test(v.trim()) ? true : /^(0|false|no)$/i.test(v.trim()) ? false : undefined;
  return undefined;
};

/** A plist converted by `plutil -convert json -o - …` */
export function parsePlistJson(json: string): PolicyValues {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return {};
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  const r = o as Record<string, unknown>;
  const out: PolicyValues = {};
  const d = bool(r.DisableUpdater);
  if (d !== undefined) out.DisableUpdater = d;
  const a = strings(r.AllowedOriginHosts);
  if (a) out.AllowedOriginHosts = a;
  if (typeof r.ProxyUrl === "string" && r.ProxyUrl.trim()) out.ProxyUrl = r.ProxyUrl.trim();
  return out;
}

/**
 * `reg query <key>` output: a header line with the key, then `    <Name>    <REG_TYPE>    <data>` per value.
 * REG_DWORD data is hex (`0x1`); REG_MULTI_SZ entries are separated by a printed `\0`.
 */
export function parseRegQuery(stdout: string): PolicyValues {
  const out: PolicyValues = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(line);
    if (!m) continue;
    const [, name, type, raw = ""] = m;
    const data = raw.trim();
    if (name === "DisableUpdater") {
      const n = type.endsWith("WORD") ? Number.parseInt(data, 16) : Number.NaN;
      const v = type.endsWith("WORD") ? (Number.isNaN(n) ? undefined : n !== 0) : bool(data);
      if (v !== undefined) out.DisableUpdater = v;
    } else if (name === "AllowedOriginHosts") {
      out.AllowedOriginHosts = data.split(/\\0|\0/).map((s) => s.trim()).filter(Boolean);
    } else if (name === "ProxyUrl" && (type === "REG_SZ" || type === "REG_EXPAND_SZ") && data) {
      out.ProxyUrl = data;
    }
  }
  return out;
}

/** Sources in precedence order (first wins per key) → the policy */
export function mergePolicy(sources: readonly { source: string; values: PolicyValues }[]): DesktopPolicy {
  const policy: DesktopPolicy = { ...NO_POLICY, allowedOriginHosts: [], sources: {} };
  for (const key of KEYS) {
    const found = sources.find((s) => s.values[key] !== undefined);
    if (!found) continue;
    policy.sources[key] = found.source;
    if (key === "DisableUpdater") policy.disableUpdater = found.values.DisableUpdater === true;
    else if (key === "AllowedOriginHosts") policy.allowedOriginHosts = [...(found.values.AllowedOriginHosts ?? [])];
    else policy.proxyUrl = found.values.ProxyUrl ?? null;
  }
  return policy;
}

/** Runs a command and answers its stdout, or null (missing, failed, timed out) */
export type Run = (file: string, args: string[], input?: string) => string | null;

const run: Run = (file, args, input) => {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout: 2000, input, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  } catch {
    return null;
  }
};

/** Every source of this platform, in precedence order */
export function readPolicy(platform: NodeJS.Platform = process.platform, exec: Run = run): DesktopPolicy {
  const sources: { source: string; values: PolicyValues }[] = [];
  if (platform === "darwin") {
    for (const dir of ["/Library/Managed Preferences", "/Library/Preferences"]) {
      const json = exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${dir}/${MAC_DOMAIN}.plist`]);
      if (json) sources.push({ source: dir, values: parsePlistJson(json) });
    }
    const xml = exec("/usr/bin/defaults", ["export", MAC_DOMAIN, "-"]);
    const json = xml && exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], xml);
    if (json) sources.push({ source: "user", values: parsePlistJson(json) });
  } else if (platform === "win32") {
    for (const hive of ["HKLM", "HKCU"]) {
      const out = exec("reg", ["query", `${hive}\\${WIN_KEY}`, "/reg:64"]);
      if (out) sources.push({ source: hive, values: parseRegQuery(out) });
    }
  }
  return mergePolicy(sources);
}

let current: DesktopPolicy = NO_POLICY;

/** Reads the policy (index.ts, before `ready`) and keeps it for the rest of the run */
export function loadPolicy(read: () => DesktopPolicy = () => readPolicy()): DesktopPolicy {
  try {
    current = read();
  } catch (e) {
    console.warn("[policy] couldn't read the deployment keys", e);
    current = NO_POLICY;
  }
  return current;
}

export const desktopPolicy = (): DesktopPolicy => current;

/** `ProxyUrl` as Chromium's switches (`direct://` = no proxy) */
export function proxySwitches(policy: DesktopPolicy): [string, string?][] {
  const p = policy.proxyUrl?.trim();
  if (!p) return [];
  if (p.toLowerCase() === "direct://") return [["no-proxy-server"]];
  return [["proxy-server", p]];
}

/** Whether main's own requests go through Chromium's network stack (`net.fetch`, which the switch reaches) */
export const proxied = (policy: DesktopPolicy): boolean => !!policy.proxyUrl?.trim() && policy.proxyUrl.trim().toLowerCase() !== "direct://";

/**
 * The store's environment for the proxy: Node's own proxy support (`NODE_USE_ENV_PROXY`, Node ≥ 24.5; Electron 44's
 * Node is 24.21) for `fetch` and `WebSocket`, which only speaks http(s):// proxies. Other schemes (`socks://`, Chromium's
 * rule lists) reach the views and main only — the store goes direct, with a warning.
 */
export function storeProxyEnv(policy: DesktopPolicy): { env: Record<string, string>; warning: string | null } {
  const p = policy.proxyUrl?.trim();
  if (!p || p.toLowerCase() === "direct://") return { env: {}, warning: null };
  if (/^https?:\/\/[^\s;=]+$/i.test(p)) {
    // Chromium never sends loopback through a proxy; Node does unless told (a local `wrangler dev` server).
    return { env: { HTTP_PROXY: p, HTTPS_PROXY: p, NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost,127.0.0.1,::1" }, warning: null };
  }
  return { env: {}, warning: `[policy] ProxyUrl ${p} isn't an http(s):// proxy: the store's requests go direct` };
}

/**
 * The server main talks to: `DESIGNER_SERVER` (development) when allowed, else the default one. With a non-empty
 * `AllowedOriginHosts` the variable is honoured only for an origin on the list.
 */
export function allowedServer(env: string | undefined, policy: DesktopPolicy): { server: string; ignored: string | null } {
  const fallback = DEFAULT_SERVER.replace(/\/+$/, "");
  const wanted = env?.trim().replace(/\/+$/, "");
  if (!wanted) return { server: fallback, ignored: null };
  if (policy.allowedOriginHosts.length === 0) return { server: wanted, ignored: null };
  let origin: string;
  try {
    origin = new URL(wanted).origin;
  } catch {
    return { server: fallback, ignored: wanted };
  }
  return originAllowed(origin, policy.allowedOriginHosts) ? { server: wanted, ignored: null } : { server: fallback, ignored: wanted };
}

/** What `DESIGNER_LOG=debug` prints at start */
export function describePolicy(policy: DesktopPolicy): string {
  const at = (k: Key) => (policy.sources[k] ? ` (${policy.sources[k]})` : "");
  return `[policy] DisableUpdater=${policy.disableUpdater}${at("DisableUpdater")} AllowedOriginHosts=[${policy.allowedOriginHosts.join(", ")}]${at("AllowedOriginHosts")} ProxyUrl=${policy.proxyUrl ?? "(system)"}${at("ProxyUrl")}`;
}
