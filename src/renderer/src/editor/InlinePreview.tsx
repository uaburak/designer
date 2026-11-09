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
 * - Its engine holds only the page's prototype (editorPresentationSource: the page and the components it reaches, not
 *   the file's other pages). Closed, the window stays mounted, hidden (Figma hides its viewer's iframe): the engine
 *   idle — no player, no frames — but fed the changes, so the next ⇧Space on the page shows at once. Another page's
 *   opening replaces it; memory pressure (EngineHealth) drops it.
 * - Preview options: Fit width (the default), Fill screen, Responsive | Follow prototype (the canvas follows the
 *   preview's frame), Resize window to 100% (✓ at 100%), Reset aspect ratio (✓ at the frame's proportions). With a
 *   device: Responsive, Zoom device to fill screen, Fixed | Follow prototype, Resize device to 100%, Show device frame.
 * - Wecra's: dragged out of the app's window by its header, it tears off into a window of its own on the desktop (main's
 *   PREVIEW_WINDOW: the editor's blank window, this window drawn there through a React portal, the same engine moved to
 *   its canvas), with the page's device as the picture of the real device (present/deviceArt.ts) like a simulator.
 *   It stays over every other window (main: always on top); closing it closes the preview, and the next opening is in
 *   a window again.
 */
import { t, useT } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, IconButton, MenuButton, OverlayWindow, cx, type MenuEntry } from "@/ds";
import type { Engine, PresentScale, PresentState } from "@/engine/Engine";
import type { Guid } from "@/engine/codec";
import { PresentationView, SCALE_ICON, presentHost } from "@/present/PresentationView";
import { applyWebOption, forgetKeptState, keptStateKey, webMenuEntries } from "@/present/webBehaviours";
import { viewRect } from "./canvas/viewInsets";
import { useEditor, type EditorController } from "./controller";
import { useUI } from "./hooks";
import {
  HEADER,
  MIN_VIEWER,
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
import type { DeviceArt } from "@/present/deviceArt";
import { applyDeviceUiOption, chromeKind, deviceUiEntries, useDeviceUi } from "@/present/deviceUi";
import { editorPresentationSource, handOverPresentation, present, presentNode } from "./present";
import styles from "./InlinePreview.module.css";

/** What the preview keeps between its openings while the editor is open (Figma hides its window, keeping its state). */
interface Kept {
  box: Box;
  scale: PresentScale | null;
  follow: boolean;
  /** In a window of its own (opens there again) */
  popout: boolean;
}
const kept = new WeakMap<EditorController, Kept>();

const EDGES: Edge[] = ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"];
/** The header's own controls keep their press (the rest of it drags the window). */
const OWN_PRESS = "button,[role=menu]";
/** main's PREVIEW_WINDOW: the one blank window an editor may open (src/main/views.ts); its -device one is frameless and
 *  transparent (the device itself is the window). */
const PREVIEW_WINDOW = "wecra-preview";
/** The device as the window (its frame a picture): the toolbar floats over it, this far above the device. */
const PILL_GAP = 12;

/** The preview's own window: its document and the element this window is drawn into. */
interface Popout {
  win: Window;
  root: HTMLElement;
}

/**
 * A window of its own for the preview (main lets an editor open PREVIEW_WINDOW only), at the box's place on the screen:
 * this page's styles and theme copied in (new ones as they come: development's hot updates), and an element to draw in.
 */
function openPopout(box: Box, bare: boolean): Popout | null {
  const features = `popup=yes,width=${Math.round(box.w)},height=${Math.round(box.h)},left=${Math.round(window.screenX + box.x)},top=${Math.round(window.screenY + box.y)}`;
  const win = window.open("about:blank", bare ? `${PREVIEW_WINDOW}-device` : PREVIEW_WINDOW, features);
  if (!win) return null;
  const doc = win.document;
  doc.title = t("Preview");
  const base = doc.createElement("base");
  base.href = document.baseURI;
  doc.head.replaceChildren(base);
  const copy = (n: Node) => {
    if (n instanceof HTMLStyleElement || (n instanceof HTMLLinkElement && n.rel === "stylesheet")) {
      const c = n.cloneNode(true) as HTMLElement;
      if (c instanceof HTMLLinkElement) c.href = (n as HTMLLinkElement).href;
      doc.head.append(c);
    }
  };
  document.head.childNodes.forEach(copy);
  const styles = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(copy)));
  styles.observe(document.head, { childList: true });
  // The theme: the root's attributes (data-theme, the interface scale's variables).
  const mirror = () => {
    for (const a of [...doc.documentElement.attributes]) doc.documentElement.removeAttribute(a.name);
    for (const a of [...document.documentElement.attributes]) doc.documentElement.setAttribute(a.name, a.value);
  };
  mirror();
  const theme = new MutationObserver(mirror);
  theme.observe(document.documentElement, { attributes: true });
  win.addEventListener("pagehide", () => {
    styles.disconnect();
    theme.disconnect();
  });
  doc.body.className = document.body.className;
  doc.body.style.cssText = `margin:0;overflow:hidden;background:${bare ? "transparent" : "var(--figma-color-bg)"}`;
  if (bare) doc.documentElement.style.background = "transparent";
  const root = doc.createElement("div");
  doc.body.replaceChildren(root);
  return { win, root };
}

