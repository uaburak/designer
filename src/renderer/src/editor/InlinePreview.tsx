/**
 * The inline preview (⇧Space, "Preview" in the Present menu; help.figma.com 360040318013 "Play your prototypes" and
 * 31011968186007): "a floating window, called the inline preview" over the canvas, playing the prototype on an engine
 * of its own fed by the editor's document — "any design changes are immediately reflected in the preview".
 *
 * - At its top: ← → (back / forward), Restart ("from the last selected frame on the canvas"; R), the overflow menu,
 *   open in presentation view in a new tab, × — PresentationView's `inline` variant.
 * - "When you click another frame on the canvas, the preview jumps to that frame."
 * - Its edges resize it; ⇧ keeps its proportions.
 * - Overflow menu: Fit width (No device / Presentation only), Responsive, Follow prototype (the canvas selection and
 *   position follow the preview's frame), Resize window/device to 100%, Respect aspect ratio (No device only), Show
 *   device frame.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MenuEntry } from "@/ds";
import type { Engine, PresentState } from "@/engine/Engine";
import type { Guid } from "@/engine/codec";
import { PresentationView } from "@/present/PresentationView";
import { useEditor, type EditorController } from "./controller";
import { useUI } from "./hooks";
import { editorPresentationSource, present, presentStart } from "./present";
import styles from "./InlinePreview.module.css";

const HEADER = 40;
const MIN_W = 160;
const MIN_H = 160;

interface Box {
  right: number;  // px from the window's right edge
  top: number;
  w: number;
  h: number;
}

/** The first size: 320 wide, the start frame's proportions (within the canvas). */
function firstBox(ed: EditorController, node: Guid | null): Box {
  const area = ed.canvas?.getBoundingClientRect();
  const right = area ? Math.max(8, window.innerWidth - area.right + 8) : 8;
  const top = area ? area.top + 8 : 48;
  const n = node ? ed.engine.readNode(node, { fields: ["size"] }) : null;
  const size = (n as { size?: { x: number; y: number } } | null)?.size;
  const w = 320;
  const maxH = area ? Math.max(MIN_H, area.height - 16) : 640;
  const h = size && size.x > 0 ? Math.min(maxH, Math.round((w * size.y) / size.x) + HEADER) : 560;
  return { right, top, w, h };
}

export function InlinePreview() {
  const preview = useUI((s) => s.preview);
  if (!preview) return null;
  return <PreviewWindow key={preview.page} page={preview.page} node={preview.node} />;
}

