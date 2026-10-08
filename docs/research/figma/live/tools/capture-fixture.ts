
// ---- `&doc=capture`: the live capture's page "Capture" (docs/research/figma/live/design) -----------------------

/** A grid frame's tracks as Figma writes them (model/grid.ts), for the capture's AL_grid. */
function gridTracks(columns: number, rows: number, session: number): Record<string, unknown> {
  const base = { stackMode: "GRID" } as GridNode;
  const cols = setTrackCount(base, "columns", columns, session).frame;
  const rowsFields = setTrackCount({ ...base, ...cols } as GridNode, "rows", rows, session).frame;
  return { ...cols, ...rowsFields };
}

const al = (guid: string, name: string, pos: string, x: number, y: number, more: Record<string, unknown>) =>
  node({ guid, type: "FRAME", name, parentIndex: { guid: "0:1", position: pos }, transform: at(x, y), fillPaints: solidFill(0xffffff), frameMaskDisabled: false, ...more });
const box = (guid: string, name: string, parent: string, pos: string, x: number, y: number, w: number, h: number, rgb: number, more: Record<string, unknown> = {}) =>
  node({ guid, type: "ROUNDED_RECTANGLE", name, parentIndex: { guid: parent, position: pos }, size: { x: w, y: h }, transform: at(x, y), fillPaints: solidFill(rgb), ...more });
const pad = (p: number) => ({ stackHorizontalPadding: p, stackVerticalPadding: p, stackPaddingRight: p, stackPaddingBottom: p });

/**
 * `&doc=capture`: the layers Figma's live panel was captured on (docs/research/figma/live/design/*.txt), with the
 * values its dumps show — F_frame, AL_vertical / _horizontal / _wrap / _grid, AL_parent with its children, Rect,
 * Ellipse, Polygon, Star, Line, Arrow, Vector, Boolean, Group, Text, Section and Image — so the Design panel can be
 * laid out against the dumps (src/renderer/src/editor/tools/editor-shot.mjs `EDITOR_ONLY=design`).
 */