/** The whole device in its screen's units, portrait: its picture around a screen of 1 × its hole's proportions. */
function deviceOuter(a: DeviceArt): Size {
  return { x: a.w / a.hole.w, y: (a.h / a.hole.h) * (a.hole.h / a.hole.w) };
}

/** The file's light / dark collection: one with a light and a dark mode (by their names, English or Turkish). */
const LIGHT = /light|aydınlık|açık|day|gündüz/i;
const DARK = /dark|karanlık|koyu|night|gece/i;
interface ThemeCollection {
  id: Guid;
  key: string;
  light: Guid;
  dark: Guid;
  defaultMode: Guid | null;
}
function themeCollection(ed: EditorController): ThemeCollection | null {
  for (const c of ed.engine.variableCollections({ includeRemote: true })) {
    const light = c.modes.find((m) => LIGHT.test(m.name) && !DARK.test(m.name));
    const dark = c.modes.find((m) => DARK.test(m.name));
    if (light && dark) return { id: c.id, key: c.key, light: light.modeId, dark: dark.modeId, defaultMode: c.defaultModeId };
  }
  return null;
}

/** The collection's mode a node shows: its own explicit one, else its page's, else the collection's default. */
function themeModeOf(ed: EditorController, theme: ThemeCollection, node: Guid | null): Guid | null {
  for (const id of [node, ed.store.page]) {
    if (!id) continue;
    const map = ed.engine.readNode(id, { fields: ["variableModeBySetMap"] }) as { variableModeBySetMap?: unknown } | null;
    type Id = { sessionID?: number; localID?: number };
    type Entry = { variableSetID?: { guid?: Id; assetRef?: { key?: string } }; variableModeID?: Id };
    const entries = (map?.variableModeBySetMap as { entries?: Entry[] } | undefined)?.entries ?? [];
    const idOf = (g?: Id) => (g && g.sessionID !== undefined && g.localID !== undefined ? `${g.sessionID}:${g.localID}` : null);
    for (const e of entries) {
      const set = e.variableSetID;
      if (idOf(set?.guid) !== theme.id && !(theme.key && set?.assetRef?.key === theme.key)) continue;
      const mode = idOf(e.variableModeID);
      if (mode === theme.dark || mode === theme.light) return mode;
    }
  }
  return theme.defaultMode;
}

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
  return {
    frame,
    device: rotated ? { x: d.size.y, y: d.size.x } : d.size,
    rotated,
  };
}

/** The window when it first opens on a frame (Figma's initial viewer size, 16 in from the visible canvas). */
function firstBox(ed: EditorController, node: Guid | null): Box {
  const view = viewRect(ed.canvas) ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const { frame, device, rotated } = frameInfo(ed, node);
  const viewer = initialViewerSize(breakpointOf(frame, device), frame, view, rotated);
  return initialBox(viewer, view);
}

export function InlinePreview() {
  const ed = useEditor();
  const preview = useUI((s) => s.preview);
  const kept = useUI((s) => s.previewKept);
  // The last opening, kept (hidden) once it closes.
  useEffect(() => {
    if (preview && preview !== kept) ed.ui.set({ previewKept: preview });
  }, [ed, preview, kept]);
  const at = preview ?? kept;
  if (!at) return null;
  return <PreviewWindow key={at.page} page={at.page} node={at.node} open={!!preview} />;
}

