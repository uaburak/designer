/**
 * The file editor (docs/editor.md): Figma UI3's chrome — the rail, the left
 * panel (file, Pages, Layers), the rulers, the engine's canvas, the bottom
 * toolbar, the right panel (Design / Prototype) — around one Engine on a
 * DocumentSource. The engine is mounted here (not EngineCanvas) because the
 * editor's shortcut layer replaces the playground's table.
 *
 * Mount: source.load() → Engine.create → engine.load → EngineStore →
 * EditorController → CanvasController({ shortcuts: [] }) → every committed
 * change to source.onChanges → keyboard, clipboard, desktop hooks → the
 * first view (zoom to fit, or a given camera).
 */
import "@/ds/global.css";
import { useEffect, useRef, useState } from "react";
import { currentTheme, HelpButton, Spinner, ToastHost, TooltipManager, useThemeRoot, type ThemeName } from "@/ds";
import { Status } from "@/engine/abi";
import { CanvasController } from "@/engine/CanvasController";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import type { DocumentSource } from "./documentSource";
import { EditorContext, EditorController, useEditor } from "./controller";
import { attachKeyboard } from "./keyboard";
import { attachClipboard } from "./clipboardIO";
import { attachDesktop } from "./desktop";
import { attachPersistence, restoreUiState } from "./persistence";
import { runEditorCommand } from "./commands";
import { useUI } from "./hooks";
import { Rail } from "./panels/Rail";
import { LeftPanel } from "./panels/LeftPanel";
import { RightPanel } from "./panels/RightPanel";
import { MinimizedPanels } from "./panels/Minimized";
import { Rulers } from "./canvas/Rulers";
import { BottomToolbar } from "./canvas/BottomToolbar";
import { CanvasMenu, attachCanvasMenu } from "./canvas/CanvasMenu";
import { ImagePlacer, attachImageDrop } from "./canvas/ImagePlacer";
import { ReturnToInstance } from "./canvas/ReturnToInstance";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { VersionDialogs } from "./VersionDialogs";
import { LocalVariables } from "./panels/variables/LocalVariables";
import { LibrariesDialog } from "./panels/libraries/LibrariesDialog";
import { PublishDialog } from "./panels/libraries/PublishDialog";
import styles from "./EditorApp.module.css";

export interface EditorAppProps {
  /** The file: where the document comes from and where its changes go */
  source: DocumentSource;
  /** "Back to files" (main menu); absent: the desktop's Home, or a note in a browser */
  onBackToFiles?: () => void;
  /** The editor is up (scripts, tests, the route's debugging hook) */
  onReady?: (ed: EditorController) => void;
  /** The first view: zoom to fit (default), or a zoom with the page's origin at a canvas point */
  initialView?: "fit" | { zoom: number; at: { x: number; y: number } };
}

const engineTheme = (t: ThemeName) => (t === "light" ? "LIGHT" : "DARK");