export const CAPTURE_DOCUMENT: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    page("0:1", "Capture", 0, 0xf5f5f5),
    internalCanvas(),
    al("7:1", "F_frame", "!", 0, 0, { size: { x: 240, y: 180 } }),
    box("7:2", "C_child_in_frame", "7:1", "!", 40, 40, 80, 60, 0x3380ff),
    al("7:10", "AL_vertical", '"', 300, 0, { size: { x: 92, y: 172 }, stackMode: "VERTICAL", stackSpacing: 10, ...pad(16), stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" }),
    ...[0, 1, 2].map((i) => box(`7:1${i + 1}`, `AL_vertical_item${i + 1}`, "7:10", String.fromCharCode(33 + i), 16, 16 + i * 50, 60, 40, 0xe5664d)),
    al("7:20", "AL_horizontal", "#", 420, 0, { size: { x: 232, y: 72 }, stackMode: "HORIZONTAL", stackSpacing: 10, ...pad(16), stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" }),
    ...[0, 1, 2].map((i) => box(`7:2${i + 1}`, `AL_horizontal_item${i + 1}`, "7:20", String.fromCharCode(33 + i), 16 + i * 70, 16, 60, 40, 0xe5664d)),
    al("7:30", "AL_wrap", "$", 700, 0, { size: { x: 170, y: 120 }, stackMode: "HORIZONTAL", stackWrap: "WRAP", stackSpacing: 10, stackCounterSpacing: 8, ...pad(16), stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" }),
    ...[0, 1, 2].map((i) => box(`7:3${i + 1}`, `AL_wrap_item${i + 1}`, "7:30", String.fromCharCode(33 + i), 16 + (i % 2) * 70, 16 + Math.floor(i / 2) * 48, 60, 40, 0xe5664d)),
    al("7:40", "AL_grid", "%", 900, 0, { size: { x: 320, y: 200 }, ...gridTracks(3, 2, 7), gridReflowEnabled: true, gridColumnGap: 8, gridRowGap: 8, ...pad(12), stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" }),
    ...[0, 1, 2, 3].map((i) => box(`7:4${i + 1}`, `AL_grid_item${i + 1}`, "7:40", String.fromCharCode(33 + i), 12, 12, 60, 40, 0x66cc80)),
    al("7:50", "AL_parent", "&", 0, 850, { size: { x: 400, y: 100 }, stackMode: "HORIZONTAL", stackSpacing: 12, ...pad(16), stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" }),
    box("7:51", "AL_child", "7:50", "!", 16, 16, 80, 50, 0xe58033),
    box("7:52", "AL_child2", "7:50", '"', 108, 16, 80, 50, 0x8080e5),
    box("7:60", "Rect", "0:1", "'", 0, 300, 120, 90, 0xd9d9d9),
    node({ guid: "7:61", type: "ELLIPSE", name: "Ellipse", parentIndex: { guid: "0:1", position: "(" }, size: { x: 100, y: 100 }, transform: at(160, 300), fillPaints: solidFill(0xd9d9d9) }),
    node({ guid: "7:62", type: "REGULAR_POLYGON", name: "Polygon", parentIndex: { guid: "0:1", position: ")" }, size: { x: 100, y: 100 }, transform: at(300, 300), fillPaints: solidFill(0xd9d9d9), count: 3 }),
    node({ guid: "7:63", type: "STAR", name: "Star", parentIndex: { guid: "0:1", position: "*" }, size: { x: 100, y: 100 }, transform: at(440, 300), fillPaints: solidFill(0xd9d9d9), count: 5, starInnerScale: 0.382 }),
    node({ guid: "7:64", type: "LINE", name: "Line", parentIndex: { guid: "0:1", position: "+" }, size: { x: 120, y: 0 }, transform: at(580, 350), strokePaints: solidFill(0x000000), strokeWeight: 1, strokeAlign: "CENTER" }),
    node({ guid: "7:65", type: "LINE", name: "Arrow", parentIndex: { guid: "0:1", position: "," }, size: { x: 120, y: 0 }, transform: at(740, 350), strokePaints: solidFill(0x000000), strokeWeight: 1, strokeAlign: "CENTER", strokeCap: "ARROW_LINES" }),
    node({ guid: "7:66", type: "VECTOR", name: "Vector", parentIndex: { guid: "0:1", position: "-" }, size: { x: 80, y: 90 }, transform: at(900, 300), fillPaints: solidFill(0xffcc33), strokePaints: solidFill(0x000000), strokeWeight: 1, strokeAlign: "CENTER" }),
    node({ guid: "7:70", type: "BOOLEAN_OPERATION", booleanOperation: "UNION", name: "Boolean", parentIndex: { guid: "0:1", position: "." }, size: { x: 120, y: 110 }, transform: at(1040, 300), fillPaints: solidFill(0xd9d9d9) }),
    box("7:71", "b1", "7:70", "!", 0, 0, 80, 80, 0xd9d9d9),
    node({ guid: "7:72", type: "ELLIPSE", name: "b2", parentIndex: { guid: "7:70", position: '"' }, size: { x: 80, y: 80 }, transform: at(40, 30), fillPaints: solidFill(0xd9d9d9) }),
    node({ guid: "7:80", type: "FRAME", name: "Group", resizeToFit: true, parentIndex: { guid: "0:1", position: "/" }, size: { x: 140, y: 80 }, transform: at(1220, 300), fillPaints: [], frameMaskDisabled: true }),
    box("7:81", "g_a", "7:80", "!", 0, 0, 60, 80, 0x4d4d4d),
    box("7:82", "g_b", "7:80", '"', 80, 0, 60, 80, 0x999999),
    node({ guid: "7:90", type: "TEXT", name: "Text", parentIndex: { guid: "0:1", position: "0" }, size: { x: 184, y: 29 }, transform: at(0, 460), fillPaints: solidFill(0x000000), textData: { characters: "Hello, Capture" }, fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 24, textAutoResize: "WIDTH_AND_HEIGHT" }),
    node({ guid: "7:95", type: "SECTION", name: "Section", parentIndex: { guid: "0:1", position: "1" }, size: { x: 400, y: 300 }, transform: at(0, 1100), fillPaints: solidFill(0x444444), strokePaints: [{ type: "SOLID", color: hex(0xffffff), opacity: 0.1, visible: true }], strokeWeight: 1, strokeAlign: "INSIDE", cornerRadius: 2 }),
    box("7:96", "Image", "0:1", "2", 1000, 600, 160, 120, 0xd9d9d9, { fillPaints: [{ type: "IMAGE", imageScaleMode: "FILL", opacity: 1, visible: true }] }),
  ],
};
