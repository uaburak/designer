/**
 * What the editor keeps through its DocumentSource besides the document
 * (docs/data.md §5.7), when the source offers it: the per-file UI state
 * (current page, each page's camera and selection, panel widths) restored
 * on open and written as it changes, and the thumbnail Home shows — the
 * first page rendered offscreen by the engine, 800 × 600, written a few
 * seconds after the last change and before the tab flushes (closes, quits,
 * hides).
 */
import { currentTheme } from "@/ds";
import { Status } from "@/engine/abi";
import type { EditorController } from "./controller";
import type { EditorUiState } from "./documentSource";
import { encodeDocumentBytes, engineDerivedDataVersion } from "./engineCompat";
import { colorToHex, hexToColor, sameColor } from "./model/color";

/**
 * The card's image: 4:3 (the store's 800 × 600 limit), the content fitted inside a margin on the page's colour. Home's
 * card shows about the middle 16:9 band of it (object-fit: cover), so the content stays within 600 × 340.
 */
const THUMB_SIZE = { width: 800, height: 600 };
const THUMB_CONTENT = { width: 600, height: 340 };
const THUMB_DELAY_MS = 4000;
/** No thumbnail within this long of the open: the card already shows the file; the first seconds are the user's. */
const OPEN_QUIET_MS = 10000;
/** After an image's bytes are in, the engine decodes and uploads it (createImageBitmap): a moment to let it. */
const IMAGE_UPLOAD_MS = 100;
/** Figma's default page colour, which the engine draws as #1E1E1E in the dark theme (as the Design panel shows it) */
const DEFAULT_PAGE = hexToColor("#f5f5f5");

/** Puts back the file's last page, camera, selection and panel widths; true when a camera was restored. */
export function restoreUiState(ed: EditorController): boolean {
  const state = ed.source.uiState;
  if (!state) return false;
  const pages = ed.store.pages; // the EngineStore's list (read once at construction, again on PAGES_CHANGED)
  if (state.currentPageId && pages.some((p) => p.guid === state.currentPageId)) ed.engine.setCurrentPage(state.currentPageId);
  if (state.leftPanelWidth > 0 || state.rightPanelWidth > 0) ed.ui.set({ ...(state.leftPanelWidth > 0 ? { leftWidth: state.leftPanelWidth } : {}), ...(state.rightPanelWidth > 0 ? { rightWidth: state.rightPanelWidth } : {}) });
  const page = state.pages[ed.store.page];
  if (!page) return false;
  if (page.selection.length) ed.engine.setSelection(page.selection.filter((id) => ed.engine.readNode(id) !== null));
  const v = page.viewport;
  if (!(v.zoom > 0)) return false;
  ed.engine.setCamera(v);
  return true;
}

/** Writes the UI state as it changes (the source debounces). */
function trackUiState(ed: EditorController): () => void {
  const set = ed.source.setUiState;
  if (!set) return () => {};
  const pages: EditorUiState["pages"] = { ...(ed.source.uiState?.pages ?? {}) };
  let frame = 0;
  const write = () => {
    frame = 0;
    if (ed.engine.destroyed) return;
    const page = ed.store.page;
    pages[page] = { viewport: ed.store.camera, selection: ed.selection };
    const ui = ed.ui.get();
    set.call(ed.source, { currentPageId: page, pages: { ...pages }, leftPanelWidth: ui.leftWidth, rightPanelWidth: ui.rightWidth });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(write);
  };
  let widths = `${ed.ui.get().leftWidth}:${ed.ui.get().rightWidth}`;
  const offs = [
    ed.store.subscribe("camera", schedule),
    ed.store.subscribe("selection", schedule),
    ed.store.subscribe("page", schedule),
    ed.ui.subscribe(() => {
      const next = `${ed.ui.get().leftWidth}:${ed.ui.get().rightWidth}`;
      if (next !== widths) {
        widths = next;
        schedule();
      }
    }),
  ];
  return () => {
    cancelAnimationFrame(frame);
    offs.forEach((off) => off());
  };
}

/** The page's colour as the engine draws it (the default one is dark in the dark theme). */
function pageColor(ed: EditorController, page: string): string {
  const color = ed.engine.readNode(page)?.backgroundColor ?? DEFAULT_PAGE;
  if (sameColor(color, DEFAULT_PAGE) && currentTheme().resolved === "dark") return "#1e1e1e";
  return `#${colorToHex(color)}`;
}

/**
 * The file's first page (Figma's cover) as an 800 × 600 PNG: its content, rendered offscreen by the engine
 * (`renderThumbnail`, no overlays, the canvas untouched), fitted within 600 × 340 and centred on the page's colour.
 * Without the margin a single shape filled the whole card with one colour, and the card looked empty. An empty page
 * gives null (Home shows its blank card).
 */
