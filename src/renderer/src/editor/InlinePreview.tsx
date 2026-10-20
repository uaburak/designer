/**
 * The inline preview (⇧Space, "Preview" in the Present menu, a flow's preview button): Figma's floating window over the
 * canvas and the panels, playing the prototype on an engine of its own fed by the editor's document — "any design
 * changes are immediately reflected in the preview". Measured live on 2026-10-20 and read from Figma's bundle
 * (docs/research/figma/live/2026-10-20/prototype-preview.txt); the geometry is inlinePreviewLayout.ts.
 *
 * - It opens on the selection's top-level frame, else the page's first flow, else its first frame, 16 in from the
 *   visible canvas's top-left, at the frame's size (a website frame at 16:9; the page's device: its screen) scaled
 *   down into half the canvas's width and its height.
 * - The header (40 and a line): Previous frame, Next frame, Restart prototype at the left; Preview options, Open in
 *   presentation view, Close at the right — no title. A narrow window keeps fewer of them. A press on the header's
 *   empty part drags the window, its header kept on screen.
 * - Focused (a click in it, or when it opens), it is lifted (the draggable modal's shadow) and its four edges and
 *   corners resize it (⇧ keeps the proportions); unfocused, a lower shadow and no handles.
 * - Esc or ⇧Space in it closes it; R restarts "from the last selected frame on the canvas"; a frame selected on the
 *   canvas jumps the preview there. Closed and opened again, it keeps its place, its size and its options.
 * - Preview options: Fit width (the default), Fill screen, Responsive | Follow prototype (the canvas follows the
 *   preview's frame), Resize window to 100% (✓ at 100%), Reset aspect ratio (✓ at the frame's proportions). With a
 *   device: Responsive, Zoom device to fill screen, Fixed | Follow prototype, Resize device to 100%, Show device frame.
 */
import { t, useT } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, IconButton, MenuButton, cx, type MenuEntry } from "@/ds";
import type { Engine, PresentScale, PresentState } from "@/engine/Engine";
import type { Guid } from "@/engine/codec";
import { PresentationView, SCALE_ICON, presentHost } from "@/present/PresentationView";
import { viewRect } from "./canvas/viewInsets";
import { useEditor, type EditorController } from "./controller";
import { useUI } from "./hooks";
import {
  HEADER,
  actualViewerSize,
  aspectViewerSize,
  breakpointOf,
  headerButtons,
  initialBox,
  initialViewerSize,
  keepHeaderOnScreen,
  resizeBox,
  sameSize,
  type Box,
  type Edge,
  type Size,
} from "./inlinePreviewLayout";
import { editorPresentationSource, present, presentStart } from "./present";
import styles from "./InlinePreview.module.css";

/** What the preview keeps between its openings while the editor is open (Figma hides its window, keeping its state). */
interface Kept {
  box: Box;
  scale: PresentScale | null;
  follow: boolean;
}
const kept = new WeakMap<EditorController, Kept>();

const EDGES: Edge[] = ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"];
/** The header's own controls keep their press (the rest of it drags the window). */
const OWN_PRESS = "button,[role=menu]";

/** A top-level frame's size, the page's device screen (rotated) and whether it is landscape. */
function frameInfo(ed: EditorController, node: Guid | null): { frame: Size; device: Size | null; rotated: boolean } {
  const n = node ? (ed.engine.readNode(node, { fields: ["size"] }) as { size?: Size } | null) : null;
  const frame = n?.size && n.size.x > 0 && n.size.y > 0 ? n.size : { x: 375, y: 812 };
  const page = ed.engine.readNode(ed.store.page, { fields: ["prototypeDevice"] }) as { prototypeDevice?: { type?: string; size?: Size; rotation?: string } } | null;
  const d = page?.prototypeDevice;
  if (!d?.type || d.type === "NONE") return { frame, device: null, rotated: false };
  if (d.type === "PRESENTATION") return { frame, device: frame, rotated: false };
  if (!d.size) return { frame, device: null, rotated: false };
  const rotated = d.rotation === "CCW_90";
  return { frame, device: rotated ? { x: d.size.y, y: d.size.x } : d.size, rotated };
}

