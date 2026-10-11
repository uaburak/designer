import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER } from "../shared/account";
import { NO_POLICY } from "../shared/desktopPolicy";
import { allowedServer, describePolicy, MAC_DOMAIN, mergePolicy, originAllowed, parsePlistJson, parseRegQuery, proxied, proxySwitches, readPolicy, storeProxyEnv, type Run } from "./policy";

/** The deployment keys (docs/desktop.md §12.5): parsers, precedence, what each key does. */

const REG_HKLM = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\DesignerV2",
  "    DisableUpdater    REG_DWORD    0x1",
  "    AllowedOriginHosts    REG_MULTI_SZ    https://*.acme.com\\0https://designer.acme.com\\0",
  "    InstalledByMsi    REG_DWORD    0x1",
  "",
].join("\r\n");
const REG_HKCU = ["", "HKEY_CURRENT_USER\\SOFTWARE\\DesignerV2", "    ProxyUrl    REG_SZ    http://proxy.acme.com:8080", "    DisableUpdater    REG_DWORD    0x0", ""].join("\r\n");

describe("parsers", () => {
  it("plutil's JSON of a plist", () => {
    expect(parsePlistJson(JSON.stringify({ DisableUpdater: true, AllowedOriginHosts: ["https://*.acme.com", " "], ProxyUrl: " socks://p:1080 ", Other: 1 }))).toEqual({
      DisableUpdater: true,
      AllowedOriginHosts: ["https://*.acme.com"],
      ProxyUrl: "socks://p:1080",
    });
    // `defaults write … DisableUpdater -int 1` and a string where an array was meant
    expect(parsePlistJson(JSON.stringify({ DisableUpdater: 1, AllowedOriginHosts: "https://a.com" }))).toEqual({ DisableUpdater: true, AllowedOriginHosts: ["https://a.com"] });
    expect(parsePlistJson("not json")).toEqual({});
    expect(parsePlistJson("[1]")).toEqual({});
    expect(parsePlistJson("{}")).toEqual({});
  });

  it("reg query's output: REG_DWORD hex, REG_MULTI_SZ split on \\0, REG_SZ", () => {
    expect(parseRegQuery(REG_HKLM)).toEqual({ DisableUpdater: true, AllowedOriginHosts: ["https://*.acme.com", "https://designer.acme.com"] });
    expect(parseRegQuery(REG_HKCU)).toEqual({ ProxyUrl: "http://proxy.acme.com:8080", DisableUpdater: false });
    // A REG_SZ "1" for the DWORD, an empty value, junk lines
    expect(parseRegQuery("    DisableUpdater    REG_SZ    1\n    ProxyUrl    REG_SZ\nERROR: nothing")).toEqual({ DisableUpdater: true });
    expect(parseRegQuery("")).toEqual({});
  });
});

describe("precedence", () => {
  it("the first source that has a key wins, per key, with its source kept", () => {
    const p = mergePolicy([
      { source: "HKLM", values: parseRegQuery(REG_HKLM) },
      { source: "HKCU", values: parseRegQuery(REG_HKCU) },
    ]);
    expect(p).toEqual({
      disableUpdater: true,
      allowedOriginHosts: ["https://*.acme.com", "https://designer.acme.com"],
      proxyUrl: "http://proxy.acme.com:8080",
      sources: { DisableUpdater: "HKLM", AllowedOriginHosts: "HKLM", ProxyUrl: "HKCU" },
    });
    expect(mergePolicy([])).toEqual(NO_POLICY);
  });

  it("macOS: managed preferences, then all users, then the user's domain", () => {
    const calls: string[] = [];
    const files: Record<string, object> = {
      [`/Library/Managed Preferences/${MAC_DOMAIN}.plist`]: { ProxyUrl: "http://managed:3128" },
      [`/Library/Preferences/${MAC_DOMAIN}.plist`]: { ProxyUrl: "http://all-users:3128", DisableUpdater: true },
    };
    const exec: Run = (file, args, input) => {
      calls.push([file, ...args].join(" "));
      if (file.endsWith("defaults")) return "<plist>user</plist>";
      if (args.at(-1) === "-") return input === "<plist>user</plist>" ? JSON.stringify({ DisableUpdater: false, AllowedOriginHosts: ["https://user.example"] }) : null;
      const f = files[args.at(-1)!];
      return f ? JSON.stringify(f) : null;
    };
    const p = readPolicy("darwin", exec);
    expect(p.proxyUrl).toBe("http://managed:3128");
    expect(p.disableUpdater).toBe(true);
    expect(p.allowedOriginHosts).toEqual(["https://user.example"]);
    expect(p.sources).toEqual({ ProxyUrl: "/Library/Managed Preferences", DisableUpdater: "/Library/Preferences", AllowedOriginHosts: "user" });
    expect(calls).toEqual([
      `/usr/bin/plutil -convert json -o - /Library/Managed Preferences/${MAC_DOMAIN}.plist`,
      `/usr/bin/plutil -convert json -o - /Library/Preferences/${MAC_DOMAIN}.plist`,
      `/usr/bin/defaults export ${MAC_DOMAIN} -`,
      "/usr/bin/plutil -convert json -o - -",
    ]);
  });

  it("Windows: HKLM over HKCU; a missing key (reg query fails) is absent", () => {
    const keys: Record<string, string> = { "HKLM\\SOFTWARE\\DesignerV2": REG_HKLM, "HKCU\\SOFTWARE\\DesignerV2": REG_HKCU };
    const exec: Run = (file, args) => (file === "reg" && args[0] === "query" && args[2] === "/reg:64" ? (keys[args[1]] ?? null) : null);
    expect(readPolicy("win32", exec).sources).toEqual({ DisableUpdater: "HKLM", AllowedOriginHosts: "HKLM", ProxyUrl: "HKCU" });
    delete keys["HKLM\\SOFTWARE\\DesignerV2"];
    expect(readPolicy("win32", exec)).toMatchObject({ disableUpdater: false, allowedOriginHosts: [], proxyUrl: "http://proxy.acme.com:8080" });
    expect(readPolicy("win32", () => null)).toEqual(NO_POLICY);
  });

  it("Linux: none", () => {
    expect(readPolicy("linux", () => "{}")).toEqual(NO_POLICY);
  });
});

