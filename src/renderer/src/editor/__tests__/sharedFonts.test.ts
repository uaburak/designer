// Organization and team fonts in the editor (docs/desktop.md §14.3): the open file's scope picks them (a local file
// none, another org's file none, a team's fonts only in that team's files), precedence installed > team > org >
// Figma's Inter > Google, the picker's "Used at ‹organization›", and the scope set before a file's fonts are asked for.
import { describe, expect, it, vi } from "vitest";
import { fonts, groupFamilies, matchFace, mergeFaces, sharedForScope, type FontFaceInfo, type FontScope, type GoogleFamilyEntry, type SharedFaceEntry } from "@/engine/fonts";
import { filterFamilies, fontFilterMenu } from "../fontList";
import { applyFontScope } from "../openFonts";

const shared = (id: string, family: string, style: string, weight: number, orgId: string, teamId: string | null): SharedFaceEntry => ({ id, family, style, weight, italic: false, orgId, teamId });

const INDEX: SharedFaceEntry[] = [
  shared("o1", "Acme Sans", "Regular", 400, "acme", null),
  shared("o2", "Acme Sans", "Bold", 700, "acme", null),
  shared("o3", "Brand Serif", "Regular", 400, "acme", null),
  shared("t1", "Brand Serif", "Regular", 400, "acme", "brand"),
  shared("t2", "Brand Serif", "Italic", 400, "acme", "brand"),
  shared("t3", "Campaign", "Regular", 400, "acme", "marketing"),
  shared("x1", "Other Org Font", "Regular", 400, "globex", null),
  shared("o4", "Inter", "Regular", 400, "acme", null),
  shared("o5", "Lora", "Regular", 400, "acme", null),
];
const ORG_FILE: FontScope = { orgId: "acme", teamId: null, orgName: "Acme" };
const TEAM_FILE: FontScope = { orgId: "acme", teamId: "brand", orgName: "Acme" };
const names = (faces: FontFaceInfo[]) => [...new Set(faces.map((f) => f.family))].sort();
const installed = (family: string): FontFaceInfo => ({ id: family, family, style: "Regular", weight: 400, italic: false, source: "user", collectionIndex: 0 });
const LORA: GoogleFamilyEntry = { family: "Lora", category: "Serif", popularity: 40, axes: [], styles: [{ style: "Regular", weight: 400, italic: false, id: "g:400:Lora" }] };

describe("shared fonts in the editor", () => {
  it("a file sees its organization's fonts and its own team's — not other teams', other orgs', or any in a local file", () => {
    expect(sharedForScope(INDEX, null)).toEqual([]);
    expect(names(sharedForScope(INDEX, ORG_FILE))).toEqual(["Acme Sans", "Brand Serif", "Inter", "Lora"]);
    expect(names(sharedForScope(INDEX, TEAM_FILE))).toEqual(["Acme Sans", "Brand Serif", "Inter", "Lora"]);
    expect(sharedForScope(INDEX, TEAM_FILE).filter((f) => f.teamId === "brand").map((f) => f.id)).toEqual(["s:t1", "s:t2"]);
    expect(sharedForScope(INDEX, { orgId: "globex", teamId: null, orgName: null }).map((f) => f.id)).toEqual(["s:x1"]);
    expect(sharedForScope(INDEX, ORG_FILE)[0]).toMatchObject({ id: "s:o1", source: "shared", orgId: "acme", teamId: null, collectionIndex: 0 });
  });

  it("precedence: installed > team > organization > Figma's Inter > Google, a family from one place", () => {
    const faces = mergeFaces([installed("Acme Sans")], [LORA], sharedForScope(INDEX, TEAM_FILE));
    const from = (family: string) => [...new Set(faces.filter((f) => f.family === family).map((f) => f.id))];
    expect(from("Acme Sans")).toEqual(["Acme Sans"]); // installed wins
    expect(from("Brand Serif")).toEqual(["s:t1", "s:t2"]); // the team's, not the org's
    expect(from("Inter")).toEqual(["s:o4"]); // the organization's over Figma's own
    expect(from("Lora")).toEqual(["s:o5"]); // over Google's
    expect(matchFace(faces, "Brand Serif", "Italic")?.id).toBe("s:t2");
    // A local file: Figma's Inter and Google's Lora as before.
    const local = mergeFaces([], [LORA], sharedForScope(INDEX, null));
    expect(local.find((f) => f.family === "Inter")?.source).toBe("bundled");
    expect(local.find((f) => f.family === "Lora")?.source).toBe("google");
  });

  it("the picker's filter: \"Used at ‹organization›\" only in an organization's file, listing its shared families", () => {
    expect(fontFilterMenu(null).map((e) => (e === "-" ? "-" : e.label))).toEqual(["All fonts", "-", "In this file", "-", "Popular fonts", "Google fonts", "Variable fonts", "-", "Uploaded by you", "Installed by you"]);
    expect(fontFilterMenu("Acme").map((e) => (e === "-" ? "-" : e.label)).slice(-3)).toEqual(["Used at Acme", "Uploaded by you", "Installed by you"]);
    const list = groupFamilies(mergeFaces([installed("Helvetica")], [LORA], sharedForScope(INDEX, TEAM_FILE)));
    expect(list.find((f) => f.family === "Brand Serif")?.source).toBe("shared");
    expect(filterFamilies(list, "org", "").map((f) => f.family)).toEqual(["Acme Sans", "Brand Serif", "Inter", "Lora"]);
    expect(filterFamilies(list, "installed", "").map((f) => f.family)).toEqual(["Helvetica"]);
    expect(filterFamilies(list, "all", "").map((f) => f.family)).toContain("Brand Serif");
  });

  it("the open file's scope is set before its fonts are asked for, then the organization's name", async () => {
    const setScope = vi.fn();
    let name: (n: string | null) => void = () => {};
    const cancel = applyFontScope({ fileSpace: () => ({ orgId: "acme", teamId: "brand" }), orgName: () => new Promise((r) => (name = r)) }, { setScope });
    expect(setScope).toHaveBeenLastCalledWith({ orgId: "acme", teamId: "brand", orgName: null });
    name("Acme");
    await vi.waitFor(() => expect(setScope).toHaveBeenLastCalledWith({ orgId: "acme", teamId: "brand", orgName: "Acme" }));
    cancel();
    applyFontScope({}, { setScope });
    expect(setScope).toHaveBeenLastCalledWith(null);
  });

  it("the font service lists the scope's shared faces and reads the list again when the scope changes", async () => {
    const list = vi.fn(async (scope?: FontScope | null) => mergeFaces([], [], sharedForScope(INDEX, scope)));
    fonts.setSource({ list, read: async () => new Uint8Array() });
    const changed = vi.fn();
    const off = fonts.onListChange(changed);
    expect(names(await fonts.list()).includes("Brand Serif")).toBe(false);
    fonts.setScope(TEAM_FILE);
    expect(changed).toHaveBeenCalled();
    expect((await fonts.list()).filter((f) => f.family === "Brand Serif").map((f) => f.id)).toEqual(["s:t1", "s:t2"]);
    const calls = list.mock.calls.length;
    // The name alone: the pickers hear it, the list isn't read again.
    fonts.setScope({ ...TEAM_FILE, orgName: "Acme Inc" });
    await fonts.list();
    expect(list.mock.calls.length).toBe(calls);
    expect(fonts.scope()?.orgName).toBe("Acme Inc");
    fonts.setScope(null);
    expect(names(await fonts.list()).includes("Brand Serif")).toBe(false);
    off();
  });
});
