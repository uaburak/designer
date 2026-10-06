/**
 * A small document for the engine's playground: a new file's three nodes
 * (docs/schema.md §3.1) and a few frames, rectangles and ellipses that use
 * what E1 draws — fills, strokes inside/centre/outside, per-corner radii,
 * clipping (square → scissor, rounded → stencil), rotation, a group.
 */
import type { Color, Matrix, Message, NodeChange, NodeType, Paint, StrokeAlign } from "./codec";

const hex = (rgb: number, a = 1): Color => ({ r: ((rgb >> 16) & 255) / 255, g: ((rgb >> 8) & 255) / 255, b: (rgb & 255) / 255, a });
const solid = (rgb: number, opacity = 1): Paint => ({ type: "SOLID", color: hex(rgb), opacity, visible: true });
const at = (x: number, y: number, degrees = 0): Matrix => {
  const r = (degrees * Math.PI) / 180;
  return { m00: Math.cos(r), m01: -Math.sin(r), m02: x, m10: Math.sin(r), m11: Math.cos(r), m12: y };
};

interface Spec {
  type: NodeType;
  name: string;
  parent: string;
  position: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  fill?: number | null;
  stroke?: { color: number; weight: number; align: StrokeAlign };
  radius?: number | [number, number, number, number];
  clip?: boolean;
  group?: boolean;
  opacity?: number;
  locked?: boolean;
}

function node(guid: string, s: Spec): NodeChange {
  const change: NodeChange = {
    guid,
    phase: "CREATED",
    type: s.type,
    name: s.name,
    parentIndex: { guid: s.parent, position: s.position },
    size: { x: s.w, y: s.h },
    transform: at(s.x, s.y, s.rotation),
    strokeWeight: s.stroke?.weight ?? 1,
    strokeAlign: s.stroke?.align ?? "INSIDE",
    fillPaints: s.fill === null || s.fill === undefined ? [] : [solid(s.fill)],
  };
  if (s.stroke) change.strokePaints = [solid(s.stroke.color)];
  if (s.opacity !== undefined) change.opacity = s.opacity;
  if (s.locked) change.locked = true;
  if (s.radius !== undefined) {
    const [tl, tr, br, bl] = typeof s.radius === "number" ? [s.radius, s.radius, s.radius, s.radius] : s.radius;
    Object.assign(change, {
      cornerRadius: tl,
      rectangleCornerRadiiIndependent: !(tl === tr && tr === br && br === bl),
      rectangleTopLeftCornerRadius: tl,
      rectangleTopRightCornerRadius: tr,
      rectangleBottomRightCornerRadius: br,
      rectangleBottomLeftCornerRadius: bl,
    });
  }
  if (s.clip === false) change.frameMaskDisabled = true;
  if (s.group) change.resizeToFit = true;
  return change;
}

