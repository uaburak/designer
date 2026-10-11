/**
 * Comments on the canvas (live: docs/research/figma/live/multiplayer/comments.md "Pins on the canvas", "The Comment
 * tool"): DOM over the canvas following the camera, as Figma's own pins are. A pin is 32 × 32 with its point at the
 * bottom-left corner on the thread's place (on its layer, so it moves with it), the author's avatar inside; hovered it
 * grows into a preview card; clicked it opens the thread; dragged it moves (the author or an editor). The Comment tool's
 * click puts down a new-comment pin with the composer 48 to its right. Pins show while View › Comments is on (⇧C).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, Portal, timeAgo } from "@/ds";
import { useCamera, useCurrentPage, useTool } from "@/engine/hooks";
import type { Camera } from "@/engine/codec";
import type { CommentAnchor, CommentThread } from "@shared/comments";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { commentsOf, useComments, type CommentsController } from "./commentsController";
import { Composer } from "./Composer";
import { canResolve, MessageText, ThreadCard } from "./Thread";
import styles from "./Comments.module.css";

const PIN = 32;
/** Live: the composer's left edge 48 right of the pin's, its top 4 above the pin's */
const CARD_DX = 48;
const CARD_DY = -4;
const DRAG_PX = 3;

export function CommentsLayer() {
  const ed = useEditor();
  const c = commentsOf(ed);
  useEffect(() => {
    if (!c) return;
    c.start();
    return () => c.stop();
  }, [c]);
  if (!c) return null;
  return <Pins c={c} />;
}

