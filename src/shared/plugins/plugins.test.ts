// The manifest's parsing (docs/plugins.md §4) and the network rules (§1 "Network", §3.2–§3.3).
import { describe, expect, it } from "vitest";
import { developmentId, notRunnableReason, parseManifest, runnableIn } from "./manifest";
import { allowedUrl, domainsOf, refusedMessage, toCspSources, uiCsp } from "./network";

const base = { name: "My plugin", id: "123", api: "1.0.0", main: "code.js" };

describe("parseManifest", () => {
  it("takes Figma's fields and keeps them as given", () => {
    const r = parseManifest({ ...base, ui: { main: "ui.html", secondary: "b.html" }, editorType: ["figma", "dev"], documentAccess: "dynamic-page", networkAccess: { allowedDomains: ["https://api.example.com"], reasoning: "x", devAllowedDomains: ["http://localhost:3000"] }, parameters: [{ name: "Icon", key: "icon", allowFreeform: true }], menu: [{ name: "A", command: "a" }, { separator: true }, { name: "Sub", menu: [{ name: "B", command: "b" }] }], relaunchButtons: [{ command: "edit", name: "Edit", multipleSelection: true }], permissions: ["currentuser"], capabilities: ["inspect"], enablePrivatePluginApi: true });
    expect("manifest" in r).toBe(true);
    if (!("manifest" in r)) return;
    expect(r.manifest).toMatchObject({ name: "My plugin", ui: { main: "ui.html" }, editorType: ["figma", "dev"], documentAccess: "dynamic-page", menu: [{ name: "A", command: "a" }, { separator: true }, { name: "Sub", menu: [{ name: "B", command: "b" }] }], relaunchButtons: [{ command: "edit", name: "Edit", multipleSelection: true }], enablePrivatePluginApi: true });
    expect(r.warnings).toEqual([]);
  });

  it("refuses what Figma refuses, with each reason", () => {
    const r = parseManifest({ name: "", api: 1, main: "", documentAccess: "all", networkAccess: { allowedDomains: [] }, editorType: ["sketch"], menu: [{ name: "x" }], permissions: ["camera"] });
    expect("errors" in r && r.errors).toEqual(
      expect.arrayContaining(['"name" is required', '"api" is required', '"id" is required', '"documentAccess" must be "dynamic-page"', expect.stringContaining("allowedDomains"), expect.stringContaining("editorType"), expect.stringContaining("menu[0]"), expect.stringContaining("permissions"), expect.stringContaining('"main"')])
    );
    expect(parseManifest("{not json")).toEqual({ errors: [expect.stringContaining("isn't valid JSON")] });
    expect(parseManifest({ ...base, containsWidget: true })).toEqual({ errors: ["Widgets aren't supported in Wecra yet"] });
    expect("errors" in parseManifest({ ...base, capabilities: ["codegen"] })).toBe(true);
  });

  it("gives a development manifest without an id one from its path; warns about * and localhost without a reason", () => {
    const r = parseManifest({ ...base, id: undefined, networkAccess: { allowedDomains: ["*", "http://localhost:3000"] } }, { development: true, path: "/Users/me/plugin/manifest.json" });
    expect("manifest" in r && r.manifest.id).toBe(developmentId("/Users/me/plugin/manifest.json"));
    expect(developmentId("/a")).toMatch(/^dev:[0-9a-f]{16}$/);
    expect(developmentId("/a")).not.toBe(developmentId("/b"));
    expect("manifest" in r && r.warnings).toEqual(['networkAccess: "*" and localhost need a "reasoning"']);
  });

  it("runs in Figma Design and Dev Mode only", () => {
    expect(runnableIn({})).toEqual(["figma"]);
    expect(runnableIn({ editorType: ["dev", "figjam"] })).toEqual(["dev"]);
    expect(notRunnableReason({ editorType: ["figjam", "slides"] })).toBe("This plugin doesn't run in Figma Design or Dev Mode");
  });
});

describe("network rules", () => {
  const access = { allowedDomains: ["figma.com", "*.example.com", "https://api.site.com/v1/", "wss://socket.io", "http://localhost:3000"], devAllowedDomains: ["http://localhost:9000"] };

  it("allows the manifest's domains with Figma's rules (scheme, subdomains, paths, ports)", () => {
    expect(allowedUrl(access, "https://figma.com/file")).toBe(true);
    expect(allowedUrl(access, "wss://figma.com/")).toBe(true);
    expect(allowedUrl(access, "http://figma.com/")).toBe(false); // no scheme: https / wss
    expect(allowedUrl(access, "https://www.figma.com/")).toBe(false);
    expect(allowedUrl(access, "https://a.example.com/x")).toBe(true);
    expect(allowedUrl(access, "https://example.com/x")).toBe(false); // *.domain is its subdomains
    expect(allowedUrl(access, "https://api.site.com/v1/users")).toBe(true);
    expect(allowedUrl(access, "https://api.site.com/v2/users")).toBe(false);
    expect(allowedUrl(access, "wss://socket.io/")).toBe(true);
    expect(allowedUrl(access, "https://socket.io/")).toBe(false);
    expect(allowedUrl(access, "http://localhost:3000/api")).toBe(true);
    expect(allowedUrl(access, "http://localhost:3001/api")).toBe(false);
    expect(allowedUrl(access, "http://localhost:9000/")).toBe(false);
    expect(allowedUrl(access, "http://localhost:9000/", { development: true })).toBe(true);
    expect(allowedUrl(access, "file:///etc/passwd")).toBe(false);
    expect(allowedUrl(access, "not a url")).toBe(false);
  });

  it("blocks everything by default and with none; * allows https and wss", () => {
    expect(allowedUrl(undefined, "https://figma.com")).toBe(false);
    expect(allowedUrl({ allowedDomains: ["none"] }, "https://figma.com")).toBe(false);
    expect(allowedUrl({ allowedDomains: ["*"], reasoning: "x" }, "https://anything.org/")).toBe(true);
    expect(allowedUrl({ allowedDomains: ["*"], reasoning: "x" }, "http://anything.org/")).toBe(false);
    expect(domainsOf(undefined, false)).toEqual([]);
  });

  it("turns the domains into CSP sources; refuses anything that could break the header", () => {
    expect(toCspSources(access)).toEqual(["https://figma.com", "wss://figma.com", "https://*.example.com", "wss://*.example.com", "https://api.site.com/v1/", "wss://socket.io", "http://localhost:3000"]);
    expect(toCspSources(access, { development: true })).toContain("http://localhost:9000");
    expect(toCspSources({ allowedDomains: ["none"] })).toEqual([]);
    expect(toCspSources({ allowedDomains: ["*"] })).toEqual(["https:", "wss:"]);
    expect(toCspSources({ allowedDomains: ["evil.com; script-src *", "ok.com 'unsafe-eval'"] })).toEqual([]);
    const csp = uiCsp({ allowedDomains: ["none"] });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(uiCsp({ allowedDomains: ["figma.com"] })).toContain("connect-src https://figma.com wss://figma.com");
    expect(refusedMessage("https://x.org")).toBe("Refused to connect to 'https://x.org' because it violates the plugin's networkAccess (manifest.json)");
  });
});