export async function captureThumbnail(ed: EditorController): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  const first = ed.store.pages[0];
  if (!first || ed.engine.destroyed) return null;
  // maxSize bounds the longer side: content taller than 4:3 is rendered smaller so it stays within the height.
  const render = () => {
    const wide = ed.engine.renderThumbnailPixels({ page: first.guid, maxSize: THUMB_CONTENT.width });
    return wide && wide.height > THUMB_CONTENT.height ? ed.engine.renderThumbnailPixels({ page: first.guid, maxSize: Math.floor((THUMB_CONTENT.width * THUMB_CONTENT.height) / wide.height) }) : wide;
  };
  // Taken at once (on close the engine goes right after); if that render asked for images it didn't have yet,
  // once they are in it is taken again, so the card shows them.
  const requests = ed.images.requests;
  let image = render();
  if (ed.images.requests !== requests || ed.images.loadingCount > 0) {
    await ed.images.settled();
    await new Promise((r) => setTimeout(r, IMAGE_UPLOAD_MS));
    if (!ed.engine.destroyed) image = render() ?? image;
  }
  if (!image) return null;
  const content = document.createElement("canvas");
  content.width = image.width;
  content.height = image.height;
  content.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
  const out = document.createElement("canvas");
  out.width = THUMB_SIZE.width;
  out.height = THUMB_SIZE.height;
  const g = out.getContext("2d");
  if (!g) return null;
  g.fillStyle = pageColor(ed, first.guid);
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(content, Math.round((out.width - image.width) / 2), Math.round((out.height - image.height) / 2));
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
  return blob ? { png: new Uint8Array(await blob.arrayBuffer()), width: out.width, height: out.height } : null;
}

/**
 * Saves a thumbnail a few seconds after the last change, and at once when the tab flushes (main closes the view right
 * after a close or quit flush, so a timer still waiting then would never fire) or when the editor goes.
 */
