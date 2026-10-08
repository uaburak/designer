// E4 / E5 in the panels as plain data: paints ↔ the picker, image references and adjustments, Selection colors
// with gradients, effects and layout guides (Figma's defaults), strokes (sides, dashes, miter), "Paste here",
// placed images, the vector-edit state.
import { describe, expect, it } from "vitest";
import type { Message, NodeChange, Paint } from "@/engine/codec";
import {
  DEFAULT_LINEAR_TRANSFORM,
  fromPicker,
  gradientKey,
  hashBytes,
  hashHex,
  imagePaint,
  paintLabel,
  paintLacksProgressive,
  paintSwatch,
  paintThumbHash,
  paintThumbnailHash,
  progressivePaintFields,
  rotated90,
  thumbHashBytes,
  toPicker,
  withAdjustment,
  withProgressive,
} from "../model/paints";
import { collectColors, regradient, showSelectionColors } from "../model/selectionColors";
import { hexToColor } from "../model/color";
import { messageAt } from "../model/clipboard";
import { defaultEffect, defaultGuide, guideKind, guideLabel, withEffectType } from "../panels/design/Effects";
import { dashOf, miterAngle, miterLimitOf, strokeSideFields, strokeSideOf } from "../panels/design/Stroke";
import type { PanelNode } from "../panels/design/shared";
import { fitImageSize, imageLayerName, memoryImageStore, sha1Hex } from "../images";
import { imageRectangles, PLACE_GAP } from "../placeImages";
import { NO_VECTOR_EDIT, readVectorEdit } from "../vectorEdit";

const red = hexToColor("#ff0000");
const blue = hexToColor("#0000ff");
const linear: Paint = { type: "GRADIENT_LINEAR", stops: [{ color: red, position: 0 }, { color: blue, position: 1 }], transform: DEFAULT_LINEAR_TRANSFORM, opacity: 1, visible: true };
const HASH = "a9993e364706816aba3e25717850c26c9cd0d89d"; // SHA-1("abc")
const TIER = "da39a3ee5e6b4b0d3255bfef95601890afd80709"; // SHA-1("") — stands in for a low-res copy's hash

describe("paints ↔ the picker", () => {
  it("maps every type with Figma's names (STRETCH is Crop)", () => {
    expect(toPicker({ type: "SOLID", color: { ...red, a: 1 }, opacity: 0.5 })).toEqual({ type: "SOLID", color: { ...red, a: 1 }, opacity: 0.5 });
    expect(toPicker(linear).stops).toHaveLength(2);
    expect(toPicker({ type: "IMAGE", imageScaleMode: "STRETCH" }).imageScaleMode).toBe("CROP");
    expect(fromPicker({ type: "IMAGE", imageScaleMode: "FILL", image: { hash: hashBytes(HASH) } }, { type: "IMAGE", imageScaleMode: "CROP" }).imageScaleMode).toBe("STRETCH");
  });

  it("a type change brings Figma's defaults and keeps what still applies", () => {
    const solid: Paint = { type: "SOLID", color: { ...red, a: 1 }, opacity: 1, visible: false };
    const g = fromPicker(solid, { type: "GRADIENT_LINEAR", stops: [{ color: { ...red, a: 1 }, position: 0 }, { color: { ...red, a: 0 }, position: 1 }], opacity: 1 });
    expect(g.transform).toEqual(DEFAULT_LINEAR_TRANSFORM);
    expect(g.color).toBeUndefined();
    expect(g.visible).toBe(false);
    const back = fromPicker(g, { type: "SOLID", color: { ...red, a: 1 }, opacity: 1 });
    expect(back.stops).toBeUndefined();
    expect(back.transform).toBeUndefined();
    const radial = fromPicker(linear, { type: "GRADIENT_RADIAL", stops: toPicker(linear).stops, opacity: 1 });
    expect(radial.transform).toEqual(DEFAULT_LINEAR_TRANSFORM); // gradient → gradient keeps its handles
    const image = fromPicker(linear, { type: "IMAGE", imageScaleMode: "FILL", opacity: 1 });
    expect(image.stops).toBeUndefined();
    expect(image.imageScaleMode).toBe("FILL");
  });

  it("names rows as Figma: the hex, or the type", () => {
    expect(paintLabel({ type: "SOLID", color: red })).toBe("#ff0000");
    expect(paintLabel(linear)).toBe("Linear");
    expect(paintLabel({ type: "GRADIENT_DIAMOND" })).toBe("Diamond");
    expect(paintLabel({ type: "IMAGE" })).toBe("Image");
    expect(paintSwatch(linear)).toContain("linear-gradient");
    expect(paintSwatch({ type: "IMAGE" }, "blob:x")).toContain('url("blob:x")');
  });
});

