// @vitest-environment happy-dom
// Every shortcut the editor has, pressed while a text field has the focus (an input, a textarea — the Agents composer —,
// a contenteditable, plaintext-only too): the editor's keyboard layer does nothing with it (no engine key, no command,
// no preventDefault: the field types it). The owner's reports: N typed into the composer zoomed to the next frame, ⇧A
// typed into a field added auto layout. Both came through the menu bar (main's runsFromMenuBar, fieldKeys.test.ts);
// this is the page's own gate.
import { afterEach, describe, expect, it } from "vitest";
import { IS_MAC } from "@/ds";
import { COMMANDS, type KeyCombo } from "../commands";
import { attachKeyboard } from "../keyboard";
import type { EditorController } from "../controller";

/** The editor as the keyboard layer sees it: every way a key could act is recorded. */
function stubEditor() {
  const acted: string[] = [];
  const ed = {
    engineKey: (type: string, e: KeyboardEvent) => (acted.push(`engine ${type} ${e.code}`), true),
    vector: { state: { get: () => ({ active: false }) }, setTool: (t: string) => acted.push(`vector ${t}`) },
    ui: { get: () => ({ preferences: { numberKeysOpacity: true } }) },
    selection: ["1:2"],
    setProps: () => acted.push("setProps"),
  };
  return { ed: ed as unknown as EditorController, acted };
}

function press(target: Element, combo: KeyCombo): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    code: combo.code,
    key: combo.code.replace(/^Key|^Digit/, ""),
    shiftKey: !!combo.shift,
    altKey: !!combo.alt,
    metaKey: IS_MAC ? !!combo.mod : false,
    ctrlKey: IS_MAC ? !!combo.ctrl : !!combo.mod,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}

const fields: [string, () => HTMLElement][] = [
  ["a textarea (the Agents composer)", () => document.createElement("textarea")],
  ["an input (a Design panel field, Find, a rename field)", () => Object.assign(document.createElement("input"), { type: "text" })],
  ["a contenteditable", () => Object.assign(document.createElement("div"), { contentEditable: "true" })],
  ["a plaintext-only contenteditable", () => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "plaintext-only");
    return el;
  }],
  ["a span inside a contenteditable", () => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "");
    el.appendChild(document.createElement("span"));
    return el;
  }],
];

const combos = COMMANDS.flatMap((c) => (c.keys ?? []).map((k) => ({ id: c.id, k })));
// The tool letters and digits (opacity) are keys of the engine and the keyboard layer, not of the command table.
const extra: KeyCombo[] = [..."VKFRTOLPHCIQBN".split("").map((l) => ({ code: `Key${l}` })), ...[0, 1, 5, 9].map((d) => ({ code: `Digit${d}` })), { code: "Space" }, { code: "Backspace" }, { code: "Escape" }, { code: "Enter" }, { code: "Tab" }, { code: "ArrowLeft" }, { code: "KeyA", shift: true }];

let detach: (() => void) | null = null;
afterEach(() => {
  detach?.();
  detach = null;
  document.body.innerHTML = "";
});

describe("keys typed into a text field", () => {
  it("the command table has the reported keys (N, ⇧A)", () => {
    expect(combos.some(({ id, k }) => id === "view.zoom-next-frame" && k.code === "KeyN" && !k.shift)).toBe(true);
    expect(combos.some(({ id, k }) => id === "object.add-auto-layout" && k.code === "KeyA" && k.shift && !k.mod)).toBe(true);
  });

  for (const [what, make] of fields)
    it(`no shortcut acts from ${what} — every command's keys, the tool letters, digits, Space`, () => {
      const canvas = document.createElement("canvas");
      document.body.appendChild(canvas);
      const host = make();
      document.body.appendChild(host);
      const target = host.querySelector("span") ?? host;
      const { ed, acted } = stubEditor();
      detach = attachKeyboard(ed, canvas);
      const leaked: string[] = [];
      for (const { id, k } of [...combos, ...extra.map((k) => ({ id: k.code, k }))]) {
        const before = acted.length;
        const e = press(target, k);
        if (acted.length !== before || e.defaultPrevented) leaked.push(`${id} ${JSON.stringify(k)}`);
      }
      expect(leaked).toEqual([]);
    });

  it("the same keys away from a field do reach the editor (the check above isn't vacuous)", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const { ed, acted } = stubEditor();
    detach = attachKeyboard(ed, canvas);
    press(document.body, { code: "KeyN" });
    press(document.body, { code: "KeyA", shift: true });
    expect(acted).toEqual(["engine down KeyN", "engine down KeyA"]);
  });
});
