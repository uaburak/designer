/** Dev Mode read-outs (devMode.ts) and units (units.ts): statuses, annotations, asset detection, List rows, units. */
import { describe, expect, it } from "vitest";
import type { NodeChange } from "@/engine/codec";
import { annotationsOf, detectAssets, editedAgo, htmlText, listRows, statusOf, STATUS_LABEL, type AssetNode } from "./devMode";
import { composeInUnit, cssInUnit, cssValueInUnit, DEFAULT_UNITS, lengthIn, swiftUIInUnit, UNITS } from "./units";

describe("Dev Mode statuses and annotations", () => {
  it("reads a design's status (BUILD = Ready for dev)", () => {
    expect(statusOf({ sectionStatusInfo: { status: "BUILD" } })).toBe("READY_FOR_DEV");
    expect(statusOf({ sectionStatusInfo: { status: "COMPLETED" } })).toBe("COMPLETED");
    expect(statusOf({ sectionStatusInfo: { status: "NONE" } })).toBeNull();
    expect(statusOf({})).toBeNull();
    expect(STATUS_LABEL.READY_FOR_DEV).toBe("Ready for dev");
  });

  it("shows Changed when the design was edited after its status was set (editInfo, as Figma's files keep it)", () => {
    const ready = { status: "BUILD", lastUpdateUnixTimestamp: 1785913481 };
    expect(statusOf({ sectionStatusInfo: ready, editInfo: { lastEditedAt: 1785914035 } })).toBe("CHANGED");
    expect(statusOf({ sectionStatusInfo: ready, editInfo: { lastEditedAt: 1785913000 } })).toBe("READY_FOR_DEV");
    expect(statusOf({ sectionStatusInfo: { ...ready, status: "COMPLETED" }, editInfo: { lastEditedAt: 1785914035 } })).toBe("CHANGED");
    expect(STATUS_LABEL.CHANGED).toBe("Changed");
    const now = 1785914035 * 1000;
    expect(editedAgo(1785914035 - 10, now)).toBe("Edited just now");
    expect(editedAgo(1785914035 - 120, now)).toBe("Edited 2 minutes ago");
    expect(editedAgo(1785914035 - 3600, now)).toBe("Edited 1 hour ago");
    expect(editedAgo(undefined, now)).toBeNull();
  });

  it("shows an annotation's rich text as text and its pinned properties with the layer's values", () => {
    expect(htmlText("<p>Tap <b>opens</b> the menu</p><ul><li>one</li><li>two &amp; three</li></ul>")).toBe("Tap opens the menu\n• one\n• two & three");
    const node = {
      guid: "1:2",
      type: "FRAME",
      size: { x: 375, y: 80 },
      fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }],
      cornerRadius: 8,
      opacity: 0.5,
      annotations: [{ label: "<p>Header</p>", properties: [{ type: "WIDTH" }, { type: "FILL" }, { type: "CORNER_RADIUS" }, { type: "OPACITY" }] }],
    } as unknown as NodeChange & { annotations: never };
    const [a] = annotationsOf(node);
    expect(a.text).toBe("Header");
    expect(a.properties).toEqual([
      { label: "Width", value: "375px" },
      { label: "Fill", value: "#FF0000" },
      { label: "Corner radius", value: "8px" },
      { label: "Opacity", value: "50%" },
    ]);
  });
});

