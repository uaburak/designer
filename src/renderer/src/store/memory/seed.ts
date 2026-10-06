/**
 * The browser demo's starting workspace: a few folders (one nested), files in Drafts and in folders with frames,
 * rectangles and ellipses drawn on their first page, an SVG thumbnail each, a starred file and folder, Recents, a
 * named version, and one file in Trash — enough to exercise every view of Home and to open something in the editor.
 */
import { encodeMessage, newDocumentNodes, type NodeChange } from "../../../../shared/schema/codec";
import { rebalancedKeys } from "../../../../shared/schema/fractionalIndex";
import { FIRST_PAGE_GUID, sessionIdFor } from "../../../../shared/schema/guid";
import type { FolderId } from "../../../../shared/store/types";
import type { MemoryStore } from "./memoryStore";

type Rgb = [number, number, number];

interface Shape {
  kind: "frame" | "rect" | "ellipse";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: Rgb;
  radius?: number;
  children?: Shape[];
}

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const WHITE = hex("#FFFFFF");
const PAGE = hex("#F5F5F5");

/** The kiwi nodes of a document whose first page holds `shapes` (GUIDs in the file's first session). */
export function demoDocument(shapes: Shape[], sessionID = sessionIdFor(1, 1)): NodeChange[] {
  const nodes = newDocumentNodes();
  let local = 1;
  const add = (list: Shape[], parent: { sessionID: number; localID: number }) => {
    const keys = rebalancedKeys(list.length);
    list.forEach((s, i) => {
      const guid = { sessionID, localID: local++ };
      const node: NodeChange = {
        guid,
        phase: "CREATED",
        type: s.kind === "frame" ? "FRAME" : s.kind === "ellipse" ? "ELLIPSE" : "ROUNDED_RECTANGLE",
        name: s.name,
        parentIndex: { guid: parent, position: keys[i] },
        visible: true,
        opacity: 1,
        size: { x: s.w, y: s.h },
        transform: { m00: 1, m01: 0, m02: s.x, m10: 0, m11: 1, m12: s.y },
        fillPaints: [{ type: "SOLID", color: { r: s.fill[0], g: s.fill[1], b: s.fill[2], a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
      };
      if (s.radius) node.cornerRadius = s.radius;
      nodes.push(node);
      if (s.children?.length) add(s.children, guid);
    });
  };
  add(shapes, FIRST_PAGE_GUID);
  return nodes;
}

/** A 400×300 SVG of the shapes on the page colour, fit with a margin (Home's card ratio). */
export function demoThumbnail(shapes: Shape[], width = 400, height = 300): Uint8Array {
  const minX = Math.min(...shapes.map((s) => s.x));
  const minY = Math.min(...shapes.map((s) => s.y));
  const maxX = Math.max(...shapes.map((s) => s.x + s.w));
  const maxY = Math.max(...shapes.map((s) => s.y + s.h));
  const pad = 28;
  const scale = Math.min((width - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1));
  const ox = (width - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (height - (maxY - minY) * scale) / 2 - minY * scale;
  const color = (c: Rgb) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
  const parts: string[] = [];
  const draw = (list: Shape[], dx: number, dy: number) => {
    for (const s of list) {
      const x = ox + (dx + s.x) * scale;
      const y = oy + (dy + s.y) * scale;
      const w = s.w * scale;
      const h = s.h * scale;
      if (s.kind === "ellipse") parts.push(`<ellipse cx="${(x + w / 2).toFixed(1)}" cy="${(y + h / 2).toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="${color(s.fill)}"/>`);
      else parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${((s.radius ?? 0) * scale).toFixed(1)}" fill="${color(s.fill)}"/>`);
      if (s.children) draw(s.children, dx + s.x, dy + s.y);
    }
  };
  draw(shapes, 0, 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color(PAGE)}"/>${parts.join("")}</svg>`;
  return new TextEncoder().encode(svg);
}

const BLUE = hex("#0D99FF");
const DARK = hex("#1E1E1E");
const LIGHT = hex("#E6E6E6");
const CARD = hex("#F0F0F0");

const landing: Shape[] = [
  {
    kind: "frame",
    name: "Desktop",
    x: 0,
    y: 0,
    w: 1440,
    h: 1024,
    fill: WHITE,
    children: [
      { kind: "rect", name: "Navigation", x: 0, y: 0, w: 1440, h: 72, fill: LIGHT },
      { kind: "rect", name: "Hero", x: 120, y: 140, w: 1200, h: 420, fill: BLUE, radius: 24 },
      { kind: "rect", name: "Button", x: 120, y: 600, w: 200, h: 56, fill: DARK, radius: 8 },
      ...[0, 1, 2].map((i): Shape => ({ kind: "rect", name: `Card ${i + 1}`, x: 120 + i * 408, y: 720, w: 384, h: 240, fill: CARD, radius: 16 })),
    ],
  },
];

const phone = (i: number, accent: Rgb): Shape => ({
  kind: "frame",
  name: ["Sign in", "Home", "Profile"][i],
  x: i * 470,
  y: 0,
  w: 390,
  h: 844,
  fill: WHITE,
  children: [
    { kind: "rect", name: "Header", x: 0, y: 0, w: 390, h: 120, fill: accent },
    { kind: "rect", name: "Card", x: 24, y: 152, w: 342, h: 180, fill: CARD, radius: 16 },
    { kind: "rect", name: "Card", x: 24, y: 356, w: 342, h: 180, fill: CARD, radius: 16 },
    { kind: "rect", name: "Button", x: 24, y: 740, w: 342, h: 56, fill: DARK, radius: 28 },
  ],
});
const mobile: Shape[] = [phone(0, hex("#A259FF")), phone(1, hex("#0ACF83")), phone(2, hex("#FF7262"))];

const logos: Shape[] = [
  {
    kind: "frame",
    name: "Logo",
    x: 0,
    y: 0,
    w: 800,
    h: 800,
    fill: WHITE,
    children: [
      { kind: "ellipse", name: "Orange", x: 160, y: 160, w: 280, h: 280, fill: hex("#FF7262") },
      { kind: "ellipse", name: "Purple", x: 360, y: 160, w: 280, h: 280, fill: hex("#A259FF") },
      { kind: "ellipse", name: "Green", x: 260, y: 360, w: 280, h: 280, fill: hex("#0ACF83") },
    ],
  },
];

const poster: Shape[] = [
  {
    kind: "frame",
    name: "Poster",
    x: 0,
    y: 0,
    w: 600,
    h: 800,
    fill: DARK,
    children: [
      { kind: "rect", name: "Title", x: 60, y: 80, w: 480, h: 120, fill: hex("#FFC700") },
      { kind: "ellipse", name: "Sun", x: 150, y: 280, w: 300, h: 300, fill: hex("#F24822") },
      { kind: "rect", name: "Footer", x: 60, y: 660, w: 480, h: 60, fill: hex("#FFFFFF") },
    ],
  },
];

const wireframes: Shape[] = [0, 1].map((i) => ({
  kind: "frame",
  name: `Wireframe ${i + 1}`,
  x: i * 1000,
  y: 0,
  w: 900,
  h: 640,
  fill: WHITE,
  children: [
    { kind: "rect", name: "Box", x: 40, y: 40, w: 820, h: 80, fill: LIGHT },
    { kind: "rect", name: "Box", x: 40, y: 160, w: 400, h: 440, fill: LIGHT },
    { kind: "rect", name: "Box", x: 460, y: 160, w: 400, h: 440, fill: LIGHT },
  ],
}));

const scratch: Shape[] = [{ kind: "rect", name: "Rectangle", x: 0, y: 0, w: 200, h: 120, fill: hex("#D9D9D9") }];

const DAY = 24 * 60 * 60 * 1000;

/** Fills an empty dev store with the demo workspace. */
export async function seedDemoWorkspace(store: MemoryStore): Promise<void> {
  const ws = store.ws;
  const api = store.api();
  const now = store.clock.now();
  const folder = (name: string, parentId: FolderId | null, color: "blue" | "green" | "gray") => api.workspace.createFolder({ name, parentId, color });
  const client = await folder("Client work", null, "blue");
  const archive = await folder("Archive", client.id, "gray");
  const personal = await folder("Personal", null, "green");

  const file = async (name: string, folderId: FolderId | null, shapes: Shape[], ageDays: number, editedDaysAgo: number) => {
    const snapshot = encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: demoDocument(shapes), blobs: [] });
    const meta = await store.addFile({ name, folderId, snapshot, nextLocal: 2, thumbnail: { bytes: demoThumbnail(shapes), mime: "image/svg+xml" }, thumbSize: { width: 400, height: 300 } });
    await ws.queue.run(() => ws.patchFile(meta.fileKey, { createdAt: now - ageDays * DAY, updatedAt: now - editedDaysAgo * DAY }, { silent: true }));
    return meta;
  };
  const landingFile = await file("Landing page", null, landing, 12, 0.02);
  const mobileFile = await file("Mobile app", client.id, mobile, 30, 1);
  const logoFile = await file("Logo explorations", personal.id, logos, 45, 3);
  await file("Old poster", archive.id, poster, 200, 150);
  const wireFile = await file("Wireframes", null, wireframes, 8, 6);
  const scratchFile = await file("Scratch", null, scratch, 2, 2);

  store.addVersion(landingFile.fileKey, { kind: "named", title: "First draft", description: "Hero, button and three cards", restoredFrom: null });
  await api.workspace.setStarred({ fileKey: landingFile.fileKey }, true);
  await api.workspace.setStarred({ folderId: client.id }, true);
  await api.workspace.trash({ files: [scratchFile.fileKey] });
  // Recents, newest first, at believable times.
  const viewed = [
    { fileKey: landingFile.fileKey, viewedAt: now - 10 * 60 * 1000 },
    { fileKey: mobileFile.fileKey, viewedAt: now - DAY },
    { fileKey: logoFile.fileKey, viewedAt: now - 3 * DAY },
    { fileKey: wireFile.fileKey, viewedAt: now - 6 * DAY },
  ];
  ws.prefs.recents = viewed;
  ws.prefs.viewedAt = Object.fromEntries(viewed.map((v) => [v.fileKey, v.viewedAt]));
  await ws.savePrefs();
}