describe("what each key does", () => {
  const policy = (proxyUrl: string | null, allowedOriginHosts: string[] = []) => ({ ...NO_POLICY, proxyUrl, allowedOriginHosts });

  it("ProxyUrl: Chromium's switch (direct:// = none), net.fetch only with a proxy", () => {
    expect(proxySwitches(policy(null))).toEqual([]);
    expect(proxySwitches(policy("direct://"))).toEqual([["no-proxy-server"]]);
    expect(proxySwitches(policy("http=foopy:80;https=foopy2"))).toEqual([["proxy-server", "http=foopy:80;https=foopy2"]]);
    expect(proxied(policy(null))).toBe(false);
    expect(proxied(policy("DIRECT://"))).toBe(false);
    expect(proxied(policy("socks://p:1080"))).toBe(true);
  });

  it("ProxyUrl: the store's environment for http(s) proxies only", () => {
    expect(storeProxyEnv(policy("http://proxy:8080"))).toEqual({ env: { HTTP_PROXY: "http://proxy:8080", HTTPS_PROXY: "http://proxy:8080", NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost,127.0.0.1,::1" }, warning: null });
    expect(storeProxyEnv(policy("socks://p:1080")).env).toEqual({});
    expect(storeProxyEnv(policy("socks://p:1080")).warning).toContain("direct");
    expect(storeProxyEnv(policy("http=foopy:80;https=foopy2")).env).toEqual({});
    expect(storeProxyEnv(policy("direct://"))).toEqual({ env: {}, warning: null });
  });

  it("AllowedOriginHosts: DESIGNER_SERVER honoured only when listed", () => {
    const def = DEFAULT_SERVER.replace(/\/+$/, "");
    expect(allowedServer(undefined, policy(null))).toEqual({ server: def, ignored: null });
    expect(allowedServer("http://localhost:8787/", policy(null))).toEqual({ server: "http://localhost:8787", ignored: null });
    expect(allowedServer("https://designer.acme.com", policy(null, ["https://*.acme.com"]))).toEqual({ server: "https://designer.acme.com", ignored: null });
    expect(allowedServer("http://localhost:8787", policy(null, ["https://*.acme.com"]))).toEqual({ server: def, ignored: "http://localhost:8787" });
    expect(allowedServer("nonsense", policy(null, ["https://*.acme.com"]))).toEqual({ server: def, ignored: "nonsense" });
  });

  it("originAllowed: wildcards are subdomains only, a bare host means https, schemes must match", () => {
    const list = ["https://*.example.com", "acme.com", "http://localhost:8787"];
    expect(originAllowed("https://a.example.com", list)).toBe(true);
    expect(originAllowed("https://a.b.example.com", list)).toBe(true);
    expect(originAllowed("https://example.com", list)).toBe(false);
    expect(originAllowed("https://evilexample.com", list)).toBe(false);
    expect(originAllowed("http://a.example.com", list)).toBe(false);
    expect(originAllowed("https://acme.com", list)).toBe(true);
    expect(originAllowed("https://www.acme.com", list)).toBe(false);
    expect(originAllowed("http://localhost:8787", list)).toBe(true);
    expect(originAllowed("http://localhost:8788", list)).toBe(false);
    expect(originAllowed("not a url", list)).toBe(false);
    expect(originAllowed("https://a.example.com", [])).toBe(false);
  });

  it("the debug line names each key's source", () => {
    const p = mergePolicy([{ source: "HKLM", values: { ProxyUrl: "http://p:1" } }]);
    expect(describePolicy(p)).toBe("[policy] DisableUpdater=false AllowedOriginHosts=[] ProxyUrl=http://p:1 (HKLM)");
  });
});
