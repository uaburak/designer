// The font pickers' list: every installed family with its own styles (variable fonts' named instances), not the
// interim "Inter + the file's families" stub.
import { describe, expect, it } from "vitest";
import { closestStyle, groupFamilies, mergeFaces, type FontFaceInfo } from "@/engine/fonts";
import { familyNames, filterFamilies, missingFonts } from "../fontList";
import { fontFamilies, fontStyles } from "../panels/design/Typography";

const face = (family: string, style: string, weight: number, italic = false, id = `${family}-${style}`): FontFaceInfo => ({
  id, family, style, weight, italic, source: "system", collectionIndex: 0,
});

const faces: FontFaceInfo[] = [
  { ...face("Roboto Flex", "Black", 900, false, "flex"), variable: true },
  { ...face("Roboto Flex", "Regular", 400, false, "flex"), variable: true },
  { ...face("Roboto Flex", "Thin", 100, false, "flex"), variable: true },
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

  it("merges installed, Figma's Inter and Google's: installed wins, then Figma's Inter, then Google", () => {
    const google = [
      { family: "Lora", category: "Serif", popularity: 40, axes: [{}], styles: [{ style: "Regular", weight: 400, italic: false, id: "g:v:Lora" }] },
      { family: "Inter", category: "Sans Serif", popularity: 5, axes: [{}], styles: [{ style: "Regular", weight: 400, italic: false, id: "g:v:Inter" }] },
      { family: "Georgia", category: "Serif", popularity: 900, axes: [], styles: [{ style: "Regular", weight: 400, italic: false, id: "g:400:Georgia" }] },
    ];
    const list = groupFamilies(mergeFaces([face("Georgia", "Regular", 400)], google));
    expect(list.map((f) => `${f.family}:${f.source}`)).toEqual(["Georgia:local", "Inter:bundled", "Lora:google"]);
    expect(list.find((f) => f.family === "Inter")!.styles).toHaveLength(18);
    expect(list.find((f) => f.family === "Lora")).toMatchObject({ category: "Serif", popularity: 40, variable: true });
    // Inter installed on the computer: it wins over Figma's (as Figma's font helper's do).
    expect(groupFamilies(mergeFaces([face("Inter", "Regular", 400)], google)).find((f) => f.family === "Inter")!.source).toBe("local");
  });

  it("filters as Figma's menu: In this file, Popular, Installed by you, Google fonts, Variable fonts; searches names", () => {
    const list = groupFamilies(mergeFaces(faces, [
      { family: "Lora", category: "Serif", popularity: 40, axes: [{}], styles: [{ style: "Regular", weight: 400, italic: false, id: "g:v:Lora" }] },
      { family: "Abril Fatface", category: "Display", popularity: 300, axes: [], styles: [{ style: "Regular", weight: 400, italic: false, id: "g:400:Abril Fatface" }] },
    ]));
    const names = (l: { family: string }[]) => l.map((f) => f.family);
    expect(names(filterFamilies(list, "google", ""))).toEqual(["Abril Fatface", "Lora"]);
    expect(names(filterFamilies(list, "installed", ""))).toEqual(["avenir", "Helvetica Neue", "Roboto Flex"]);
    expect(names(filterFamilies(list, "variable", ""))).toEqual(["Inter", "Lora", "Roboto Flex"]);
    expect(names(filterFamilies(list, "file", "", new Set(["helvetica neue"])))).toEqual(["Helvetica Neue"]);
    expect(names(filterFamilies(list, "popular", ""))).toEqual(["Abril Fatface", "Inter", "Lora"]);
    expect(names(filterFamilies(list, "all", "neue helv"))).toEqual(["Helvetica Neue"]);
    expect(names(filterFamilies(list, "all", "AVÉN"))).toEqual(["avenir"]);
  });

  it("finds the document's missing fonts: a family nobody has, or a style the family lacks", () => {
    const list = groupFamilies(mergeFaces(faces));
    const used = [
      { family: "Inter", style: "Semi Bold", uses: 3 },
      { family: "Helvetica Neue", style: "Black", uses: 1 },
      { family: "Matter", style: "Medium", uses: 7 },
      { family: "Roboto Flex", style: "Black", uses: 2 },
    ];
    expect(missingFonts(list, used).map((m) => `${m.family} ${m.style}`)).toEqual(["Helvetica Neue Black", "Matter Medium"]);
    expect(missingFonts(null, used)).toEqual([]);
  });

  it("keeps the style across a family change, else the nearest weight and slant", () => {
    expect(closestStyle(["Regular", "Italic", "Bold", "Bold Italic"], "Bold")).toBe("Bold");
    expect(closestStyle(["Regular", "SemiBold", "Bold"], "Semi Bold")).toBe("SemiBold");
    expect(closestStyle(["Regular", "Italic", "Bold", "Bold Italic"], "Semi Bold Italic")).toBe("Bold Italic");
    expect(closestStyle(["Thin", "Regular", "Black"], "Medium")).toBe("Regular");
  });
});
