// Round 11 — Design panel and popovers (docs/editor.md "Round 11 — Design panel and popovers"): an instance's flow, a
// mixed selection's W / H, the text edit header, Type settings › Details, the list menus over their field, the Text
// styles popover's place and the capture fixture's strokes — each against the live dumps in
// docs/research/figma/live/.
import { describe, expect, it } from "vitest";
import { instanceFlow } from "../panels/design/Layout";
import { SIZING_LIST_DY, SIZING_LIST_DY_CHILD, sizeLocked } from "../panels/design/Sizing";
import { HEADER_ACTIONS, headerKind } from "../panels/design/Header";
import { detailsApplicable, moreFeatures } from "../panels/design/TypeSettings";
import { TEXT_STYLES_RESERVE } from "../panels/design/Styles";
import { CAPTURE_DOCUMENT } from "../fixtures";
import type { PanelNode } from "../panels/design/shared";

const node = (n: Record<string, unknown>) => n as unknown as PanelNode;
const rect = node({ guid: "7:60", type: "ROUNDED_RECTANGLE", size: { x: 120, y: 90 } });
const frame = node({ guid: "7:1", type: "FRAME", size: { x: 240, y: 180 } });
const text = node({ guid: "7:90", type: "TEXT", textAutoResize: "WIDTH_AND_HEIGHT", textData: { characters: "Hello Figma text" } });

describe("An instance's flow (live design/variant-instance.txt, instance.txt, nested-instance-parent.txt)", () => {
  it("an instance of a component without auto layout: no Flow row, no Use auto layout (Dimensions at 350)", () => {
    expect(instanceFlow([node({ guid: "8:61", type: "INSTANCE" })])).toBe("hidden");
  });
  it("an instance of an auto layout component: Flow and Wrap shown, disabled", () => {
    expect(instanceFlow([node({ guid: "8:60", type: "INSTANCE", stackMode: "HORIZONTAL" })])).toBe("locked");
    expect(instanceFlow([node({ guid: "8:62", type: "INSTANCE", stackMode: "VERTICAL" })])).toBe("locked");
  });
  it("frames and groups keep their own flow", () => {
    expect(instanceFlow([frame])).toBeNull();
    expect(instanceFlow([node({ guid: "7:20", type: "FRAME", stackMode: "HORIZONTAL" })])).toBeNull();
  });
});

describe("W / H of a mixed selection (live design/mixed-multi.txt: Rect + Ellipse + Text + F_frame, both DISABLED)", () => {
  it("an auto-width text among the layers locks both fields", () => {
    const mixed = [rect, node({ guid: "7:61", type: "ELLIPSE" }), text, frame];
    expect(sizeLocked(mixed, "x")).toBe(true);
    expect(sizeLocked(mixed, "y")).toBe(true);
  });
  it("an auto-height text locks only H; shapes and frames alone neither", () => {
    const tall = node({ guid: "7:91", type: "TEXT", textAutoResize: "HEIGHT" });
    expect(sizeLocked([rect, tall], "x")).toBe(false);
    expect(sizeLocked([rect, tall], "y")).toBe(true);
    expect(sizeLocked([rect, frame], "x")).toBe(false);
  });
});

describe("Text edit header (live design/text-editing-caret.txt: Create link 152, Apply variable 180, Create component 208)", () => {
  it("while the text is edited: three actions, no More actions", () => {
    expect(headerKind([text], false, "7:90")).toBe("textEdit");
    expect(HEADER_ACTIONS.textEdit).toEqual(["link", "variable", "create"]);
  });
  it("at rest (or another layer edited): the text's four", () => {
    expect(headerKind([text], false, null)).toBe("text");
    expect(headerKind([text], false, "7:91")).toBe("text");
    expect(HEADER_ACTIONS.text).toEqual(["link", "variable", "create", "more"]);
  });
});

describe("Type settings › Details (live popovers/type-settings-details.txt on \"Hello Figma text\")", () => {
  const fontHas = (tag: string) => ["case", "cpsp", "frac", "zero", "dlig", "calt", "ordn", "salt", "kern", "ss01", "cv05", "dnom", "numr"].includes(tag);
  const a = detailsApplicable("Hello Figma text", fontHas, ["cpsp", "salt", "kern", "cv05", "numr"], false);
  it("a feature applies when it acts on the text; Contextual alternates, Fractions, Ordinals whenever the font has them", () => {
    expect(["cpsp", "salt", "kern", "cv05", "numr", "calt", "frac", "ordn"].every(a.feature)).toBe(true);
    expect(["case", "zero", "dlig", "ss01", "dnom"].some(a.feature)).toBe(false);
  });
  it("Number style without digits, Hanging punctuation without punctuation, Hanging lists without a list: not applicable", () => {
    expect([a.numbers, a.hanging, a.hangingList]).toEqual([false, false, false]);
    const b = detailsApplicable("“Open 4.”", fontHas, null, true);
    expect([b.numbers, b.hanging, b.hangingList]).toEqual([true, true, true]);
  });
  it("before the font answers every feature it has applies", () => {
    expect(detailsApplicable("x", fontHas, null, false).feature("zero")).toBe(true);
    expect(detailsApplicable("x", fontHas, null, false).feature("smcp")).toBe(false);
  });
  it("More features: Fraction denominators, Fraction numerators, Scientific inferiors (the shaping internals hidden)", () => {
    const inter = ["aalt", "calt", "case", "ccmp", "cv01", "dlig", "dnom", "frac", "locl", "numr", "ordn", "pnum", "salt", "sinf", "ss01", "subs", "sups", "tnum", "zero", "cpsp", "kern", "mark", "mkmk"].map((tag) => ({ tag }));
    expect(moreFeatures(inter).map((f) => f.label)).toEqual(["Fraction denominators", "Fraction numerators", "Scientific inferiors"]);
  });
});

describe("Popover places (live popovers/width-sizing-menu.txt, gap-menu.txt, typography-styles.txt)", () => {
  it("a W / H / gap list: its checked row 4 above the field (the panel's body at 81: W at 435, Hug contents at 431, the list at 399)", () => {
    expect(435 + SIZING_LIST_DY - 32).toBe(399);
    expect(485 + SIZING_LIST_DY - 8).toBe(473);
  });
  it("round 12: a plain child's Width list (no Hug contents) has its checked row level with the field: 387, the list at 379", () => {
    expect(387 + SIZING_LIST_DY_CHILD - 8).toBe(379);
  });
  it("Text styles opens as if 457 high: 427 in a 900 high window, from its button at 586", () => {
    expect(Math.min(586, 900 - 16 - Math.max(165, TEXT_STYLES_RESERVE))).toBe(427);
  });
});

describe("Capture fixture (live popovers/autolayout-advanced-settings.txt: Inside stroke Included)", () => {
  it("the auto layout frames include their strokes; the plain frame leaves it", () => {
    const byName = new Map((CAPTURE_DOCUMENT.nodeChanges ?? []).map((n) => [n.name, n]));
    for (const name of ["AL_vertical", "AL_horizontal", "AL_wrap", "AL_grid", "AL_parent"]) expect(byName.get(name)?.bordersTakeSpace).toBe(true);
    expect(byName.get("F_frame")?.bordersTakeSpace).toBeUndefined();
  });
});
