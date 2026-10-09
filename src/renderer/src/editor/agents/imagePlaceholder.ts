/**
 * Where an agent's image will land, shown on the canvas while it is being made (Figma AI's placeholder: grey with a
 * soft light sweeping across). It appears as soon as the chat's prompt asks for a picture (activity.ts
 * `asksForImage`), else when the agent starts generate_image — over a selected layer that can take a fill (a frame,
 * with auto layout or not, a rectangle, an ellipse, a component, an instance, a vector: the picture becomes that
 * layer's IMAGE fill, scale mode FILL, no new layer), centred inside a selected section, else at the viewport's centre
 * — 512 × 512 (or the aspect asked for) scaled to fit. place_image then puts the image exactly there unless the agent
 * named another place (`placeholderArgs`); the placeholder plays its reveal over the picture (a last brighter sweep,
 * then the grey dissolves) and goes. On an error, Stop or a turn ending without a picture it fades out.
 *
 * Transient editor state, never the document's: no node, no undo step, nothing in the file. The canvas overlay
 * (canvas/AgentImagePlaceholders.tsx) draws it over the engine's canvas, following pan and zoom.
 */
import type { Camera, Guid } from "@/engine/codec";
import { motion } from "@/ds/tokens";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A 2D affine transform [m00, m01, m02, m10, m11, m12] (the document's transform). */
export type Affine = [number, number, number, number, number, number];

/** The placeholder's own rectangle as the overlay draws it: `width` × `height` put on the page by `m` (rotation included). */
export interface PlaceholderShape {
  m: Affine;
  width: number;
  height: number;
  /** Corner radii, clockwise from the top left (a filled rectangle or frame) */
  radius?: [number, number, number, number];
  /** A filled ellipse */
  ellipse?: boolean;
}

export interface PlaceholderTarget {
  page: Guid;
  /** The layer the image goes into (a section, or the page) — absent when it fills `nodeId` */
  parentId?: Guid;
  /** The selected layer the image will fill */
  nodeId?: Guid;
  /** In the parent's coordinates (the layer's own when it fills `nodeId`) */
  box: Box;
  /** On the page: its bounds */
  world: Box;
  /** On the page: what the overlay draws */
  shape: PlaceholderShape;
}

export interface Placeholder {
  id: string;
  /** The chat turn it belongs to (the answer's message id until the turn has its id) */
  turnId: string;
  /** "active" while the image is made; "revealing" over the placed picture; "leaving" as it fades out */
  state: "active" | "revealing" | "leaving";
  target: PlaceholderTarget;
  /** The generate_image step it shows; absent while the prompt asked for a picture and the agent hasn't started one */
  tool?: string;
}

/** A node as the placeholder needs it (its real type: a group is "GROUP", not "FRAME"). */
export interface PlaceNode {
  type: string;
  size?: { x: number; y: number };
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
  parent?: Guid | null;
  /** Corner radii, clockwise from the top left */
  radius?: [number, number, number, number];
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
const ms = (v: string) => parseFloat(v) || 0;
/** How long a placeholder takes to fade out (--ds-duration-fade) */
export const FADE_MS = ms(motion["duration-fade"]);
/** How long the reveal over a placed picture plays (--ds-duration-reveal) */
export const REVEAL_MS = ms(motion["duration-reveal"]);

/** Layers an image fills (Place image over a selected layer). */
const FILLABLE = new Set(["FRAME", "SYMBOL", "COMPONENT", "COMPONENT_SET", "INSTANCE", "RECTANGLE", "ROUNDED_RECTANGLE", "ELLIPSE", "REGULAR_POLYGON", "POLYGON", "STAR", "VECTOR", "BOOLEAN_OPERATION"]);
/** Layers an image goes inside, centred. */
const CONTAINERS = new Set(["SECTION"]);

const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];
const mul = (a: Affine, b: Affine): Affine => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2], a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];
const affineOf = (t: PlaceNode["transform"]): Affine => (t ? [t.m00, t.m01, t.m02, t.m10, t.m11, t.m12] : IDENTITY);
const translate = (x: number, y: number): Affine => [1, 0, x, 0, 1, y];

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

/** A box in a parent's space (`parentM`: the parent's transform to the page) as a target. */
function inParent(page: Guid, parentId: Guid, parentM: Affine, box: Box): PlaceholderTarget {
  return { page, parentId, box, world: toPage(parentM, box), shape: { m: mul(parentM, translate(box.x, box.y)), width: box.width, height: box.height } };
}

/** Where the image goes, from the selection and the view. Null without a page. */
export function placeholderTarget(env: PlaceholderEnv, aspect = 1): PlaceholderTarget | null {
  const page = env.page;
  if (!page) return null;
  const only = env.selection.length === 1 ? env.selection[0] : null;
  const n = only ? env.read(only) : null;
  if (only && n?.size && n.size.x > 0 && n.size.y > 0) {
    const own: Box = { x: 0, y: 0, width: n.size.x, height: n.size.y };
    const m = pageTransform(env, only);
    if (FILLABLE.has(n.type)) {
      const shape: PlaceholderShape = { m, width: own.width, height: own.height };
      if (n.type === "ELLIPSE") shape.ellipse = true;
      else if (n.radius?.some((r) => r > 0)) shape.radius = n.radius;
      return { page, nodeId: only, box: own, world: toPage(m, own), shape };
    }
    if (CONTAINERS.has(n.type)) return inParent(page, only, m, centred(fitSize(aspect, own.width, own.height), own));
  }
  // The visible part of the page, its middle.
  const { camera: c, viewport: v } = env;
  const zoom = c.zoom > 0 ? c.zoom : 1;
  const visible: Box = { x: -c.x / zoom, y: -c.y / zoom, width: Math.max(1, v.width) / zoom, height: Math.max(1, v.height) / zoom };
  return inParent(page, page, IDENTITY, centred(fitSize(aspect, visible.width * 0.6, visible.height * 0.6), visible));
}

