/**
 * Comments on the canvas (live: docs/research/figma/live/multiplayer/comments.md "Pins on the canvas", "The Comment
 * tool"; values: docs/research/atlas/16-comments-versions.md §2.3): DOM over the canvas following the camera, as Figma's
 * own pins are. A pin is 32 high with its point at the bottom-left corner on the thread's place (on its layer, so it
 * moves with it), the faces of the people in the thread inside (32 wide for one, 55 for two, 78 for three or "+N");
 * hovered it grows into a preview card; clicked it opens the thread; dragged past 5 px it moves (the author or an
 * editor; left button, no modifier keys; dropped at least 20 px in from the canvas's right and top). Pins that would
 * overlap at this zoom merge into one cluster pin, whose click zooms in on them. With the Comment tool, Tab / Shift+Tab
 * walk the pins and the arrow keys nudge the focused one. A thread someone else just posted grows in and shows its
 * preview for a moment. The Comment tool's click puts down a new-comment pin with the composer 48 to its right. Pins
 * show while View › Comments is on (⇧C).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, Portal, timeAgo } from "@/ds";
import { t, tp, useT } from "@/i18n";
import { useCamera, useCurrentPage, useTool } from "@/engine/hooks";
import type { Camera } from "@/engine/codec";
import type { CommentAnchor, CommentThread, CommentUser } from "@shared/comments";
import { loadNudge } from "../canvasTools";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { commentsOf, useComments, type CommentsController } from "./commentsController";
import {
  ANIMATE_NEW_DELAY_MS,
  CLUSTER,
  clusterClickZoom,
  clusterPeople,
  clusterPins,
  DRAG_INSET,
  MIN_DRAG,
  PIN_HEIGHT,
  pinAvatars,
  pinTabOrder,
  pinWidth,
  threadPeople,
  type PinCluster,
} from "./clusters";
import { AttachmentThumb } from "./attachments";
import { Composer } from "./Composer";
import { canResolve, MessageText, ThreadCard } from "./Thread";
import styles from "./Comments.module.css";

const PIN = PIN_HEIGHT;
/** Live: the composer's left edge 48 right of the pin's, its top 4 above the pin's */
const CARD_DX = 48;
const CARD_DY = -4;

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
  useT();
  const ed = useEditor();
  const v = useComments(ed);
  const cam = useCamera(ed.store);
  const page = useCurrentPage(ed.store);
  const tool = useTool(ed.store);
  const shown = useUI((s) => s.comments !== false);
  const layer = useRef<HTMLDivElement>(null);
  // Pins on layers follow them: any change to the page re-places them.
  const [, bump] = useState(0);
  useEffect(() => ed.engine.onAny((e) => (e.type === "DOCUMENT_CHANGED" || e.type === "NODES_CHANGED") && bump((n) => n + 1)), [ed]);
  // Clusters are rebuilt once the zoom has held still for 50 ms (`rebuildClustersZoomDelay`).
  const [clusterZoom, setClusterZoom] = useState(cam.zoom);
  useEffect(() => {
    if (clusterZoom === cam.zoom) return;
    const timer = setTimeout(() => setClusterZoom(cam.zoom), CLUSTER.rebuildDelayMs);
    return () => clearTimeout(timer);
  }, [cam.zoom, clusterZoom]);
  // Threads others post while the file is open grow in and show their preview for a moment (`ANIMATE_NEW_*`).
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const data = v.data;
    if (!data) return;
    const ids = data.threads.map((th) => th.id);
    if (!seen.current) {
      seen.current = new Set(ids);
      return;
    }
    const known = seen.current;
    const added = data.threads.filter((th) => !known.has(th.id) && th.comments[0]?.user.id !== data.me.id).map((th) => th.id);
    for (const id of ids) known.add(id);
    if (!added.length) return;
    setFresh((f) => new Set([...f, ...added]));
    const timer = setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), ANIMATE_NEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [v.data]);

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
      if (!d || d.id !== e.pointerId || Math.max(Math.abs(e.clientX - d.x), Math.abs(e.clientY - d.y)) >= MIN_DRAG) return;
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
  // Pin focus (atlas 16 §2.9): with the Comment tool, Tab / Shift+Tab from the canvas or a pin go to the next / previous
  // pin — a nearest-neighbour walk from the top-left one; past either end focus goes back to the canvas.
  useEffect(() => {
    if (!commenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = layer.current;
      const active = document.activeElement as HTMLElement | null;
      const onPin = !!active && !!el?.contains(active);
      if (!el || (!onPin && active !== ed.canvas)) return;
      const pins = pinTabOrder([...el.querySelectorAll<HTMLElement>("[data-comment-pin]")].map((node) => ({ node, x: node.offsetLeft, y: node.offsetTop + node.offsetHeight })));
      if (!pins.length) return;
      e.preventDefault();
      e.stopPropagation();
      const at = onPin ? pins.findIndex((p) => p.node === active) : -1;
      const next = at < 0 ? (e.shiftKey ? pins.length - 1 : 0) : at + (e.shiftKey ? -1 : 1);
      if (next < 0 || next >= pins.length) ed.focusCanvas();
      else pins[next].node.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ed, commenting]);

  const data = v.data;
  const threads = (data?.threads ?? []).filter((th) => th.anchor.pageId === page && (!th.resolvedAt || v.showResolved || v.open === th.id));
  const at = (a: CommentAnchor) => toCanvas(cam, c.pagePoint(a));
  const draftAt = v.draft && v.draft.pageId === page ? at(v.draft) : null;
  const open = data?.threads.find((th) => th.id === v.open) ?? null;
  const openAt = open && open.anchor.pageId === page ? at(open.anchor) : null;
  const canvasRect = ed.canvas?.getBoundingClientRect() ?? new DOMRect();
  const bounds = { width: canvasRect.width, height: canvasRect.height };
  // Merged at the zoom the clusters were last built for (page points × that zoom), drawn where the camera puts them now.
  const clusters = clusterPins(
    threads.map((thread) => {
      const p = c.pagePoint(thread.anchor);
      return { thread, x: p.x * clusterZoom, y: p.y * clusterZoom };
    }),
    clusterZoom,
    v.open,
  );

  return (
    <>
      <div ref={layer} className={styles.pins} data-comment-pins="">
        {(shown || commenting) &&
          clusters.map((cl) => {
            const p = toCanvas(cam, { x: cl.x / clusterZoom, y: cl.y / clusterZoom });
            if (cl.threads.length > 1) return <ClusterPin key={cl.id} cluster={cl} x={p.x} y={p.y} zoom={clusterZoom} bounds={bounds} />;
            const th = cl.threads[0];
            return <Pin key={th.id} c={c} thread={th} x={p.x} y={p.y} open={th.id === v.open} fresh={fresh.has(th.id)} movable={!!data && canResolve(data, th)} people={v.people} bounds={bounds} />;
          })}
        {draftAt && <div className={styles.draftPin} style={{ left: draftAt.x, top: draftAt.y - PIN }} aria-hidden />}
      </div>
      {draftAt && data && (
        <Portal>
          <Card left={canvasRect.left + draftAt.x + CARD_DX} top={canvasRect.top + draftAt.y - PIN + CARD_DY} width={296}>
            {(style) => (
              <div className={styles.newComment} style={style} onPointerDown={(e) => e.stopPropagation()} data-comment-composer="">
                <Composer
                  placeholder={t("Add a comment")}
                  people={v.people}
                  me={data.me.id}
                  autoFocus
                  images={c.attachments()}
                  rich={c.rich()}
                  onChange={(text) => (c.draftText = text)}
                  onSubmit={async (text, files, meta, mentions) => {
                    const ok = await c.post(text, files, meta, mentions);
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


/** The faces in a pin: up to three 24 px avatars 23 apart, or two and "+N" */
function PinFaces({ people }: { people: CommentUser[] }) {
  const { shown, more } = pinAvatars(people);
  return (
    <>
      {shown.map((u, i) => (
        <span key={u.id} className={styles.pinAvatar} style={{ left: 4 + 23 * i }}>
          <Avatar name={u.name} src={u.picture ?? undefined} size={24} />
        </span>
      ))}
      {more > 0 && (
        <span className={styles.pinMore} style={{ left: 4 + 23 * shown.length }}>
          +{more}
        </span>
      )}
    </>
  );
}

function Pin({
  c,
  thread,
  x,
  y,
  open,
  fresh,
  movable,
  people,
  bounds,
}: {
  c: CommentsController;
  thread: CommentThread;
  x: number;
  y: number;
  open: boolean;
  fresh: boolean;
  movable: boolean;
  people: { id: string; name: string; email: string }[];
  bounds: { width: number; height: number };
}) {
  useT();
  const ed = useEditor();
  const [hover, setHover] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const first = thread.comments[0];
  const replies = thread.comments.length - 1;
  const files = thread.comments.reduce((n, x) => n + (x.attachments?.length ?? 0), 0);
  const faces = threadPeople(thread);
  // A drop stays inside the canvas, 20 px in from its right and top edges (Figma's drag clamp).
  const clampDrop = (px: number, py: number) => ({ x: Math.min(Math.max(px, 0), bounds.width - DRAG_INSET), y: Math.min(Math.max(py, DRAG_INSET), bounds.height) });
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Only a plain left press drags (Figma: no Ctrl, Alt, Shift or ⌘); a click opens the thread either way.
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      if (!moved && Math.max(Math.abs(dx), Math.abs(dy)) < MIN_DRAG) return;
      if (!movable || !plain) return;
      moved = true;
      setHover(false);
      const to = clampDrop(x + dx, y + dy);
      setDrag({ dx: to.x - x, dy: to.y - y });
    };
    const up = (u: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDrag(null);
      if (u.type === "pointercancel") return;
      if (moved) {
        const to = clampDrop(x + (u.clientX - start.x), y + (u.clientY - start.y));
        void c.move(thread.id, to.x, to.y);
      } else c.openThread(open ? null : thread.id);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  // A focused pin's arrows nudge it by the editor's nudge (⇧: the big one), in the file's units; Esc goes back to the canvas.
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      ed.focusCanvas();
      return;
    }
    const dir = ARROWS[e.key];
    if (!dir || !movable || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const nudge = loadNudge();
    const step = (e.shiftKey ? nudge.big : nudge.small) * ed.engine.getCamera().zoom;
    void c.move(thread.id, x + dir[0] * step, y + dir[1] * step);
  };
  const preview = (hover || fresh) && !open && !drag ? first : undefined;
  const left = x + (drag?.dx ?? 0);
  const top = y - PIN + (drag?.dy ?? 0);
  return (
    <button
      type="button"
      className={styles.pin}
      style={{ left, top, width: pinWidth(faces.length) }}
      data-comment-pin=""
      data-thread={thread.id}
      data-open={open || undefined}
      data-unread={thread.unread || undefined}
      data-resolved={thread.resolvedAt ? "" : undefined}
      data-fresh={fresh || undefined}
      data-hover={!!preview || undefined}
      aria-label={t("Comment by {name}: {message}", { name: first?.user.name ?? "", message: first?.message ?? "" })}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onWheel={(e) => ed.canvas?.dispatchEvent(new WheelEvent("wheel", e.nativeEvent))}
    >
      {preview ? (
        <span className={styles.preview}>
          <Avatar name={preview.user.name} src={preview.user.picture ?? undefined} size={24} />
          <span className={styles.previewMain}>
            <span className={styles.previewHead}>
              <span className={styles.previewName}>{preview.user.name}</span>
              <span className={styles.previewTime}>{timeAgo(preview.createdAt)}</span>
            </span>
            <span className={styles.previewText}>
              <MessageText text={preview.message} people={people} mentions={preview.mentions} meta={preview.messageMeta} />
            </span>
            {preview.attachments?.[0] && <AttachmentThumb images={c.attachments() ?? ed.source.images} a={preview.attachments[0]} size={48} />}
            {(replies > 0 || files > 0) && (
              <span className={styles.previewReplies}>{[replies > 0 ? tp(replies, "{n} reply", "{n} replies") : "", files > 0 ? tp(files, "{n} attachment", "{n} attachments") : ""].filter(Boolean).join(" · ")}</span>
            )}
          </span>
        </span>
      ) : (
        <PinFaces people={faces} />
      )}
    </button>
  );
}

const ARROWS: Record<string, [number, number] | undefined> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Several threads' pins merged at this zoom: their authors' faces; a click zooms in on them (atlas 16 §2.3) */
function ClusterPin({ cluster, x, y, zoom, bounds }: { cluster: PinCluster; x: number; y: number; zoom: number; bounds: { width: number; height: number } }) {
  useT();
  const ed = useEditor();
  const people = clusterPeople(cluster.threads);
  const unread = cluster.threads.some((th) => th.unread);
  const zoomIn = () => {
    // The members' spread around the cluster's point, in page units (the points were placed at `zoom`).
    const spread = Math.max(0, ...cluster.points.map((p) => Math.hypot(p.x - cluster.x, p.y - cluster.y) / zoom));
    ed.engine.centerOn(cluster.x / zoom, cluster.y / zoom, clusterClickZoom(spread, ed.engine.getCamera().zoom, bounds));
  };
  return (
    <button
      type="button"
      className={styles.pin}
      style={{ left: x, top: y - PIN, width: pinWidth(people.length) }}
      data-comment-pin=""
      data-cluster={cluster.threads.length}
      data-unread={unread || undefined}
      aria-label={tp(cluster.threads.length, "{n} comment", "{n} comments")}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={zoomIn}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          ed.focusCanvas();
        }
      }}
      onWheel={(e) => ed.canvas?.dispatchEvent(new WheelEvent("wheel", e.nativeEvent))}
    >
      <PinFaces people={people.map((p) => p.user)} />
    </button>
  );
}