function PreviewWindow({ page, node }: { page: Guid; node: Guid | null }) {
  const ed = useEditor();
  const source = useMemo(() => editorPresentationSource(ed), [ed]);
  const [box, setBox] = useState<Box>(() => firstBox(ed, node));
  const engineRef = useRef<Engine | null>(null);
  const stateRef = useRef<PresentState | null>(null);
  const [state, setState] = useState<PresentState | null>(null);
  const [follow, setFollow] = useState(false);
  const [aspect, setAspect] = useState(false);
  // The frame Restart goes back to: the last one selected on the canvas.
  const lastFrame = useRef<Guid | null>(node);

  const onReady = useCallback((engine: Engine) => {
    engineRef.current = engine;
    window.__designerPreview = engine;
    // The window fits its frame (Figma's preview shows the whole frame; Fit width when chosen).
    engine.presentSetOptions({ scale: "FIT" });
  }, []);
  // Respect aspect ratio: the window takes the frame's proportions (now, and whenever the frame shown changes).
  const aspectRef = useRef(false);
  const fitAspect = useCallback(() => {
    const id = stateRef.current?.screen;
    const n = id ? (ed.engine.readNode(id, { fields: ["size"] }) as { size?: { x: number; y: number } } | null) : null;
    const size = n?.size;
    if (!size || size.x <= 0) return;
    setBox((b) => ({ ...b, h: Math.max(MIN_H, Math.round((b.w * size.y) / size.x) + HEADER) }));
  }, [ed]);
  const onState = useCallback(
    (s: PresentState) => {
      const moved = stateRef.current?.screen !== s.screen;
      stateRef.current = s;
      setState(s);
      if (moved && aspectRef.current) fitAspect();
    },
    [fitAspect]
  );

  useEffect(
    () => () => {
      if (window.__designerPreview === engineRef.current) delete window.__designerPreview;
    },
    []
  );

  // A frame selected on the canvas: the preview jumps to it.
  useEffect(() => {
    const jump = () => {
      const frame = presentStart(ed);
      const engine = engineRef.current;
      if (!frame || !engine || engine.destroyed) return;
      lastFrame.current = frame;
      if (stateRef.current?.screen === frame) return;
      engine.presentStart({ node: frame });
    };
    return ed.engine.on("SELECTION_CHANGED", jump);
  }, [ed]);

  // Follow prototype: the canvas selection and position follow the preview's frame.
  useEffect(() => {
    if (!follow || !state?.screen) return;
    if (ed.selection.length === 1 && ed.selection[0] === state.screen) return;
    ed.engine.setSelection([state.screen]);
    ed.engine.command("ZOOM_TO_SELECTION");
  }, [ed, follow, state?.screen]);

  const frameSize = (): { x: number; y: number } | null => {
    const s = stateRef.current?.screen;
    const n = s ? (ed.engine.readNode(s, { fields: ["size"] }) as { size?: { x: number; y: number } } | null) : null;
    return n?.size ?? null;
  };

  const device = !!state?.device;
  const presentationDevice = state?.deviceType === "PRESENTATION";
  const options: MenuEntry[] = [
    ...(!device || presentationDevice ? [{ id: "fit-width", label: "Fit width", checked: state?.scale === "FIT_WIDTH" }] : []),
    { id: "responsive", label: "Responsive", checked: device ? !!state?.responsive : state?.scale === "RESPONSIVE" },
    { id: "follow", label: "Follow prototype", checked: follow },
    { id: "actual", label: device ? "Resize device to 100%" : "Resize window to 100%" },
    ...(!device ? [{ id: "aspect", label: "Respect aspect ratio", checked: aspect }] : []),
    ...(state?.hasDeviceFrame ? [{ id: "frame", label: "Show device frame", checked: state.deviceFrame !== false }] : []),
  ];
  const onOption = (id: string) => {
    const engine = engineRef.current;
    const s = stateRef.current;
    if (!engine || engine.destroyed) return;
    if (id === "fit-width") engine.presentSetOptions({ scale: s?.scale === "FIT_WIDTH" ? "FIT" : "FIT_WIDTH" });
    else if (id === "responsive") {
      if (device) engine.presentSetOptions({ responsive: !s?.responsive });
      else engine.presentSetOptions({ scale: s?.scale === "RESPONSIVE" ? "FIT" : "RESPONSIVE" });
    } else if (id === "follow") setFollow((f) => !f);
    else if (id === "aspect") {
      aspectRef.current = !aspect;
      setAspect(!aspect);
      if (!aspect) fitAspect();
    }
    else if (id === "frame") engine.presentSetOptions({ deviceFrame: s?.deviceFrame === false });
    else if (id === "actual") {
      // The window grows (or shrinks) until the screen is drawn at 100%: by the scale it is drawn at now.
      const r = s?.screenRect;
      const width = device ? deviceWidth(ed) : frameSize()?.x;
      const scale = r && width && width > 0 ? r.w / width : 0;
      if (scale > 0) setBox((b) => ({ ...b, w: Math.max(MIN_W, Math.round(b.w / scale)), h: Math.max(MIN_H, Math.round((b.h - HEADER) / scale) + HEADER) }));
    }
  };
  const restart = () => {
    const engine = engineRef.current;
    if (!engine || engine.destroyed) return;
    engine.presentStart(lastFrame.current ? { node: lastFrame.current } : {});
  };

  // Resizing by the left and bottom edges and their corner (the window hangs from its top-right).
  const drag = (edge: "left" | "bottom" | "corner") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, box };
    const ratio = (box.h - HEADER) / box.w;
    const move = (ev: PointerEvent) => {
      let w = start.box.w + (edge !== "bottom" ? start.x - ev.clientX : 0);
      let h = start.box.h + (edge !== "left" ? ev.clientY - start.y : 0);
      if (ev.shiftKey || aspect) {
        if (edge === "bottom") w = (h - HEADER) / ratio;
        else h = w * ratio + HEADER;
      }
      setBox({ ...start.box, w: Math.max(MIN_W, Math.round(w)), h: Math.max(MIN_H, Math.round(h)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className={styles.window} style={{ right: box.right, top: box.top, width: box.w, height: box.h }} data-inline-preview="" role="dialog" aria-label="Preview">
      <PresentationView
        source={source}
        page={page}
        node={node}
        variant="inline"
        canvasId="preview-canvas"
        extraOptions={options}
        onExtraOption={onOption}
        onRestart={restart}
        onOpenFull={() => present(ed, { node: stateRef.current?.screen ?? lastFrame.current ?? undefined })}
        onClose={() => {
          ed.ui.set({ preview: null });
          ed.focusCanvas();
        }}
        onReady={onReady}
        onState={onState}
      />
      <div className={styles.edgeLeft} onPointerDown={drag("left")} />
      <div className={styles.edgeBottom} onPointerDown={drag("bottom")} />
      <div className={styles.corner} onPointerDown={drag("corner")} />
    </div>
  );
}

/** The page's prototype device's screen width (landscape: its height), or undefined. */
function deviceWidth(ed: EditorController): number | undefined {
  const page = ed.engine.readNode(ed.store.page, { fields: ["prototypeDevice"] }) as { prototypeDevice?: { size?: { x: number; y: number }; rotation?: string } } | null;
  const d = page?.prototypeDevice;
  if (!d?.size) return undefined;
  return d.rotation === "CCW_90" ? d.size.y : d.size.x;
}

declare global {
  interface Window {
    /** The inline preview's engine, for scripts (tools/editor-shot.mjs) */
    __designerPreview?: Engine;
  }
}
