// @vitest-environment happy-dom
// A prototype playing over the editor has the keys (the "Web davranışları turu" recording: with frame 01 selected,
// "5" pressed during Present here set its opacity to 0.5 — "unsaved changes"). Present here takes every key, wherever
// the focus is; the inline preview the keys it has the focus for. The editor's keyboard layer, its Delete for property
// rows and the menu bar's keys (desktop.ts) leave the document alone then; without a presentation the same key acts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { attachKeyboard, presentationHasKeys } from "../keyboard";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.body.innerHTML = "";
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  cleanups.push(attachKeyboard(ed, canvas), () => engine.destroy());
  engine.setSelection(["1:5"]);
  return { ed, engine, source, canvas };
}

function press(target: EventTarget, code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { code, key: code.replace(/^Digit|^Key/, "").toLowerCase(), bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  target.dispatchEvent(new KeyboardEvent("keyup", { code, key: e.key, bubbles: true, cancelable: true, ...init }));
  return e;
}

/** The keys of the recording and the editor's busiest ones: digits (opacity), Delete, tool letters, ⌘D, ⌘G, arrows. */
const KEYS: [string, KeyboardEventInit?][] = [
  ["Digit5"],
  ["Digit0"],
  ["Backspace"],
  ["Delete"],
  ["KeyR"],
  ["KeyC"],
  ["KeyA", { shiftKey: true }],
  ["KeyD", { metaKey: true, ctrlKey: true }],
  ["KeyG", { metaKey: true, ctrlKey: true }],
  ["ArrowRight"],
  ["ArrowDown", { shiftKey: true }],
  ["BracketRight", { metaKey: true }],
];

describe("keys while a prototype plays over the editor", () => {
  it("Present here: no key changes the document, whatever has the focus", async () => {
    const { ed, engine, source, canvas } = await editor();
    const before = source.changes.length;
    const opacity = engine.readNode("1:5")?.opacity ?? 1;
    ed.ui.set({ presenting: { page: "0:1", node: null } });
    // The presentation's own canvas (in the page), the editor's canvas, the body.
    const present = document.createElement("div");
    present.setAttribute("data-presentation", "");
    const presentCanvas = document.createElement("canvas");
    presentCanvas.tabIndex = 0;
    present.appendChild(presentCanvas);
    document.body.appendChild(present);
    for (const target of [presentCanvas, canvas, document.body])
      for (const [code, init] of KEYS) {
        const e = press(target, code, init);
        expect(e.defaultPrevented, code).toBe(false);
      }
    expect(source.changes.length).toBe(before);
    expect(engine.readNode("1:5")?.opacity ?? 1).toBeCloseTo(opacity);
    expect(engine.readNode("1:5")).toBeTruthy();
    expect(ed.selection).toEqual(["1:5"]);

    // Present here closed: the same digit sets the opacity again (the editor's own).
    ed.ui.set({ presenting: null });
    press(document.body, "Digit5");
    expect(engine.readNode("1:5")?.opacity).toBeCloseTo(0.5);
    expect(source.changes.length).toBe(before + 1);
  });

  it("the inline preview: its keys while it has the focus, the editor's otherwise", async () => {
    const { ed, engine, source } = await editor();
    const before = source.changes.length;
    const inline = document.createElement("div");
    inline.setAttribute("data-presentation", "inline");
    const previewCanvas = document.createElement("canvas");
    previewCanvas.tabIndex = 0;
    inline.appendChild(previewCanvas);
    document.body.appendChild(inline);
    expect(presentationHasKeys(ed, previewCanvas)).toBe(true);
    expect(presentationHasKeys(ed, document.body)).toBe(false);
    for (const [code, init] of KEYS) press(previewCanvas, code, init);
    expect(source.changes.length).toBe(before);
    expect(engine.readNode("1:5")?.opacity ?? 1).toBeCloseTo(1);
    press(document.body, "Digit3");
    expect(engine.readNode("1:5")?.opacity).toBeCloseTo(0.3);
  });
});
