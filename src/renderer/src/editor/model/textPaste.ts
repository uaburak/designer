/**
 * Plain text pasted on the canvas (docs/desktop.md §13): Figma makes it a new text layer — auto width, Inter Regular
 * 12, black, named by its first characters — in the middle of the view (or into the selected frame, the engine's
 * paste rule). What Figma's "Copy as text" and any text editor put on the clipboard.
 */
import type { Message, NodeChange } from "@/engine/codec";

/** Figma's text defaults (a new text layer). */
const FONT = { family: "Inter", style: "Regular", postscript: "" };
const FONT_SIZE = 12;
/** Inter's line height at 12 px "Auto" (1.21 em) — a first box until the engine lays the text out. */
const LINE = 14.52;
/** Figma names a text layer by its characters; long ones are cut. */
const NAME_MAX = 100;

/** Text that becomes a layer: trailing whitespace dropped, line ends normalized; null when nothing is left. */
export function pastableText(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return t.trim() ? t : null;
}

/** A clipboard Message with one text layer holding `text`, its top-left at `at` (page px). */
export function textToMessage(text: string, at: { x: number; y: number } = { x: 0, y: 0 }): Message {
  const lines = text.split("\n");
  const width = Math.max(1, Math.ceil(Math.max(...lines.map((l) => l.length)) * FONT_SIZE * 0.6));
  const node = {
    guid: "4294967294:1",
    phase: "CREATED",
    type: "TEXT",
    name: text.replace(/\s+/g, " ").trim().slice(0, NAME_MAX),
    parentIndex: { guid: "0:1", position: "!" },
    size: { x: width, y: Math.ceil(lines.length * LINE) },
    transform: { m00: 1, m01: 0, m02: Math.round(at.x), m10: 0, m11: 1, m12: Math.round(at.y) },
    fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
    fontName: FONT,
    fontSize: FONT_SIZE,
    textAutoResize: "WIDTH_AND_HEIGHT",
    textData: { characters: text },
  } as unknown as NodeChange;
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [node] } as unknown as Message;
}
