// @vitest-environment happy-dom
// The Gallery's Developer page (the Developer tab): a sidebar of components from the generated usage index, the selected
// one's distinct looks drawn live with the real component, and the hand-made controls that look like it beside the ds
// look that would replace them.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import Gallery from "../Gallery";
import { UsagesSection, USAGE_INDEX, captionOf, diffWords, entriesOf, sampleProps, suggestionOf } from "../gallery/UsagesSection";
import type { UsageIndex } from "../gallery/usageTypes";
import { $, $$, click, mount, type, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  history.replaceState(null, "", "/");
});

const FIXTURE: UsageIndex = {
  files: 2,
  ds: [
    {
      name: "Button",
      count: 3,
      files: 2,
      looks: [
        { props: { variant: "primary" }, sample: { variant: "primary" }, text: "Save", count: 2, variants: 2, locs: [{ file: "src/renderer/src/a.tsx", line: 3 }, { file: "src/renderer/src/b.tsx", line: 9 }] },
        { props: { variant: "ghost", icon: "✓" }, sample: { variant: "ghost", icon: "24.plus.small" }, text: "Add {name}", count: 1, variants: 1, locs: [{ file: "src/renderer/src/a.tsx", line: 5 }] },
      ],
    },
    { name: "Dialog", count: 1, files: 1, looks: [{ props: {}, sample: { title: "Hi" }, count: 1, variants: 1, locs: [{ file: "src/renderer/src/c.tsx", line: 1 }] }] },
    { name: "RailSpacer", count: 1, files: 1, looks: [{ props: {}, sample: {}, count: 1, variants: 1, locs: [{ file: "src/renderer/src/d.tsx", line: 1 }] }] },
  ],
  custom: [
    { tag: "button", cssFile: null, className: "raw", extraClasses: [], hasText: true, hasIcon: false, text: "Go", count: 4, locs: [{ file: "src/renderer/src/a.tsx", line: 7 }], similarTo: "Button", similarWhy: "a text button", suggest: { variant: "ghost" }, lookIndex: 1 },
    { tag: "button", cssFile: null, className: "chip", extraClasses: [], hasText: true, hasIcon: false, text: "Chip", count: 1, locs: [{ file: "src/renderer/src/b.tsx", line: 2 }] },
    { tag: "a", cssFile: null, className: "more", extraClasses: [], hasText: true, hasIcon: false, count: 1, locs: [{ file: "src/renderer/src/b.tsx", line: 4 }], needsContext: "position: absolute" },
  ],
};

describe("The Developer page", () => {
  it("lists core components, internal pieces (folded) and the hand-made kinds in the sidebar", () => {
    m = mount(UsagesSection, { index: FIXTURE });
    const groups = $$("[data-usage-group]").map((g) => g.getAttribute("data-usage-group"));
    expect(groups).toEqual(["core", "internal", "handmade"]);
    // Each row: the name, its looks and its hand-made look-alikes
    expect($('[data-usage-entry="Button"]').textContent).toBe("Button2 görünüm · 1 benzer");
    expect($('[data-usage-entry="Dialog"]').textContent).toBe("Dialog1 görünüm");
    // Internal pieces start folded
    expect(document.querySelector('[data-usage-entry="RailSpacer"]')).toBeNull();
    click($('[data-usage-group="internal"] button[aria-expanded]'));
    expect(document.querySelector('[data-usage-entry="RailSpacer"]')).not.toBeNull();
    expect($('[data-usage-entry="handmade:buttons"]').textContent).toContain("1 kontrol");
    expect($('[data-usage-entry="handmade:links"]').textContent).toContain("1 kontrol");
  });

  it("shows Button by default: each look live with its words, count and places", () => {
    m = mount(UsagesSection, { index: FIXTURE });
    expect($('[data-usage-entry="Button"]').getAttribute("aria-current")).toBe("true");
    const looks = $$("[data-usage-look]");
    expect(looks).toHaveLength(2);
    // The real ds Button, with the usage's text ({name} placeholders spelled out)
    expect(looks[0].querySelector('[data-ds="Button"]')?.textContent).toContain("Save");
    expect(looks[1].querySelector('[data-ds="Button"]')?.textContent).toContain("Add name");
    expect(looks[0].textContent).toContain("Birincil (mavi)");
    expect(looks[1].textContent).toContain("Hayalet (çerçevesiz), ikonlu");
    expect(looks[0].querySelector("summary")?.textContent).toBe("2 yerde · 2 dosya");
    expect(looks[0].querySelector("li")?.textContent).toBe("a.tsx:3");
  });

  it("shows each hand-made look-alike beside the ds look that would replace it", async () => {
    m = mount(UsagesSection, { index: FIXTURE });
    await act(async () => {});
    const alikes = $$("[data-lookalike]");
    expect(alikes).toHaveLength(1);
    expect(alikes[0].querySelector("button.raw")?.textContent).toBe("Go");
    expect(alikes[0].querySelector('[data-ds="Button"][data-variant="ghost"]')?.textContent).toBe("Go");
    expect(alikes[0].textContent).toContain('→ <Button variant="ghost"> ile değiştirilebilir');
    expect(alikes[0].textContent).toContain("zaten 1 yerde var");
    expect(alikes[0].textContent).toContain("4 yerde");
  });

  it("switches by the sidebar and its search; overlays are listed, not drawn", async () => {
    m = mount(UsagesSection, { index: FIXTURE });
    click($('[data-usage-entry="Dialog"]'));
    expect($("[data-usage-component]").getAttribute("data-usage-component")).toBe("Dialog");
    expect($("[data-usage-look]").textContent).toContain("Sayfada çizilmez");
    click($('[data-usage-entry="handmade:buttons"]'));
    await act(async () => {});
    expect($$("[data-custom-control]")).toHaveLength(1);
    expect($("[data-custom-control] button.chip")).not.toBeNull();
    // The search narrows the rows
    type($("nav input") as HTMLInputElement, "dia");
    expect($$("[data-usage-entry]").map((e) => e.getAttribute("data-usage-entry"))).toEqual(["Dialog"]);
  });
});

