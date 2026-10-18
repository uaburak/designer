// @vitest-environment happy-dom
// Social's CSV import and the Templates gallery's filters (docs/social.md §4.3, §4.5, round 18b): RFC 4180 rows —
// quotes, doubled quotes, commas and line breaks inside a cell, a BOM, CRLF, a semicolon file — the columns by name in
// any case, at most 500 rows; the gallery's platform / format / Static-Animated / brand filters over this file's
// templates and a library's manifest.
import { describe, expect, it } from "vitest";
import type { LibraryAsset, LibraryVersion } from "@shared/store/types";
import type { SocialTemplateData } from "@shared/social/types";
import { MAX_ROWS, parseCsv, readCsvPosts } from "../social/templates/csvImport";
import { filterTemplates, libraryTemplates, normalizeSlot, normalizeTemplate, type TemplateEntry } from "../social/templates/templates";

describe("CSV (RFC 4180, ours)", () => {
  it("parses quotes, commas, line breaks in cells, a BOM and CRLF", () => {
    const text = '﻿headline,body\r\n"Fresh, organic","Line one\nline two"\r\n"Say ""hi""",plain\r\n\r\nlast,\n';
    expect(parseCsv(text)).toEqual([
      ["headline", "body"],
      ["Fresh, organic", "Line one\nline two"],
      ['Say "hi"', "plain"],
      ["last", ""],
    ]);
  });

  it("reads a semicolon file (a spreadsheet in Turkish) and Turkish letters", () => {
    expect(parseCsv("Başlık;Gövde\nÇiftçi;Gübre, sıvı\n")).toEqual([
      ["Başlık", "Gövde"],
      ["Çiftçi", "Gübre, sıvı"],
    ]);
  });

  it("reads the columns by name in any case and order, ignoring the others", () => {
    const r = readCsvPosts("Caption,HEADLINE,extra,Hashtags,alt,Product,brand\nHello world,Big news,x,#tarım gübre,A field,Liq Humus,Acme\n");
    if ("error" in r) throw new Error(r.error);
    expect(r.columns).toEqual(["headline", "caption", "hashtags", "alt", "product", "brand"]);
    expect(r.posts).toEqual([{ values: { headline: "Big news" }, caption: "Hello world", hashtags: ["tarım", "gübre"], altText: "A field", product: "Liq Humus", brand: "Acme" }]);
  });

  it("refuses an empty file, unknown columns and more than 500 rows", () => {
    expect(readCsvPosts("")).toEqual({ error: "The file is empty" });
    expect(readCsvPosts("a,b\n1,2\n")).toMatchObject({ error: expect.stringContaining("No known column") });
    const many = ["headline", ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `Row ${i}`)].join("\n");
    expect(readCsvPosts(many)).toEqual({ error: `At most ${MAX_ROWS} rows (this file has ${MAX_ROWS + 1})` });
    const enough = ["headline", ...Array.from({ length: MAX_ROWS }, (_, i) => `Row ${i}`)].join("\n");
    expect((readCsvPosts(enough) as { posts: unknown[] }).posts).toHaveLength(MAX_ROWS);
  });
});

const data = (over: Partial<SocialTemplateData>): SocialTemplateData => ({ v: 1, name: "T", formats: { "Instagram post": "instagram.post" }, animated: false, platforms: ["instagram"], origin: "owner", ...over });
const asset = (key: string, social: SocialTemplateData | null, over: Partial<LibraryAsset> = {}): LibraryAsset => ({ key, kind: "COMPONENT_SET", name: social?.name ?? key, description: "", guid: "1:1", versionHash: "0".repeat(40), dependencyOnly: false, dependencies: [], thumbnail: null, ...(social ? { social: { template: social } } : {}), ...over });

describe("Templates gallery's filters", () => {
  const local: TemplateEntry = { key: "k-local", name: "Hero", data: data({ name: "Hero", formats: { "Instagram post": "instagram.post", "Instagram story": "instagram.story" } }), library: null, libraryName: null, node: "1:2", asset: null };
  const manifest: LibraryVersion = {
    libraryFileKey: "LIB",
    version: 1,
    publishedAt: 0,
    description: "",
    changes: { created: [], modified: [], removed: [], moved: [] },
    assets: [asset("k-reel", data({ name: "Reel", formats: { "Instagram reel": "instagram.reel" }, animated: true })), asset("k-li", data({ name: "Quote", formats: { "LinkedIn square": "linkedin.square" }, platforms: ["linkedin"] })), asset("k-plain", null), asset("k-dep", data({ name: "Hidden" }), { dependencyOnly: true })],
  } as LibraryVersion;
  const lib = libraryTemplates({ enabled: ["LIB", "OFF"], manifests: new Map([["LIB", manifest]]), names: new Map([["LIB", "Social templates"]]) }, [{ library: "LIB", key: "k-li", guid: "9:9" }]);
  const all = [local, ...lib];

  it("lists a library's templates from its manifest (never its plain components or dependencies), with a copy here when imported", () => {
    expect(lib.map((e) => [e.name, e.library, e.libraryName, e.node])).toEqual([
      ["Reel", "LIB", "Social templates", null],
      ["Quote", "LIB", "Social templates", "9:9"],
    ]);
  });

  it("filters by platform, format, Static / Animated and the brand's libraries", () => {
    const names = (f: Parameters<typeof filterTemplates>[1]) => filterTemplates(all, f).map((e) => e.name);
    expect(names({})).toEqual(["Hero", "Reel", "Quote"]);
    expect(names({ platform: "instagram" })).toEqual(["Hero", "Reel"]);
    expect(names({ platform: "linkedin" })).toEqual(["Quote"]);
    expect(names({ formatId: "instagram.story" })).toEqual(["Hero"]);
    expect(names({ animated: true })).toEqual(["Reel"]);
    expect(names({ animated: false })).toEqual(["Hero", "Quote"]);
    expect(names({ brandLibraries: new Set(["OTHER"]) })).toEqual(["Hero"]);
    expect(names({ brandLibraries: new Set(["LIB"]), platform: "instagram" })).toEqual(["Hero", "Reel"]);
  });

  it("reads markers tolerantly: no formats is no template, bad slots are none", () => {
    expect(normalizeTemplate({ name: "x", formats: {} })).toBeNull();
    expect(normalizeTemplate({ formats: { A: "instagram.post", B: 3 }, platforms: ["instagram", "myspace"], origin: "?" })).toEqual({ v: 1, name: "", formats: { A: "instagram.post" }, animated: false, platforms: ["instagram"], origin: "owner" });
    expect(normalizeSlot({ role: "logo" })).toEqual({ v: 1, role: "logo", property: null, locked: false, maxChars: null });
    expect(normalizeSlot({ role: "sticker" })).toBeNull();
    expect(normalizeSlot(null)).toBeNull();
  });
});
