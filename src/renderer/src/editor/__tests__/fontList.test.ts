// The font pickers' list: every installed family with its own styles (variable fonts' named instances), not the
// interim "Inter + the file's families" stub.
import { describe, expect, it } from "vitest";
import { closestStyle, groupFamilies, type FontFaceInfo } from "@/engine/fonts";
import { familyNames } from "../fontList";
import { fontFamilies, fontStyles } from "../panels/design/Typography";

const face = (family: string, style: string, weight: number, italic = false, id = `${family}-${style}`): FontFaceInfo => ({
  id, family, style, weight, italic, source: "system", collectionIndex: 0,
});

const faces: FontFaceInfo[] = [
  face("Roboto Flex", "Black", 900, false, "flex"),
  face("Roboto Flex", "Regular", 400, false, "flex"),
  face("Roboto Flex", "Thin", 100, false, "flex"),
  face("avenir", "Book", 300),
  face("Helvetica Neue", "Bold Italic", 700, true),
  face("Helvetica Neue", "Bold", 700),
  face("Helvetica Neue", "Italic", 400, true),
  face("Helvetica Neue", "Regular", 400),
];

describe("font list", () => {
  it("groups faces into families sorted by name, styles by weight with the upright first", () => {
    const list = groupFamilies(faces);
    expect(list.map((f) => f.family)).toEqual(["avenir", "Helvetica Neue", "Roboto Flex"]);
    expect(list[1].styles).toEqual(["Regular", "Italic", "Bold", "Bold Italic"]);
    // A variable font's named instances are its styles.
    expect(list[2].styles).toEqual(["Thin", "Regular", "Black"]);
  });

  it("lists every installed family, plus the selection's missing ones", () => {
    const list = groupFamilies(faces);
    expect(fontFamilies(list, [{ fontName: { family: "Matter" } }])).toEqual(["avenir", "Helvetica Neue", "Inter", "Matter", "Roboto Flex"]);
    expect(familyNames(list, ["helvetica neue"])).toEqual(["avenir", "Helvetica Neue", "Roboto Flex"]);
  });

  it("offers a family's own styles, the current one when the family isn't installed", () => {
    const list = groupFamilies(faces);
    expect(fontStyles(list, "Helvetica Neue", "Bold")).toEqual(["Regular", "Italic", "Bold", "Bold Italic"]);
    expect(fontStyles(list, "Matter", "Medium")).toEqual(["Medium"]);
    // Before the list arrives Inter offers its nine weights.
    expect(fontStyles(null, "Inter", "Regular")).toContain("Semi Bold");
  });

  it("keeps the style across a family change, else the nearest weight and slant", () => {
    expect(closestStyle(["Regular", "Italic", "Bold", "Bold Italic"], "Bold")).toBe("Bold");
    expect(closestStyle(["Regular", "SemiBold", "Bold"], "Semi Bold")).toBe("SemiBold");
    expect(closestStyle(["Regular", "Italic", "Bold", "Bold Italic"], "Semi Bold Italic")).toBe("Bold Italic");
    expect(closestStyle(["Thin", "Regular", "Black"], "Medium")).toBe("Regular");
  });
});