describe("helpers", () => {
  it("names a look in plain words", () => {
    expect(captionOf({ variant: "secondary", size: "large", icon: "✓" })).toBe("İkincil (çerçeveli), büyük (32), ikonlu");
    expect(captionOf({ icon: "✓", tone: "secondary" }, "IconButton")).toBe("Soluk");
    expect(captionOf({})).toBe("Varsayılan");
  });

  it("writes the replacing JSX and the box difference", () => {
    expect(suggestionOf("Button", { variant: "ghost", size: "large", icon: "24.plus" })).toBe('<Button variant="ghost" size="large" icon>');
    expect(suggestionOf("IconButton", { icon: "24.more" })).toBe('<IconButton icon="24.more">');
    const box = { width: 24, height: 24, padding: "0", radius: "5", font: "11px 450", background: "x", color: "y" };
    expect(diffWords({ ...box, height: 20, width: 20, radius: "2" }, box)).toEqual(["Yükseklik 20 — ds 24 (4px daha alçak)", "Genişlik 20 — ds 24 (4px daha dar)", "Köşe yarıçapı 2 — ds 5"]);
    expect(diffWords(box, box)).toEqual([]);
  });

  it("gives every component what it needs to draw", () => {
    const props = sampleProps("Select", { props: {}, sample: { size: "large" } });
    expect(props).toMatchObject({ size: "large", value: "a", label: "Select" });
    expect(sampleProps("IconButton", { props: {}, sample: { icon: "24.nope" } }).icon).toBe("24.more");
    expect(sampleProps("Button", { props: { variant: "primary" }, sample: { variant: "primary" } }).children).toBe("Button");
  });

  it("puts a component only hand-made copies exist of in the sidebar", () => {
    const { entries } = entriesOf({ ...FIXTURE, custom: [{ ...FIXTURE.custom[0], similarTo: "Slider" }] });
    expect(entries.find((e) => e.id === "Slider")).toMatchObject({ group: "core", meta: "0 görünüm · 1 benzer" });
  });

  it("the committed index groups the app's buttons into a few looks", () => {
    const button = USAGE_INDEX.ds.find((c) => c.name === "Button")!;
    expect(button.count).toBeGreaterThan(50);
    expect(button.looks.length).toBeGreaterThan(3);
    expect(button.looks.length).toBeLessThan(40);
    expect(USAGE_INDEX.custom.some((c) => c.similarTo === "IconButton" && c.suggest)).toBe(true);
  });
});

describe("Gallery", () => {
  it("opens on the Developer page; other sections leave it out", () => {
    history.replaceState(null, "", "/?gallery&theme=light");
    m = mount(Gallery, {});
    expect($('[data-gallery-section="usages"]')).not.toBeNull();
    m.unmount();
    m = null;
    history.replaceState(null, "", "/?gallery&section=tokens&theme=light&pick=IconButton");
    m = mount(Gallery, {});
    expect(document.querySelector('[data-gallery-section="usages"]')).toBeNull();
  });

  it("selects the component the URL picks", () => {
    history.replaceState(null, "", "/?gallery&theme=light&pick=IconButton");
    m = mount(Gallery, {});
    expect($('[data-usage-entry="IconButton"]').getAttribute("aria-current")).toBe("true");
  });
});
