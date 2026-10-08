import { describe, expect, it } from "vitest";
import { COMMAND_BY_ID, comboText, matchesCombo } from "../commands";
import { MAIN_MENU } from "../menus";
import { opacityForDigit } from "../opacityKeys";
import { pasteOptions } from "../clipboardIO";

const key = (code: string, mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  code,
  shiftKey: !!mods.shiftKey,
  altKey: !!mods.altKey,
  ctrlKey: !!mods.ctrlKey,
  metaKey: !!mods.metaKey,
});
const pressed = (id: string, e: ReturnType<typeof key>) => COMMAND_BY_ID.get(id)!.keys!.some((c) => matchesCombo(c, e, true));

describe("round 7: live Figma's keys and menus", () => {
  it("opacity digits: one digit tens, 0 = 100 %; two within ~475 ms combine", () => {
    let r = opacityForDigit(null, 5, 0);
    expect(r.opacity).toBe(0.5);
    expect(opacityForDigit(null, 0, 0).opacity).toBe(1);
    r = opacityForDigit(opacityForDigit(null, 4, 1000).buffer, 5, 1450);
    expect(r.opacity).toBeCloseTo(0.45);
    expect(r.buffer).toBeNull();
    expect(opacityForDigit(opacityForDigit(null, 0, 0).buffer, 5, 100).opacity).toBeCloseTo(0.05);
    expect(opacityForDigit(opacityForDigit(null, 1, 0).buffer, 0, 100).opacity).toBeCloseTo(0.1);
    // 500 ms or more: the second starts over.
    expect(opacityForDigit(opacityForDigit(null, 4, 0).buffer, 5, 500).opacity).toBe(0.5);
  });

  it("the live shortcuts: ] [ front/back, ⌘] ⌘[ one step, N ⇧N, ⇧⌘O, ⇧', ⌘S, ⌘⌫, ⇧⌘R, ⌥⌘A, ⌃⌥T", () => {
    expect(pressed("object.bring-to-front", key("BracketRight"))).toBe(true);
    expect(pressed("object.bring-to-front", key("BracketRight", { metaKey: true, altKey: true }))).toBe(true);
    expect(pressed("object.send-to-back", key("BracketLeft"))).toBe(true);
    expect(pressed("object.bring-forward", key("BracketRight", { metaKey: true }))).toBe(true);
    expect(pressed("object.send-backward", key("BracketLeft", { metaKey: true }))).toBe(true);
    expect(pressed("view.zoom-next-frame", key("KeyN"))).toBe(true);
    expect(pressed("view.zoom-previous-frame", key("KeyN", { shiftKey: true }))).toBe(true);
    expect(pressed("view.outlines", key("KeyO", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("view.pixel-grid", key("Quote", { shiftKey: true }))).toBe(true);
    expect(pressed("object.wrap-in-section", key("KeyS", { metaKey: true }))).toBe(true);
    expect(pressed("object.ungroup", key("Backspace", { metaKey: true }))).toBe(true);
    expect(pressed("edit.paste-to-replace", key("KeyR", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("edit.select-matching", key("KeyA", { metaKey: true, altKey: true }))).toBe(true);
    expect(pressed("arrange.tidy-up", key("KeyT", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(pressed("vector.flatten", key("KeyF", { altKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("view.minimize-ui", key("Backslash", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(comboText(COMMAND_BY_ID.get("view.pixel-grid")!.keys![0])).toContain("′");  // live: "⇧′"
  });

  it("paste modes: ⇧⌘V above the selection at its position (round 8), ⇧⌘R replacing it", () => {
    expect(pasteOptions({ mode: "over" })).toEqual({ over: true });
    expect(pasteOptions({ mode: "replace" })).toEqual({ replace: true });
    expect(pasteOptions({ mode: "inPlace" })).toEqual({ inPlace: true });
    expect(pasteOptions(null)).toEqual({ inPlace: false });
  });

  it("the main menu's Edit, View, Object and Arrange in live Figma's order", () => {
    const sub = (label: string) => (MAIN_MENU.find((s) => typeof s === "object" && "label" in s && s.label === label) as { items: unknown[] }).items;
    const ids = (label: string) => sub(label).filter((s): s is string => typeof s === "string" && s !== "-");
    expect(ids("Edit").slice(0, 6)).toEqual(["edit.undo", "edit.redo", "edit.paste-over-selection", "edit.paste-to-replace", "edit.duplicate", "edit.delete"]);
    expect(ids("Edit").slice(-4)).toEqual(["edit.select-all", "edit.select-matching", "edit.select-none", "edit.select-inverse"]);
    expect(ids("View").slice(0, 3)).toEqual(["view.pixel-grid", "view.layout-guides", "view.rulers"]);
    expect(ids("View").slice(-6)).toEqual(["view.previous-page", "view.next-page", "view.zoom-previous-frame", "view.zoom-next-frame", "view.find-previous-frame", "view.find-next-frame"]);
    expect(ids("Object").slice(0, 4)).toEqual(["object.frame-selection", "object.group", "object.ungroup", "object.wrap-in-section"]);
    expect(ids("Arrange").slice(0, 8)).toEqual([
      "arrange.round-to-pixel",
      "arrange.align-left",
      "arrange.align-horizontal-center",
      "arrange.align-right",
      "arrange.align-top",
      "arrange.align-vertical-center",
      "arrange.align-bottom",
      "arrange.tidy-up",
    ]);
    // Every id in the menus is a registered command.
    const all = (specs: unknown[]): string[] =>
      specs.flatMap((s) => (typeof s === "string" ? (s === "-" ? [] : [s]) : typeof s === "object" && s && "items" in s ? all((s as { items: unknown[] }).items) : []));
    for (const id of all(MAIN_MENU)) expect(COMMAND_BY_ID.has(id), id).toBe(true);
  });
});
