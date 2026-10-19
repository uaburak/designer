/**
 * A spreadsheet pasted on the canvas (atlas 15 §12.1, Figma's `handle-paste-spreadsheet`): HTML from Google Sheets
 * (`google-sheets-html-origin`), Excel (`content=Excel.Sheet`) or any HTML that is one table and nothing else becomes
 * a grid (Figma Design's `grid_from_spreadsheet_paste_created`): a grid auto-layout frame with a text layer per cell,
 * row by row, its tracks hugging their cells. How Figma styles the grid (gaps, padding, fills, the text) wasn't read
 * from the build (atlas 15 §17): Figma's text defaults (Inter Regular 12, black) and the grid's own defaults here.
 * Parsed by hand: nothing pasted is run or loaded.
 */
import type { Message, NodeChange } from "@/engine/codec";
import { positions } from "./svgImport";
import { textToMessage } from "./textPaste";
import { trackFields, type Track } from "./grid";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A cell's text: line breaks and block ends as new lines, other tags gone, entities decoded, edges trimmed. */
function cellText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/[ \t\r\n]+/g, (ws) => (ws.includes("\n") ? "\n" : " "))
  ).trim();
}

/** Whether `html` is a spreadsheet's copy: Google Sheets', Excel's, or only one table. */
export function isSpreadsheetHtml(html: string | null | undefined): boolean {
  if (!html || !/<table[\s>]/i.test(html)) return false;
  if (html.includes("google-sheets-html-origin") || /content=["']?Excel\.Sheet/i.test(html)) return true;
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(meta|link)[^>]*>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(html|head|body)[^>]*>/gi, "")
    .trim();
  return /^<table[\s>]/i.test(body) && /<\/table>$/i.test(body) && (body.match(/<table[\s>]/gi) ?? []).length === 1;
}

/** The table's rows of cell texts (a cell spanning columns is followed by empty cells), or null when there is none. */
export function spreadsheetCells(html: string): string[][] | null {
  if (!isSpreadsheetHtml(html)) return null;
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row: string[] = [];
    for (const td of tr[1].matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
      row.push(cellText(td[3]));
      const span = Number(/colspan=["']?(\d+)/i.exec(td[2])?.[1] ?? 1);
      for (let i = 1; i < Math.min(span, 100); i++) row.push("");
    }
    if (row.length) rows.push(row);
  }
  const columns = Math.max(0, ...rows.map((r) => r.length));
  if (!rows.length || !columns) return null;
  return rows.map((r) => [...r, ...Array<string>(columns - r.length).fill("")]);
}

/** Track ids of the pasted grid (any GUIDs: the engine keeps a frame's tracks as they come). */
const trackId = (localID: number) => ({ sessionID: 4294967294, localID });

/** A clipboard Message with the grid: the frame, then a text layer per non-empty cell anchored to its tracks. */
export function spreadsheetToMessage(rows: readonly (readonly string[])[]): Message {
  const columns = rows[0]?.length ?? 0;
  const keys = positions(Math.max(columns, rows.length));
  const tracks = (n: number, first: number): Track[] =>
    Array.from({ length: n }, (_, i) => ({ id: trackId(first + i), position: keys[i], sizing: { type: "HUG", value: 1 } }));
  const cols = tracks(columns, 1), rowTracks = tracks(rows.length, 1 + columns);
  const frame = {
    guid: "4294967294:1",
    phase: "CREATED",
    type: "FRAME",
    name: "Grid",
    parentIndex: { guid: "0:1", position: "!" },
    size: { x: 100, y: 100 },
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    fillPaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
    stackMode: "GRID",
    stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",
    stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",
    // Placed by their anchors (an empty cell has no layer, so a flow would move the next ones up).
    gridReflowEnabled: false,
    gridColumnGap: 10,
    gridRowGap: 10,
    ...trackFields("columns", cols),
    ...trackFields("rows", rowTracks),
  } as unknown as NodeChange;
  const cells: NodeChange[] = [];
  const order = positions(columns * rows.length);
  let next = 2;
  rows.forEach((row, r) =>
    row.forEach((text, c) => {
      if (!text) return;
      const node = textToMessage(text).nodeChanges[0] as NodeChange & Record<string, unknown>;
      cells.push({
        ...node,
        guid: `4294967294:${next++}`,
        parentIndex: { guid: frame.guid, position: order[r * columns + c] },
        gridColumnAnchor: cols[c].id,
        gridRowAnchor: rowTracks[r].id,
      } as unknown as NodeChange);
    })
  );
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [frame, ...cells] } as unknown as Message;
}
