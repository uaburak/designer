// Round 6a: Rename layers' eligibility rules, the outline's batches, Replace content's groups, texts written whole,
// and First Draft's builder — pure, without the engine.
import { describe, expect, it } from "vitest";
import { KITS, kitById } from "@shared/ai/kits";
import { OUTLINE_MAX_LAYERS } from "@shared/ai/prompts";
import type { Layer } from "../ai/layers";
import { outlineBatches } from "../ai/layers";
import { hasDefaultName, matchGroups, renameCandidates } from "../ai/rename";
import { likelyButton, repeatGroups, textDataFor } from "../ai/service";
import { BUILT_BLOCKS, buildDraft, onColor } from "../ai/draft/build";

let next = 1;
function L(type: string, name: string, o: Partial<Layer> = {}, children: Layer[] = []): Layer {
  return { id: `1:${next++}`, type, name, hidden: false, locked: false, width: 100, height: 40, imageFill: false, inInstance: false, top: null, path: "", children, ...o };
}

describe("Rename layers' rules", () => {
  it("default names by kind", () => {
    expect(hasDefaultName(L("FRAME", "Frame 12"))).toBe(true);
    expect(hasDefaultName(L("FRAME", "Frame"))).toBe(true);
    expect(hasDefaultName(L("FRAME", "Header"))).toBe(false);
    expect(hasDefaultName(L("GROUP", "Group 3"))).toBe(true);
    expect(hasDefaultName(L("RECTANGLE", "Image 2"))).toBe(true);
    expect(hasDefaultName(L("TEXT", "Welcome back", { text: "Welcome back" }))).toBe(true);
    expect(hasDefaultName(L("TEXT", "Title", { text: "Welcome back" }))).toBe(false);
    expect(hasDefaultName(L("TEXT", "Anything", { text: "x", autoRename: true }))).toBe(true);
    expect(hasDefaultName(L("INSTANCE", "Button", { mainName: "Button" }))).toBe(true);
    expect(hasDefaultName(L("INSTANCE", "Submit", { mainName: "Button" }))).toBe(false);
  });

  it("skips renamed, hidden and locked layers (with what is in them), layers inside instances and plain vectors; renames an instance alone", () => {
    const inner = L("TEXT", "Label", { text: "Label", inInstance: true });
    const instance = L("INSTANCE", "Button", { mainName: "Button" }, [inner]);
    const hiddenText = L("TEXT", "Secret", { text: "Secret" });
    const lockedText = L("TEXT", "Locked", { text: "Locked" });
    const image = L("RECTANGLE", "Rectangle 2", { imageFill: true });
    const plain = L("RECTANGLE", "Rectangle 3");
    const vector = L("VECTOR", "Vector 1");
    const ellipse = L("ELLIPSE", "Ellipse 1");
    const renamed = L("FRAME", "Header", {}, [L("TEXT", "Hi", { text: "Hi" })]);
    const root = L("FRAME", "Frame 1", {}, [instance, L("FRAME", "Frame 2", { hidden: true }, [hiddenText]), L("GROUP", "Group 1", { locked: true }, [lockedText]), image, plain, vector, ellipse, renamed]);
    const got = renameCandidates([root]).map((l) => l.name);
    expect(got).toEqual(["Frame 1", "Button", "Rectangle 2", "Hi"]);
    // Rename anyway: renamed ones too — still not hidden, locked, inside instances or vectors.
    expect(renameCandidates([root], true).map((l) => l.name)).toEqual(["Frame 1", "Button", "Rectangle 2", "Header", "Hi"]);
  });

  it("matching layers across top-level frames form one group; top-level frames stay alone", () => {
    const a1 = L("FRAME", "Frame 3", { top: "A", path: "0" });
    const b1 = L("FRAME", "Frame 3", { top: "B", path: "0" });
    const a2 = L("TEXT", "Hi", { top: "A", path: "0/0" });
    const topA = L("FRAME", "Frame 1", { top: "A", path: "" });
    const topB = L("FRAME", "Frame 2", { top: "B", path: "" });
    expect(matchGroups([topA, a1, a2, topB, b1]).map((g) => g.map((l) => l.id))).toEqual([[topA.id], [a1.id, b1.id], [a2.id], [topB.id]]);
  });
});