function Pins({ c }: { c: CommentsController }) {
  const ed = useEditor();
  const v = useComments(ed);
  const cam = useCamera(ed.store);
  const page = useCurrentPage(ed.store);
  const tool = useTool(ed.store);
  const shown = useUI((s) => s.comments !== false);
  // Pins on layers follow them: any change to the page re-places them.
  const [, bump] = useState(0);
  useEffect(() => ed.engine.onAny((e) => (e.type === "DOCUMENT_CHANGED" || e.type === "NODES_CHANGED") && bump((n) => n + 1)), [ed]);

  // The Comment tool: a click on the canvas (not a drag, not a pan) starts a new comment there; a second click while
  // the composer is empty closes it.
  const commenting = tool === "COMMENT";
  useEffect(() => {
    const canvas = ed.canvas;
    if (!commenting || !canvas) return;
    let down: { x: number; y: number; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 && !e.altKey && !e.metaKey && !e.ctrlKey ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX) return;
      if ((c.view.draft || c.view.open) && !c.draftText.trim()) {
        c.cancelDraft();
        c.openThread(null);
        return;
      }
      if (c.draftText.trim()) return;
      const r = canvas.getBoundingClientRect();
      c.startDraft(e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
  }, [ed, c, commenting]);
  // Leaving the Comment tool drops an empty draft.
  useEffect(() => {
    if (!commenting && !c.draftText.trim()) c.cancelDraft();
  }, [c, commenting]);

  const data = v.data;
  const threads = (data?.threads ?? []).filter((t) => t.anchor.pageId === page && (!t.resolvedAt || v.showResolved || v.open === t.id));
  const at = (a: CommentAnchor) => toCanvas(cam, c.pagePoint(a));
  const draftAt = v.draft && v.draft.pageId === page ? at(v.draft) : null;
  const open = data?.threads.find((t) => t.id === v.open) ?? null;
  const openAt = open && open.anchor.pageId === page ? at(open.anchor) : null;
  const canvasRect = ed.canvas?.getBoundingClientRect() ?? new DOMRect();

  return (
    <>
      <div className={styles.pins} data-comment-pins="">
        {(shown || commenting) &&
          threads.map((t) => {
            const p = at(t.anchor);
            return <Pin key={t.id} c={c} thread={t} x={p.x} y={p.y} open={t.id === v.open} movable={!!data && canResolve(data, t)} people={v.people} />;
          })}
        {draftAt && <div className={styles.draftPin} style={{ left: draftAt.x, top: draftAt.y - PIN }} aria-hidden />}
      </div>
      {draftAt && data && (
        <Portal>
          <Card left={canvasRect.left + draftAt.x + CARD_DX} top={canvasRect.top + draftAt.y - PIN + CARD_DY} width={296}>
            {(style) => (
              <div className={styles.newComment} style={style} onPointerDown={(e) => e.stopPropagation()} data-comment-composer="">
                <Composer
                  placeholder="Add a comment"
                  people={v.people}
                  me={data.me.id}
                  autoFocus
                  onChange={(t) => (c.draftText = t)}
                  onSubmit={async (text) => {
                    const ok = await c.post(text);
                    if (ok) c.draftText = "";
                    return ok;
                  }}
                  onCancel={() => {
                    c.draftText = "";
                    c.cancelDraft();
                  }}
                />
              </div>
            )}
          </Card>
        </Portal>
      )}
      {open && openAt && data && (
        <Portal>
          <Card left={canvasRect.left + openAt.x + CARD_DX} top={canvasRect.top + openAt.y - PIN + CARD_DY} width={360}>
            {(style) => <ThreadCard c={c} data={data} thread={open} people={v.people} style={style} />}
          </Card>
        </Portal>
      )}
    </>
  );
}

const toCanvas = (cam: Camera, p: { x: number; y: number }) => ({ x: cam.x + p.x * cam.zoom, y: cam.y + p.y * cam.zoom });

/** A card at (left, top) in the window, moved in to stay inside it once its height is known */
function Card({ left, top, width, children }: { left: number; top: number; width: number; children: (style: React.CSSProperties) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    setHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  const x = Math.max(8, Math.min(left, innerWidth - width - 8));
  const y = Math.max(8, Math.min(top, innerHeight - height - 8));
  return <div ref={ref} style={{ display: "contents" }}>{children({ left: x, top: y, width })}</div>;
}

function Pin({ c, thread, x, y, open, movable, people }: { c: CommentsController; thread: CommentThread; x: number; y: number; open: boolean; movable: boolean; people: { id: string; name: string; email: string }[] }) {
  const ed = useEditor();
  const [hover, setHover] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const first = thread.comments[0];
  const replies = thread.comments.length - 1;
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) <= DRAG_PX) return;
      if (!movable) return;
      moved = true;
      setHover(false);
      setDrag({ dx, dy });
    };
    const up = (u: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDrag(null);
      if (u.type === "pointercancel") return;
      if (moved) void c.move(thread.id, x + (u.clientX - start.x), y + (u.clientY - start.y));
      else c.openThread(open ? null : thread.id);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const left = x + (drag?.dx ?? 0);
  const top = y - PIN + (drag?.dy ?? 0);
  return (
    <button
      type="button"
      className={styles.pin}
      style={{ left, top }}
      data-thread={thread.id}
      data-open={open || undefined}
      data-unread={thread.unread || undefined}
      data-resolved={thread.resolvedAt ? "" : undefined}
      data-hover={(hover && !open && !drag) || undefined}
      aria-label={`Comment by ${first?.user.name ?? ""}: ${first?.message ?? ""}`}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={onPointerDown}
      onWheel={(e) => ed.canvas?.dispatchEvent(new WheelEvent("wheel", e.nativeEvent))}
    >
      {hover && !open && !drag && first ? (
        <span className={styles.preview}>
          <Avatar name={first.user.name} src={first.user.picture ?? undefined} size={24} />
          <span className={styles.previewMain}>
            <span className={styles.previewHead}>
              <span className={styles.previewName}>{first.user.name}</span>
              <span className={styles.previewTime}>{timeAgo(first.createdAt)}</span>
            </span>
            <span className={styles.previewText}>
              <MessageText text={first.message} people={people} mentions={first.mentions} />
            </span>
            {replies > 0 && <span className={styles.previewReplies}>{replies === 1 ? "1 reply" : `${replies} replies`}</span>}
          </span>
        </span>
      ) : (
        <span className={styles.pinAvatar}>
          <Avatar name={first?.user.name ?? "?"} src={first?.user.picture ?? undefined} size={24} />
        </span>
      )}
    </button>
  );
}
