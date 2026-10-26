/**
 * Links that work on the canvas while you design:
 * - A text's link (Create link ⇧⌘U, or a pasted URL / layer link): with the pointer on it, a chip under it names
 *   where it goes (the website, or the layer's outermost frame); a click on the chip follows it — a website in the
 *   browser, a layer of this file selected and in view, another file's in its tab.
 * - A canvas button (model/canvasButtons.ts, ours): a click runs it — its one link followed, or a menu of its links
 *   ("/home", "/search"…) when it has several; ⌘-click selects it (then it drags and styles as any frame). A selected
 *   button takes clicks as any layer does.
 * Only with the Move tool and no text being edited; the engine sees nothing of a button's click.
 */
import { useEffect, useRef } from "react";
import { t, useT } from "@/i18n";
import { ContextMenu, Icon, showToast } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { applyIntent } from "../multiplayer/links";
import { buttonAmong, buttonEntry, readButton } from "../model/canvasButtons";
import { fileKeyOf, followLink, hyperlinkTarget, placeName, urlLabel, type LinkTarget } from "../model/canvasLinks";
import styles from "./CanvasLinks.module.css";

type M = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
const ID: M = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const mul = (a: M, b: M): M => ({
  m00: a.m00 * b.m00 + a.m01 * b.m10,
  m01: a.m00 * b.m01 + a.m01 * b.m11,
  m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
  m10: a.m10 * b.m00 + a.m11 * b.m10,
  m11: a.m10 * b.m01 + a.m11 * b.m11,
  m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
});

/** A layer's transform on its page. */
function pageTransform(ed: EditorController, id: Guid): M {
  let m = ID;
  let cur: Guid | undefined = id;
  for (let guard = 0; cur && guard < 256; guard++) {
    const n = ed.engine.readNode(cur, { fields: ["transform", "parentIndex", "type"] }) as { transform?: M; parentIndex?: { guid: Guid }; type?: string } | null;
    if (!n || n.type === "CANVAS" || n.type === "DOCUMENT") break;
    m = mul(n.transform ?? ID, m);
    cur = n.parentIndex?.guid;
  }
  return m;
}

/** The link under page point `p` in one of these layers (innermost first): its target and its box on the page. */
function linkUnder(ed: EditorController, hits: readonly Guid[], p: { x: number; y: number }): { target: LinkTarget; box: { x: number; y: number; w: number; h: number }; m: M } | null {
  const here = fileKeyOf(ed);
  for (const id of hits) {
    const n = ed.engine.readNode(id, { fields: ["type"] });
    if (n?.type !== "TEXT") continue;
    const boxes = ed.engine.textLayout(id)?.hyperlinkBoxes;
    if (!boxes?.length) continue;
    const m = pageTransform(ed, id);
    const det = m.m00 * m.m11 - m.m01 * m.m10;
    if (!det) continue;
    const dx = p.x - m.m02, dy = p.y - m.m12;
    const lx = (m.m11 * dx - m.m01 * dy) / det, ly = (-m.m10 * dx + m.m00 * dy) / det;
    for (const b of boxes) {
      const r = b.bounds;
      if (lx < r.x || lx > r.x + r.w || ly < r.y || ly > r.y + r.h) continue;
      const target = hyperlinkTarget({ url: b.url, guid: b.guid }, here);
      if (target) return { target, box: r, m };
    }
  }
  return null;
}

const targetLabel = (ed: EditorController, target: LinkTarget): string =>
  target.kind === "url" ? urlLabel(target.url) : (!target.fileKey ? placeName(ed, target.nodeId) : null) ?? target.nodeId;

/** Lands on a layer of this file: its page, selected, in view. */
const land = (ed: EditorController) => (nodeId: Guid) => applyIntent(ed, { nodeId });

/** Runs a canvas button: its link followed, or its links as a menu at (x, y) (viewport px). */
export function runButton(ed: EditorController, button: Guid, x: number, y: number): void {
  const links = readButton(ed, button)?.links ?? [];
  const usable = links.map((l) => buttonEntry(ed, l)).filter((e) => e.target);
  if (!usable.length) {
    showToast({ message: t("This button has no links yet: ⌘-click it, then add them in the Design panel") });
    return;
  }
  if (usable.length === 1) return followLink(ed, usable[0].target!, land(ed));
  ed.ui.set({ buttonMenu: { x, y, button } });
}