/** The aspect a placeholder has before the agent asks for one: a filled layer's own, else square. */
export const targetAspect = (t: PlaceholderTarget | null): number => (t?.nodeId ? t.box.width / Math.max(1, t.box.height) : 1);

/**
 * The placeholder at the aspect generate_image asked for, once it is known: the same centre, fitted in the square it
 * had. A filled layer keeps its own shape (the picture fills it).
 */
export function reshapeTarget(t: PlaceholderTarget, aspect: number, read: PlaceholderEnv["read"]): PlaceholderTarget {
  if (t.nodeId || !t.parentId) return t;
  const side = Math.max(t.box.width, t.box.height);
  const size = fitSize(aspect, side, side);
  if (size.width === t.box.width && size.height === t.box.height) return t;
  const parentM = t.parentId === t.page ? IDENTITY : pageTransform({ read }, t.parentId);
  return inParent(t.page, t.parentId, parentM, centred(size, t.box));
}

/**
 * place_image's arguments with the placeholder's place as defaults. Over a selected layer the picture fills that
 * layer (`nodeId`) unless the agent named another layer or parent. Otherwise, when the agent named no place of its own
 * (no nodeId, parentId, x or y), it lands centred on the placeholder — at the agent's own width / height when it gave
 * them, else fitted into it (`__box`, read by mcpTools' place_image).
 */
export function placeholderArgs(args: Record<string, unknown>, p: Placeholder | undefined): Record<string, unknown> {
  if (!p) return args;
  const given = (k: string) => args[k] !== undefined && args[k] !== null;
  const t = p.target;
  if (t.nodeId) {
    if (given("nodeId") || (given("parentId") && args.parentId !== t.nodeId)) return args;
    const rest = { ...args };
    for (const k of ["parentId", "x", "y", "width", "height"]) delete rest[k];
    return { ...rest, nodeId: t.nodeId };
  }
  if (["nodeId", "parentId", "x", "y"].some(given)) return args;
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
  private patch(id: string, fn: (p: Placeholder) => Placeholder) {
    this.emit(this.items.map((p) => (p.id === id ? fn(p) : p)));
  }

  /** A new placeholder for the turn (an image being made — or asked for: no `tool` yet), or null when there is nowhere to put it. */
  start(turnId: string, target: PlaceholderTarget | null, tool?: string): Placeholder | null {
    if (!target) return null;
    const p: Placeholder = { id: `ph${++seq}`, turnId, state: "active", target, ...(tool ? { tool } : {}) };
    this.emit([...this.items, p]);
    return p;
  }

  /** The turn's id, once main gave it (a placeholder started as the prompt was sent carries the answer's id). */
  rekey(from: string, to: string) {
    if (this.items.some((p) => p.turnId === from)) this.emit(this.items.map((p) => (p.turnId === from ? { ...p, turnId: to } : p)));
  }

  /** The placeholder showing generate_image step `tool`, if any. */
  ofTool(turnId: string, tool: string): Placeholder | undefined {
    return this.items.find((p) => p.turnId === turnId && p.tool === tool);
  }

  /**
   * generate_image started: the turn's placeholder put up when the prompt was sent now shows it (reshaped to the
   * aspect asked for, by `reshape`). Undefined when there is none waiting.
   */
  bind(turnId: string, tool: string, reshape?: (t: PlaceholderTarget) => PlaceholderTarget): Placeholder | undefined {
    const p = this.items.find((x) => x.turnId === turnId && x.state === "active" && !x.tool);
    if (!p) return undefined;
    const bound = { ...p, tool, target: reshape ? reshape(p.target) : p.target };
    this.patch(p.id, () => bound);
    return bound;
  }

  /** The turn's oldest image still waiting for place_image. */
  next(turnId: string): Placeholder | undefined {
    return this.items.find((p) => p.turnId === turnId && p.state === "active");
  }

  /** The image is on the canvas, where the placeholder was: the reveal plays over it, then the placeholder goes. */
  placed(id: string) {
    const p = this.items.find((x) => x.id === id);
    if (!p || p.state !== "active") return;
    this.patch(id, (x) => ({ ...x, state: "revealing" }));
    this.removeAfter(id, REVEAL_MS);
  }

  /** The newest image of the turn failed: its placeholder fades out. */
  fail(turnId: string, tool?: string) {
    const last = [...this.items].reverse().find((p) => p.turnId === turnId && p.state === "active" && (!tool || p.tool === tool));
    if (last) this.leave([last.id]);
  }

  /** The turn is over (done, error or Stop): what is left fades out. */
  end(turnId: string) {
    this.leave(this.items.filter((p) => p.turnId === turnId && p.state === "active").map((p) => p.id));
  }

  private leave(ids: string[]) {
    if (!ids.length) return;
    this.emit(this.items.map((p) => (ids.includes(p.id) ? { ...p, state: "leaving" as const } : p)));
    for (const id of ids) this.removeAfter(id, FADE_MS);
  }

  private removeAfter(id: string, delay: number) {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.emit(this.items.filter((p) => p.id !== id));
      }, delay)
    );
  }

  dispose() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.items = [];
    this.listeners.clear();
  }
}
