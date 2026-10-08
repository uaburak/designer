/**
 * Placing images as Figma does: each image becomes a rectangle its own size
 * (after the 4096 px cap), named after its file, filled with the image (Fill
 * mode). With a point (the Image tool's click, a drop) it goes at that point
 * in the innermost frame there; without one (a paste) it goes where a paste
 * goes (the selected frame, else the middle of the view). Several images sit
 * in a row. One undo step, the placed layers selected.
 *
 * The engine's paste does the work (fresh ids, parenting, one step): the
 * rectangles travel as a clipboard Message whose transforms are page
 * positions, pasted in place under a target chosen by the selection.
 */
import type { Guid, Message, NodeChange, Vector } from "@/engine/codec";
import type { EditorController } from "./controller";
import { hasCommand } from "./engineCompat";
import { DEFAULT_VIDEO_PLAYBACK, mediaPaint } from "./model/paints";
import type { ImportedImage } from "./images";

/** The gap between images placed together (unverified against Figma). */
export const PLACE_GAP = 20;

/** The clipboard Message of rectangles for `images`, the first one's top-left at `origin` (page px), in a row. */
export function imageRectangles(images: readonly ImportedImage[], origin: Vector, size?: Vector): Message {
  const nodeChanges: NodeChange[] = [];
  let x = origin.x;
  images.forEach((img, i) => {
    const w = i === 0 && size ? size.x : img.width;
    const h = i === 0 && size ? size.y : img.height;
    nodeChanges.push({
      guid: `4294967294:${i + 1}`,
      phase: "CREATED",
      type: "ROUNDED_RECTANGLE",
      name: img.name,
      parentIndex: { guid: "4294967294:0", position: String.fromCharCode(33 + i) },
      size: { x: w, y: h },
      transform: { m00: 1, m01: 0, m02: Math.round(x), m10: 0, m11: 1, m12: Math.round(origin.y) },
      // The paint carries the image's ThumbHash and low-res copy (progressive display) when the import made them; a
      // video's is a VIDEO paint over its poster frame, and the layer gets Prototype › Video.
      fillPaints: [mediaPaint(img)],
      ...(img.video ? { videoPlayback: { ...DEFAULT_VIDEO_PLAYBACK } } : {}),
      strokeWeight: 1,
      strokeAlign: "INSIDE",
    });
    x += w + PLACE_GAP;
  });
  return { type: "NODE_CHANGES", sessionID: 0, nodeChanges, clipboardSelectionRegions: [{ parent: "4294967294:0", nodes: nodeChanges.map((n) => n.guid), enclosingFrameOffset: { x: 0, y: 0 } }] };
}

const isFrameLike = (n: NodeChange | null) => !!n && ["FRAME", "SECTION", "SYMBOL", "INSTANCE"].includes(n.type ?? "") && n.resizeToFit !== true;

/** The innermost frame under a canvas point (CSS px), or null (the page). */
export function frameAt(ed: EditorController, canvasX: number, canvasY: number): Guid | null {
  for (const id of ed.engine.hitTest(canvasX, canvasY)) {
    let n = ed.store.readNode(id);
    for (let depth = 0; n && depth < 256; depth++) {
      if (isFrameLike(n)) return n.guid;
      n = n.parentIndex?.guid ? ed.store.readNode(n.parentIndex.guid) : null;
      if (n?.type === "CANVAS") break;
    }
  }
  return null;
}

/** Canvas CSS px → page px. */
export function toPage(ed: EditorController, canvasX: number, canvasY: number): Vector {
  const cam = ed.engine.getCamera();
  return { x: (canvasX - cam.x) / cam.zoom, y: (canvasY - cam.y) / cam.zoom };
}

/**
 * Places `images` (already in the image store). `at`: a canvas point (CSS px) for the first image's top-left,
 * `size`: the first image's size when it was dragged out. Returns how many layers were placed.
 */
export function placeImages(ed: EditorController, images: readonly ImportedImage[], at?: { x: number; y: number }, size?: Vector): number {
  if (!images.length) return 0;
  if (at) {
    const origin = toPage(ed, at.x, at.y);
    const frame = frameAt(ed, at.x, at.y);
    ed.engine.setSelection(frame ? [frame] : []);
    return ed.engine.paste(imageRectangles(images, origin, size), { inPlace: true });
  }
  // Like a paste: into the selected frame (the engine centres it there), else in the middle of the view.
  const canvas = ed.canvas;
  const centre = toPage(ed, (canvas?.clientWidth ?? 0) / 2, (canvas?.clientHeight ?? 0) / 2);
  const width = images.reduce((w, img, i) => w + (i === 0 && size ? size.x : img.width), 0) + PLACE_GAP * (images.length - 1);
  const height = Math.max(...images.map((img, i) => (i === 0 && size ? size.y : img.height)));
  return ed.engine.paste(imageRectangles(images, { x: centre.x - width / 2, y: centre.y - height / 2 }, size), {});
}

/** The engine places images itself (E5's PLACE_IMAGES) — not needed by this path, reported in docs/editor.md. */
export const enginePlacesImages = () => hasCommand("PLACE_IMAGES");