/** The canvas's pointer for links and buttons (CanvasLinks draws what it finds). */
export function attachCanvasLinks(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  let frame = 0;
  let last: { x: number; y: number } | null = null;
  let pressed: { button: Guid; id: number; x: number; y: number } | null = null;
  let overButton = false;
  let engineCursor = canvas.style.cursor;
  const active = () => !ed.engine.destroyed && ed.store.tool === "MOVE" && !ed.engine.textEdit && ed.ui.get().mode !== "dev";
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const selected = (id: Guid) => ed.selection.includes(id);

  const setCursor = (on: boolean) => {
    if (on === overButton) return;
    overButton = on;
    canvas.style.cursor = on ? "pointer" : engineCursor;
  };
  const offCursor = ed.engine.onCursor(() => {
    // The engine's own cursor, put back when the pointer leaves a button.
    engineCursor = canvas.style.cursor;
    if (overButton) canvas.style.cursor = "pointer";
  });

  const look = () => {
    frame = 0;
    if (!last || !active()) {
      setCursor(false);
      return;
    }
    const hits = ed.engine.hitTest(last.x, last.y);
    const button = buttonAmong(ed, hits);
    setCursor(!!button && !selected(button));
    const ui = ed.ui.get();
    if (button) {
      if (ui.canvasLink) ed.ui.set({ canvasLink: null });
      return;
    }
    const found = linkUnder(ed, hits, ed.engine.screenToWorld(last.x, last.y));
    if (!found) return; // the chip hides itself when the pointer leaves the link and the chip
    const cam = ed.engine.getCamera();
    const r = canvas.getBoundingClientRect();
    const { m, box } = found;
    const corners = [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x, box.y + box.h],
      [box.x + box.w, box.y + box.h],
    ].map(([x, y]) => ({ x: r.left + cam.x + (m.m00 * x + m.m01 * y + m.m02) * cam.zoom, y: r.top + cam.y + (m.m10 * x + m.m11 * y + m.m12) * cam.zoom }));
    const left = Math.min(...corners.map((c) => c.x)), top = Math.min(...corners.map((c) => c.y));
    const rect = { x: left, y: top, width: Math.max(...corners.map((c) => c.x)) - left, height: Math.max(...corners.map((c) => c.y)) - top };
    const label = targetLabel(ed, found.target);
    const cur = ui.canvasLink;
    if (cur && cur.label === label && Math.abs(cur.x - rect.x) < 1 && Math.abs(cur.y - rect.y) < 1) return;
    ed.ui.set({ canvasLink: { target: found.target, label, ...rect } });
  };

  const onMove = (e: PointerEvent) => {
    if (e.target !== canvas || e.buttons) return;
    last = local(e);
    if (!frame) frame = requestAnimationFrame(look);
  };
  const onLeave = () => {
    last = null;
    setCursor(false);
  };

  // A press on a button that isn't selected: taken before the engine sees it (capture, on the window).
  const onDown = (e: PointerEvent) => {
    if (e.target !== canvas || e.button !== 0 || !active() || e.shiftKey || e.altKey || e.ctrlKey) return;
    const at = local(e);
    const button = buttonAmong(ed, ed.engine.hitTest(at.x, at.y));
    if (!button || selected(button)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.metaKey) {
      // ⌘-click: the button itself, not the layer deepest in it (a ⌘-click's usual pick).
      ed.engine.setSelection([button]);
      canvas.focus({ preventScroll: true });
      setCursor(false);
      return;
    }
    pressed = { button, id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (!pressed || e.pointerId !== pressed.id) return;
    const p = pressed;
    pressed = null;
    e.stopPropagation();
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return;
    runButton(ed, p.button, e.clientX, e.clientY);
  };

  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    offCursor();
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointerup", onUp, true);
  };
}

/** The link chip and a button's menu. */
export function CanvasLinks() {
  useT();
  const ed = useEditor();
  const link = useUI((s) => s.canvasLink ?? null);
  const menu = useUI((s) => s.buttonMenu ?? null);
  const chip = useRef<HTMLButtonElement>(null);

  // The chip stays while the pointer is on the link or on the chip, and goes a moment after it leaves both.
  useEffect(() => {
    if (!link) return;
    let timer = 0;
    const onMove = (e: PointerEvent) => {
      const pad = 6;
      const inLink = e.clientX >= link.x - pad && e.clientX <= link.x + link.width + pad && e.clientY >= link.y - pad && e.clientY <= link.y + link.height + pad;
      const c = chip.current?.getBoundingClientRect();
      const inChip = !!c && e.clientX >= c.left - pad && e.clientX <= c.right + pad && e.clientY >= c.top - pad && e.clientY <= c.bottom + pad;
      const between = !!c && e.clientX >= Math.min(link.x, c.left) && e.clientX <= Math.max(link.x + link.width, c.right) && e.clientY >= link.y && e.clientY <= c.bottom;
      window.clearTimeout(timer);
      if (!inLink && !inChip && !between) timer = window.setTimeout(() => ed.ui.set({ canvasLink: null }), 250);
    };
    const hide = () => ed.ui.set({ canvasLink: null });
    const offCam = ed.engine.on("CAMERA_CHANGED", hide);
    const offEdit = ed.engine.on("TEXT_EDIT", hide);
    window.addEventListener("pointermove", onMove, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onMove, true);
      offCam();
      offEdit();
    };
  }, [ed, link]);

  const entries = menu ? (readButton(ed, menu.button)?.links ?? []).map((l, i) => ({ ...buttonEntry(ed, l), i })).filter((e) => e.target) : [];
  return (
    <>
      {link && (
        <button
          ref={chip}
          type="button"
          className={styles.chip}
          style={{ left: link.x, top: link.y + link.height + 4 }}
          title={link.target.kind === "url" ? link.target.url : link.label}
          onClick={() => {
            ed.ui.set({ canvasLink: null });
            followLink(ed, link.target, land(ed));
          }}
          data-canvas-link=""
        >
          <Icon name={link.target.kind === "url" ? "24.external" : "24.link"} />
          <span className={styles.label}>{link.label}</span>
        </button>
      )}
      {menu && entries.length > 0 && (
        <ContextMenu
          at={{ x: menu.x + 4, y: menu.y }}
          flipX={menu.x - 4}
          entries={entries.map((e) => ({ id: `link:${e.i}`, label: e.label }))}
          label={t("Links")}
          context
          onSelect={(id) => {
            const e = entries.find((x) => `link:${x.i}` === id);
            ed.ui.set({ buttonMenu: null });
            if (e?.target) followLink(ed, e.target, land(ed));
          }}
          onClose={() => ed.ui.set({ buttonMenu: null })}
        />
      )}
    </>
  );
}