function PreviewWindow({ page, node, open }: { page: Guid; node: Guid | null; open: boolean }) {
  useT();
  const ed = useEditor();
  const source = useMemo(() => editorPresentationSource(ed, page), [ed, page]);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const start = useMemo(() => kept.get(ed), [ed]);
  const [box, setBox] = useState<Box>(() => start?.box ?? firstBox(ed, node));
  // The box a drag or a resize starts from (read in pointer handlers).
  const boxRef = useRef(box);
  const windowRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const stateRef = useRef<PresentState | null>(null);
  const [state, setState] = useState<PresentState | null>(null);
  const [follow, setFollow] = useState(start?.follow ?? false);
  // In a window of its own (dragged out of the app's window), and whether it goes back there when opened again.
  const [popout, setPopout] = useState<Popout | null>(null);
  const popoutRef = useRef<Popout | null>(null);
  useEffect(() => {
    popoutRef.current = popout;
  }, [popout]);
  const [wantPopout, setWantPopout] = useState(start?.popout ?? false);
  // The device's picture (present/deviceArt.ts): with it the preview is the device itself — no window around it, the
  // toolbar floating over it, the window kept at the device's proportions.
  const [art, setArt] = useState<DeviceArt | null>(null);
  // The device's interface settings: the menu's ✓ follow them.
  useDeviceUi();
  // Whether it is (read in the handlers: the popping out, a resize).
  const bareRef = useRef(false);
  // The canvas the keys go to (this window's, or the preview's own).
  const previewCanvas = () => (popoutRef.current?.win.document ?? document).getElementById("preview-canvas");
  const [focused, setFocused] = useState(true);
  // The file's light / dark modes (a toggle in the header) and the one the viewer chose (null: as designed); a restart
  // or a jump starts the prototype again, so the choice is set again after it.
  const theme = useMemo(() => themeCollection(ed), [ed]);
  const [themeMode, setThemeMode] = useState<Guid | null>(null);
  const themeRef = useRef<{ collection: Guid; key: string; mode: Guid } | null>(null);
  const reTheme = (engine: Engine) => {
    if (themeRef.current) engine.presentSetOptions({ variableMode: themeRef.current });
  };
  // The frame Restart goes back to: the last one selected on the canvas.
  const lastFrame = useRef<Guid | null>(node);
  // A selection made by Follow prototype itself (not the user's): the preview doesn't jump on it.
  const following = useRef(false);

  // Kept for the next opening (place, size, options).
  useEffect(() => {
    kept.set(ed, {
      box,
      scale: (state?.device ? null : state?.scale) ?? kept.get(ed)?.scale ?? null,
      follow,
      popout: wantPopout,
    });
  }, [ed, box, follow, state?.scale, state?.device, wantPopout]);

  const onReady = useCallback(
    (engine: Engine) => {
      engineRef.current = engine;
      window.__designerPreview = engine;
      // Figma's inline preview: Fit width (scale-down-width) without a device, the device fitted with one.
      const s = engine.presentState();
      engine.presentSetOptions({ scale: s.device ? "FIT" : (kept.get(ed)?.scale ?? "FIT_WIDTH"), host: presentHost() });
      // It takes the keys as it opens (Figma focuses its iframe).
      previewCanvas()?.focus({ preventScroll: true });
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
  }, [popout]);

  // A frame selected on the canvas: the preview jumps to it.
  useEffect(() => {
    const jump = (e: { refs: readonly Guid[] }) => {
      if (following.current) return;
      // The event's own refs: the store's selection may not have heard of it yet.
      const frame = e.refs[0] ? presentNode(ed, e.refs[0]) : undefined;
      const engine = engineRef.current;
      if (!frame || !engine || engine.destroyed || !openRef.current) return;
      lastFrame.current = frame;
      if (stateRef.current?.screen === frame) return;
      engine.presentStart({ node: frame });
      reTheme(engine);
    };
    return ed.engine.on("SELECTION_CHANGED", jump);
  }, [ed]);

  // Opened again at another frame while open (a flow's preview in the Prototype panel): it goes there.
  // Opened again (kept hidden in between) at a frame: Restart goes back there (the view started there).
  useEffect(() => {
    const engine = engineRef.current;
    if (!node || !engine || engine.destroyed || !open) return;
    lastFrame.current = node;
    if (stateRef.current?.screen === node) return;
    engine.presentStart({ node });
    reTheme(engine);
  }, [node, open]);

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

  // Into a window of its own and back: the prototype's engine goes along (handed from the view that unmounts to the one
  // that mounts — no second load, its state kept).
  const closing = useRef(false);
  const popOut = (at: Box = boxRef.current) => {
    const p = openPopout(at, bareRef.current);
    if (!p) return null;
    handOverPresentation(ed, page);
    setWantPopout(true);
    setPopout(p);
    // Closed by its own close button: the preview closes (and opens in a window again next time).
    p.win.addEventListener("pagehide", () => {
      if (closing.current || popoutRef.current?.win !== p.win) return;
      handOverPresentation(ed, page);
      setPopout(null);
      ed.ui.set({ preview: null });
    });
    p.win.focus();
    return p;
  };
  const dock = () => {
    const p = popoutRef.current;
    if (!p) return;
    handOverPresentation(ed, page);
    setPopout(null);
    // After the commit that moved the engine back: its window goes.
    setTimeout(() => {
      closing.current = true;
      p.win.close();
      closing.current = false;
    }, 0);
  };
  // Closed while in its window: the window goes (opened again in one next time); opened: back in one.
  useEffect(() => {
    if (!open && popoutRef.current) dock();
    else if (open && wantPopout && !popoutRef.current) popOut();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // The editor closing: its window with it (main closes it too).
  useEffect(
    () => () => {
      const p = popoutRef.current;
      if (p && !p.win.closed) p.win.close();
    },
    []
  );
  // Keep state on reload: where the presentation keeps this prototype's state (PresentationView: file, page, start).
  const keptKey = () => keptStateKey(source.stateKey ?? source.fileName, page, node);
  const restart = () => {
    const engine = engineRef.current;
    if (!engine || engine.destroyed) return;
    forgetKeptState(keptKey());
    engine.presentStart(lastFrame.current ? { node: lastFrame.current } : {});
    reTheme(engine);
    refresh();
  };
  // Light ⇄ dark: the collection's other mode, for the page and every screen of it.
  const shownMode = theme ? (themeMode ?? themeModeOf(ed, theme, state?.screen ?? node)) : null;
  const darkShown = !!theme && shownMode === theme.dark;
  const toggleTheme = () => {
    const engine = engineRef.current;
    if (!theme || !engine || engine.destroyed) return;
    const next = darkShown ? theme.light : theme.dark;
    themeRef.current = { collection: theme.id, key: theme.key, mode: next };
    reTheme(engine);
    setThemeMode(next);
    refresh();
  };
  const step = (c: "back" | "next" | "previous") => {
    engineRef.current?.presentCommand(c);
    refresh();
  };

  // The viewer now and the frame's natural sizes (the menu's ✓ and its two resizes).
  const info = frameInfo(ed, state?.screen ?? node);
  const bare = !!(art && state?.frameArt && state.bareDevice && state.device && state.deviceFrame !== false && info.device);
  useEffect(() => {
    bareRef.current = bare;
  }, [bare]);
  const top = bare ? HEADER + PILL_GAP : HEADER;
  // The whole device (its picture around the screen), its height over its width.
  const deviceRatio = bare && art && info.device ? (info.rotated ? deviceOuter(art).x / deviceOuter(art).y : deviceOuter(art).y / deviceOuter(art).x) : null;
  // The window takes the device's proportions (its height kept) when the device or its picture changes.
  // Read by a resize in progress: the device's own proportions, whatever the window's were.
  const deviceRatioRef = useRef<number | null>(null);
  useEffect(() => {
    deviceRatioRef.current = deviceRatio;
  }, [deviceRatio]);
  // Shown at them always (a device or its picture changed, a window kept from before): the width follows the height.
  const shown: Box = deviceRatio && !popout ? { ...box, w: Math.max(MIN_VIEWER.x, Math.max(MIN_VIEWER.y, box.h - top) / deviceRatio) } : box;
  useEffect(() => {
    boxRef.current = shown;
  });
  // Its own window keeps them too (main's setAspectRatio: the device's width over its height, the toolbar above it).
  useEffect(() => {
    if (!popout) return;
    const desktop = (window as unknown as { designer?: { tab?: { previewAspect?: (a: { ratio: number; extraHeight: number } | null) => void } } }).designer;
    desktop?.tab?.previewAspect?.(deviceRatio ? { ratio: 1 / deviceRatio, extraHeight: top } : null);
    // At them now: the window's width follows its height.
    if (deviceRatio) {
      const vh = popout.win.innerHeight - top;
      const want = Math.round(vh / deviceRatio);
      if (Math.abs(popout.win.innerWidth - want) > 1) popout.win.resizeBy(want - popout.win.innerWidth, 0);
    }
  }, [popout, deviceRatio, top]);
  const bp = breakpointOf(info.frame, info.device);
  const viewer: Size = popout ? { x: popout.win.innerWidth, y: popout.win.innerHeight - top } : { x: shown.w, y: shown.h - top };
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
    // The device's own interface (present/deviceUi.ts): its status bar, a browser's bars.
    ...(device && state?.deviceType === "PRESET" ? deviceUiEntries(chromeKind(state.devicePreset)) : []),
    // Wecra's (webBehaviours.ts): the prototype plays like a website, as in the presentation's Advanced settings.
    "-",
    { id: "advanced", label: t("Advanced settings"), items: webMenuEntries(state) },
  ];
  const resizeViewer = (v: Size) => {
    const p = popoutRef.current;
    // Its own window: the window grows or shrinks by what the viewer lacks.
    if (p) p.win.resizeBy(Math.round(v.x - p.win.innerWidth), Math.round(v.y + top - p.win.innerHeight));
    else setBox((b) => ({ ...b, w: v.x, h: v.y + top }));
  };
  const onOption = (id: string) => {
    const engine = engineRef.current;
    const s = stateRef.current;
    if (!engine || engine.destroyed) return;
    if (applyWebOption(engine, s, id, keptKey) || applyDeviceUiOption(id)) {
      refresh();
      return;
    }
    if (id.startsWith("scale:")) engine.presentSetOptions({ scale: id.slice(6) as PresentScale });
    else if (id === "device:responsive") engine.presentSetOptions({ responsive: true });
    else if (id === "device:fill") engine.presentSetOptions({ responsive: false, scale: "FILL" });
    else if (id === "device:fixed") engine.presentSetOptions({ responsive: false, scale: "FIT" });
    else if (id === "follow") setFollow((f) => !f);
    else if (id === "actual") resizeViewer(actual);
    else if (id === "aspect") resizeViewer(aspectViewerSize(viewer, bp, info.frame));
    else if (id === "frame") engine.presentSetOptions({ deviceFrame: s?.deviceFrame === false });
    refresh();
    previewCanvas()?.focus({ preventScroll: true });
  };

  // The header drags the window (Figma's draggable modal), its header kept on screen.
  // The pointer held by a header drag: an element of this page that stays while the preview moves into its own window
  // (the header itself goes with it), so the drag goes on outside the app's window.
  const dragProxy = useRef<HTMLDivElement>(null);
  const onHeaderDown = (e: React.PointerEvent<HTMLElement>) => {
    // In its own window the system's title bar (the bare device's pill) moves it.
    if (popoutRef.current || e.button !== 0 || (e.target as Element).closest(OWN_PRESS)) return;
    const proxy = dragProxy.current;
    if (!proxy) return;
    e.preventDefault();
    previewCanvas()?.focus({ preventScroll: true });
    const from = { x: e.clientX, y: e.clientY, box: boxRef.current };
    // Where the pointer holds the window (from its top-left), kept as it moves on the screen.
    const grip = { x: e.clientX - from.box.x, y: e.clientY - from.box.y };
    let torn: Popout | null = null;
    proxy.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (torn) {
        // The system's title bar above a framed window's page.
        const bar = torn.win.outerHeight - torn.win.innerHeight;
        torn.win.moveTo(Math.round(ev.screenX - grip.x), Math.round(ev.screenY - grip.y - bar));
        return;
      }
      const next = {
        ...from.box,
        x: from.box.x + ev.clientX - from.x,
        y: from.box.y + ev.clientY - from.y,
      };
      // Out of the app's window: torn off into a window of its own, under the pointer.
      if (ev.clientX < 0 || ev.clientY < 0 || ev.clientX > window.innerWidth || ev.clientY > window.innerHeight) {
        torn = popOut(next);
        if (torn) return;
      }
      setBox(keepHeaderOnScreen(next, { width: window.innerWidth, height: window.innerHeight }));
    };
    const up = () => {
      proxy.removeEventListener("pointermove", move);
      proxy.removeEventListener("pointerup", up);
      proxy.removeEventListener("lostpointercapture", up);
      if (proxy.hasPointerCapture(e.pointerId)) proxy.releasePointerCapture(e.pointerId);
      torn?.win.focus();
    };
    proxy.addEventListener("pointermove", move);
    proxy.addEventListener("pointerup", up);
    proxy.addEventListener("lostpointercapture", up);
  };
  // An edge or a corner resizes it (⇧ keeps the viewer's proportions).
  const onEdgeDown = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = { x: e.clientX, y: e.clientY, box: boxRef.current };
    // The bare device keeps its proportions.
    track((ev) => setBox(resizeBox(from.box, edge, ev.clientX - from.x, ev.clientY - from.y, ev.shiftKey || bareRef.current, bareRef.current ? HEADER + PILL_GAP : HEADER, bareRef.current ? (deviceRatioRef.current ?? undefined) : undefined)));
  };

  const buttons = headerButtons(popout ? popout.win.innerWidth : shown.w);
  const frame = (
    <div className={cx(styles.frame, bare && styles.bareFrame)}>
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
          {theme && buttons >= 4 && <IconButton icon="24.theme" label={darkShown ? t("Switch to light mode") : t("Switch to dark mode")} aria-pressed={darkShown} onClick={toggleTheme} />}
          <MenuButton label={t("Preview options")} entries={options} onSelect={onOption} className={styles.menuTrigger} align="end" menuWidth={200} tooltip>
            <Icon name="24.libraries-settings" />
          </MenuButton>
          {buttons >= 4 && (
            <IconButton icon="24.proto.open.presentation" label={t("Open in presentation view")} onClick={() => present(ed, { node: stateRef.current?.screen ?? lastFrame.current ?? undefined })} />
          )}
          <IconButton icon="24.close" label={t("Close")} onClick={close} />
        </div>
      </header>
      <div className={styles.content}>
        <PresentationView
          source={source}
          page={page}
          node={node}
          hidden={!open}
          variant="inline"
          canvasId="preview-canvas"
          onRestart={restart}
          onClose={close}
          onReady={onReady}
          onState={onState}
          onDeviceArt={setArt}
        />
      </div>
    </div>
  );
  const proxy = <div ref={dragProxy} className={styles.dragProxy} aria-hidden />;
  // In its own window: the whole of it, its menus opening there.
  if (popout)
    return (
      <>
        {proxy}
        {createPortal(
          <OverlayWindow.Provider value={popout.win}>
            <div ref={windowRef} className={cx(styles.popout, bare && styles.bare)} data-inline-preview="" data-popout="" data-bare-device={bare || undefined} role="dialog" aria-label={t("Preview")}>
              {frame}
            </div>
          </OverlayWindow.Provider>,
          popout.root
        )}
      </>
    );
  return (
    <>
      {proxy}
      <div
        ref={windowRef}
        className={cx(styles.window, focused && styles.focused, bare && styles.bare)}
        data-bare-device={bare || undefined}
        // Closed: kept in place but not shown — its canvas keeps its size, so opening again draws at once.
        style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h, visibility: open ? undefined : "hidden" }}
        data-inline-preview=""
        data-closed={open ? undefined : ""}
        aria-hidden={open ? undefined : true}
        role="dialog"
        aria-label={t("Preview")}
      >
        {frame}
        {focused && EDGES.map((edge) => <div key={edge} className={styles[`resize-${edge}`]} data-resize={edge} onPointerDown={onEdgeDown(edge)} />)}
      </div>
    </>
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
