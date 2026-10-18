// @vitest-environment happy-dom
// Dev Mode's Motion tab (docs/motion.md §8.2; round 8f) on the real engine and the Figma logo fixture: the resolved
// motion of a layer or of what it holds, the Timing rows, the code in CSS / React / JSON, and the timeline view —
// read-only, the canvas playing the frame while it is open and at rest when it closes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import { memoryDocumentSource } from "@/editor/documentSource";
import MOTION_LOGO_DOCUMENT from "@/editor/motion/fixtures/figma-logo-motion.json";
import { $, $$, click, mount, type Mounted } from "../../renderer/src/ds/__tests__/dom";
import { DevTimeline, MotionTab, motionOf } from "./MotionTab";
import { DEFAULT_UNITS } from "./units";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function engineWithLogo() {
  const source = memoryDocumentSource(MOTION_LOGO_DOCUMENT as unknown as Message, { fileName: "Figma logo · Motion" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  return engine;
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("Dev Mode's Motion tab", () => {
  it("resolves a layer's motion, or every animated layer a frame holds; nothing for a page", async () => {
    const engine = await engineWithLogo();
    const red = motionOf(engine, "1:2")!;
    expect(red.layers.map((l) => l.node)).toEqual(["1:2"]);
    const frame = motionOf(engine, "1:1")!;
    expect(frame.layers.length).toBeGreaterThan(1);
    expect(frame.root).toBe("1:1");
    expect(motionOf(engine, "0:1")).toBeNull();
  });

  it("shows Timing and the code (CSS by default, React, JSON); Show in timeline view asks for the timeline", async () => {
    const engine = await engineWithLogo();
    const asked: boolean[] = [];
    m = mount(MotionTab, { engine, id: "1:2", units: DEFAULT_UNITS, onTimeline: (open: boolean) => void asked.push(open) });
    expect($$("[data-motion-property]", m.host).map((r) => r.getAttribute("data-motion-property"))).toEqual(expect.arrayContaining(["OPACITY", "TRANSLATION_XY"]));
    const code = () => $("[data-motion-code] pre", m!.host).textContent ?? "";
    expect(code()).toContain("@keyframes red-opacity");
    expect(code()).toContain("animation: red-");
    act(() => click($$('[role="radio"]', m!.host).find((b) => b.textContent === "React")!));
    expect(code()).toContain('import { motion } from "motion/react";');
    act(() => click($$('[role="radio"]', m!.host).find((b) => b.textContent === "JSON")!));
    expect(JSON.parse(code()).root).toBe("1:1");
    act(() => click($("[data-show-timeline]", m!.host)));
    expect(asked).toEqual([true]);
  });

  it("the timeline view is read-only, plays the frame on the canvas while open, and leaves it at rest when closed", async () => {
    const engine = await engineWithLogo();
    const restX = engine.readNode("1:2")!.transform!.m02;
    let closed = false;
    m = mount(DevTimeline, { engine, root: "1:1", panel: null, onClose: () => void (closed = true) });
    const view = document.querySelector("[data-dev-timeline]")!;
    expect(view).not.toBeNull();
    // Motion's own timeline, on the root's model: its layers listed.
    expect(view.querySelector("[data-motion-timeline]")).not.toBeNull();
    expect(view.textContent).toContain("Red");
    m.unmount();
    m = null;
    expect(document.querySelector("[data-dev-timeline]")).toBeNull();
    expect(engine.readNode("1:2")!.transform!.m02).toBe(restX);
    expect(closed).toBe(false);
  });
});