describe("images", () => {
  it("references the 20-byte SHA-1 as numbers, reads hex too", async () => {
    expect(hashHex(hashBytes(HASH))).toBe(HASH);
    expect(hashHex(HASH.toUpperCase())).toBe(HASH);
    expect(hashHex([1, 2])).toBeNull();
    expect(await sha1Hex(new TextEncoder().encode("abc"))).toBe(HASH);
    const store = memoryImageStore();
    expect(await store.put(new TextEncoder().encode("abc"), "image/png")).toBe(HASH);
    expect(await store.get(HASH)).not.toBeNull();
  });

  it("an image fill: Fill mode, its original size, named", () => {
    const p = imagePaint(HASH, { width: 640, height: 480 }, "photo");
    expect(p).toMatchObject({ type: "IMAGE", imageScaleMode: "FILL", originalImageWidth: 640, originalImageHeight: 480, image: { name: "photo" } });
    expect(hashHex(p.image?.hash)).toBe(HASH);
  });

  it("caps at 4096 keeping the aspect; names layers after the file", () => {
    expect(fitImageSize(8192, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(fitImageSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(imageLayerName("Screen Shot 2026.png")).toBe("Screen Shot 2026");
    expect(imageLayerName(undefined)).toBe("Image");
  });

  it("adjustments (−100…100 → −1…1, 0 removes) and Rotate 90°", () => {
    let p: Paint = { type: "IMAGE" };
    p = withAdjustment(p, "exposure", 50);
    expect(p.paintFilter).toEqual({ exposure: 0.5 });
    p = withAdjustment(p, "exposure", 0);
    expect(p.paintFilter).toBeUndefined();
    expect(rotated90(rotated90(rotated90(rotated90({ type: "IMAGE" })))).rotation).toBe(0);
    expect(rotated90({ type: "IMAGE", rotation: 270 }).rotation).toBe(0);
  });

  it("placed images: rectangles their size in a row, filled, pasted in place, with their progressive fields", () => {
    const m = imageRectangles(
      [
        { hash: HASH, width: 100, height: 50, name: "a", mime: "image/png", thumbHash: new Uint8Array([9, 8, 7, 6, 5]), thumbnail: { hash: TIER, width: 100, height: 50 } },
        { hash: HASH, width: 40, height: 40, name: "b", mime: "image/png" },
      ],
      { x: 10, y: 20 }
    );
    expect(m.nodeChanges.map((n) => [n.name, n.size, n.transform?.m02, n.transform?.m12])).toEqual([
      ["a", { x: 100, y: 50 }, 10, 20],
      ["b", { x: 40, y: 40 }, 10 + 100 + PLACE_GAP, 20],
    ]);
    expect(m.nodeChanges[0].fillPaints?.[0].type).toBe("IMAGE");
    expect(m.nodeChanges[0].fillPaints?.[0].thumbHash).toEqual([9, 8, 7, 6, 5]);
    expect(paintThumbnailHash(m.nodeChanges[0].fillPaints![0])).toBe(TIER);
    expect(m.nodeChanges[1].fillPaints?.[0].thumbHash).toBeUndefined();
    expect(m.nodeChanges[1].fillPaints?.[0].imageThumbnail).toBeUndefined();
  });
});

describe("progressive images (Paint.thumbHash, Paint.imageThumbnail)", () => {
  const thumb = new Uint8Array([21, 246, 2, 156, 154, 1, 2, 3]);

  it("the wire fields: thumbHash as numbers, imageThumbnail as a 20-byte Image; nothing for what isn't known", () => {
    expect(progressivePaintFields({ thumbHash: thumb, thumbnail: { hash: TIER } })).toEqual({ thumbHash: [...thumb], imageThumbnail: { hash: hashBytes(TIER) } });
    expect(progressivePaintFields({ thumbHash: null, thumbnail: null })).toEqual({});
    expect(progressivePaintFields(undefined)).toEqual({});
    expect(progressivePaintFields({ thumbnail: { hash: "not a hash" } })).toEqual({});
    const p = imagePaint(HASH, { width: 640, height: 480, thumbHash: thumb, thumbnail: { hash: TIER, width: 512, height: 384 } }, "photo");
    expect(p.thumbHash).toEqual([...thumb]);
    expect(paintThumbnailHash(p)).toBe(TIER);
    expect(hashHex(p.image?.hash)).toBe(HASH);
  });

  it("reads thumbHash as bytes, numbers or base64; knows the low-res copy", () => {
    expect(paintThumbHash({ type: "IMAGE", thumbHash: [...thumb] })).toEqual(thumb);
    expect(paintThumbHash({ type: "IMAGE", thumbHash: thumb })).toBe(thumb);
    expect(paintThumbHash({ type: "IMAGE", thumbHash: btoa(String.fromCharCode(...thumb)) })).toEqual(thumb);
    expect(paintThumbHash({ type: "IMAGE", thumbHash: [] })).toBeNull();
    expect(paintThumbHash({ type: "IMAGE" })).toBeNull();
    expect(thumbHashBytes("%%%")).toBeNull();
    expect(thumbHashBytes(["x"])).toBeNull();
    expect(paintThumbnailHash({ type: "IMAGE", imageThumbnail: { hash: hashBytes(TIER) } })).toBe(TIER);
    expect(paintThumbnailHash({ type: "IMAGE", imageThumbnail: { hash: TIER } })).toBe(TIER);
    expect(paintThumbnailHash({ type: "IMAGE" })).toBeNull();
  });

  it("a paint lacking either field is a write-back candidate; withProgressive fills only what is missing", () => {
    const bare: Paint = { type: "IMAGE", image: { hash: hashBytes(HASH) }, opacity: 0.5 };
    expect(paintLacksProgressive(bare)).toBe(true);
    expect(paintLacksProgressive({ ...bare, thumbHash: [...thumb] })).toBe(true);
    expect(paintLacksProgressive({ ...bare, imageThumbnail: { hash: hashBytes(TIER) } })).toBe(true);
    expect(paintLacksProgressive({ ...bare, thumbHash: [...thumb], imageThumbnail: { hash: hashBytes(TIER) } })).toBe(false);
    expect(paintLacksProgressive({ type: "IMAGE" })).toBe(false); // no image: nothing to compute from
    expect(paintLacksProgressive({ type: "SOLID", color: red })).toBe(false);
    const filled = withProgressive(bare, { thumbHash: thumb, thumbnail: { hash: TIER } });
    expect(filled).toEqual({ ...bare, thumbHash: [...thumb], imageThumbnail: { hash: hashBytes(TIER) } });
    expect(filled).not.toBe(bare);
    // What the paint has is kept (Figma's own values win over ours).
    const theirs = { ...bare, thumbHash: [1, 2, 3, 4, 5], imageThumbnail: { hash: hashBytes("ab".repeat(20)) } };
    expect(withProgressive(theirs, { thumbHash: thumb, thumbnail: { hash: TIER } })).toEqual(theirs);
    const half = withProgressive({ ...bare, thumbHash: [1, 2, 3, 4, 5] }, { thumbHash: thumb, thumbnail: { hash: TIER } });
    expect(half.thumbHash).toEqual([1, 2, 3, 4, 5]);
    expect(paintThumbnailHash(half)).toBe(TIER);
  });

  it("a type change away from IMAGE drops the progressive fields with the image", () => {
    const image: Paint = { type: "IMAGE", image: { hash: hashBytes(HASH) }, thumbHash: [...thumb], imageThumbnail: { hash: hashBytes(TIER) }, imageScaleMode: "FILL", opacity: 1 };
    const solid = fromPicker(image, { type: "SOLID", color: { ...red, a: 1 }, opacity: 1 });
    expect(solid.thumbHash).toBeUndefined();
    expect(solid.imageThumbnail).toBeUndefined();
    expect(solid.image).toBeUndefined();
    // An image → image edit keeps them.
    const crop = fromPicker(image, { type: "IMAGE", imageScaleMode: "CROP", opacity: 1 });
    expect(crop.thumbHash).toEqual([...thumb]);
    expect(paintThumbnailHash(crop)).toBe(TIER);
  });
});

describe("Selection colors with gradients", () => {
  const n = (guid: string, fills: Paint[]): NodeChange => ({ guid, fillPaints: fills });
  it("lists a gradient as one row (not its stops), images not at all", () => {
    const colors = collectColors([n("1:1", [linear]), n("1:2", [{ ...linear, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } }]), n("1:3", [{ type: "IMAGE" }]), n("1:4", [{ type: "SOLID", color: red, opacity: 1 }])]);
    expect(colors).toHaveLength(2);
    expect(colors[0].gradient?.type).toBe("GRADIENT_LINEAR");
    expect(colors[0].uses.map((u) => u.guid)).toEqual(["1:1", "1:2"]);
    expect(gradientKey(linear)).not.toBe(gradientKey({ ...linear, type: "GRADIENT_RADIAL" }));
  });

  it("masks are left out; a gradient edit keeps each use's handles", () => {
    expect(collectColors([{ guid: "1:1", mask: true, fillPaints: [{ type: "SOLID", color: red }] } as NodeChange])).toHaveLength(0);
    const t = { m00: 2, m01: 0, m02: 0, m10: 0, m11: 2, m12: 0 };
    const nodes = new Map([["1:1", n("1:1", [{ ...linear, transform: t }])]]);
    const out = regradient(nodes, [{ guid: "1:1", field: "fillPaints", index: 0 }], { type: "GRADIENT_RADIAL", stops: [{ color: blue, position: 0 }, { color: red, position: 1 }] });
    const p = out.get("1:1")!.fillPaints![0];
    expect(p.type).toBe("GRADIENT_RADIAL");
    expect(p.transform).toEqual(t);
    expect(showSelectionColors([n("1:1", [linear]), n("1:2", [{ type: "SOLID", color: red }])], [])).toBe(true);
  });
});

describe("effects and layout guides", () => {
  it("Figma's new drop shadow: 0 4 4 0 #000 25%", () => {
    expect(defaultEffect()).toMatchObject({ type: "DROP_SHADOW", offset: { x: 0, y: 4 }, radius: 4, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 }, visible: true, showShadowBehindNode: false });
    expect(defaultEffect("FOREGROUND_BLUR")).toEqual({ type: "FOREGROUND_BLUR", radius: 4, visible: true });
  });

  it("a type change keeps a shadow's numbers, a blur's radius", () => {
    const s = { ...defaultEffect(), offset: { x: 2, y: 9 }, radius: 12 };
    const inner = withEffectType(s, "INNER_SHADOW");
    expect(inner).toMatchObject({ type: "INNER_SHADOW", offset: { x: 2, y: 9 }, radius: 12 });
    expect(inner.showShadowBehindNode).toBeUndefined();
    expect(withEffectType(s, "BACKGROUND_BLUR")).toEqual({ type: "BACKGROUND_BLUR", radius: 12, visible: true });
  });

  it("guides: Grid 10px red 10%; Columns / Rows 5 stretch, gutter 20", () => {
    expect(guideLabel(defaultGuide())).toBe("Grid 10px");
    expect(defaultGuide().color).toEqual({ r: 1, g: 0, b: 0, a: 0.1 });
    expect(guideLabel(defaultGuide("COLUMNS"))).toBe("Columns 5");
    expect(guideKind(defaultGuide("ROWS"))).toBe("ROWS");
    expect(defaultGuide("ROWS")).toMatchObject({ axis: "Y", numSections: 5, type: "STRETCH", gutterSize: 20 });
  });
});

describe("strokes", () => {
  const frame = (f: Partial<PanelNode>): PanelNode => ({ guid: "1:1", type: "FRAME", strokeWeight: 2, ...f }) as PanelNode;
  it("reads and writes individual sides", () => {
    expect(strokeSideOf(frame({}))).toBe("ALL");
    expect(strokeSideOf(frame({ borderStrokeWeightsIndependent: true, borderTopWeight: 0, borderRightWeight: 0, borderBottomWeight: 2, borderLeftWeight: 0 }))).toBe("BOTTOM");
    expect(strokeSideOf(frame({ borderStrokeWeightsIndependent: true, borderTopWeight: 1, borderRightWeight: 0, borderBottomWeight: 2, borderLeftWeight: 0 }))).toBe("CUSTOM");
    expect(strokeSideFields(frame({}), "TOP")).toMatchObject({ borderStrokeWeightsIndependent: true, borderTopWeight: 2, borderBottomWeight: 0, borderLeftWeight: 0, borderRightWeight: 0 });
    expect(strokeSideFields(frame({ borderStrokeWeightsIndependent: true, borderTopWeight: 4 }), "ALL")).toMatchObject({ borderStrokeWeightsIndependent: false, strokeWeight: 4 });
  });

  it("dashes and Figma's miter angle (limit 4 = 28.96°)", () => {
    expect(dashOf(undefined)).toEqual({ dashed: false, dash: 2, gap: 2 });
    expect(dashOf([6])).toEqual({ dashed: true, dash: 6, gap: 6 });
    expect(miterAngle(4)).toBeCloseTo(28.955, 2);
    expect(miterLimitOf(miterAngle(7))).toBeCloseTo(7, 6);
  });
});

describe("Paste here", () => {
  it("moves the Message so its corner lands on the point (regions shifted)", () => {
    const m: Message = {
      type: "NODE_CHANGES",
      sessionID: 1,
      nodeChanges: [
        { guid: "1:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", parentIndex: { guid: "1:1", position: "!" }, size: { x: 10, y: 10 }, transform: { m00: 1, m01: 0, m02: 5, m10: 0, m11: 1, m12: 5 } },
        { guid: "1:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", parentIndex: { guid: "1:1", position: '"' }, size: { x: 10, y: 10 }, transform: { m00: 1, m01: 0, m02: 30, m10: 0, m11: 1, m12: 0 } },
      ],
      clipboardSelectionRegions: [{ parent: "1:1", nodes: ["1:2", "1:3"], enclosingFrameOffset: { x: 100, y: 100 } }],
    };
    const moved = messageAt(m, { x: 0, y: 0 });
    // The union's corner was (105, 100): every region shifts by (−105, −100).
    expect(moved.clipboardSelectionRegions).toEqual([{ parent: "1:1", nodes: ["1:2", "1:3"], enclosingFrameOffset: { x: -5, y: 0 } }]);
  });
});

describe("vector edit state", () => {
  it("reads VECTOR_EDIT; anything inactive is no edit", () => {
    expect(readVectorEdit(null)).toBe(NO_VECTOR_EDIT);
    expect(readVectorEdit({ active: false })).toBe(NO_VECTOR_EDIT);
    const s = readVectorEdit({ active: true, ref: "1:2", tool: "PEN", selectedVertices: [0, 3], selectedSegments: [], vertexCount: 5, segmentCount: 5, mirroring: "MIXED" });
    expect(s).toMatchObject({ active: true, ref: "1:2", tool: "PEN", selectedVertices: [0, 3], mirroring: "MIXED", vertexCount: 5 });
    expect(readVectorEdit({ active: true, tool: "SPLINE" }).tool).toBe("MOVE");
  });
});
