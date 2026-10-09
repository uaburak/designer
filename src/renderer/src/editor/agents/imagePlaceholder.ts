/**
 * Where an agent's image will land, shown on the canvas while it is being made (Figma AI's placeholder: a soft
 * gradient with a light sweeping across). It appears as soon as the agent starts generate_image — at the selected
 * frame (centred inside it; beside it, on the page, when the frame has auto layout — a child would join its flow), over
 * a selected shape (the image fills it, as Place image fills a selected shape), else at the viewport's centre — 512 × 512 (or the aspect asked for) scaled to fit. place_image then puts the image exactly
 * there unless the agent gave a place of its own (`placeholderArgs`), and the placeholder goes; on an error or Stop it
 * fades out.
 *
 * Transient editor state, never the document's: no node, no undo step, nothing in the file. The canvas overlay
 * (canvas/AgentImagePlaceholders.tsx) draws it over the engine's canvas, following pan and zoom.
 */
import type { Camera, Guid } from "@/engine/codec";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaceholderTarget {
  page: Guid;
  /** The layer the image goes into (a frame, or the page) — absent when it fills `nodeId` */
  parentId?: Guid;
  /** A selected shape the image will fill */
  nodeId?: Guid;
  /** In the parent's coordinates (the shape's own when it fills `nodeId`) */
  box: Box;
  /** On the page, for drawing */
  world: Box;
}

export interface Placeholder {
  id: string;
  turnId: string;
  state: "active" | "leaving";
  target: PlaceholderTarget;
}

/** A node as the placeholder needs it (its real type: a group is "GROUP", not "FRAME"). */
export interface PlaceNode {
  type: string;
  size?: { x: number; y: number };
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
  parent?: Guid | null;
  /** A frame with auto layout (its children follow its flow, not their x / y) */
  autoLayout?: boolean;
}

export interface PlaceholderEnv {
  page: Guid | null;
  selection: readonly Guid[];
  read(id: Guid): PlaceNode | null;
  camera: Camera;
  /** The canvas's CSS size */
  viewport: { width: number; height: number };
}

export const PLACEHOLDER_SIZE = 512;
/** How long a placeholder takes to fade out (--ds-duration-fade) */
export const FADE_MS = 300;

/** Beside an auto layout frame, on the page (px). */
export const BESIDE_GAP = 40;

/** Layers an image goes inside, centred. */
const CONTAINERS = new Set(["FRAME", "SECTION", "SYMBOL", "COMPONENT", "COMPONENT_SET"]);
/** Layers an image fills (Place image over a selected shape). */
const SHAPES = new Set(["RECTANGLE", "ROUNDED_RECTANGLE", "ELLIPSE", "REGULAR_POLYGON", "POLYGON", "STAR", "VECTOR"]);

type Affine = [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];
const mul = (a: Affine, b: Affine): Affine => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2], a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];
const affineOf = (t: PlaceNode["transform"]): Affine => (t ? [t.m00, t.m01, t.m02, t.m10, t.m11, t.m12] : IDENTITY);

/** A node's transform to the page (its parents' composed up to the page). */
export function pageTransform(env: Pick<PlaceholderEnv, "read">, id: Guid): Affine {
  let m = IDENTITY;
  let cur: Guid | null | undefined = id;
  for (let depth = 0; cur && depth < 256; depth++) {
    const n = env.read(cur);
    if (!n || n.type === "CANVAS" || n.type === "DOCUMENT") break;
    m = mul(affineOf(n.transform), m);
    cur = n.parent;
  }
  return m;
}

