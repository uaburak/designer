// Convert to Social file (docs/social.md §18.1): the owner's "Sosyal Medya" as the engine reads it — containers
// unwrapped in reading order, sizes to formats, tiny frames skipped, the thumbnail page and pages without designs left
// out, the page's name to its brand — and the conversion the choices make.
import { describe, expect, it } from "vitest";
import { conversionCounts, conversionPlan, defaultChoices, findConvertible, formatsFitting, readConversion, readingOrder, suggestFormat, type ConvertInput, type ConvertNode } from "./convert";

const frame = (id: string, x: number, y: number, width: number, height: number, name = id): ConvertNode => ({ id, name, type: "FRAME", x, y, width, height });

/** A grid of `n` frames `w` × `h`, `cols` wide with 8 px gaps (ids "<prefix><index in reading order>"), listed shuffled. */
function grid(prefix: string, n: number, cols: number, w: number, h: number): ConvertNode[] {
  const out = Array.from({ length: n }, (_, i) => frame(`${prefix}${i}`, 100 + (i % cols) * (w + 8), 100 + Math.floor(i / cols) * (h + 8), w, h));
  // Layer order isn't reading order: the designer drew them in any order.
  return out.map((f, i) => ({ f, k: (i * 7) % n })).sort((a, b) => a.k - b.k).map((x) => x.f);
}

const SOSYAL_MEDYA: ConvertInput = {
  thumbnailPageId: "p:thumb",
  brands: [
    { id: "b:mtm", name: "MTM AGRO" },
    { id: "b:other", name: "Başka" },
  ],
  pages: [
    {
      id: "p:mtm",
      name: "MTM Agro",
      nodes: [
        { ...frame("post", 0, 0, 3456, 11776, "Post"), children: grid("p", 24, 3, 1080, 1440) },
        { ...frame("test", 4000, 0, 3602, 4806, "test"), children: grid("t", 9, 3, 1080, 1440) },
        frame("postA", 8000, 0, 1080, 1350, "PostA"),
        frame("postB", 9200, 0, 1080, 1080, "PostB"),
        frame("f25", 10400, 0, 189, 100, "Frame 25"),
      ],
    },
    { id: "p:partner", name: "Partner Agro", nodes: [frame("f26", 0, 0, 304, 145, "Frame 26")] },
    { id: "p:thumb", name: "Thumbnail", nodes: [frame("cover", 0, 0, 1920, 1080, "Cover")] },
    { id: "p:wire", name: "wireframe", nodes: [frame("w1", 0, 0, 2400, 1600, "▸ H"), { id: "note", name: "Note", type: "TEXT", x: 0, y: 2000, width: 400, height: 40 }] },
  ],
};

