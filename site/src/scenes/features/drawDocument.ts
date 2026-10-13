// The Draw scene's file: one frame, a small landscape made of shapes (sun, hills, a star, a moon), with room around it
// for the visitor's own drawing. The same list draws the still frame before the engine runs (DrawScene's Still).
import { DocBuilder, radius, solid } from "../engine/doc";

export interface StillShape {
  kind: "frame" | "rect" | "ellipse" | "star";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  r?: number;
  clip?: boolean;
}

const hexStr = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** The poster frame's world rectangle: the first view centres it. */
export const POSTER = { x: 0, y: 0, w: 560, h: 380 };

export function drawDocument() {
  const d = new DocBuilder("Sketches");
  const page = "0:1";
  const still: StillShape[] = [];
  const add = (parent: string, type: string, name: string, x: number, y: number, w: number, h: number, fill: number, more: Record<string, unknown> = {}, ox = 0, oy = 0) => {
    const guid = d.add(parent, type, name, x, y, w, h, { fillPaints: solid(fill), ...more });
    const kind = type === "FRAME" ? "frame" : type === "ELLIPSE" ? "ellipse" : type === "STAR" ? "star" : "rect";
    still.push({ kind, x: ox + x, y: oy + y, w, h, fill: hexStr(fill), r: typeof more.cornerRadius === "number" ? more.cornerRadius : 0, clip: parent !== page });
    return guid;
  };

  const poster = add(page, "FRAME", "Poster", POSTER.x, POSTER.y, POSTER.w, POSTER.h, 0xfff1dc);
  const o = [POSTER.x, POSTER.y] as const;
  const sun = add(poster, "ELLIPSE", "Sun", 334, 54, 132, 132, 0xffa629, {}, ...o);
  add(poster, "ELLIPSE", "Hill", -120, 238, 470, 300, 0x5cc98a, {}, ...o);
  add(poster, "ELLIPSE", "Hill", 210, 262, 470, 280, 0x14ae5c, {}, ...o);
  const star = add(poster, "STAR", "Star", 92, 66, 54, 54, 0xffffff, { count: 5, starInnerScale: 0.42 }, ...o);
  add(poster, "ROUNDED_RECTANGLE", "Cloud", 150, 132, 112, 34, 0xffffff, radius(17), ...o);
  add(poster, "ROUNDED_RECTANGLE", "Cloud", 196, 112, 64, 40, 0xffffff, radius(20), ...o);

  // A second, empty frame to draw in
  add(page, "FRAME", "Sketch", POSTER.x + POSTER.w + 48, POSTER.y, 280, POSTER.h, 0xffffff);

  return { message: d.message(), poster, sun, star, still };
}
