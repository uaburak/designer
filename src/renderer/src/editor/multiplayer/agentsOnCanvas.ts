/**
 * The editor's side of agent presence (agentPresence.ts): the engine's pages, layers' bounds and camera, the canvas's
 * visible part, the presence sink, and the owner's input that ends following. One per editor, started by
 * <Multiplayer /> (local files too: agents work on any file).
 */
import type { Guid, Matrix } from "@/engine/codec";
import { IDENTITY, multiply } from "../model/geometry";
import { viewRect } from "../canvas/viewInsets";
import type { EditorController } from "../controller";
import { AgentPresence, keyStopsFollowing, type AgentPresenceHost, type Rect } from "./agentPresence";
import { presenceSink } from "./presenceSink";

interface ViewEngine {
  centerOn?(x: number, y: number, zoom: number): void;
  viewCenter?(): { x: number; y: number; zoom: number };
}

/** A layer's box on its page (its corners through the transforms up to the page). */
function boundsOf(ed: EditorController, id: Guid): Rect | null {
  const read = (g: Guid) => (ed.engine.destroyed ? null : ed.engine.readNode(g, { fields: ["transform", "size", "parentIndex", "type"] }));
  const n = read(id);
  if (!n || n.type === "CANVAS" || n.type === "DOCUMENT") return null;
  let m: Matrix = (n.transform as Matrix | undefined) ?? IDENTITY;
  let p = n.parentIndex?.guid ? read(n.parentIndex.guid) : null;
  for (let i = 0; p && p.type !== "CANVAS" && p.type !== "DOCUMENT" && i < 400; i++) {
    m = multiply((p.transform as Matrix | undefined) ?? IDENTITY, m);
    p = p.parentIndex?.guid ? read(p.parentIndex.guid) : null;
  }
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const pts = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ].map(([x, y]) => [m.m00 * x + m.m01 * y + m.m02, m.m10 * x + m.m11 * y + m.m12]);
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function pageOf(ed: EditorController, id: Guid): Guid | null {
  if (ed.engine.destroyed) return null;
  let n = ed.engine.readNode(id, { fields: ["parentIndex", "type"] });
  for (let i = 0; n && i < 400; i++) {
    if (n.type === "CANVAS") return n.guid;
    n = n.parentIndex?.guid ? ed.engine.readNode(n.parentIndex.guid, { fields: ["parentIndex", "type"] }) : null;
  }
  return null;
}

export function editorAgentHost(ed: EditorController): AgentPresenceHost {
  const view = ed.engine as unknown as ViewEngine;
  return {
    page: () => ed.store.page,
    setPage: (page) => void ed.engine.setCurrentPage(page),
    pageOf: (id) => pageOf(ed, id),
    pageName: (page) => (ed.engine.destroyed ? null : (ed.engine.readNode(page, { fields: ["name"] })?.name ?? null)),
    bounds: (id) => boundsOf(ed, id),
    view: () => (view.viewCenter && !ed.engine.destroyed ? view.viewCenter.call(ed.engine) : { x: 0, y: 0, zoom: 1 }),
    centerOn: (x, y, zoom) => {
      if (view.centerOn && !ed.engine.destroyed) view.centerOn.call(ed.engine, x, y, zoom);
    },
    viewport: () => {
      const r = viewRect(ed.canvas);
      return r ? { w: r.width, h: r.height } : { w: 800, h: 600 };
    },
    draw: (peers) => presenceSink(ed).set("agents", peers),
    cursorsOn: () => ed.ui.get().multiplayerCursors !== false,
  };
}

const registry = new WeakMap<EditorController, AgentPresence>();
const started = new WeakMap<EditorController, () => void>();

/** The editor's agent presence (made on first use). */
export function agentPresenceOf(ed: EditorController): AgentPresence {
  let p = registry.get(ed);
  if (!p) registry.set(ed, (p = new AgentPresence(editorAgentHost(ed))));
  return p;
}

/**
 * Draws the agents and ends following on the owner's own moves: a click or wheel on the canvas, a key (Esc always; not
 * typing in a field), a camera or page change it didn't make. Returns the stop.
 */
export function startAgentPresence(ed: EditorController): () => void {
  started.get(ed)?.();
  const p = agentPresenceOf(ed);
  p.start();
  const offs: (() => void)[] = [];
  offs.push(ed.engine.on("CAMERA_CHANGED", () => p.cameraChanged()));
  offs.push(ed.engine.on("CURRENT_PAGE_CHANGED", () => p.pageChanged()));
  const onCanvas = (e: Event) => p.state.following !== null && !!ed.canvas && e.target === ed.canvas && p.stopFollowing();
  const onKey = (e: KeyboardEvent) => p.state.following !== null && keyStopsFollowing(e) && p.stopFollowing();
  window.addEventListener("pointerdown", onCanvas, true);
  window.addEventListener("wheel", onCanvas, { capture: true, passive: true });
  window.addEventListener("keydown", onKey, true);
  offs.push(() => {
    window.removeEventListener("pointerdown", onCanvas, true);
    window.removeEventListener("wheel", onCanvas, true);
    window.removeEventListener("keydown", onKey, true);
  });
  const stop = () => {
    for (const off of offs.splice(0)) off();
    p.stop();
    started.delete(ed);
  };
  started.set(ed, stop);
  return stop;
}
