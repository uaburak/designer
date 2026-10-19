// @vitest-environment happy-dom
// "/" opens Cursor chat (docs/governance.md §9 "End-to-end run": in headless Chromium the keydown arrived and
// `ui.cursorChat` stayed null). The keyboard layer matches by `code` ("Slash", any `key`), from the canvas or the body;
// a field, a dialog or the org's Cursor chat setting keep it closed.
import { afterEach, describe, expect, it } from "vitest";
import { attachKeyboard } from "../keyboard";
import type { EditorController } from "../controller";

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  document.body.innerHTML = "";
});

function editor() {
  let ui: Record<string, unknown> = {};
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const ed = {
    engineKey: () => false, // the engine has no use for "/"
    vector: { state: { get: () => ({ active: false }) } },
    ui: { get: () => ui, set: (p: Record<string, unknown>) => void (ui = { ...ui, ...p }), subscribe: () => () => {} },
    selection: [],
    source: {},
    canvas,
  } as unknown as EditorController;
  offs.push(attachKeyboard(ed, canvas));
  return { ed, canvas, chat: () => ui.cursorChat ?? null };
}

const slash = (target: EventTarget, key = "/") => {
  const e = new KeyboardEvent("keydown", { code: "Slash", key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe("Cursor chat's key", () => {
  it("opens from the canvas and from the page, by the key's code", () => {
    const a = editor();
    expect(slash(a.canvas).defaultPrevented).toBe(true);
    expect(a.chat()).not.toBeNull();
    offs.splice(0).forEach((off) => off());
    const b = editor();
    slash(document.body, "Dead"); // another layout's character on the same key: still the key
    expect(b.chat()).not.toBeNull();
  });

  it("a field or a dialog keeps the key", () => {
    const { chat } = editor();
    const input = document.createElement("input");
    document.body.append(input);
    slash(input);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    dialog.append(inside);
    document.body.append(dialog);
    slash(inside);
    expect(chat()).toBeNull();
  });
});