describe("Dev Mode assets", () => {
  const nodes: Record<string, AssetNode> = {
    root: { id: "root", name: "Screen", type: "FRAME", visible: true, size: { x: 375, y: 812 }, children: ["icon", "photo", "card", "box"] },
    icon: { id: "icon", name: "Icon/Search", type: "INSTANCE", visible: true, size: { x: 24, y: 24 }, children: ["v1", "v2"] },
    v1: { id: "v1", name: "Vector", type: "VECTOR", visible: true, size: { x: 16, y: 16 }, children: [] },
    v2: { id: "v2", name: "Line", type: "LINE", visible: true, size: { x: 6, y: 0 }, children: [] },
    photo: { id: "photo", name: "Photo", type: "ROUNDED_RECTANGLE", visible: true, size: { x: 300, y: 200 }, fillPaints: [{ type: "IMAGE", image: { hash: "ab12" }, visible: true } as never], children: [] },
    card: { id: "card", name: "Card", type: "FRAME", visible: true, size: { x: 300, y: 100 }, children: ["label", "chevron"] },
    label: { id: "label", name: "Label", type: "TEXT", visible: true, size: { x: 100, y: 20 }, children: [] },
    chevron: { id: "chevron", name: "Chevron", type: "VECTOR", visible: true, size: { x: 8, y: 12 }, children: [] },
    box: { id: "box", name: "Box", type: "ROUNDED_RECTANGLE", visible: true, size: { x: 40, y: 40 }, children: [] },
  };
  it("finds the icons (small, only vectors) and the images, outermost first", () => {
    const found = detectAssets("root", (id) => nodes[id] ?? null);
    expect(found).toEqual([
      { id: "icon", name: "Icon/Search", kind: "icon" },
      { id: "photo", name: "Photo", kind: "image", imageHash: "ab12" },
      { id: "chevron", name: "Chevron", kind: "icon" },
    ]);
  });
});

describe("the List view and units", () => {
  it("lists a snippet's declarations as properties", () => {
    expect(listRows([{ property: "border-radius", value: "8px" }, { property: "background", value: "#FFF" }])).toEqual([
      { label: "Border radius", value: "8px" },
      { label: "Background", value: "#FFF" },
    ]);
  });

  it("writes lengths in the chosen unit (atlas 14 §5.2, §6, §8)", () => {
    expect(UNITS.css.map((u) => u.value)).toEqual(["px", "rem"]);
    expect(UNITS.compose.map((u) => u.value)).toEqual(["px", "dp"]);
    const rem = { ...DEFAULT_UNITS, unit: { ...DEFAULT_UNITS.unit, css: "rem" as const } };
    // Only the box, spacing, radius and text properties; 5 decimals; a line's comment too.
    expect(cssInUnit("width: 375px;\npadding: 8px 12px;\nborder: 1px solid #FFF;\nbox-shadow: 0 4px 4px 0 #000;\nline-height: 30px; /* 125% */\nfont-size: 15px;", rem)).toBe(
      "width: 23.4375rem;\npadding: 0.5rem 0.75rem;\nborder: 1px solid #FFF;\nbox-shadow: 0 4px 4px 0 #000;\nline-height: 1.875rem; /* 125% */\nfont-size: 0.9375rem;",
    );
    expect(cssInUnit("width: 32px;\nfont-size: 16px;", { ...rem, remOnText: true })).toBe("width: 32px;\nfont-size: 1rem;");
    expect(cssInUnit("width: 32px;", { ...rem, scale: { ...rem.scale, css: 8 } })).toBe("width: 4rem;");
    expect(cssInUnit("width: 375px;", DEFAULT_UNITS)).toBe("width: 375px;");
    expect(cssValueInUnit("height", "32px", rem)).toBe("2rem");
    // iOS / Android: the scaled unit divides by the factor; Compose keeps .dp / .sp.
    const at2x = { ...DEFAULT_UNITS, scale: { ...DEFAULT_UNITS.scale, swiftui: 2, compose: 2 } };
    expect(swiftUIInUnit(".frame(width: 100, height: 40, alignment: .topLeading)\n.padding(.horizontal, 8)\n.background(Color(red: 0.5, green: 0.5, blue: 0.5))\nstartPoint: UnitPoint(x: 0.5, y: 0),", at2x)).toBe(
      ".frame(width: 50, height: 20, alignment: .topLeading)\n.padding(.horizontal, 4)\n.background(Color(red: 0.5, green: 0.5, blue: 0.5))\nstartPoint: UnitPoint(x: 0.5, y: 0),",
    );
    expect(swiftUIInUnit(".frame(width: 100)", { ...at2x, unit: { ...at2x.unit, swiftui: "px" } })).toBe(".frame(width: 100)");
    expect(composeInUnit("Modifier.width(100.dp).padding(start = 8.dp)\nfontSize = 16.sp", at2x)).toBe("Modifier.width(50.dp).padding(start = 4.dp)\nfontSize = 8.sp");
    expect(lengthIn(32, "css", rem)).toBe("2rem");
    expect(lengthIn(32, "swiftui", DEFAULT_UNITS)).toBe("32pt");
    expect(lengthIn(32, "swiftui", at2x)).toBe("16pt");
  });
});
