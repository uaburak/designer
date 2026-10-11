// A dev resource link's title (docs/editor.md D-3): https only, no local hosts, redirects checked, size and time caps.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch } }));
const { isLocalHost, linkTitle, titleOf } = await import("./devmodeLinks");

describe("devmode:link-title", () => {
  let server: Server;
  let origin = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = (body: string, type = "text/html; charset=utf-8") => void res.writeHead(200, { "Content-Type": type }).end(body);
      if (req.url === "/page") return html("<html><head><title>  Button &amp; Co\n — Storybook </title></head></html>");
      if (req.url === "/cookie") return html(`<title>${req.headers.cookie ?? "no cookie"}</title>`);
      if (req.url === "/hop") return void res.writeHead(301, { Location: "/page" }).end();
      if (req.url === "/json") return html('{"title": "x"}', "application/json");
      if (req.url === "/slow") return void setTimeout(() => html("<title>late</title>"), 1000);
      if (req.url === "/huge") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.write("<html>" + " ".repeat(600 * 1024));
        return void res.end("<title>too far</title>");
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const local = { fetcher: fetch, schemes: ["http:"], allowLocal: true };

  it("reads the page's title", async () => {
    expect(await linkTitle(`${origin}/page`, local)).toEqual({ title: "Button & Co — Storybook" });
    expect(await linkTitle(`${origin}/hop`, local)).toEqual({ title: "Button & Co — Storybook" });
    expect(await linkTitle(`${origin}/cookie`, { ...local, fetcher: (u, i) => fetch(u, { ...i, headers: { ...(i.headers as Record<string, string>) } }) })).toEqual({ title: "no cookie" });
  });

  it("answers null for what isn't an HTML page, too slow or too big", async () => {
    expect(await linkTitle(`${origin}/json`, local)).toEqual({ title: null });
    expect(await linkTitle(`${origin}/missing`, local)).toEqual({ title: null });
    expect(await linkTitle(`${origin}/slow`, { ...local, timeoutMs: 200 })).toEqual({ title: null });
    expect(await linkTitle(`${origin}/huge`, local)).toEqual({ title: null });
  });

  it("is https only, and never this computer or the local network", async () => {
    const fetcher = vi.fn(fetch);
    expect(await linkTitle(`${origin}/page`, { fetcher })).toEqual({ title: null });
    expect(await linkTitle(`${origin.replace("http:", "https:")}/page`, { fetcher })).toEqual({ title: null });
    expect(await linkTitle("javascript:alert(1)", { fetcher })).toEqual({ title: null });
    expect(fetcher).not.toHaveBeenCalled();
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "[::1]", "printer.local"]) expect(isLocalHost(h), h).toBe(true);
    expect(isLocalHost("github.com")).toBe(false);
    // A redirect from an allowed page to a local one stops there.
    const hop = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/admin" } }));
    expect(await linkTitle("https://example.com/", { fetcher: hop })).toEqual({ title: null });
    expect(hop).toHaveBeenCalledTimes(1);
  });

  it("refuses a name that resolves to a local address, and connects to the address it checked", async () => {
    const at = (map: Record<string, string[]>) => async (host: string) => (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    // Any one local address among the answers is enough to refuse; nothing is fetched.
    const fetcher = vi.fn(fetch);
    const evil = at({ "evil.example": ["93.184.215.14", "127.0.0.1"], "v6.example": ["fd00::1"], "meta.example": ["169.254.169.254"] });
    for (const host of ["evil.example", "v6.example", "meta.example", "nowhere.example"]) expect(await linkTitle(`https://${host}/`, { fetcher, resolver: evil }), host).toEqual({ title: null });
    expect(fetcher).not.toHaveBeenCalled();
    // A redirect to a public-looking name that resolves locally stops there.
    const hop = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://internal.example/admin" } }));
    expect(await linkTitle("https://example.com/", { fetcher: hop, resolver: at({ "example.com": ["93.184.215.14"], "internal.example": ["10.0.0.5"] }) })).toEqual({ title: null });
    expect(hop).toHaveBeenCalledTimes(1);
    // The default connection is pinned: a name nothing else resolves reaches the server at the resolver's address.
    const port = new URL(origin).port;
    const pinnedOnly = at({ "pinned.test": ["127.0.0.1"] });
    expect(await linkTitle(`http://pinned.test:${port}/page`, { schemes: ["http:"], allowLocal: true, resolver: pinnedOnly })).toEqual({ title: "Button & Co — Storybook" });
    expect(await linkTitle(`http://pinned.test:${port}/hop`, { schemes: ["http:"], allowLocal: true, resolver: pinnedOnly })).toEqual({ title: "Button & Co — Storybook" });
    // …and refused once local addresses aren't allowed.
    expect(await linkTitle(`http://pinned.test:${port}/page`, { schemes: ["http:"], resolver: pinnedOnly })).toEqual({ title: null });
  });

  it("decodes entities and collapses space", () => {
    expect(titleOf("<TITLE data-x>A&#39;s &#x2014; b&nbsp;c</TITLE>")).toBe("A's — b c");
    expect(titleOf("<p>none</p>")).toBeNull();
  });
});
