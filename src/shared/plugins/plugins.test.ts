// The manifest's parsing (docs/plugins.md §4) and the network rules (§1 "Network", §3.2–§3.3).
import { describe, expect, it } from "vitest";
import { developmentId, notRunnableReason, parseManifest, runnableIn } from "./manifest";
import { allowedUrl, domainsOf, refusedMessage, toCspSources, uiCsp } from "./network";

const base = { name: "My plugin", id: "123", api: "1.0.0", main: "code.js", editorType: ["figma"] };

describe("parseManifest", () => {
  it("takes Figma's fields and keeps them as given", () => {
    const r = parseManifest({ ...base, ui: { main: "ui.html", secondary: "b.html" }, editorType: ["figma", "dev"], documentAccess: "dynamic-page", networkAccess: { allowedDomains: ["https://api.example.com"], reasoning: "x", devAllowedDomains: ["http://localhost:3000"] }, menu: [{ name: "A", command: "a", parameters: [{ name: "Icon", key: "icon", allowFreeform: true }] }, { separator: true }, { name: "Sub", menu: [{ name: "B", command: "b" }] }], relaunchButtons: [{ command: "edit", name: "Edit", multipleSelection: true }], permissions: ["currentuser"], capabilities: ["inspect"], enablePrivatePluginApi: true });
    expect("manifest" in r).toBe(true);
    if (!("manifest" in r)) return;
    expect(r.manifest).toMatchObject({ name: "My plugin", ui: { main: "ui.html" }, editorType: ["figma", "dev"], documentAccess: "dynamic-page", menu: [{ name: "A", command: "a", parameters: [{ name: "Icon", key: "icon", allowFreeform: true }] }, { separator: true }, { name: "Sub", menu: [{ name: "B", command: "b" }] }], relaunchButtons: [{ command: "edit", name: "Edit", multipleSelection: true }], enablePrivatePluginApi: true });
    expect(r.warnings).toEqual([]);
  });

  it("refuses what Figma refuses, with each reason", () => {
    const r = parseManifest({ name: "", api: 1, main: "", documentAccess: "all", networkAccess: { allowedDomains: [] }, editorType: ["sketch"], menu: [{ name: "x" }], permissions: ["camera"] });
    expect("errors" in r && r.errors).toEqual(
      expect.arrayContaining(['"name" is required', '"api" is required', '"id" is required', '"documentAccess" must be "dynamic-page"', expect.stringContaining("allowedDomains"), expect.stringContaining("editorType"), expect.stringContaining("menu[0]"), expect.stringContaining('"main"')])
    );
    expect(parseManifest("{not json")).toEqual({ errors: [expect.stringContaining("isn't valid JSON")] });
    expect(parseManifest({ ...base, containsWidget: true })).toEqual({ errors: ["Widgets aren't supported in Wecra yet"] });
  });

  it("Figma's validator texts (docs/research/atlas/17-plugins.md §4.1, §5.2)", () => {
    const errors = (j: Record<string, unknown>) => {
      const r = parseManifest({ ...base, ...j });
      return "errors" in r ? r.errors : [];
    };
    const hint = 'Specify a combination of ["figma", "figjam", "dev", "sites", "slides", "buzz"]';
    expect(errors({ editorType: undefined })).toEqual([`Missing editorType in manifest.  ${hint}`]);
    expect(errors({ editorType: [] })).toEqual([`Invalid editorType in manifest.  ${hint}`]);
    expect(parseManifest({ ...base, editorType: ["inspect"] })).toMatchObject({ manifest: { editorType: ["dev"] } });
    expect(errors({ permissions: ["currentuser", "camera", "telepathy"] })).toEqual(["Invalid permission specified: telepathy"]);
    expect(parseManifest({ ...base, permissions: ["currentuser", "camera"] })).toMatchObject({ manifest: { permissions: ["currentuser"] }, warnings: ["Untrusted local plugin denied internal api permissions"] });
    expect(errors({ capabilities: ["magic"] })).toEqual(["Invalid capability specified: magic"]);
    expect(errors({ capabilities: ["inspect"] })).toEqual(['Capability "inspect" requires "editorType" to include "dev"']);
    expect(errors({ editorType: ["dev"], capabilities: ["codegen"] })).toEqual(["codegen plugins must define at least one language in codegenLanguages"]);
    expect(errors({ codegenLanguages: [{ label: "CSS", value: "css" }] })).toEqual(["codegenLanguages only supported for codegen plugins"]);
    expect(errors({ editorType: ["dev"], capabilities: ["codegen"], codegenLanguages: [{ label: "CSS", value: "css" }], codegenPreferences: [{ itemType: "unit", scaledUnit: "rem" }, { itemType: "unit", scaledUnit: "em" }, { itemType: "select", propertyName: "a", options: [{ label: "A", value: "a" }] }, { itemType: "action", propertyName: "b" }, { itemType: "action", propertyName: "b" }] })).toEqual([
      'codegenPreferences "action" itemType settings must have unique propertyName values',
      'codegenPreferences itemType: "select" should have exactly one default option',
      'codegenPreferences should have at most one itemType: "unit"',
    ]);
    expect(errors({ relaunchButtons: [{ command: "a", name: "A" }, { command: "a", name: "B" }] })).toEqual(['Expected "manifest.relaunchButtons" to have unique commands, but got more than one button with command: "a"']);
    expect(errors({ menu: [{ name: "A", command: "a" }], parameters: [{ name: "X", key: "x" }] })).toEqual(["manifest.parameters should not be specified when menu items are defined"]);
    expect(errors({ parameters: [] })).toEqual(['Expected "manifest.parameters" to have non-empty parameter list.']);
    expect(errors({ parameters: [{ name: "X", key: "x" }, { name: "Y", key: "x" }] })).toEqual(['Expected "manifest.parameters" to have unique keys, but got more than one parameter with key: "x"']);
    expect(errors({ parameters: [{ name: "X", key: "x", optional: true }, { name: "Y", key: "y" }] })).toEqual(["Optional parameters must be listed last in the parameter list. y not marked as optional."]);
    expect(errors({ menu: [{ name: "A", command: "a", parameterOnly: true }] })).toEqual(['Expected parameters to be defined for "manifest.menu[0]" marked as parameterOnly.']);
    // networkAccess (§4.1)
    expect(errors({ networkAccess: { allowedDomains: [] } })).toEqual(['Invalid value for allowedDomains. To block all network access, set allowedDomains: ["none"]']);
    expect(errors({ networkAccess: { allowedDomains: ["none", "https://a.com"] } })).toEqual(["Invalid value for allowedDomains. 'none' must be the only value in the array."]);
    expect(errors({ networkAccess: { allowedDomains: ["figma.com"] } })).toEqual(["Invalid value for allowedDomains. 'figma.com' must include a scheme, such as https://."]);
    expect(errors({ networkAccess: { allowedDomains: ["https://a.com", "https://a.com"] } })).toEqual(["Invalid value for allowedDomains. 'https://a.com' is duplicated."]);
    expect(errors({ networkAccess: { allowedDomains: ["https://a .com"] } })).toEqual(["Invalid value for allowedDomains. 'https://a .com' must be a valid URL."]);
    expect(errors({ networkAccess: { allowedDomains: ["*"] } })).toEqual(['Invalid value for networkAccess. If you want to allow all domains, please add a "reasoning" field to the networkAccess object.']);
    expect(errors({ networkAccess: { allowedDomains: ["*"], reasoning: "x".repeat(1000) } })).toEqual(['Invalid value for networkAccess. The "reasoning" field must be less than 1000 characters.']);
    expect(errors({ networkAccess: { allowedDomains: ["none"], devAllowedDomains: ["http://localhost:3000", "bad url"] } })).toEqual(["Invalid value for devAllowedDomains. 'bad url' must be a valid URL."]);
    expect(errors({ networkAccess: { allowedDomains: ["*"], reasoning: "An image search" } })).toEqual([]);
  });

  it("gives a development manifest without an id one from its path", () => {
    const r = parseManifest({ ...base, id: undefined, networkAccess: { allowedDomains: ["none"] } }, { development: true, path: "/Users/me/plugin/manifest.json" });
    expect("manifest" in r && r.manifest.id).toBe(developmentId("/Users/me/plugin/manifest.json"));
    expect(developmentId("/a")).toMatch(/^dev:[0-9a-f]{16}$/);
    expect(developmentId("/a")).not.toBe(developmentId("/b"));
  });

  it("runs in Figma Design and Dev Mode only", () => {
    expect(runnableIn({})).toEqual(["figma"]);
    expect(runnableIn({ editorType: ["dev", "figjam"] })).toEqual(["dev"]);
    expect(notRunnableReason({ editorType: ["figjam", "slides"] })).toBe('The manifest editorType does not include "figma"');
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
    expect(allowedUrl(access, "https://socket.io/")).toBe(true); // Figma's matcher: wss also covers https
    expect(allowedUrl(access, "http://socket.io/")).toBe(false);
    expect(allowedUrl(access, "https://localhost:3000/api")).toBe(true); // http also covers https
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