function trackThumbnail(ed: EditorController): () => void {
  const save = ed.source.saveThumbnail;
  if (!save) return () => {};
  const opened = performance.now();
  let timer = 0;
  let idle = 0;
  let stale = false;
  let writing: Promise<void> = Promise.resolve();
  const cancelIdle = () => {
    if (idle && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
    idle = 0;
  };
  const write = (): Promise<void> => {
    window.clearTimeout(timer);
    timer = 0;
    cancelIdle();
    if (!stale || ed.engine.destroyed) return writing;
    stale = false;
    writing = captureThumbnail(ed)
      .then((t) => (t ? save.call(ed.source, t.png, { width: t.width, height: t.height }) : undefined))
      .catch(() => {});
    return writing;
  };
  // A few seconds after the last change, on an idle moment (the capture is a 60–70 ms task), never while the file is
  // still opening — and only for the user's changes: a SYSTEM change (fonts arriving and relaying out text, library
  // bookkeeping) doesn't earn a new card.
  const schedule = () => {
    window.clearTimeout(timer);
    cancelIdle();
    const wait = Math.max(THUMB_DELAY_MS, OPEN_QUIET_MS - (performance.now() - opened));
    timer = window.setTimeout(() => {
      timer = 0;
      if (typeof requestIdleCallback === "function") idle = requestIdleCallback(() => void write(), { timeout: 2000 });
      else void write();
    }, wait);
  };
  const off = ed.engine.on("DOCUMENT_CHANGED", (e) => {
    if (e.kind === "SYSTEM") return;
    stale = true;
    schedule();
  });
  ed.beforeFlush.add(write);
  return () => {
    off();
    ed.beforeFlush.delete(write);
    void write(); // the last changes, before the engine goes
  };
}

// ---- The engine's snapshot with its derived data (docs/data.md §5.5) -----------------------------------------------

/** How long after the last change the engine's snapshot is taken (on an idle moment). */
const SNAPSHOT_DELAY_MS = 5000;
/** A file whose stored snapshot lacks this engine's derived data gets one this long after the open, edits or not. */
const SNAPSHOT_AFTER_OPEN_MS = 15000;
/** An encode + hand-over slower than this is kept off the flush handshake (main waits 3 s) and left to idle moments. */
const SNAPSHOT_FLUSH_BUDGET_MS = 1200;
/** Snapshots at most this often while editing (the flush's is always taken). */
const SNAPSHOT_MIN_INTERVAL_MS = 60_000;

/** What EditorApp knows of the open that the snapshot schedule needs. */
const openInfo = new WeakMap<EditorController, { derivedStored: boolean }>();

/** Whether the file's stored snapshot already carried this engine's derived data at open (EditorApp says so). */
export function noteOpenInfo(ed: EditorController, info: { derivedStored: boolean }): void {
  openInfo.set(ed, info);
}

/**
 * The engine's own snapshot of the document — every node with its `@derived` fields (`fillGeometry`, `strokeGeometry`,
 * `derivedTextData`, `derivedSymbolData`) and the engine's `derivedDataVersion` — handed to the store, which adopts it
 * as the file's snapshot when nothing else happened since (`DocumentSource.saveSnapshot`), as Figma's files keep
 * their derived data: the next open draws its first frame from stored glyph outlines and instance layout, before any
 * font arrives. Null when this engine build can't encode kiwi with derived data, or a transaction is open.
 */
export function captureSnapshot(ed: EditorController): { bytes: Uint8Array; derivedDataVersion: number } | null {
  const engine = ed.engine;
  if (engine.destroyed) return null;
  const version = engineDerivedDataVersion(engine);
  if (!version) return null;
  // Never in the middle of a transaction: the snapshot would hold writes the journal doesn't have (yet, or ever).
  if (engine.txnBegin("snapshot") !== Status.OK) return null;
  engine.txnCancel();
  const bytes = encodeDocumentBytes(engine, { derived: true });
  return bytes ? { bytes, derivedDataVersion: version } : null;
}

/**
 * Saves the engine's snapshot a few seconds after the last change (on an idle moment), once after the open when the
 * stored one lacked this engine's derived data, and at the tab's flush (close, quit, hide) when the encode is quick
 * enough for the handshake. Off for a source without `saveSnapshot` or an engine without the encode.
 */
function trackSnapshot(ed: EditorController): () => void {
  const save = ed.source.saveSnapshot;
  if (!save || !engineDerivedDataVersion(ed.engine)) return () => {};
  let timer = 0;
  let idle = 0;
  let stale = false;
  let supported = true;
  let lastCostMs = 0;
  let lastSavedAt = -Infinity;
  let writing: Promise<void> = Promise.resolve();
  const cancelIdle = () => {
    if (idle && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
    idle = 0;
  };
  const write = (reason: "idle" | "flush"): Promise<void> => {
    window.clearTimeout(timer);
    timer = 0;
    cancelIdle();
    if (!stale || !supported || ed.engine.destroyed) return writing;
    if (reason === "flush" && lastCostMs > SNAPSHOT_FLUSH_BUDGET_MS) return writing;
    // At most one a minute while editing (an encode and the store's check are ~0.5 s of work on a big file).
    if (reason === "idle" && performance.now() - lastSavedAt < SNAPSHOT_MIN_INTERVAL_MS) {
      schedule(SNAPSHOT_MIN_INTERVAL_MS - (performance.now() - lastSavedAt));
      return writing;
    }
    if (ed.gestureActive) {
      if (reason === "idle") schedule(SNAPSHOT_DELAY_MS);
      return writing;
    }
    const t0 = performance.now();
    const snapshot = captureSnapshot(ed);
    if (!snapshot) {
      // An open transaction (a scrub): again later. No encode at all: this build can't; stop asking.
      if (!encodeDocumentBytes(ed.engine, { derived: false })) supported = false;
      else if (reason === "idle") schedule(SNAPSHOT_DELAY_MS);
      return writing;
    }
    stale = false;
    // In the same task as the encode (the source names the head the snapshot stands at).
    writing = save
      .call(ed.source, snapshot.bytes, { derivedDataVersion: snapshot.derivedDataVersion })
      .then((adopted) => {
        lastCostMs = performance.now() - t0;
        if (adopted === "refused") {
          // The store won't take this engine's snapshots (they would lose what the file holds): no more this session.
          supported = false;
          return;
        }
        lastSavedAt = performance.now();
        if (!adopted && !ed.engine.destroyed) {
          // The head moved past the snapshot (a frame from elsewhere): the next quiet moment carries it.
          stale = true;
          schedule(SNAPSHOT_DELAY_MS);
        }
      })
      .catch(() => {});
    return writing;
  };
  const schedule = (wait: number) => {
    window.clearTimeout(timer);
    cancelIdle();
    timer = window.setTimeout(() => {
      timer = 0;
      if (typeof requestIdleCallback === "function") idle = requestIdleCallback(() => void write("idle"), { timeout: 4000 });
      else void write("idle");
    }, wait);
  };
  const off = ed.engine.on("DOCUMENT_CHANGED", () => {
    // Every committed change, the engine's own included (fonts arriving relaid text: new glyph data to keep).
    stale = true;
    schedule(SNAPSHOT_DELAY_MS);
  });
  if (openInfo.get(ed)?.derivedStored === false) {
    stale = true;
    schedule(SNAPSHOT_AFTER_OPEN_MS);
  }
  const onFlush = () => write("flush");
  ed.beforeFlush.add(onFlush);
  return () => {
    off();
    ed.beforeFlush.delete(onFlush);
    window.clearTimeout(timer);
    cancelIdle();
    void write("flush"); // the last state, before the engine goes
  };
}

export function attachPersistence(ed: EditorController): () => void {
  const offs = [trackUiState(ed), trackThumbnail(ed), trackSnapshot(ed)];
  return () => offs.forEach((off) => off());
}
