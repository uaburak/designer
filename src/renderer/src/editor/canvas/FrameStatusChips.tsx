/**
 * Frame status chips on the canvas (ours: editor/frameStatus.ts, docs/editor.md "Frame status (ours)"): DOM over the
 * canvas following the camera, as the comment pins are — a chip right-aligned on each statused frame's top edge, in
 * Design and Dev Mode; a selected frame without one shows a "Set status" chip for editors. Clicked, the status menu
 * (ds ContextMenu): the owner's statuses with a check on the current one, then "No status". Hidden for frames too
 * small on screen (as Ready for dev's label is); viewers see the chips but can't open the menu.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ContextMenu, MenuButton, type MenuEntry } from "@/ds";
import { useCurrentPage } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { usePresence } from "../multiplayer/presence";
import { FRAME_STATUS_COLOR, FRAME_STATUSES, frameStatusLabel, frameStatusOf, frameStatusTargets, setFrameStatus, statusedFrames, type FrameStatus } from "../frameStatus";
import styles from "./FrameStatus.module.css";

/** Frames narrower than this on screen get no chip. */
const MIN_SCREEN_WIDTH = 80;
/** The chip's gap above the frame's top edge. */
const GAP = 4;
/** A selected design's `</>` (Dev Mode's Ready for dev toggle, drawn by the engine) sits at its top right: room for it. */
const DEV_ICON_ROOM = 28;

export const NO_STATUS = "none";

/** The status menu's rows: the statuses (the current one checked), then "No status". */
export function frameStatusMenu(current: FrameStatus | null): MenuEntry[] {
  return [...FRAME_STATUSES.map((s) => ({ id: s.id, label: s.label, swatch: FRAME_STATUS_COLOR[s.id], checked: s.id === current })), "-", { id: NO_STATUS, label: "No status", checked: current === null }];
}

/** A status's dot and label. */
function Face({ status, text }: { status: FrameStatus | null; text: string }) {
  return (
    <>
      <span className={styles.dot} style={status ? { background: FRAME_STATUS_COLOR[status] } : undefined} aria-hidden />
      {text}
    </>
  );
}

export function pickFrameStatus(ed: EditorController, ids: readonly Guid[], id: string): void {
  setFrameStatus(ed, ids, id === NO_STATUS ? null : (id as FrameStatus));
}

export function FrameStatusChips() {
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const presence = usePresence(ed);
  const viewer = presence.shared && presence.role === "viewer";
  const [version, bump] = useState(0);
  useEffect(() => {
    const offs = [
      ed.engine.onAny((e) => (e.type === "DOCUMENT_CHANGED" || e.type === "NODES_CHANGED") && bump((n) => n + 1)),
      ed.store.subscribe("selection", () => bump((n) => n + 1)),
    ];
    return () => offs.forEach((off) => off());
  }, [ed]);
  const [menu, setMenu] = useState<{ id: Guid; x: number; y: number } | null>(null);
  const selection = ed.selection;
  const selectable = viewer ? [] : frameStatusTargets(ed);
  const frames = statusedFrames(ed, selectable.length === 1 ? selectable : []);
  void version;
  void page;
  const layer = useRef<HTMLDivElement>(null);
  const selected = new Set(selection);

  useLayoutEffect(() => {
    const place = () => {
      const el = layer.current;
      if (!el) return;
      const c = ed.store.camera;
      const z = c.zoom;
      for (const node of Array.from(el.children) as HTMLElement[]) {
        const f = frames.find((x) => x.id === node.dataset.frameId);
        if (!f) continue;
        node.hidden = f.width * z < MIN_SCREEN_WIDTH;
        const right = c.x + (f.x + f.width) * z - (node.dataset.selected !== undefined ? DEV_ICON_ROOM : 0);
        const top = c.y + f.y * z;
        node.style.transform = `translate(${right}px, ${top - GAP}px) translate(-100%, -100%)`;
      }
    };
    place();
    const offs = [ed.store.subscribe("camera", place), ed.store.subscribe("page", place)];
    return () => offs.forEach((off) => off());
  }, [ed, frames]);

  const current = menu ? frameStatusOf(ed, menu.id) : null;
  return (
    <>
      <div ref={layer} className={styles.layer} data-frame-status-chips="">
        {frames.map((f) => (
          <button
            key={f.id}
            type="button"
            className={styles.chip}
            data-frame-id={f.id}
            data-frame-status={f.status ?? NO_STATUS}
            data-selected={selected.has(f.id) ? "" : undefined}
            data-readonly={viewer ? "" : undefined}
            aria-label={f.status ? `Status: ${frameStatusLabel(f.status)}` : "Set status"}
            aria-haspopup="menu"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              if (viewer) return;
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ id: f.id, x: r.left, y: r.bottom + GAP });
            }}
          >
            <Face status={f.status} text={f.status ? frameStatusLabel(f.status) : "Set status"} />
          </button>
        ))}
      </div>
      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          entries={frameStatusMenu(current)}
          label="Status"
          onClose={() => setMenu(null)}
          onSelect={(id) => {
            const target = menu.id;
            setMenu(null);
            pickFrameStatus(ed, [target], id);
          }}
        />
      )}
    </>
  );
}

/** The Design panel header's status button (a frame, section or group's header): the chip, its menu under it. */
export function FrameStatusButton() {
  const ed = useEditor();
  const p = usePresence(ed);
  const viewer = p.shared && p.role === "viewer";
  const targets = frameStatusTargets(ed);
  if (!targets.length) return null;
  const list = targets.map((id) => frameStatusOf(ed, id));
  const status = list.every((s) => s === list[0]) ? list[0] : null;
  const mixed = !list.every((s) => s === list[0]);
  const text = mixed ? "Mixed" : status ? frameStatusLabel(status) : "Status";
  const chip = (
    <span className={styles.face} data-frame-status={mixed || !status ? NO_STATUS : status}>
      <Face status={mixed ? null : status} text={text} />
    </span>
  );
  if (viewer) return chip;
  return (
    <MenuButton label="Status" entries={() => frameStatusMenu(mixed ? null : status)} className={styles.headerButton} onSelect={(id) => pickFrameStatus(ed, targets, id)}>
      {chip}
    </MenuButton>
  );
}
