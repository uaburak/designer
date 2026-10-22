// @vitest-environment happy-dom
// The Gallery's "Usages in the app" and "Not from the design system" (the Developer tab): drawn from the generated
// usage index, each ds variant live with the real component, filtered by the Gallery's search.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import Gallery from "../Gallery";
import { CustomSection, UsagesSection, USAGE_INDEX, sampleProps } from "../gallery/UsagesSection";
import type { UsageIndex } from "../gallery/usageTypes";
import { $, $$, click, mount, type Mounted } from "./dom";

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
      variants: [
        { props: { variant: "primary", children: "text" }, sample: { variant: "primary" }, text: "Save", count: 2, locs: [{ file: "src/renderer/src/a.tsx", line: 3 }, { file: "src/renderer/src/b.tsx", line: 9 }] },
        { props: { variant: "ghost", icon: "✓", children: "text" }, sample: { variant: "ghost", icon: "24.plus.small" }, text: "Add {name}", count: 1, locs: [{ file: "src/renderer/src/a.tsx", line: 5 }] },
      ],
    },
    { name: "Dialog", count: 1, files: 1, variants: [{ props: { title: "✓" }, sample: { title: "Hi" }, count: 1, locs: [{ file: "src/renderer/src/c.tsx", line: 1 }] }] },
  ],
  custom: [
    { tag: "button", cssFile: null, className: "raw", extraClasses: [], hasText: false, hasIcon: true, icon: "24.more", count: 4, locs: [{ file: "src/renderer/src/a.tsx", line: 7 }], similarTo: "IconButton", similarWhy: "an icon-only button" },
    { tag: "input", type: "text", cssFile: null, className: null, extraClasses: [], hasText: true, text: "Name", count: 1, hasIcon: false, locs: [{ file: "src/renderer/src/b.tsx", line: 2 }], needsContext: "position: absolute" },
  ],
};

describe("Usages in the app", () => {
  it("draws each variant live with the real component, its props, count and places", () => {
    m = mount(UsagesSection, { query: "", index: FIXTURE });
    const section = $('[data-gallery-section="usages"]');
    expect(section.textContent).toContain("2 components");
    const cards = $$('[data-usage-component="Button"] [data-usage-variant]');
    expect(cards).toHaveLength(2);
    // The real ds Button, with the usage's text ({name} placeholders spelled out)
    expect(cards[0].querySelector('[data-ds="Button"], button')?.textContent).toContain("Save");
    expect(cards[1].querySelector("button")?.textContent).toContain("Add name");
    expect(cards[0].textContent).toContain("variant=primary");
    expect(cards[0].textContent).toContain("2×");
    expect(cards[0].querySelector("summary")?.textContent).toBe("2 places in 2 files");
    expect(cards[0].querySelector("li")?.textContent).toBe("a.tsx:3");
    // Overlays are listed, not drawn
    expect($('[data-usage-component="Dialog"]').textContent).toContain("Not drawn inline (overlay)");
  });

  it("filters by component, prop or file", () => {
    m = mount(UsagesSection, { query: "ghost", index: FIXTURE });
    expect($$("[data-usage-variant]")).toHaveLength(1);
    m.rerender(UsagesSection, { query: "c.tsx", index: FIXTURE });
    expect($$("[data-usage-component]").map((e) => e.getAttribute("data-usage-component"))).toEqual(["Dialog"]);
  });

  it("gives every component what it needs to draw", () => {
    const props = sampleProps("Select", { props: {}, sample: { size: "large" }, count: 1, locs: [] });
    expect(props).toMatchObject({ size: "large", value: "a", label: "Select" });
    expect(sampleProps("IconButton", { props: {}, sample: { icon: "24.nope" }, count: 1, locs: [] }).icon).toBe("24.more");
  });

  it("the committed index lists the app's buttons", () => {
    const button = USAGE_INDEX.ds.find((c) => c.name === "Button");
    expect(button && button.count).toBeGreaterThan(50);
    expect(USAGE_INDEX.custom.length).toBeGreaterThan(10);
  });
});

describe("Not from the design system", () => {
  it("lists hand-made controls with their look-alike and context tags", async () => {
    m = mount(CustomSection, { query: "", index: FIXTURE });
    await act(async () => {});
    const cards = $$("[data-custom-control]");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("similar to: IconButton");
    expect(cards[0].querySelector("button.raw")).not.toBeNull();
    expect(cards[1].textContent).toContain("needs context");
    expect(cards[1].querySelector("input")?.getAttribute("placeholder")).toBe("Name");
    click($$("button").find((b) => b.textContent === "Only near-duplicates")!);
    expect($$("[data-custom-control]")).toHaveLength(1);
  });
});

describe("Gallery", () => {
  it("shows the two usage sections first", () => {
    history.replaceState(null, "", "/?gallery&section=usages&theme=light");
    m = mount(Gallery, {});
    expect($('[data-gallery-section="usages"]')).not.toBeNull();
    expect(document.querySelector('[data-gallery-section="custom"]')).toBeNull();
    m.unmount();
    m = null;
    history.replaceState(null, "", "/?gallery&section=custom&theme=light");
    m = mount(Gallery, {});
    expect($('[data-gallery-section="custom"]')).not.toBeNull();
    expect(document.querySelector('[data-gallery-section="usages"]')).toBeNull();
  });
});
