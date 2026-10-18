// Actions' ranking (Atlas 03 §9.1, §9.2): the weighted score, frecency's buckets and cap, Figma's popularity order.
import { describe, expect, it } from "vitest";
import { bucketScore, frecencyKey, frecencyOf, fuzzyScore, matchScore, popularity, rankScore, RANK_WEIGHTS, substringScore, withRun, type FrecencyHistory } from "../panels/actionsRank";
import { actionRows } from "../panels/ActionsPanel";
import type { ActionItem } from "../menus";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("Actions' ranking", () => {
  it("weighs the match 0.4, can run 0.3, frecency 0.2 (f / (f + 1 000)), AI 0.1", () => {
    expect(Object.values(RANK_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(rankScore({ match: 1, enabled: true, frecency: 1000, ai: true })).toBeCloseTo(0.4 + 0.3 + 0.1 + 0.1);
    expect(rankScore({ match: 0.5, enabled: false, frecency: 0, ai: false })).toBeCloseTo(0.2);
  });

  it("matches fuzzily (the letters in order, against the label's own perfect score) and by substring", () => {
    expect(fuzzyScore("Flatten", "Flatten")).toBe(1);
    expect(fuzzyScore("Flatten", "fltn")).toBeGreaterThan(0);
    expect(fuzzyScore("Flatten", "xyz")).toBe(0);
    // A word's start beats the middle; a shorter label answers better.
    expect(fuzzyScore("Select all", "al")).toBeGreaterThan(fuzzyScore("Ungroup selection", "al"));
    expect(substringScore("Paste over selection", "sel")).toBeGreaterThan(0);
    expect(substringScore("Flatten", "att")).toBe((3 / 7) * 0.5);
    // Its other wording (the English label under Turkish) counts too.
    expect(matchScore("Düzleştir", "flatten", ["Flatten"])).toBe(1);
  });

  it("keeps Figma's frecency: buckets 100 … 0 by age, count × mean, 10 runs, the label cut to 20", () => {
    expect([0, HOUR, 5 * HOUR, 2 * DAY, 10 * DAY, 60 * DAY, 100 * DAY].map(bucketScore)).toEqual([100, 70, 50, 30, 20, 10, 0]);
    const now = 100 * DAY;
    let h: FrecencyHistory = {};
    for (let i = 0; i < 12; i++) h = withRun(h, "Select matching layers", now - i * 1000);
    expect(Object.keys(h)).toEqual([frecencyKey("Select matching layers")]);
    expect(frecencyKey("Select matching layers")).toHaveLength(20);
    const r = h[frecencyKey("Select matching layers")];
    expect(r.timestamps).toHaveLength(10);
    expect(r.count).toBe(12);
    expect(frecencyOf(h, "Select matching layers", now)).toBe(1200);
    expect(frecencyOf(h, "Select matching layers", now + 2 * DAY)).toBe(12 * 30);
  });

  it("orders the unsearched list by Figma's popularity: Ungroup, Group, Wrap in new section first", () => {
    expect(popularity("object.ungroup")).toBe(320);
    expect(popularity("object.group")).toBe(319);
    expect(popularity("object.wrap-in-section")).toBe(318);
    expect(popularity("view.zoom-50")).toBe(0);
    const items: ActionItem[] = [
      { id: "view.zoom-50", label: "Zoom to 50%", section: "View", disabled: false },
      { id: "object.group", label: "Group selection", section: "Object", disabled: false },
      { id: "object.ungroup", label: "Ungroup selection", section: "Object", disabled: false },
    ];
    expect(actionRows(items, "", [], () => true, { all: true }).map((r) => r.label)).toEqual(["Ungroup selection", "Group selection", "Zoom to 50%"]);
  });

  it("puts what can run before what can't, and what ran often and lately higher", () => {
    const items: ActionItem[] = [
      { id: "a", label: "Select inverse", section: "Edit", disabled: true },
      { id: "b", label: "Select none", section: "Edit", disabled: false },
      { id: "c", label: "Select matching layers", section: "Edit", disabled: false },
    ];
    const run = () => true;
    expect(actionRows(items, "select", [], run).map((r) => r.label)).toEqual(["Select none", "Select matching layers", "Select inverse"]);
    const now = 10 * DAY;
    let h: FrecencyHistory = {};
    for (let i = 0; i < 100; i++) h = withRun(h, "Select matching layers", now);
    expect(actionRows(items, "select", [], run, { frecency: h, now }).map((r) => r.label)).toEqual(["Select matching layers", "Select none", "Select inverse"]);
  });
});
