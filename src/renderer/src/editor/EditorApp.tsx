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
import { useEffect, useMemo, useRef, useState } from "react";
import { currentTheme, HelpButton, Spinner, ToastHost, TooltipManager, useThemeRoot, type ThemeName } from "@/ds";
import { Status } from "@/engine/abi";
import { CanvasController } from "@/engine/CanvasController";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { fonts } from "@/engine/fonts";
import { setEngineWireFormat } from "@/store/documentSource";
import { canReplayJournal, type DocumentFacts } from "@/store/loadDocument";
import type { DocumentSource } from "./documentSource";
import { EditorContext, EditorController, useEditor } from "./controller";
import type { Message } from "@/engine/codec";
import { messageToEngine } from "@/store/engineMessage";
import { decodeMessage as decodeKiwiMessage } from "../../../shared/schema/codec";
import { applyEngineBytes, changeBytesOf, engineDerivedDataVersion, engineMethod, engineWireFormat, loadEngineBytes } from "./engineCompat";
import { planFonts, requestFonts } from "./openFonts";
import { attachKeyboard, runTextKey } from "./keyboard";
import { attachClipboard } from "./clipboardIO";
import { attachDesktop } from "./desktop";
import { attachPersistence, noteOpenInfo, restoreUiState } from "./persistence";
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
import { ExportDialog } from "./ExportDialog";
import { LinkEditor } from "./canvas/LinkEditor";
import { PresentationView } from "@/present/PresentationView";
import { editorPresentationSource } from "./present";
import { ShareDialog } from "./ShareDialog";
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

/**
 * How long the load waits for the document's fonts once they are requested (they are asked for as soon as the file is
 * decoded, while it is still being converted): a font that is in before `engine_load` is shaped once; one that arrives
 * after it costs a relayout of every text and a second first frame. Bundled Inter takes a few ms; a system face
 * crosses the desktop's IPC. Past this the canvas shows with what has arrived (Figma draws before fonts too).
 */
const FONT_WAIT_MS = 300;