describe("outline batches", () => {
  it("cuts trees over 400 layers into batches; every layer is in one", () => {
    const rows = Array.from({ length: 900 }, (_, i) => L("TEXT", `T${i}`, { text: "x" }));
    const root = L("FRAME", "Big", {}, [L("FRAME", "A", {}, rows.slice(0, 300)), L("FRAME", "B", {}, rows.slice(300, 600)), L("FRAME", "C", {}, rows.slice(600))]);
    const batches = outlineBatches([root]);
    const count = (ns: { children?: unknown[] }[]): number => ns.reduce((s, n) => s + 1 + count((n.children ?? []) as never), 0);
    for (const b of batches) expect(count(b)).toBeLessThanOrEqual(OUTLINE_MAX_LAYERS);
    expect(batches.reduce((s, b) => s + count(b), 0)).toBe(904);
  });
});

describe("Replace content's groups and the text write", () => {
  it("repeated siblings' texts at the same place form a group", () => {
    const row = () => L("FRAME", "Row", {}, [L("TEXT", "Name", { text: "Lorem" }), L("TEXT", "Price", { text: "$0" })]);
    const rows = [row(), row(), row()];
    const groups = repeatGroups([L("FRAME", "List", {}, rows)]);
    expect(groups).toEqual([rows.map((r) => r.children[0].id), rows.map((r) => r.children[1].id)]);
  });

  it("a text keeps its first run's style for every character; lines follow the paragraphs", () => {
    expect(textDataFor({ characters: "ab", characterStyleIDs: [3, 0], styleOverrideTable: [{ styleID: 3 }], lines: [{ lineType: "PLAIN" }] }, "x\ny")).toEqual({ characters: "x\ny", characterStyleIDs: [3, 3, 3], styleOverrideTable: [{ styleID: 3 }], lines: [{ lineType: "PLAIN" }, { lineType: "PLAIN" }] });
    expect(textDataFor({ characters: "ab" }, "c")).toEqual({ characters: "c", characterStyleIDs: [] });
  });

  it("likely buttons", () => {
    expect(likelyButton(L("FRAME", "Sign up button"))).toBe(true);
    expect(likelyButton(L("FRAME", "Frame 4", { height: 44 }, [L("TEXT", "Go", { text: "Go" })]))).toBe(true);
    expect(likelyButton(L("FRAME", "Hero", { height: 400 }, [L("TEXT", "Go", { text: "Go" })]))).toBe(false);
  });
});

describe("First Draft's builder", () => {
  it("draws every block of every kit; the frame is 390 / 1440 wide, vertical auto layout, plain layers", () => {
    for (const kit of KITS) {
      for (const b of kit.blocks) expect(BUILT_BLOCKS.has(b.id), `${kit.id} ${b.id}`).toBe(true);
      const spec = buildDraft({ name: "All", platform: kit.platform, blocks: kit.blocks.map((b) => ({ block: b.id, props: {} })) }, kit, kit.themes[0]);
      expect(spec).toMatchObject({ type: "FRAME", name: "All", width: kit.width, layoutMode: "VERTICAL", layoutSizingVertical: "HUG" });
      expect((spec.children as unknown[]).length).toBe(kit.blocks.length);
      const types = new Set<string>();
      const walk = (s: Record<string, unknown>) => {
        types.add(String(s.type));
        (s.children as Record<string, unknown>[] | undefined)?.forEach(walk);
      };
      walk(spec);
      expect([...types].every((t) => ["FRAME", "TEXT", "RECTANGLE"].includes(t))).toBe(true);
    }
  });

  it("is deterministic; themes and style controls change colours, radius, spacing and fonts", () => {
    const kit = kitById("app-design");
    const plan = { name: "S", platform: "app" as const, blocks: [{ block: "buttons", props: { primary: "Go" } }] };
    const a = buildDraft(plan, kit, kit.themes[0]);
    expect(buildDraft(plan, kit, kit.themes[0])).toEqual(a);
    const btn = (s: Record<string, unknown>) => ((s.children as Record<string, unknown>[])[0].children as Record<string, unknown>[])[0];
    expect(btn(a)).toMatchObject({ fills: [kit.themes[0].light.primary], cornerRadius: kit.themes[0].radius });
    const b = buildDraft(plan, kit, kit.themes[0], { mode: "dark", primary: "#FFD600", radius: 99, fonts: { label: "DM Sans" } });
    expect(btn(b)).toMatchObject({ fills: ["#FFD600"], cornerRadius: 99 });
    expect((btn(b).children as Record<string, unknown>[])[0]).toMatchObject({ fontFamily: "DM Sans", fills: ["#141414"] });
    expect(b.fills).toEqual([kit.themes[0].dark.background]);
    expect(onColor("#000000")).toBe("#FFFFFF");
  });
});
