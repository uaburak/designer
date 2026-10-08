/**
 * The developer preview viewer (docs/data.md §13): the same engine.wasm as the editor, loaded read-only with the
 * preview's derived snapshot (text drawn from its stored glyph outlines, no fonts needed), in Dev Mode's layout —
 * pages and layers on the left, the canvas, Inspect on the right (help.figma.com "Guide to Dev Mode").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentTheme, EmptyState, Spinner, ToastHost, TooltipManager, useThemeRoot } from "@/ds";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { fonts } from "@/engine/fonts";
import { loadEngine } from "@/engine/loadEngine";
import { Status } from "@/engine/abi";
import { inlineWasm, loadPreview, PreviewError, type LoadedPreview } from "./source";
import { viewerFontSource } from "./fonts";
import { attachViewerCanvas } from "./ViewerCanvas";
import { ViewerDoc } from "./viewerDoc";
import { LeftPanel } from "./LeftPanel";
import { InspectPanel } from "./InspectPanel";
import { Measurements } from "./Measurements";
import { Annotations } from "./Annotations";
import { PresentationView, type PresentationSource } from "@/present/PresentationView";
import type { Guid } from "@/engine/codec";
import { ViewerContext, type ViewerState } from "./context";
import styles from "./Viewer.module.css";

const engineTheme = (t: "light" | "dark") => (t === "light" ? "LIGHT" : "DARK");

export function ViewerApp() {
  const theme = useThemeRoot();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<ViewerState | null>(null);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let engine: Engine | null = null;
    const offs: (() => void)[] = [];
    (async () => {
      const wasmBinary = inlineWasm();
      fonts.setSource(viewerFontSource);
      const [preview] = await Promise.all([loadPreview(), loadEngine(wasmBinary ? { wasmBinary } : {})]);
      if (disposed) return;
      engine = await Engine.create(canvas, { sessionID: 1, theme: engineTheme(currentTheme().resolved) });
      if (disposed) return engine.destroy();
      const firstPage = preview.manifest.pages[0]?.id;
      const status = engine.loadKiwi(preview.message, firstPage ? { page: firstPage } : {});
      if (status !== Status.OK) throw new PreviewError("This preview can't be opened", `Its document could not be read (${status}).`);
      engine.setImageSource((sha1) => preview.image(sha1));
      // Read-only (Dev Mode): no resize handles, nothing a click or a key could change (engine viewer mode).
      engine.setViewerMode(true);
      const doc = new ViewerDoc(engine);
      offs.push(attachViewerCanvas(canvas, engine, { parentOf: (id) => doc.parentOf(id) }));
      engine.command("ZOOM_TO_FIT");
      canvas.focus({ preventScroll: true });
      setState(makeState(engine, doc, preview));
    })().catch((e: unknown) => {
      if (disposed) return;
      if (e instanceof PreviewError) setError({ title: e.title, body: e.message });
      else setError({ title: "This preview can't be opened", body: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      disposed = true;
      for (const off of offs.splice(0)) off();
      engine?.destroy();
    };
  }, []);

  useEffect(() => {
    if (state && !state.engine.destroyed) state.engine.setTheme(engineTheme(theme.resolved));
  }, [state, theme.resolved]);

  // ⌘-wheel and pinches zoom the canvas, never the page.
  useEffect(() => {
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    window.addEventListener("wheel", stop, { passive: false });
    return () => window.removeEventListener("wheel", stop);
  }, []);

  useEffect(() => {
    if (state) document.title = `${state.preview.manifest.fileName || "Untitled"} – Developer preview`;
  }, [state]);

  // Present (the prototype player, ⌥⌘↩): from the selection's top-level frame, else the page's first flow.
  const [presenting, setPresenting] = useState<{ page: Guid; node: Guid | null } | null>(null);
  const present = useCallback(() => {
    if (!state) return;
    const sel = state.engine.getSelection();
    let node: Guid | null = sel.refs[0] ?? null;
    for (let guard = 0; node && guard < 256; guard++) {
      const parent = state.doc.parentOf(node);
      if (!parent) break;
      node = parent;
    }
    setPresenting({ page: sel.pageId, node });
  }, [state]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.altKey && (e.metaKey || e.ctrlKey) && state && !presenting) {
        e.preventDefault();
        present();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, presenting, present]);
  const presentSource = useMemo<PresentationSource | null>(
    () => (state ? { fileName: state.preview.manifest.fileName || "Untitled", load: async () => ({ bytes: state.preview.message }), images: (h) => state.preview.image(h) } : null),
    [state]
  );

  return (
    <ViewerContext.Provider value={state}>
      <div className={styles.viewer} data-viewer="" data-ready={state ? "" : undefined}>
        {state ? <LeftPanel /> : <div className={styles.left} />}
        <div className={styles.canvasArea}>
          <canvas ref={canvasRef} id="engine-canvas" className={styles.canvas} aria-label="Canvas" />
          {state && <Annotations />}
          {state && <Measurements />}
          {!state && (
            <div className={styles.status} role="status">
              {error ? <EmptyState icon="24.warning" title={error.title} body={error.body} size="page" /> : <Spinner size={24} />}
            </div>
          )}
        </div>
        {state ? <InspectPanel onPresent={present} /> : <div className={styles.right} />}
      </div>
      {presenting && presentSource && (
        <PresentationView
          source={presentSource}
          page={presenting.page}
          node={presenting.node}
          onClose={() => {
            setPresenting(null);
            canvasRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
      <TooltipManager />
      <ToastHost />
    </ViewerContext.Provider>
  );
}

function makeState(engine: Engine, doc: ViewerDoc, preview: LoadedPreview): ViewerState {
  return { engine, store: new EngineStore(engine), doc, preview };
}

export default ViewerApp;