/** The window when it first opens on a frame (Figma's initial viewer size, 16 in from the visible canvas). */
function firstBox(ed: EditorController, node: Guid | null): Box {
  const view = viewRect(ed.canvas) ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const { frame, device, rotated } = frameInfo(ed, node);
  const viewer = initialViewerSize(breakpointOf(frame, device), frame, view, rotated);
  return initialBox(viewer, view);
}

export function InlinePreview() {
  const preview = useUI((s) => s.preview);
  if (!preview) return null;
  return <PreviewWindow key={preview.page} page={preview.page} node={preview.node} />;
}

function PreviewWindow({ page, node }: { page: Guid; node: Guid | null }) {
  useT();
  const ed = useEditor();
  const source = useMemo(() => editorPresentationSource(ed), [ed]);
  const start = useMemo(() => kept.get(ed), [ed]);
  const [box, setBox] = useState<Box>(() => start?.box ?? firstBox(ed, node));
  // The box a drag or a resize starts from (read in pointer handlers).
  const boxRef = useRef(box);
  useEffect(() => {
    boxRef.current = box;
  }, [box]);
  const windowRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const stateRef = useRef<PresentState | null>(null);
  const [state, setState] = useState<PresentState | null>(null);
  const [follow, setFollow] = useState(start?.follow ?? false);
  const [focused, setFocused] = useState(true);
  // The frame Restart goes back to: the last one selected on the canvas.
  const lastFrame = useRef<Guid | null>(node);
  // A selection made by Follow prototype itself (not the user's): the preview doesn't jump on it.
  const following = useRef(false);

  // Kept for the next opening (place, size, options).
  useEffect(() => {
    kept.set(ed, { box, scale: (state?.device ? null : state?.scale) ?? kept.get(ed)?.scale ?? null, follow });
  }, [ed, box, follow, state?.scale, state?.device]);

  const onReady = useCallback(
    (engine: Engine) => {
      engineRef.current = engine;
      window.__designerPreview = engine;
      // Figma's inline preview: Fit width (scale-down-width) without a device, the device fitted with one.
      const s = engine.presentState();
      engine.presentSetOptions({ scale: s.device ? "FIT" : (kept.get(ed)?.scale ?? "FIT_WIDTH"), host: presentHost() });
      // It takes the keys as it opens (Figma focuses its iframe).
      document.getElementById("preview-canvas")?.focus({ preventScroll: true });
    },
    [ed]
  );
  const onState = useCallback((s: PresentState) => {
    stateRef.current = s;
    setState(s);
  }, []);
  const refresh = () => {
    const engine = engineRef.current;
    if (engine && !engine.destroyed) onState(engine.presentState());
  };

  useEffect(
    () => () => {
      if (window.__designerPreview === engineRef.current) delete window.__designerPreview;
    },
    []
  );

  // Focused or not (Figma's previewFocused / previewNotFocused): the shadow and the resize handles.
  useEffect(() => {
    const el = windowRef.current;
    if (!el) return;
    const update = () => setFocused(el.contains(document.activeElement));
    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node) && !(e.target as Element).closest?.("#ds-overlays")) setFocused(false);
    };
    const onOut = () => requestAnimationFrame(update);
    el.addEventListener("focusin", update);
    el.addEventListener("focusout", onOut);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      el.removeEventListener("focusin", update);
      el.removeEventListener("focusout", onOut);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, []);

  // A frame selected on the canvas: the preview jumps to it.
  useEffect(() => {
    const jump = (e: { refs: readonly Guid[] }) => {
      if (following.current) return;
      // The event's own refs: the store's selection may not have heard of it yet.
      const frame = e.refs[0] ? presentStart(ed, e.refs[0]) : undefined;
      const engine = engineRef.current;
      if (!frame || !engine || engine.destroyed) return;
      lastFrame.current = frame;
      if (stateRef.current?.screen === frame) return;
      engine.presentStart({ node: frame });
    };
    return ed.engine.on("SELECTION_CHANGED", jump);
  }, [ed]);

  // Opened again at another frame while open (a flow's preview in the Prototype panel): it goes there.
  useEffect(() => {
    const engine = engineRef.current;
    if (!node || !engine || engine.destroyed || stateRef.current?.screen === node) return;
    lastFrame.current = node;
    engine.presentStart({ node });
  }, [node]);

  // Follow prototype: the canvas moves to the preview's frame (live: zoomed to it, the selection left as it was).
  useEffect(() => {
    if (!follow || !state?.screen) return;
    const keep = [...ed.selection];
    following.current = true;
    try {
      ed.engine.setSelection([state.screen]);
      ed.engine.command("ZOOM_TO_SELECTION");
      ed.engine.setSelection(keep);
    } finally {
      following.current = false;
    }
  }, [ed, follow, state?.screen]);

  const close = () => {
    ed.ui.set({ preview: null });
    ed.focusCanvas();
  };
  const restart = () => {
    const engine = engineRef.current;
    if (!engine || engine.destroyed) return;
    engine.presentStart(lastFrame.current ? { node: lastFrame.current } : {});
    refresh();
  };
  const step = (c: "back" | "next" | "previous") => {
    engineRef.current?.presentCommand(c);
    refresh();
  };

  // The viewer now and the frame's natural sizes (the menu's ✓ and its two resizes).
  const info = frameInfo(ed, state?.screen ?? node);
  const bp = breakpointOf(info.frame, info.device);
  const viewer: Size = { x: box.w, y: box.h - HEADER };
  const actual = actualViewerSize(bp, info.frame, info.rotated);
  const device = !!state?.device;
  const scale = state?.scale;
  const scaleEntry = (value: PresentScale, label: string): MenuEntry => ({ id: `scale:${value}`, label: t(label), icon: SCALE_ICON[value], checked: scale === value });
  const options: MenuEntry[] = [
    // Live (the owner's "Kahve", a landscape iPad): Responsive, Zoom device to fill screen, Fixed — one of three.
    ...(device
      ? [
          { id: "device:responsive", label: t("Responsive"), icon: SCALE_ICON.RESPONSIVE, checked: !!state?.responsive },
          { id: "device:fill", label: t("Zoom device to fill screen"), icon: SCALE_ICON.FILL, checked: !state?.responsive && scale === "FILL" },
          { id: "device:fixed", label: t("Fixed"), icon: SCALE_ICON.ACTUAL, checked: !state?.responsive && scale !== "FILL" },
        ]
      : [scaleEntry("FIT_WIDTH", "Fit width"), scaleEntry("FILL", "Fill screen"), scaleEntry("RESPONSIVE", "Responsive")]),
    "-",
    { id: "follow", label: t("Follow prototype"), checked: follow },
    { id: "actual", label: device ? t("Resize device to 100%") : t("Resize window to 100%"), checked: sameSize(viewer, actual) },
    ...(!device ? [{ id: "aspect", label: t("Reset aspect ratio"), checked: sameSize(viewer, aspectViewerSize(viewer, bp, info.frame)) }] : []),
    ...(state?.hasDeviceFrame ? [{ id: "frame", label: t("Show device frame"), checked: state.deviceFrame !== false }] : []),
  ];
  const resizeViewer = (v: Size) => setBox((b) => ({ ...b, w: v.x, h: v.y + HEADER }));
  const onOption = (id: string) => {
    const engine = engineRef.current;
    const s = stateRef.current;
    if (!engine || engine.destroyed) return;
    if (id.startsWith("scale:")) engine.presentSetOptions({ scale: id.slice(6) as PresentScale });
    else if (id === "device:responsive") engine.presentSetOptions({ responsive: true });
    else if (id === "device:fill") engine.presentSetOptions({ responsive: false, scale: "FILL" });
    else if (id === "device:fixed") engine.presentSetOptions({ responsive: false, scale: "FIT" });
    else if (id === "follow") setFollow((f) => !f);
    else if (id === "actual") resizeViewer(actual);
    else if (id === "aspect") resizeViewer(aspectViewerSize(viewer, bp, info.frame));
    else if (id === "frame") engine.presentSetOptions({ deviceFrame: s?.deviceFrame === false });
    refresh();
    document.getElementById("preview-canvas")?.focus({ preventScroll: true });
  };

  // The header drags the window (Figma's draggable modal), its header kept on screen.
  const onHeaderDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest(OWN_PRESS)) return;
    e.preventDefault();
    document.getElementById("preview-canvas")?.focus({ preventScroll: true });
    const from = { x: e.clientX, y: e.clientY, box: boxRef.current };
    const move = (ev: PointerEvent) => setBox(keepHeaderOnScreen({ ...from.box, x: from.box.x + ev.clientX - from.x, y: from.box.y + ev.clientY - from.y }, { width: window.innerWidth, height: window.innerHeight }));
    track(move);
  };
  // An edge or a corner resizes it (⇧ keeps the viewer's proportions).
  const onEdgeDown = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = { x: e.clientX, y: e.clientY, box: boxRef.current };
    track((ev) => setBox(resizeBox(from.box, edge, ev.clientX - from.x, ev.clientY - from.y, ev.shiftKey)));
  };

  const buttons = headerButtons(box.w);
  return (
    <div
      ref={windowRef}
      className={cx(styles.window, focused && styles.focused)}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      data-inline-preview=""
      role="dialog"
      aria-label={t("Preview")}
    >
      <div className={styles.frame}>
        <header className={styles.header} onPointerDown={onHeaderDown}>
          <div className={styles.group}>
            {buttons === 6 && (
              <>
                <IconButton icon="24.proto.frame.previous" label={t("Previous frame")} disabled={!state?.canBack && !state?.canPrevious} onClick={() => step(state?.canBack ? "back" : "previous")} />
                <IconButton icon="24.proto.frame.next" label={t("Next frame")} disabled={!state?.canNext} onClick={() => step("next")} />
              </>
            )}
            {buttons >= 4 && <IconButton icon="24.proto.restart" label={t("Restart prototype")} shortcut="R" onClick={restart} />}
          </div>
          <div className={styles.group}>
            <MenuButton label={t("Preview options")} entries={options} onSelect={onOption} className={styles.menuTrigger} align="end" menuWidth={200} tooltip>
              <Icon name="24.libraries-settings" />
            </MenuButton>
            {buttons >= 4 && <IconButton icon="24.proto.open.presentation" label={t("Open in presentation view")} onClick={() => present(ed, { node: stateRef.current?.screen ?? lastFrame.current ?? undefined })} />}
            <IconButton icon="24.close" label={t("Close")} onClick={close} />
          </div>
        </header>
        <div className={styles.content}>
          <PresentationView source={source} page={page} node={node} variant="inline" canvasId="preview-canvas" onRestart={restart} onClose={close} onReady={onReady} onState={onState} />
        </div>
      </div>
      {focused && EDGES.map((edge) => <div key={edge} className={styles[`resize-${edge}`]} data-resize={edge} onPointerDown={onEdgeDown(edge)} />)}
    </div>
  );
}

/** Follows the pointer until it is let go. */
function track(move: (e: PointerEvent) => void): void {
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

declare global {
  interface Window {
    /** The inline preview's engine, for scripts (tools/editor-shot.mjs) */
    __designerPreview?: Engine;
  }
}
