import { describe, expect, it } from "vitest";
import { MIXED } from "@/ds/types";
import type { Message, Paint } from "@/engine/codec";
import { CLIPBOARD_TYPE, decodeClipboard, encodeClipboard, envelopeOf, plainTextOf } from "../model/clipboard";
import { colorToHex, hexToColor } from "../model/color";
import { flip, panelPosition, rotateBy, rotateTo, rotationOf, withPanelPosition, IDENTITY } from "../model/geometry";
import { mixed, mixedNumber, mixedPaints, sameData } from "../model/mixed";
import { labelAlpha, rulerLabel, rulerStep, rulerTicks, toScreen } from "../model/rulers";
import { applyMessage, memoryDocumentSource, orderParentsFirst } from "../documentSource";

const paint = (hex: string, opacity = 1): Paint => ({ type: "SOLID", color: hexToColor(hex), opacity, visible: true });

describe("mixed values", () => {
  it("agrees or says Mixed", () => {
    expect(mixed([1, 1, 1])).toBe(1);
    expect(mixed([1, 2])).toBe(MIXED);
    expect(mixed([])).toBeUndefined();
    expect(mixedNumber([10, 10.001])).toBe(10);
    expect(mixedNumber([10, 10.1])).toBe(MIXED);
  });

  it("compares paint lists structurally", () => {
    expect(mixedPaints([[paint("#ffffff")], [paint("#ffffff")]])).toEqual([paint("#ffffff")]);
    expect(mixedPaints([[paint("#ffffff")], [paint("#ffffff", 0.5)]])).toBe(MIXED);
    expect(mixedPaints([[paint("#ffffff")], []])).toBe(MIXED);
    expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});

describe("colours", () => {
  it("round-trips hex", () => {
    expect(colorToHex(hexToColor("#0c8ce9"))).toBe("#0c8ce9");
    expect(colorToHex({ r: 1, g: 1, b: 1 })).toBe("#ffffff");
  });
});

describe("panel geometry", () => {
  const size = { x: 100, y: 50 };
  it("reads rotation as Figma does (counter-clockwise positive)", () => {
    expect(rotationOf(IDENTITY)).toBe(0);
    // A clockwise turn on screen (sampleDocument's `at(…, 20)`) reads −20°.
    const r = (20 * Math.PI) / 180;
    expect(rotationOf({ m00: Math.cos(r), m01: -Math.sin(r), m02: 0, m10: Math.sin(r), m11: Math.cos(r), m12: 0 })).toBeCloseTo(-20, 6);
  });

  it("rotates about the centre", () => {
    const m = rotateTo({ ...IDENTITY, m02: 10, m12: 20 }, size, 90);
    expect(rotationOf(m)).toBeCloseTo(90, 6);
    // The centre stays at (60, 45).
    expect(m.m00 * 50 + m.m01 * 25 + m.m02).toBeCloseTo(60, 6);
    expect(m.m10 * 50 + m.m11 * 25 + m.m12).toBeCloseTo(45, 6);
    expect(rotationOf(rotateBy(m, size, -90))).toBeCloseTo(0, 6);
  });

  it("flips in place", () => {
    const m = flip({ ...IDENTITY, m02: 10, m12: 20 }, size, "x");
    expect(m).toMatchObject({ m00: -1, m02: 110, m11: 1, m12: 20 });
    expect(rotationOf(m)).toBe(180);
    const v = flip(IDENTITY, size, "y");
    expect(v).toMatchObject({ m11: -1, m12: 50 });
    expect(rotationOf(v)).toBe(0);
  });

  it("measures X/Y from the nearest non-group ancestor", () => {
    const group = { ...IDENTITY, m02: 100, m12: 200 };
    const m = { ...IDENTITY, m02: 5, m12: 6 };
    expect(panelPosition(m, group)).toEqual({ x: 105, y: 206 });
    const moved = withPanelPosition(m, group, 150, null);
    expect(panelPosition(moved, group)).toEqual({ x: 150, y: 206 });
    expect(moved.m02).toBe(50);
  });
});

describe("rulers", () => {
  it("labels every 50 at 100%, coarser zoomed out, finer zoomed in", () => {
    expect(rulerStep(1)).toBe(50);
    expect(rulerStep(0.5)).toBe(100);
    expect(rulerStep(2)).toBe(25);
    expect(rulerStep(64)).toBe(1);
  });

  it("lists the visible values from the ruler's origin", () => {
    const axis = { offset: 288, zoom: 1, origin: 0 };
    const ticks = rulerTicks(axis, 1000);
    expect(ticks).toContain(0);
    expect(ticks).toContain(-250);
    expect(ticks.every((v) => v % 50 === 0)).toBe(true);
    expect(toScreen(axis, -34)).toBe(254);
    // With a frame selected, 0 moves to its corner.
    expect(toScreen({ ...axis, origin: -34 }, 0)).toBe(254);
  });

  it("fades labels near the selection's edge labels", () => {
    expect(labelAlpha(500, [300])).toBe(1);
    expect(labelAlpha(340, [300])).toBe(0);
    expect(labelAlpha(360, [300])).toBeGreaterThan(0);
    expect(labelAlpha(360, [300])).toBeLessThan(1);
    expect(rulerLabel(-0.0001)).toBe("0");
    expect(rulerLabel(437)).toBe("437");
  });
});

describe("clipboard", () => {
  const message: Message = {
    type: "NODE_CHANGES",
    sessionID: 1,
    nodeChanges: [
      { guid: "1:1", phase: "CREATED", type: "FRAME", name: "Frame 1 — ünïcode", parentIndex: { guid: "0:1", position: "!" } },
      { guid: "1:2", phase: "CREATED", type: "ELLIPSE", name: "Dot", parentIndex: { guid: "1:1", position: "!" } },
      { guid: "1:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Card", parentIndex: { guid: "0:1", position: "\"" } },
    ],
  };

  it("writes our type, an HTML envelope and the layer names", () => {
    const out = encodeClipboard(message);
    expect(Object.keys(out).sort()).toEqual([CLIPBOARD_TYPE, "text/html", "text/plain"].sort());
    expect(out["text/plain"]).toBe("Frame 1 — ünïcode\nCard");
    expect(plainTextOf(message)).toBe(out["text/plain"]);
    expect(envelopeOf(out["text/html"])).toBe(out[CLIPBOARD_TYPE]);
  });

  it("reads our type first, then the envelope in HTML or plain text", () => {
    const out = encodeClipboard(message);
    expect(decodeClipboard((t) => out[t])).toEqual(message);
    expect(decodeClipboard((t) => (t === "text/html" ? out["text/html"] : undefined))).toEqual(message);
    expect(decodeClipboard((t) => (t === "text/plain" ? `junk ${out["text/html"]} junk` : undefined))).toEqual(message);
  });

  it("ignores what isn't ours", () => {
    expect(decodeClipboard(() => undefined)).toBeNull();
    expect(decodeClipboard((t) => (t === "text/plain" ? "hello" : undefined))).toBeNull();
    expect(decodeClipboard((t) => (t === CLIPBOARD_TYPE ? "bm90IGpzb24=" : undefined))).toBeNull();
  });
});

describe("document source", () => {
  const doc: Message = {
    type: "NODE_CHANGES",
    sessionID: 0,
    nodeChanges: [
      { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
      { guid: "1:1", phase: "CREATED", type: "FRAME", name: "Frame", parentIndex: { guid: "0:1", position: "!" } },
      { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } },
    ],
  };

  it("orders a snapshot parents first", () => {
    expect(orderParentsFirst(doc.nodeChanges).map((n) => n.guid)).toEqual(["0:0", "0:1", "1:1"]);
  });

  it("applies changes: updates replace fields, CREATED adds, REMOVED deletes", () => {
    const source = memoryDocumentSource(doc, { fileName: "burakkoc" });
    source.onChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:1", name: "Renamed", opacity: 0.5 }] });
    source.onChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:2", phase: "CREATED", type: "ELLIPSE", parentIndex: { guid: "1:1", position: "!" } }] });
    source.onChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:2", phase: "REMOVED" }] });
    const nodes = source.snapshot().nodeChanges;
    expect(nodes.map((n) => n.guid)).toEqual(["0:0", "0:1", "1:1"]);
    expect(nodes[2]).toMatchObject({ name: "Renamed", opacity: 0.5, type: "FRAME" });
    expect(source.changes).toHaveLength(3);
    expect(source.fileName).toBe("burakkoc");
  });

  it("clears fields by name", () => {
    const nodes = new Map(doc.nodeChanges.map((n) => [n.guid, { ...n }]));
    applyMessage(nodes, { type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:1", clearedFields: [5] }] }, (id) => (id === 5 ? "name" : undefined));
    expect(nodes.get("1:1")?.name).toBeUndefined();
  });
});