export function EditorApp({ source, onBackToFiles, onReady, initialView = "fit" }: EditorAppProps) {
  const theme = useThemeRoot();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<{ source: DocumentSource; ed: EditorController | null; error: string | null } | null>(null);
  const viewRef = useRef(initialView);
  const ed = state?.source === source ? state.ed : null;
  const error = state?.source === source ? state.error : null;

  useEffect(() => {
    viewRef.current = initialView;
  }, [initialView]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let engine: Engine | null = null;
    let store: EngineStore | null = null;
    let controller: EditorController | null = null;
    const cleanups: (() => void)[] = [];
    (async () => {
      const doc = await source.load();
      if (disposed) return;
      const created = await Engine.create(canvas, { sessionID: source.sessionID ?? 1, theme: engineTheme(currentTheme().resolved) });
      if (disposed) return created.destroy();
      engine = created;
      const loaded = engine.load(doc);
      if (loaded !== Status.OK) throw new Error(`the document could not be read (${loaded})`);
      store = new EngineStore(engine);
      controller = new EditorController(engine, store, source);
      controller.noteSourceTypes(doc);
      controller.canvas = canvas;
      const ed = controller;
      cleanups.push(new CanvasController(canvas, engine, { shortcuts: [] }).attach());
      cleanups.push(engine.onDocumentChanged((_, e) => source.onChanges(e.message, { kind: e.kind, label: e.label })));
      // Changes made elsewhere (another window, sync) come in without an undo entry; a rename elsewhere shows here.
      const external = source.onExternalChanges?.((changes) => {
        if (created.destroyed) return;
        ed.noteSourceTypes(changes);
        created.applyChanges(changes, "remote");
      });
      if (external) cleanups.push(external);
      const meta = source.onMetaChanged?.((m) => ed.ui.set({ fileName: m.fileName }));
      if (meta) cleanups.push(meta);
      cleanups.push(ed.images.attach());
      if (canvas.parentElement) cleanups.push(attachImageDrop(ed, canvas.parentElement));
      cleanups.push(attachKeyboard(ed, canvas));
      cleanups.push(attachClipboard(ed));
      cleanups.push(attachCanvasMenu(ed, canvas));
      cleanups.push(attachDesktop(ed));
      // The file's last page and camera when the source kept them, else the first view asked for.
      if (!restoreUiState(ed)) {
        const view = viewRef.current;
        if (view === "fit") engine.command("ZOOM_TO_FIT");
        else engine.setCamera({ x: view.at.x, y: view.at.y, zoom: view.zoom });
      }
      cleanups.push(attachPersistence(ed));
      canvas.focus({ preventScroll: true });
      setState({ source, ed, error: null });
    })().catch((e: unknown) => {
      if (!disposed) setState({ source, ed: null, error: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      disposed = true;
      for (const c of cleanups.splice(0).reverse()) c();
      controller?.dispose();
      store?.dispose();
      engine?.destroy();
    };
  }, [source]);

  useEffect(() => {
    if (ed && !ed.engine.destroyed) ed.engine.setTheme(engineTheme(theme.resolved));
  }, [ed, theme.resolved]);

  useEffect(() => {
    ed?.setBackToFiles(onBackToFiles ?? null);
  }, [ed, onBackToFiles]);

  useEffect(() => {
    if (ed) onReady?.(ed);
  }, [ed, onReady]);

  // ⌘-wheel and pinches anywhere in the editor zoom the canvas, never the page.
  useEffect(() => {
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    window.addEventListener("wheel", stop, { passive: false });
    return () => window.removeEventListener("wheel", stop);
  }, []);

  // The <canvas> stays the same element from the first render on (the engine is bound to it): the panels
  // around it are placeholders until the engine is up, then the chrome.
  return (
    <EditorContext.Provider value={ed}>
      <div className={styles.editor} data-editor="">
        {ed ? <LeftSide /> : <LeftPlaceholder />}
        <div className={styles.canvasArea} data-canvas-area="">
          <canvas ref={canvasRef} id="engine-canvas" className={styles.canvas} aria-label="Canvas" />
          {ed ? (
            <CanvasOverlays />
          ) : (
            <div className={styles.status} role="status">
              {error ? <span className={styles.error}>The file could not be opened: {error}</span> : <Spinner size={24} />}
            </div>
          )}
        </div>
        {ed ? <RightSide /> : <div className={styles.right} style={{ width: "var(--ds-size-panel)" }} />}
        {ed && <Overlays />}
      </div>
      <TooltipManager />
      <ToastHost />
    </EditorContext.Provider>
  );
}

export default EditorApp;

function LeftPlaceholder() {
  return (
    <>
      <div className={styles.railPlaceholder} />
      <div className={styles.left} style={{ width: "var(--ds-size-panel)" }} />
    </>
  );
}

/** The rail and the left panel, while docked (⌘\ hides them, ⇧\ folds them into a card). */
function LeftSide() {
  const docked = useUI((s) => !s.uiHidden && !s.uiMinimized);
  return docked ? (
    <>
      <Rail />
      <LeftPanel />
    </>
  ) : null;
}

function RightSide() {
  const docked = useUI((s) => !s.uiHidden && !s.uiMinimized);
  return docked ? <RightPanel /> : null;
}

/** Over the canvas: the rulers, the toolbar, "Return to instance", the minimized cards. */
function CanvasOverlays() {
  const hidden = useUI((s) => s.uiHidden);
  const minimized = useUI((s) => s.uiMinimized);
  if (hidden) return null;
  return (
    <>
      <Rulers />
      <ImagePlacer />
      <ReturnToInstance />
      <BottomToolbar />
      {minimized && <MinimizedPanels />}
    </>
  );
}

function Overlays() {
  const hidden = useUI((s) => s.uiHidden);
  const variables = useUI((s) => s.variablesOpen);
  return (
    <>
      {variables && <LocalVariables />}
      {!hidden && !variables && <Help />}
      <CanvasMenu />
      <ShortcutsDialog />
      <VersionDialogs />
      <LibrariesDialog />
      <PublishDialog />
    </>
  );
}

function Help() {
  const ed = useEditor();
  return (
    <div className={styles.help}>
      <HelpButton inline onClick={() => runEditorCommand(ed, "help.shortcuts")} />
    </div>
  );
}