describe("Convert to Social file: formats", () => {
  it("suggests the exact size's format, else a near one of the same shape, else none", () => {
    expect(suggestFormat(1080, 1440)?.id).toBe("instagram.portrait");
    expect(suggestFormat(1080, 1350)?.id).toBe("instagram.post");
    expect(suggestFormat(1080, 1080)?.id).toBe("instagram.square");
    expect(suggestFormat(1080.0004, 1439.9996)?.id).toBe("instagram.portrait");
    // Same shape, a little smaller: still Instagram post 3:4; much smaller or another shape: none.
    expect(suggestFormat(900, 1200)?.id).toBe("instagram.portrait");
    expect(suggestFormat(189, 100)).toBeNull();
    expect(suggestFormat(304, 145)).toBeNull();
    expect(suggestFormat(3602, 4806)).toBeNull();
    expect(formatsFitting(1080, 1350).map((f) => f.id)).toEqual(expect.arrayContaining(["instagram.post", "instagram.carousel", "linkedin.portrait", "facebook.post"]));
    expect(formatsFitting(1080, 1080)[0].id).toBe("instagram.square");
    expect(formatsFitting(189, 100)).toEqual([]);
  });

  it("reads rows top-down, each left to right", () => {
    const order = readingOrder([frame("c", 0, 1448, 10, 1440), frame("b", 1088, 2, 10, 1440), frame("a", 0, 0, 10, 1440), frame("d", 1088, 1450, 10, 1440)]);
    expect(order.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("Convert to Social file: what is found", () => {
  const found = findConvertible(SOSYAL_MEDYA);

  it("keeps the pages with designs, leaving out the thumbnail page and the pages without any", () => {
    expect(found.pages.map((p) => p.pageName)).toEqual(["MTM Agro"]);
    expect(found.leftOut).toEqual([
      { pageId: "p:partner", pageName: "Partner Agro", reason: "no-designs" },
      { pageId: "p:thumb", pageName: "Thumbnail", reason: "thumbnail" },
      { pageId: "p:wire", pageName: "wireframe", reason: "no-designs" },
    ]);
  });

  it("matches the page's name to a brand, case and accents folded", () => {
    expect(found.pages[0].brand).toEqual({ id: "b:mtm", name: "MTM AGRO" });
  });

  it("unwraps containers in reading order and lists posts, with tiny frames skipped", () => {
    const rows = found.pages[0].rows;
    expect(rows.map((r) => [r.name, r.kind, r.count, r.suggested])).toEqual([
      ["Post", "container", 24, "instagram.portrait"],
      ["test", "container", 9, "instagram.portrait"],
      ["PostA", "post", 1, "instagram.post"],
      ["PostB", "post", 1, "instagram.square"],
      ["Frame 25", "post", 1, null],
    ]);
    expect(rows[0].children?.map((c) => c.id)).toEqual(Array.from({ length: 24 }, (_, i) => `p${i}`));
    expect(rows[0]).toMatchObject({ width: 1080, height: 1440 });
  });

  it("makes the conversion the choices say, with counts for the footer", () => {
    const choices = defaultChoices(found);
    expect(choices.f25).toEqual({ checked: false, formatId: null });
    expect(conversionCounts(found, choices)).toEqual({ designs: 35, skipped: 1 });
    const plan = conversionPlan(found, choices, { allPages: ["p:mtm", "p:partner", "p:thumb", "p:wire"] });
    expect(plan.removePages).toEqual(["p:partner", "p:thumb", "p:wire"]);
    const page = plan.pages[0];
    expect(page.brandId).toBe("b:mtm");
    expect(page.unwrap.map((u) => u.id)).toEqual(["post", "test"]);
    expect(page.posts.slice(0, 3)).toEqual([
      { id: "p0", formatId: "instagram.portrait" },
      { id: "p1", formatId: "instagram.portrait" },
      { id: "p2", formatId: "instagram.portrait" },
    ]);
    expect(page.posts.slice(-2)).toEqual([
      { id: "postA", formatId: "instagram.post" },
      { id: "postB", formatId: "instagram.square" },
    ]);
    // The square changed to LinkedIn's in the Select, "test" unchecked: nine fewer, kept wrapped.
    const changed = conversionPlan(found, { ...choices, postB: { checked: true, formatId: "linkedin.square" }, test: { checked: false, formatId: "instagram.portrait" } });
    expect(changed.pages[0].unwrap.map((u) => u.id)).toEqual(["post"]);
    expect(changed.pages[0].posts.find((p) => p.id === "postB")?.formatId).toBe("linkedin.square");
    expect(conversionCounts(found, { ...choices, test: { checked: false, formatId: "instagram.portrait" } })).toEqual({ designs: 26, skipped: 10 });
    // The file itself converted: no page removed.
    expect(conversionPlan(found, choices).removePages).toEqual([]);
    // Read back as stored.
    expect(readConversion(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(readConversion({ v: 2 })).toBeNull();
  });

  it("doesn't take a frame of mixed children for a container", () => {
    const mixed = findConvertible({ pages: [{ id: "p", name: "P", nodes: [{ ...frame("c", 0, 0, 5000, 5000), children: [frame("a", 0, 0, 1080, 1080), frame("b", 1100, 0, 200, 300), { id: "t", name: "T", type: "TEXT", x: 0, y: 1200, width: 10, height: 10 }] }, frame("ok", 6000, 0, 1080, 1350)] }] });
    expect(mixed.pages[0].rows.map((r) => [r.id, r.kind, r.suggested])).toEqual([
      ["c", "post", null],
      ["ok", "post", "instagram.post"],
    ]);
  });
});