export const SAMPLE_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    {
      guid: "0:1",
      phase: "CREATED",
      type: "CANVAS",
      name: "Page 1",
      parentIndex: { guid: "0:0", position: "!" },
      backgroundColor: hex(0xf5f5f5),
      backgroundEnabled: true,
    },
    { guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", parentIndex: { guid: "0:0", position: "~" }, internalOnly: true, visible: false },

    // Desktop: a square frame (scissor clip) with a header, cards and a clipped image block.
    node("1:1", { type: "FRAME", name: "Desktop", parent: "0:1", position: "!", x: 0, y: 0, w: 640, h: 420, fill: 0xffffff }),
    node("1:2", { type: "ROUNDED_RECTANGLE", name: "Header", parent: "1:1", position: "!", x: 0, y: 0, w: 640, h: 56, fill: 0x1e1e1e }),
    node("1:3", { type: "ELLIPSE", name: "Logo", parent: "1:1", position: "\"", x: 20, y: 14, w: 28, h: 28, fill: 0x0d99ff }),
    node("1:4", { type: "ROUNDED_RECTANGLE", name: "Nav", parent: "1:1", position: "#", x: 440, y: 20, w: 176, h: 16, fill: 0x444444, radius: 8 }),
    node("1:5", { type: "ROUNDED_RECTANGLE", name: "Card", parent: "1:1", position: "$", x: 24, y: 88, w: 280, h: 160, fill: 0xf2f2f2, radius: 12, stroke: { color: 0xd9d9d9, weight: 1, align: "INSIDE" } }),
    node("1:6", { type: "ROUNDED_RECTANGLE", name: "Card 2", parent: "1:1", position: "%", x: 336, y: 88, w: 280, h: 160, fill: 0xfff4d6, radius: [24, 4, 24, 4], stroke: { color: 0xffc700, weight: 2, align: "CENTER" } }),
    node("1:7", { type: "FRAME", name: "Clip", parent: "1:1", position: "&", x: 24, y: 272, w: 592, h: 124, fill: 0xe5f4ff }),
    node("1:8", { type: "ELLIPSE", name: "Sun", parent: "1:7", position: "!", x: 460, y: 40, w: 200, h: 200, fill: 0xffc700 }),
    node("1:9", { type: "ROUNDED_RECTANGLE", name: "Hill", parent: "1:7", position: "\"", x: -40, y: 70, w: 360, h: 120, fill: 0x14ae5c, radius: 60, rotation: -8 }),

    // Mobile: a rounded frame (stencil clip) whose content runs past its corners.
    node("1:10", { type: "FRAME", name: "Mobile", parent: "0:1", position: "\"", x: 720, y: 0, w: 260, h: 420, fill: 0x2c2c2c, radius: 32 }),
    node("1:11", { type: "ELLIPSE", name: "Glow", parent: "1:10", position: "!", x: -60, y: -60, w: 220, h: 220, fill: 0x9747ff }),
    node("1:12", { type: "ROUNDED_RECTANGLE", name: "Button", parent: "1:10", position: "\"", x: 24, y: 340, w: 212, h: 48, fill: 0x0d99ff, radius: 24 }),
    node("1:13", { type: "ROUNDED_RECTANGLE", name: "Sheet", parent: "1:10", position: "#", x: 0, y: 260, w: 260, h: 200, fill: 0xffffff, radius: [20, 20, 0, 0], opacity: 0.08 }),

    // On the page: strokes outside/centre, a rotated rectangle, a group.
    node("1:20", { type: "ROUNDED_RECTANGLE", name: "Outside stroke", parent: "0:1", position: "#", x: 0, y: 480, w: 160, h: 100, fill: 0xd9d9d9, radius: 8, stroke: { color: 0xf24822, weight: 6, align: "OUTSIDE" } }),
    node("1:21", { type: "ELLIPSE", name: "Ring", parent: "0:1", position: "$", x: 210, y: 480, w: 100, h: 100, fill: null, stroke: { color: 0x0d99ff, weight: 8, align: "CENTER" } }),
    node("1:22", { type: "ROUNDED_RECTANGLE", name: "Rotated", parent: "0:1", position: "%", x: 400, y: 470, w: 120, h: 80, fill: 0x14ae5c, rotation: 20, radius: 6 }),
    // A group stores its own box: the union of its children (the engine keeps it so, docs/engine.md §4.5).
    node("1:23", { type: "FRAME", name: "Group 1", parent: "0:1", position: "&", x: 600, y: 470, w: 150, h: 110, fill: null, group: true }),
    node("1:24", { type: "ELLIPSE", name: "Left", parent: "1:23", position: "!", x: 0, y: 0, w: 90, h: 90, fill: 0xff24bd, opacity: 0.9 }),
    node("1:25", { type: "ELLIPSE", name: "Right", parent: "1:23", position: "\"", x: 60, y: 20, w: 90, h: 90, fill: 0x0d99ff, opacity: 0.9 }),
    node("1:26", { type: "ROUNDED_RECTANGLE", name: "Locked", parent: "0:1", position: "'", x: 800, y: 480, w: 180, h: 100, fill: 0xb3b3b3, radius: 4, locked: true }),
  ],
};