/** Resolves when the font service is idle, or after `ms`. */
const fontsSettledWithin = (ms: number) => Promise.race([fonts.settled(), new Promise<void>((r) => setTimeout(r, ms))]);

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
      // The engine (Wasm compile, GL init, the bundled fonts' request) and the document (decoded in the source's
      // worker when it has one) are prepared together. An engine that reads kiwi takes the store's own bytes as they
      // are — the snapshot, then each journal frame (docs/desktop.md §3.1) — with no conversion; the shown page's
      // fonts are requested as soon as the file is decoded, so they bind during the hand-over and the first frame's
      // text is shaped once. A snapshot that carries this engine's derived data (stored glyphs and instance layout,
      // as Figma's files do) draws its first frame before any font: the load doesn't wait for them then.
      const eager = source.prepare?.() ?? null;
      const creating = Engine.create(canvas, { sessionID: source.sessionID ?? 1, theme: engineTheme(currentTheme().resolved) });
      let loaded: number;
      let facts: DocumentFacts | null = null;
      let factsLater: Promise<DocumentFacts> | null = null;
      let derivedStored = false;
      const shownPage = source.uiState?.currentPageId ?? null;
      const askFonts = (known: DocumentFacts) => {
        if (disposed) return;
        cleanups.push(requestFonts(planFonts(known, shownPage)));
      };
      if (eager) {
        const created = await creating;
        if (disposed) return created.destroy();
        const format = engineWireFormat(created);
        setEngineWireFormat(format);
        // The kiwi wire for the engine's outputs too: changes come as the kiwi Message the journal keeps (`bytes`),
        // the panels read them through `changesOf` (GUIDs as strings on either wire).
        if (format === "kiwi") engineMethod<(w: "kiwi") => number>(created, "setWireFormat")?.("kiwi");
        const prepared = source.prepare!(format);
        const raw = prepared.raw;
        derivedStored = !!raw && raw.derivedDataVersion > 0 && raw.derivedDataVersion === engineDerivedDataVersion(created);
        if (format === "kiwi" && raw && canReplayJournal(raw.frames.map((message) => ({ message })))) {
          // Zero conversions: the worker's decode only tells the fonts and the types, and the load needn't wait for
          // it when the first frame draws from stored derived data.
          if (derivedStored) factsLater = prepared.facts.then((f) => (askFonts(f), f));
          else {
            facts = await prepared.facts;
            if (disposed) return created.destroy();
            askFonts(facts);
            await fontsSettledWithin(FONT_WAIT_MS);
          }
          if (disposed) return created.destroy();
          engine = created;
          // The saved page is the one derived at load (`engine_load_at`); `restoreUiState` then finds it current.
          loaded = loadEngineBytes(engine, raw.snapshot, "kiwi", { page: shownPage });
          for (const frame of raw.frames) {
            if (loaded !== Status.OK) break;
            const s = applyEngineBytes(engine, frame, "load");
            if (s !== null && s !== Status.OK) loaded = s;
          }
        } else {
          facts = await prepared.facts;
          if (disposed) return created.destroy();
          askFonts(facts);
          const doc = await prepared.document;
          if (disposed) return created.destroy();
          if (!derivedStored || doc.format !== "kiwi") await fontsSettledWithin(FONT_WAIT_MS);
          if (disposed) return created.destroy();
          engine = created;
          loaded = doc.bytes ? loadEngineBytes(engine, doc.bytes, doc.format, { page: shownPage }) : loadEngineBytes(engine, raw!.snapshot, "kiwi", { page: shownPage });
          if (!doc.bytes) {
            for (const frame of raw!.frames) {
              if (loaded !== Status.OK) break;
              const s = applyEngineBytes(engine, frame, "load");
              if (s !== null && s !== Status.OK) loaded = s;
            }
          }
        }
      } else {
        const [doc, created] = await Promise.all([source.load(), creating]);
        if (disposed) return created.destroy();
        engine = created;
        loaded = engine.load(doc);
        facts = { nodeCount: doc.nodeChanges.length, types: doc.nodeChanges.filter((c) => c.type !== undefined || "booleanOperation" in c), fonts: [], fontsByPage: {}, needsFallbackFont: false, derivedDataVersion: 0 };
      }
      if (loaded !== Status.OK) throw new Error(`the document could not be read (${loaded})`);
      const created = engine;
      store = new EngineStore(engine);
      controller = new EditorController(engine, store, source);
      if (facts) controller.noteSourceTypes({ nodeChanges: facts.types });
      else if (factsLater) {
        const ctl = controller;
        void factsLater.then((f) => {
          if (!disposed && controller === ctl) ctl.noteSourceTypes({ nodeChanges: f.types });
        });
      }
      controller.canvas = canvas;
      const ed = controller;
      cleanups.push(new CanvasController(canvas, engine, { shortcuts: [], onTextKey: (e) => runTextKey(ed, e) }).attach());
      cleanups.push(ed.attachGestureTracking(canvas));
      // The change as the engine wrote it (kiwi, when the engine speaks it) goes to the store as it is.
      cleanups.push(
        engine.on("DOCUMENT_CHANGED", (e) => {
          const bytes = changeBytesOf(e);
          // The engine's JSON form for a source that keeps Messages (memory sources, tests), converted only if read;
          // the store's source journals `bytes` as they are.
          const kiwiShaped = created.wire === "kiwi" && !!bytes;
          let converted: Message | null = null;
          const message = kiwiShaped
            ? ({
                type: "NODE_CHANGES",
                sessionID: source.sessionID ?? 1,
                get nodeChanges() {
                  return (converted ??= messageToEngine(decodeKiwiMessage(bytes!))).nodeChanges;
                },
                get blobs() {
                  return (converted ??= messageToEngine(decodeKiwiMessage(bytes!))).blobs;
                },
              } as Message)
            : e.message;
          source.onChanges(message, { kind: e.kind, label: e.label, bytes });
        })
      );
      // Changes made elsewhere (another window, sync) come in without an undo entry; a rename elsewhere shows here.
      const external = source.onExternalChanges?.((changes, info) => {
        if (created.destroyed) return;
        ed.noteSourceTypes(changes);
        const bytes = (info as { bytes?: Uint8Array } | undefined)?.bytes;
        if (!bytes || applyEngineBytes(created, bytes, "remote") === null) created.applyChanges(changes, "remote");
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
      noteOpenInfo(ed, { derivedStored });
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

  // The chrome has painted (two frames after its first commit): the file's images may go to the GPU now.
  useEffect(() => {
    if (!ed) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => ed.images.releaseUploads());
    });
    return () => cancelAnimationFrame(frame);
  }, [ed]);

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
      <ExportDialog />
      <Presenting />
      <ShareDialog />
      <LinkEditor />
    </>
  );
}

/** "Present in this tab": the presentation view over the editor, on the editor's document and its live changes. */
function Presenting() {
  const ed = useEditor();
  const presenting = useUI((s) => s.presenting);
  const source = useMemo(() => (presenting ? editorPresentationSource(ed) : null), [ed, presenting]);
  if (!presenting || !source) return null;
  return (
    <PresentationView
      source={source}
      page={presenting.page}
      node={presenting.node}
      onClose={() => {
        ed.ui.set({ presenting: null });
        ed.focusCanvas();
      }}
    />
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