/** A box in a layer's coordinates as a box on the page (the bounds of its corners, for a rotated layer). */
function toPage(m: Affine, b: Box): Box {
  const pts = [
    [b.x, b.y],
    [b.x + b.width, b.y],
    [b.x, b.y + b.height],
    [b.x + b.width, b.y + b.height],
  ].map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** 512 on the longer side at the aspect asked for, scaled down to fit `w` × `h`; rounded to whole pixels. */
export function fitSize(aspect: number, w = Infinity, h = Infinity): { width: number; height: number } {
  const base = aspect >= 1 ? { width: PLACEHOLDER_SIZE, height: PLACEHOLDER_SIZE / aspect } : { width: PLACEHOLDER_SIZE * aspect, height: PLACEHOLDER_SIZE };
  const s = Math.min(1, w / base.width, h / base.height);
  return { width: Math.max(1, Math.round(base.width * s)), height: Math.max(1, Math.round(base.height * s)) };
}

const centred = (size: { width: number; height: number }, around: Box): Box => ({ x: Math.round(around.x + (around.width - size.width) / 2), y: Math.round(around.y + (around.height - size.height) / 2), ...size });

/** Where the image goes, from the selection and the view. Null without a page. */
export function placeholderTarget(env: PlaceholderEnv, aspect = 1): PlaceholderTarget | null {
  const page = env.page;
  if (!page) return null;
  const only = env.selection.length === 1 ? env.selection[0] : null;
  const n = only ? env.read(only) : null;
  if (only && n?.size && n.size.x > 0 && n.size.y > 0) {
    const own: Box = { x: 0, y: 0, width: n.size.x, height: n.size.y };
    if (CONTAINERS.has(n.type) && n.autoLayout) {
      const frame = toPage(pageTransform(env, only), own);
      const size = fitSize(aspect, Infinity, frame.height);
      const box = { x: Math.round(frame.x + frame.width + BESIDE_GAP), y: Math.round(frame.y), ...size };
      return { page, parentId: page, box, world: box };
    }
    if (CONTAINERS.has(n.type)) {
      const box = centred(fitSize(aspect, own.width, own.height), own);
      return { page, parentId: only, box, world: toPage(pageTransform(env, only), box) };
    }
    if (SHAPES.has(n.type)) return { page, nodeId: only, box: own, world: toPage(pageTransform(env, only), own) };
  }
  // The visible part of the page, its middle.
  const { camera: c, viewport: v } = env;
  const zoom = c.zoom > 0 ? c.zoom : 1;
  const visible: Box = { x: -c.x / zoom, y: -c.y / zoom, width: Math.max(1, v.width) / zoom, height: Math.max(1, v.height) / zoom };
  const box = centred(fitSize(aspect, visible.width * 0.6, visible.height * 0.6), visible);
  return { page, parentId: page, box, world: box };
}

/**
 * place_image's arguments with the placeholder's place as defaults: when the agent named no place of its own (no
 * nodeId, parentId, x or y), the image fills the placeholder's shape, or lands centred on it — at the agent's own
 * width / height when it gave them, else fitted into the placeholder (`__box`, read by mcpTools' place_image).
 */
export function placeholderArgs(args: Record<string, unknown>, p: Placeholder | undefined): Record<string, unknown> {
  if (!p) return args;
  const own = ["nodeId", "parentId", "x", "y"].some((k) => args[k] !== undefined && args[k] !== null);
  if (own) return args;
  const t = p.target;
  if (t.nodeId) return { ...args, nodeId: t.nodeId };
  return { ...args, parentId: t.parentId, __box: t.box };
}

/** Where an image of `image`'s size lands in a placeholder's box: the agent's width / height (one keeps the aspect) or fitted; centred. */
export function landInBox(box: Box, image: { width: number; height: number }, asked: { width?: number; height?: number } = {}): Box {
  const ratio = image.width / Math.max(1, image.height);
  let width: number;
  let height: number;
  if (asked.width !== undefined && asked.height !== undefined) [width, height] = [asked.width, asked.height];
  else if (asked.width !== undefined) [width, height] = [asked.width, Math.round(asked.width / ratio)];
  else if (asked.height !== undefined) [width, height] = [Math.round(asked.height * ratio), asked.height];
  else {
    const s = Math.min(box.width / Math.max(1, image.width), box.height / Math.max(1, image.height));
    [width, height] = [Math.max(1, Math.round(image.width * s)), Math.max(1, Math.round(image.height * s))];
  }
  return centred({ width, height }, box);
}

let seq = 0;

/** The placeholders on the canvas, per turn in the order their images were asked for. */
export class ImagePlaceholders {
  private items: Placeholder[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();

  list = (): readonly Placeholder[] => this.items;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit(items: Placeholder[]) {
    this.items = items;
    this.listeners.forEach((fn) => fn());
  }

  /** A new placeholder for the turn (an image being made), or null when there is nowhere to put it. */
  start(turnId: string, target: PlaceholderTarget | null): Placeholder | null {
    if (!target) return null;
    const p: Placeholder = { id: `ph${++seq}`, turnId, state: "active", target };
    this.emit([...this.items, p]);
    return p;
  }

  /** The turn's oldest image still waiting for place_image. */
  next(turnId: string): Placeholder | undefined {
    return this.items.find((p) => p.turnId === turnId && p.state === "active");
  }

  /** The image is on the canvas: its placeholder goes at once (the image is drawn where it was). */
  placed(id: string) {
    if (this.items.some((p) => p.id === id)) this.emit(this.items.filter((p) => p.id !== id));
  }

  /** The newest image of the turn failed: its placeholder fades out. */
  fail(turnId: string) {
    const last = [...this.items].reverse().find((p) => p.turnId === turnId && p.state === "active");
    if (last) this.leave([last.id]);
  }

  /** The turn is over (done, error or Stop): what is left fades out. */
  end(turnId: string) {
    this.leave(this.items.filter((p) => p.turnId === turnId && p.state === "active").map((p) => p.id));
  }

  private leave(ids: string[]) {
    if (!ids.length) return;
    this.emit(this.items.map((p) => (ids.includes(p.id) ? { ...p, state: "leaving" as const } : p)));
    for (const id of ids) {
      this.timers.set(
        id,
        setTimeout(() => {
          this.timers.delete(id);
          this.emit(this.items.filter((p) => p.id !== id));
        }, FADE_MS)
      );
    }
  }

  dispose() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.items = [];
    this.listeners.clear();
  }
}
