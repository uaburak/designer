/**
 * The presentation view (Figma's, R8 §9; measured live 2026-10-20, docs/research/figma/live/2026-10-20/
 * prototype-preview.txt): a prototype played by the engine's player (engine/src/proto/Player) on an engine of its own
 * — the same Wasm renderer as the canvas —, over the page's prototype background, its videos played by the browser
 * (presentationVideos.ts).
 *
 * - The bar (48 and a line): Open flows list (the flows sidebar: its rows and the current flow's description) and
 *   comments (shown, disabled: there is no multiplayer) at the left; the file's name in the middle with its ▾ ("Open
 *   in editor"); Share prototype, Options and full screen at the right, 48 × 46 glyph buttons.
 * - Options: "Recommended" — the file's first two scales — and "Other scaling options", each with its glyph and "Z"
 *   beside the next one; "Advanced settings ›" (Enable Figma shortcuts, Show hints on click); "Hide UI ⌘\". With a
 *   device: Responsive / Fixed size (its scales — Fit device on screen, Zoom device to fill screen, Show device at
 *   100%, Show device frame — in the footer's device menu). Advanced settings also holds Wecra's "Website behaviours"
 *   (webBehaviours.ts): text inputs typed into through a hidden <textarea> over the field, keyboard focus, cursors.
 * - No footer bar: the ‹ | › stepper floats at the bottom's middle, Restart (R) at its right.
 * - Keys as Figma's: → Space N next frame, ← previous, R restart, Z the next scale option, F full screen (with
 *   "Enable Figma shortcuts"), ? the keyboard shortcuts, ⌘\ Hide UI, Esc leaves (in this tab); interactions with
 *   Key / Gamepad triggers take their keys first.
 *
 * The document comes from a PresentationSource: the store's file opened read-only in a tab of its own (PresentRoute),
 * or the editor's engine when presenting in its own tab; its live changes keep the prototype current. The `inline`
 * variant is only the prototype of the editor's inline preview (InlinePreview.tsx draws its window and header).
 */
import { t, useT } from "@/i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Dialog, Icon, IconButton, MenuButton, Spinner, showToast, type IconName, type MenuEntry } from "@/ds";
import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, Status } from "@/engine/abi";
import { Engine, type ImageSource, type PresentScale, type PresentState } from "@/engine/Engine";
import type { Guid } from "@/engine/codec";
import { PresentationVideos } from "./presentationVideos";
import { applyWebOption, forgetKeptState, keptStateKey, readWebOptions, restoreKeptState, saveKeptState, webBehavioursParam, webMenuEntries } from "./webBehaviours";
import styles from "./Present.module.css";

export interface PresentationSource {
  /** The file's name (the top bar) */
  fileName: string;
  /** The file's key: Keep state on reload keeps a prototype's state under it (else the name) */
  stateKey?: string;
  /** The document: a kiwi Message (the store's snapshot or the editor's own encoding), and journal frames after it */
  load(): Promise<{ bytes: Uint8Array; frames?: Uint8Array[] }>;
  /** Live changes (kiwi NODE_CHANGES Messages) until the returned function is called */
  subscribe?(apply: (bytes: Uint8Array) => void): () => void;
  images?: ImageSource;
  /**
   * Instead of `load`: fills the engine straight from another one in this module (Engine.loadPageOf — the editor's
   * engine, no Message written or read); called again when a partial document is loaded anew.
   */
  loadInto?(engine: Engine): void;
  /**
   * The document is a page's subset (Engine.encodePageKiwi: the editor's own): the engine keeps out what happens on
   * other pages, and when a change needs a node it lacks that the file has (`has`), the subset is loaded again.
   */
  partial?: { has(id: Guid): boolean };
  /**
   * An engine another view of this source handed over (the inline preview's to Present here, and back), taken at mount
   * instead of a new one: no load, the screens it derived kept.
   */
  takeEngine?(): Engine | null;
  /**
   * At unmount: whether the source keeps the engine for the view that takes over (it then follows the changes until
   * taken); false, it is destroyed. `back`: the engine was taken this moment and goes back untouched.
   */
  keepEngine?(engine: Engine, back: boolean): boolean;
}

/**
 * Keeps `engine` following `source`'s changes; a page's subset is loaded again when a change needs a node it lacks
 * (and the file has), the prototype going on from the screen it shows while `presenting()`. Returns the stop.
 */
export function followSource(engine: Engine, source: PresentationSource, page: Guid | null | undefined, presenting: () => boolean = () => false, after?: () => void): () => void {
  if (!source.subscribe) return () => {};
  const refill = (next: { bytes: Uint8Array } | null) => {
    if (engine.destroyed) return;
    const on = presenting();
    const screen = on ? engine.presentState().screen : null;
    if (on) engine.presentStop();
    if (next) engine.loadKiwi(next.bytes, page ? { page } : {});
    else source.loadInto?.(engine);
    if (on) engine.presentStart({ ...(page ? { page } : {}), ...(screen ? { node: screen } : {}) });
    after?.();
  };
  const reload = () => (source.loadInto ? refill(null) : void source.load().then(refill));
  return source.subscribe((bytes) => {
    if (engine.destroyed) return;
    engine.applyChangesKiwi(bytes, "remote");
    if (source.partial && engine.takeLacking().some((id) => source.partial!.has(id))) reload();
  });
}

export interface PresentationViewProps {
  source: PresentationSource;
  /** The canvas's id (the engine finds its canvas by selector; two presentations at once need two) */
  canvasId?: string;
  /** "inline": the editor's inline preview — its own bar, no footer, never full screen */
  variant?: "full" | "inline";
  /** Inline: Restart by R (default: the engine's, from the flow's start) */
  onRestart?: () => void;
  /** The title's menu "Open in editor" (live: the file name's ▾); default: Leave (onClose) when there is one */
  onOpenEditor?: () => void;
  /** Every state read (the inline preview follows it) */
  onState?: (state: PresentState) => void;
  /** The page; default: the document's first page */
  page?: Guid | null;
  /** Where to start: a frame (or a layer in one); default: the first flow's start */
  node?: Guid | null;
  /** Leave (Esc, ×) — absent in a tab of its own */
  onClose?: () => void;
  /** The engine is up and presenting (scripts, tests) */
  onReady?: (engine: Engine) => void;
  /** Share prototype (the toolbar's; docs/editor.md D-6): with the screen shown; default, the presentation's link copied */
  onShare?: (screen: Guid | null) => void;
  /** Figma's prototype URL parameters (`presentUrlOptions`): the scale, hints, device frame and UI to start with */
  urlOptions?: PresentUrlOptions;
  /**
   * Hidden (the inline preview closed, kept for its next opening): the player stops, the engine draws nothing and asks
   * for no frames, its videos go; the document still follows the changes. Shown again, it starts at `node` at once.
   */
  hidden?: boolean;
}

/** What a prototype link's parameters ask for (atlas 13 §10.6). */
export interface PresentUrlOptions {
  scale?: PresentScale;
  hints?: boolean;
  deviceFrame?: boolean;
  hideUi?: boolean;
  /** The frame to show (`node-id`), else the flow to start (`starting-point-node-id`) */
  node?: Guid;
  /** `web-behaviours=0`: Website behaviours off for this view (Wecra's; webBehaviours.ts) */
  websiteBehaviours?: boolean;
}

/**
 * Figma's prototype URL parameters (atlas 13 §10.6, `pathToSelectedView`) as the view's options: `scaling` (min-zoom →
 * Actual size, scale-down → Fit width and height, scale-down-width → Fit width, contain → Fill screen, or Responsive with
 * `content-scaling=responsive`), `hotspot-hints=0`, `device-frame=0`, `hide-ui=1`, `node-id` / `starting-point-node-id`
 * ("1-2" or "1:2"). The others (`bg-color`, `bare-ui`, `disable-default-keyboard-nav`, comments, versions, popouts) have
 * nothing to set here yet.
 */
export function presentUrlOptions(params: URLSearchParams): PresentUrlOptions {
  const out: PresentUrlOptions = {};
  const scaling = params.get("scaling");
  const responsive = params.get("content-scaling") === "responsive";
  const scale: PresentScale | undefined =
    scaling === "min-zoom" ? "ACTUAL" : scaling === "scale-down" ? "FIT" : scaling === "scale-down-width" ? "FIT_WIDTH" : scaling === "contain" ? (responsive ? "RESPONSIVE" : "FILL") : undefined;
  if (scale) out.scale = scale;
  if (params.get("hotspot-hints") === "0") out.hints = false;
  if (params.get("device-frame") === "0") out.deviceFrame = false;
  if (params.get("hide-ui") === "1") out.hideUi = true;
  const id = (params.get("node-id") ?? params.get("starting-point-node-id") ?? "").replace("-", ":");
  if (/^\d+:\d+$/.test(id)) out.node = id;
  const web = webBehavioursParam(params);
  if (web !== undefined) out.websiteBehaviours = web;
  return out;
}

/** The scale options in Figma's menu order, without a device and with one. */
const SCALES: { value: PresentScale; label: string }[] = [
  { value: "ACTUAL", label: "Actual size (100%)" },
  { value: "RESPONSIVE", label: "Responsive" },
  { value: "FIT_WIDTH", label: "Fit width" },
  { value: "FIT", label: "Fit width and height" },
  { value: "FILL", label: "Fill screen" },
];
const DEVICE_SCALES: { value: PresentScale; label: string }[] = [
  { value: "FIT", label: "Fit device on screen" },
  { value: "FILL", label: "Zoom device to fill screen" },
  { value: "ACTUAL", label: "Show device at 100%" },
];

/**
 * The scale options in Figma's order for the file (atlas 13 §10.1; the player's `scaleOrder`, else its classes here):
 * every frame 16:9 or a Presentation device — Fill screen, Actual size, Fit width and height, Fit width, Responsive; a
 * Custom device — Fit width and height, Fill screen, Actual size, Responsive, Fit width; a first frame wider than
 * 1024 px — Actual size, Responsive, Fit width, Fit width and height, Fill screen; narrower — Actual size, Fit width
 * and height, Fit width, Responsive, Fill screen.
 */
export function scaleOrder(state: PresentState | null): PresentScale[] {
  if (state?.scaleOrder?.length && !state.device) return state.scaleOrder;
  if (state?.deviceType === "PRESENTATION" || state?.allWide) return ["FILL", "ACTUAL", "FIT", "FIT_WIDTH", "RESPONSIVE"];
  if (state?.deviceType === "CUSTOM") return ["FIT", "FILL", "ACTUAL", "RESPONSIVE", "FIT_WIDTH"];
  return (state?.firstFrameWidth ?? 0) > 1024 ? ["ACTUAL", "RESPONSIVE", "FIT_WIDTH", "FIT", "FILL"] : ["ACTUAL", "FIT", "FIT_WIDTH", "RESPONSIVE", "FILL"];
}

/** The options Figma recommends for the file (help "Play your prototypes"): the first two of its order, the default first. */
export function recommendedScales(state: PresentState | null): PresentScale[] {
  return scaleOrder(state).slice(0, 2);
}

/** A phone's or a tablet's browser (Figma's mobile viewer: Fit width, no device frame — atlas 13 §10.1, §10.7). */
export function isMobileBrowser(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
}

/** The machine the prototype plays on (the player's scroll physics, ⌘ in key triggers). */
export function presentHost(platform: string = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : ""): "mac" | "windows" | "linux" | "other" {
  const p = platform.toLowerCase();
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
  if (p.includes("win")) return "windows";
  if (p.includes("linux") || p.includes("android")) return "linux";
  return "other";
}

/**
 * Hide / show UI's key with ⌘ (Ctrl off the Mac), atlas 13 §10.3: \ — the character on that key in each keyboard
 * layout Figma adapts it to (German ^, Swedish / Finnish / UK-Mac §, UK-PC `, Danish $, Norwegian ' or |, Spanish º,
 * French AZERTY and Japanese kana @, Korean ₩); the physical Backslash key too.
 */
export const HIDE_UI_KEYS: readonly string[] = ["\\", "^", "§", "`", "$", "'", "|", "º", "@", "₩"];

/** Whether a keydown is Hide / show UI (⌘ on the Mac, Ctrl elsewhere, no other modifier). */
export function isHideUiKey(e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac = presentHost() === "mac"): boolean {
  if ((mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) || e.altKey) return false;
  return e.code === "Backslash" || HIDE_UI_KEYS.includes(e.key);
}

/** The view's own options (not the engine's): Figma's shortcuts, the sidebar, the UI. */
export interface ViewOptions {
  shortcuts: boolean;
  sidebar: boolean;
  hideUi: boolean;
}

/** Each scale option's glyph (live 2026-10-20: the Options menu's 24 icons, also the inline preview's). */
export const SCALE_ICON: Record<PresentScale, IconName> = {
  ACTUAL: "24.proto.scale.actual",
  FIT: "24.proto.scale.fit",
  FIT_WIDTH: "24.proto.scale.fit.width",
  FILL: "24.proto.scale.fill",
  RESPONSIVE: "24.proto.scale.responsive",
};

/**
 * The options menu's entries for a state (the full view's; the inline preview has its own). Live 2026-10-20
 * (prototype-preview.txt): "Recommended" — the file's first two scales —, "Other scaling options" — the rest —, each
 * with its glyph, "Z" beside the option Z goes to next; then "Advanced settings ›" (Enable Figma shortcuts, Show
 * hints on click) and "Hide UI ⌘\". With a device: Responsive / Fixed size instead (its scales are in the footer's
 * device menu).
 */
export function presentOptions(state: PresentState | null, view: ViewOptions = { shortcuts: true, sidebar: false, hideUi: false }): MenuEntry[] {
  const device = !!state?.device;
  const scale = state?.scale;
  const order = scaleOrder(state);
  const next = scale ? order[(order.indexOf(scale) + 1) % order.length] : undefined;
  const scaleEntry = (v: PresentScale): MenuEntry => ({ id: `scale:${v}`, label: t(SCALES.find((s) => s.value === v)!.label), icon: SCALE_ICON[v], checked: scale === v, ...(v === next ? { shortcut: "Z" } : {}) });
  return [
    ...(device
      ? [
          { id: "responsive:on", label: t("Responsive"), checked: !!state?.responsive },
          { id: "responsive:off", label: t("Fixed size"), checked: !state?.responsive },
        ]
      : [{ header: t("Recommended") }, ...order.slice(0, 2).map(scaleEntry), { header: t("Other scaling options") }, ...order.slice(2).map(scaleEntry)]),
    "-",
    {
      id: "advanced",
      label: t("Advanced settings"),
      items: [
        { id: "shortcuts", label: t("Enable Figma shortcuts"), checked: view.shortcuts },
        { id: "hints", label: t("Show hints on click"), checked: state?.hints !== false },
        // Wecra's (webBehaviours.ts): the prototype plays like a website.
        "-",
        ...webMenuEntries(state),
      ],
    },
    { id: "hide-ui", label: t("Hide UI"), checked: view.hideUi, shortcut: presentHost() === "mac" ? "⌘\\" : "Ctrl+\\" },
  ];
}

/** With a device: the bottom bar's device menu (help: "Use the device switcher … access other scaling options"). */
export function deviceOptions(state: PresentState | null): MenuEntry[] {
  const scale = state?.scale;
  return [
    ...DEVICE_SCALES.map((s) => ({ id: `scale:${s.value}`, label: t(s.label), checked: scale === s.value || (s.value === "FIT" && (scale === "FIT_WIDTH" || scale === "RESPONSIVE")) })),
    ...(state?.hasDeviceFrame ? ["-" as const, { id: "frame", label: t("Show device frame"), checked: state.deviceFrame !== false }] : []),
  ];
}

/** The keyboard shortcuts of the presentation view (the dialog "?" opens; wording ours where Figma's isn't published). */
export const PRESENT_SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "Next frame", keys: ["→", "Space", "N"] },
  { label: "Previous frame", keys: ["←"] },
  { label: "Restart", keys: ["R"] },
  { label: "Change scale option", keys: ["Z"] },
  { label: "Full screen", keys: ["F"] },
  { label: "Comments", keys: ["C"] },
  { label: "Keyboard shortcuts", keys: ["?"] },
];

/** A device preset's name as the bottom bar shows it ("IPHONE_15_PRO" → "iPhone 15 Pro"). */
export function deviceName(preset: string | undefined): string {
  if (!preset) return t("Device");
  const words = preset.split("_").map((w) => {
    const l = w.toLowerCase();
    if (l === "iphone") return "iPhone";
    if (l === "ipad") return "iPad";
    if (l === "macbook") return "MacBook";
    if (l === "se") return "SE";
    return l.charAt(0).toUpperCase() + l.slice(1);
  });
  return words.join(" ");
}

/** Applies an options menu entry (presentOptions' ids) to the engine; `stateKey`: where Keep state on reload keeps it. */
export function applyPresentOption(engine: Engine, state: PresentState | null, id: string, stateKey?: () => string | null): void {
  if (applyWebOption(engine, state, id, stateKey)) return;
  if (id === "hints") engine.presentSetOptions({ hints: state?.hints === false });
  else if (id === "shortcuts") engine.presentSetOptions({ shortcuts: state?.shortcuts === false });
  else if (id === "frame") engine.presentSetOptions({ deviceFrame: state?.deviceFrame === false });
  else if (id.startsWith("responsive:")) engine.presentSetOptions({ responsive: id === "responsive:on" });
  else if (id.startsWith("scale:")) engine.presentSetOptions({ scale: id.slice(6) as PresentScale });
}

const POINTER = { down: 0, move: 1, up: 2, cancel: 3, enter: 4, leave: 5 } as const;
const POINTER_TYPE: Record<string, number> = {
  pointerdown: POINTER.down,
  pointermove: POINTER.move,
  pointerup: POINTER.up,
  pointercancel: POINTER.cancel,
  pointerleave: POINTER.leave,
};

/** After the next frame is drawn (a hidden page, which draws none: after 100 ms) — what follows is a task of its own. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });
}

function modsOf(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): number {
  return (e.shiftKey ? MOD_SHIFT : 0) | (e.altKey ? MOD_ALT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.metaKey ? MOD_META : 0);
}

declare global {
  interface Window {
    /** The presentation's engine, for scripts (tools/editor-shot.mjs) */
    __designerPresent?: Engine;
  }
}

const SIDEBAR_KEY = "designer.present.sidebar";
const readSidebar = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
};

export function PresentationView({ source, page, node, onClose, onReady, onShare, canvasId = "present-canvas", variant = "full", onRestart, onOpenEditor, onState, urlOptions, hidden = false }: PresentationViewProps) {
  useT();
  const inline = variant === "inline";
  const onStateRef = useRef(onState);
  useEffect(() => {
    onStateRef.current = onState;
  }, [onState]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [state, setState] = useState<PresentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastState = useRef("");
  // Asks for the next screens to be derived while idle (set while presenting).
  const deriveAhead = useRef<(() => void) | null>(null);
  const videoHost = useRef<HTMLDivElement>(null);
  // The view's own options: the flows sidebar (remembered), the UI hidden, the keyboard shortcuts dialog.
  const [sidebar, setSidebarState] = useState(readSidebar);
  const [hideUi, setHideUi] = useState(!!urlOptions?.hideUi);
  const hideUiRef = useRef(hideUi);
  hideUiRef.current = hideUi;
  const toggleHideUi = () => {
    const next = !hideUiRef.current;
    hideUiRef.current = next;
    setHideUi(next);
    // Figma: "Remind you how to restore the toolbar and footer."
    if (next) showToast({ message: t("UI hidden. Use the options button in the corner, or {key}, to show it again.", { key: presentHost() === "mac" ? "⌘\\" : "Ctrl+\\" }) });
  };
  const [keysOpen, setKeysOpen] = useState(false);
  const setSidebar = useCallback((on: boolean) => {
    setSidebarState(on);
    try {
      localStorage.setItem(SIDEBAR_KEY, on ? "1" : "0");
    } catch {
      /* not remembered */
    }
  }, []);

  // Keep state on reload (webBehaviours.ts): where this prototype's state is kept in the tab's session storage.
  const keptKey = useRef<string | null>(null);
  const readState = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || engine.destroyed) return;
    const s = engine.presentState();
    for (const e of s.events) if (e.type === "OPEN_URL" && e.url) window.open(e.url, e.newTab ? "_blank" : "_self", "noopener");
    // Restart forgets what was kept.
    if (keptKey.current && s.events.some((e) => e.type === "RESTARTED")) forgetKeptState(keptKey.current);
    const { events: _events, ...rest } = s;
    void _events;
    const key = JSON.stringify(rest);
    // The cursor at once (website behaviours: per hotspot; Figma's: a hand over hotspots, grabbing while dragging).
    if (canvasRef.current) canvasRef.current.style.cursor = s.cursor ?? (s.scrubbing ? "grabbing" : s.hotspot ? "pointer" : "default");
    if (key !== lastState.current) {
      lastState.current = key;
      setState(s);
      onStateRef.current?.(s);
      deriveAhead.current?.();
      if (keptKey.current && s.active && s.websiteBehaviours !== false && readWebOptions().keepState) saveKeptState(engine, keptKey.current);
    }
  }, []);

  // The engine and its document, once per mount: loaded, sized, fed the source's changes (hidden too).
  const [ready, setReady] = useState<Engine | null>(null);
  const presentingRef = useRef(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let engine: Engine | null = null;
    const cleanups: (() => void)[] = [];
    // An engine handed over by the view this one replaces (the inline preview's, Present here's): no new load.
    const handed = source.takeEngine?.() ?? null;
    // (React's development double mount undoes this mount at once: a handed engine goes back untouched.)
    let settled = false;
    const settle = window.setTimeout(() => (settled = true), 0);
    (async () => {
      if (handed) {
        engine = handed;
        engineRef.current = engine;
        window.__designerPresent = engine;
        engine.moveTo(canvas);
      } else {
        const created = await Engine.create(canvas, { theme: "DARK", wire: "kiwi", sessionID: 1 });
        if (disposed) return created.destroy();
        // The document once the engine is up: a mount undone meanwhile (React's development double mount) encodes nothing.
        const doc = source.loadInto ? null : await source.load();
        if (disposed) return created.destroy();
        engine = created;
        engineRef.current = engine;
        window.__designerPresent = engine;
        if (source.images) engine.setImageSource(source.images);
        // Its page's screens are derived as they are shown (the first one only, now), not the whole page; a page's subset
        // (the editor's) keeps out what happens elsewhere.
        engine.setPartial({ subset: !!source.partial, screens: true });
        if (source.loadInto) source.loadInto(engine);
        else if (doc) {
          engine.loadKiwi(doc.bytes, page ? { page } : {});
          for (const frame of doc.frames ?? []) engine.applyChangesKiwi(frame, "load");
        }
        // The load, the first screen and its first frame are separate tasks: the editor draws in between.
        await nextTask();
        if (disposed) return;
      }
      // The size first: the player lays the screen out in the canvas.
      const observer = new ResizeObserver(() => {
        const r = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        if (r.width > 0 && r.height > 0 && engine && !engine.destroyed) {
          engine.setViewport(r.width, r.height, dpr, Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr)));
          engine.frameNow(); // drawn before this frame is painted: never a blank or stretched canvas (CanvasController.observeSize)
          readState();
        }
      });
      observer.observe(canvas);
      cleanups.push(() => observer.disconnect());
      cleanups.push(followSource(engine, source, page, () => presentingRef.current, readState));
      setReady(engine);
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      disposed = true;
      for (const c of cleanups.splice(0)) c();
      if (window.__designerPresent === engine) delete window.__designerPresent;
      window.clearTimeout(settle);
      // Kept for the view that takes over (Present here from the inline preview and back), else gone.
      if (engine && !engine.destroyed && !source.keepEngine?.(engine, !settled && engine === handed)) engine.destroy();
      engineRef.current = null;
    };
    // The source and page are fixed for a mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Presenting while shown: the player from `node`, the videos, the state read; hidden, the engine is idle (no player,
  // no frames). A layout effect: shown again, it presents before the canvas's size is observed and painted.
  useLayoutEffect(() => {
    const engine = ready;
    const canvas = canvasRef.current;
    if (!engine || engine.destroyed || !canvas) return;
    if (hidden) {
      engine.setPaused(true);
      return;
    }
    engine.setPaused(false);
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    engine.setViewport(Math.max(1, r.width), Math.max(1, r.height), dpr, Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr)));
    // Website behaviours: the viewer's own setting (a link's web-behaviours=0 over it), before the start picks a breakpoint.
    const web = readWebOptions();
    const websiteBehaviours = urlOptions?.websiteBehaviours ?? web.websiteBehaviours;
    engine.presentSetOptions({ host: presentHost(), websiteBehaviours });
    const start = node ?? urlOptions?.node;
    const status = engine.presentStart({ ...(page ? { page } : {}), ...(start ? { node: start } : {}) });
    // (Told after this effect: the page may have gained frames since a failed opening.)
    const failed = status !== Status.OK;
    queueMicrotask(() => setError(failed ? t("This page has no frames to present") : null));
    if (failed) return;
    presentingRef.current = true;
    // Keep state on reload: what this tab kept for this prototype comes back; saved again as it changes, and as the page
    // goes (a reload).
    const kept = keptStateKey(source.stateKey ?? source.fileName, page, start);
    keptKey.current = kept;
    if (websiteBehaviours && web.keepState) restoreKeptState(engine, kept);
    const onPageHide = () => {
      if (!engine.destroyed && engine.presentState().websiteBehaviours !== false && readWebOptions().keepState) saveKeptState(engine, kept);
    };
    window.addEventListener("pagehide", onPageHide);
    // A prototype link's parameters, over the file's own settings; in a mobile browser Fit width and no device frame
    // unless the link says otherwise.
    const mobile = !inline && isMobileBrowser();
    const { scale = mobile ? "FIT_WIDTH" : undefined, hints, deviceFrame = mobile ? false : undefined } = urlOptions ?? {};
    if (scale || hints !== undefined || deviceFrame !== undefined) engine.presentSetOptions({ ...(scale ? { scale } : {}), ...(hints !== undefined ? { hints } : {}), ...(deviceFrame !== undefined ? { deviceFrame } : {}) });
    // The videos: played by the browser, decided by the player.
    const videos = new PresentationVideos(engine, source.images, videoHost.current);
    (window as unknown as { __designerVideos?: PresentationVideos }).__designerVideos = videos;
    // After delay, transitions and the scale change the state without input: read it a few times a second.
    const timer = window.setInterval(readState, 150);
    readState();
    if (!inline) canvas.focus({ preventScroll: true });
    onReady?.(engine);
    // What comes next — the screens the shown one leads to — derived while the browser is idle (one screen at least a
    // call), so going there doesn't wait for it; again after each change of screen. Only in a real pause (no frame due):
    // a heavy screen takes 50–130 ms, which in a running animation or a drag would be a dropped run of frames.
    let idle = 0;
    const idleCall = (fn: (deadline?: IdleDeadline) => void): number => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn) : window.setTimeout(fn, 50));
    const derive = (deadline?: IdleDeadline) => {
      idle = 0;
      if (engine.destroyed) return;
      const left = deadline?.timeRemaining() ?? 50;
      if (left < 30) idle = idleCall(derive);
      else if (engine.deriveNext(Math.min(8, left))) idle = idleCall(derive);
    };
    idle = idleCall(derive);
    deriveAhead.current = () => {
      if (!idle && !engine.destroyed) idle = idleCall(derive);
    };
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      keptKey.current = null;
      deriveAhead.current = null;
      if (idle) (typeof cancelIdleCallback === "function" ? cancelIdleCallback : window.clearTimeout)(idle);
      window.clearInterval(timer);
      videos.dispose();
      presentingRef.current = false;
      if (engine.destroyed) return;
      engine.presentStop();
      engine.setPaused(true);
    };
    // Shown again: from the `node` of that opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hidden]);

  // Keys: the prototype's first (Key / Gamepad), then the presentation's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine || engine.destroyed) return;
      const target = e.target as HTMLElement | null;
      // (The prototype's own canvas is in the inline preview's dialog: its keys are the prototype's.)
      if (target && target !== canvasRef.current && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.closest("[role='menu'],[role='dialog']"))) return;
      if (e.type === "keyup") {
        engine.presentKey("up", e.keyCode, modsOf(e));
        return;
      }
      // The inline preview: Esc or ⇧Space close it before the prototype sees them (Figma's listener on its iframe; the
      // viewer's own next-frame keys leave ⇧Space alone there).
      if (inline && onClose && (e.key === "Escape" || (e.code === "Space" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey))) {
        e.preventDefault();
        // Website behaviours: Esc closes the prototype's dismissible overlay first (or leaves a field).
        if (e.key === "Escape" && engine.presentState().websiteBehaviours !== false && engine.presentKey("down", e.keyCode, modsOf(e))) {
          readState();
          return;
        }
        onClose();
        return;
      }
      // The inline preview's R: from the last frame selected on the canvas.
      if (inline && onRestart && e.code === "KeyR" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (keptKey.current) forgetKeptState(keptKey.current);
        onRestart();
        readState();
        return;
      }
      if (engine.presentKey("down", e.keyCode, modsOf(e))) {
        e.preventDefault();
        readState();
        return;
      }
      if (inline) return;
      if (isHideUiKey(e)) {
        e.preventDefault();
        toggleHideUi();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || inline) return;
      const shortcuts = engine.presentState().shortcuts !== false;
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else onClose();
      } else if (e.key === "?") {
        e.preventDefault();
        setKeysOpen(true);
      } else if (e.code === "KeyF" && shortcuts) {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.code === "KeyC" && shortcuts) {
        // Comments: there is no multiplayer to comment with.
        e.preventDefault();
        showToast({ message: t("Comments aren't available in this app") });
      }
    };
    // The inline preview takes keys only while it has the focus (the editor keeps its own).
    const target: HTMLElement | Window | null = inline ? canvasRef.current : window;
    if (!target) return;
    target.addEventListener("keydown", onKey as EventListener, true);
    target.addEventListener("keyup", onKey as EventListener, true);
    return () => {
      target.removeEventListener("keydown", onKey as EventListener, true);
      target.removeEventListener("keyup", onKey as EventListener, true);
    };
  }, [onClose, readState, inline, onRestart]);

  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current;
    if (!engine || engine.destroyed) return;
    const type = POINTER_TYPE[e.type] ?? POINTER.move;
    if (type === POINTER.down) {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus({ preventScroll: true });
    }
    const [x, y] = at(e);
    engine.presentPointer(type, x, y, e.buttons, modsOf(e));
    if (type !== POINTER.move) readState();
    else e.currentTarget.style.cursor = engine.presentCursor();
  };

  // Website behaviours: a text input the prototype focused takes the typing through a hidden <textarea> over it — the
  // caret, the selection, IME, the clipboard are the browser's; the engine draws them and the text.
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fieldSerial = useRef<string>("");
  const field = state?.field ?? null;
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    if (!field) {
      fieldSerial.current = "";
      if (document.activeElement === el) canvasRef.current?.focus({ preventScroll: true });
      return;
    }
    const serial = `${field.id}#${field.serial}`;
    if (serial !== fieldSerial.current) {
      fieldSerial.current = serial;
      el.value = field.value;
      el.setSelectionRange(field.start, field.end);
      // Only when the prototype moved the focus or the caret (a click, Tab): typing elsewhere keeps its focus.
      if (document.activeElement !== el) el.focus({ preventScroll: true });
    }
  }, [field]);
  const syncField = () => {
    const el = fieldRef.current;
    const engine = engineRef.current;
    if (!el || !engine || engine.destroyed || !field) return;
    engine.presentText(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length);
    readState();
  };
  const onFieldKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const engine = engineRef.current;
    if (!engine || engine.destroyed) return;
    // Tab, Esc and (one line) Enter are the prototype's: its Key / Gamepad triggers, then focus, leave, submit.
    const multi = field?.type === "MULTI_LINE";
    if (e.key === "Tab" || e.key === "Escape" || (e.key === "Enter" && !multi && !e.nativeEvent.isComposing)) {
      if (engine.presentKey("down", e.keyCode, modsOf(e)) || e.key !== "Escape") e.preventDefault();
      readState();
    }
  };
  const fieldInput = (
    <textarea
      ref={fieldRef}
      className={styles.fieldInput}
      aria-label={t("Text input")}
      aria-hidden={field ? undefined : true}
      tabIndex={-1}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      inputMode={field?.type === "NUMBER" ? "decimal" : field?.type === "EMAIL" ? "email" : "text"}
      style={field ? { left: field.rect.x, top: field.rect.y, width: Math.max(1, field.rect.w), height: Math.max(1, field.rect.h) } : undefined}
      onInput={syncField}
      onSelect={syncField}
      onKeyUp={syncField}
      onKeyDown={onFieldKey}
    />
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const engine = engineRef.current;
      if (!engine || engine.destroyed) return;
      e.preventDefault();
      const [x, y] = at(e);
      engine.presentWheel(x, y, e.deltaX, e.deltaY, e.deltaMode);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const command = (c: "restart" | "next" | "previous" | "back" | "scale") => {
    engineRef.current?.presentCommand(c);
    readState();
    canvasRef.current?.focus({ preventScroll: true });
  };
  const flows = state?.flows ?? [];
  const options: MenuEntry[] = presentOptions(state, { shortcuts: state?.shortcuts !== false, sidebar, hideUi });
  const onOption = (id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (id === "sidebar") setSidebar(!sidebar);
    else if (id === "hide-ui") toggleHideUi();
    else if (id === "keys") setKeysOpen(true);
    else applyPresentOption(engine, state, id, () => keptKey.current);
    readState();
    canvasRef.current?.focus({ preventScroll: true });
  };
  const share = () => {
    if (onShare) return onShare(state?.screen ?? null);
    const url = new URL(window.location.href);
    if (state?.screen) url.searchParams.set("node", state.screen);
    void navigator.clipboard?.writeText(url.toString()).then(
      () => showToast({ message: t("Link copied to clipboard") }),
      () => showToast({ message: t("The link couldn't be copied"), kind: "error" }),
    );
  };
  const restart = () => {
    if (onRestart) {
      if (keptKey.current) forgetKeptState(keptKey.current);
      onRestart();
      readState();
    } else {
      command("restart");
    }
  };
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }
  const startFlow = (id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.presentStart({ node: id });
    readState();
  };
  const openEditor = onOpenEditor ?? onClose;

  const canvas = (
    <canvas
      ref={canvasRef}
      // Its own id: the engine finds its canvas by selector, and the editor's is "engine-canvas".
      id={canvasId}
      className={styles.canvas}
      tabIndex={0}
      aria-label={t("Prototype")}
      onPointerDown={onPointer}
      onPointerMove={onPointer}
      onPointerUp={onPointer}
      onPointerCancel={onPointer}
      onPointerLeave={onPointer}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
  // The inline preview draws its own header (InlinePreview.tsx: Figma's draggable window); here only the prototype.
  if (inline)
    return (
      <div className={styles.inline} data-presentation="inline">
        <div className={styles.stage}>
          {canvas}
          {fieldInput}
          <div ref={videoHost} className={styles.videos} aria-hidden />
          {!state && !error && (
            <div className={styles.center}>
              <Spinner />
            </div>
          )}
          {error && <div className={styles.center}>{error}</div>}
        </div>
      </div>
    );

  // Live 2026-10-20 (prototype-preview.txt): the Options button is a 48 × 46 glyph button at the bar's right.
  const optionsButton = (
    <MenuButton label={t("Options")} entries={options} onSelect={onOption} className={styles.barButton} align="end" tooltip>
      <Icon name="24.adjust" />
    </MenuButton>
  );
  const current = flows.find((f) => f.node === state?.flow) ?? null;
  return (
    <div className={styles.root} data-presentation data-hide-ui={hideUi || undefined}>
      {/* Live: a 48 high bar (and its line) — the flows list and comments at the left, the file's name and its ▾
          ("Open in editor") in the middle, Share prototype, Options and full screen at the right. */}
      {!hideUi && (
        <header className={styles.top}>
          <button type="button" className={styles.barButton} aria-label={sidebar ? t("Close flows list") : t("Open flows list")} aria-pressed={sidebar} onClick={() => setSidebar(!sidebar)}>
            <Icon name="24.proto.flows.list" />
          </button>
          {/* Comments need other people (multiplayer): shown as Figma has it, not available here. */}
          <button type="button" className={styles.barButton} aria-label={t("Comments aren't available in this app")} disabled>
            <Icon name="24.comment" />
          </button>
          <div className={styles.title}>
            <h1 className={styles.file}>{source.fileName}</h1>
            {openEditor && (
              <MenuButton label={t("Options dropdown")} entries={[{ id: "editor", label: t("Open in editor") }]} onSelect={() => openEditor()} className={styles.caret}>
                <Icon name="24.caret.down" />
              </MenuButton>
            )}
          </div>
          <span className={styles.grow} />
          <Button variant="primary" size="large" onClick={share}>
            {t("Share prototype")}
          </Button>
          {optionsButton}
          <button type="button" className={styles.barButton} aria-label={document.fullscreenElement ? t("Exit full screen") : t("Enter full screen")} onClick={toggleFullscreen}>
            <Icon name="24.fullscreen.enter" />
          </button>
        </header>
      )}
      <div className={styles.body}>
        {/* Live: the flows sidebar — "Flows" and ×, a row per flow, the current flow's description under a line. */}
        {sidebar && !hideUi && (
          <aside className={styles.sidebar} aria-label={t("Flows")}>
            <div className={styles.sidebarHeader}>
              <span>{t("Flows")}</span>
              <IconButton icon="24.close" label={t("Close")} onClick={() => setSidebar(false)} />
            </div>
            {flows.length === 0 && <p className={styles.sidebarEmpty}>{t("No flows on this page")}</p>}
            <ul className={styles.flowList}>
              {flows.map((f) => (
                <li key={f.node}>
                  <button type="button" className={styles.flowRow} aria-current={state?.flow === f.node || undefined} data-flow={f.node} onClick={() => startFlow(f.node)}>
                    <Icon name="16.play" />
                    <span className={styles.flowName}>{f.name || t("Flow")}</span>
                  </button>
                </li>
              ))}
            </ul>
            {flows.length > 0 && (
              <section className={styles.flowDescription} aria-label={t("Flow description")}>
                <p>{current?.description || t("No description")}</p>
              </section>
            )}
          </aside>
        )}
        <div className={styles.stage}>
          {canvas}
          {fieldInput}
          <div ref={videoHost} className={styles.videos} aria-hidden />
          {hideUi && <div className={styles.corner}>{optionsButton}</div>}
          {!state && !error && (
            <div className={styles.center}>
              <Spinner />
            </div>
          )}
          {error && <div className={styles.center}>{error}</div>}
          {/* Live: no footer bar — the ‹ | › stepper floats at the bottom's middle, Restart (R) at its right. */}
          {!hideUi && (
            <div className={styles.footer}>
              <div className={styles.stepper} role="group" aria-label={t("Stepper")}>
                <IconButton icon="24.proto.frame.previous" label={t("Previous frame")} shortcut="←" disabled={!state?.canPrevious} onClick={() => command("previous")} />
                <span className={styles.stepperLine} />
                <IconButton icon="24.proto.frame.next" label={t("Next frame")} shortcut="→" disabled={!state?.canNext} onClick={() => command("next")} />
              </div>
              <div className={styles.footerRight}>
                {state?.device && (
                  <MenuButton label={t("Device")} entries={deviceOptions(state)} onSelect={onOption} placement="top" className={styles.pill}>
                    <span>{deviceName(state.devicePreset)}</span>
                    <Icon name="16.chevron.down" />
                  </MenuButton>
                )}
                <button type="button" className={styles.pill} aria-label={t("Restart")} aria-keyshortcuts="R" onClick={restart}>
                  <Icon name="24.proto.restart" />
                  <span>{t("Restart")}</span>
                  <span className={styles.pillKey} aria-hidden>
                    R
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <Dialog title={t("Keyboard shortcuts")} open={keysOpen} onClose={() => setKeysOpen(false)}>
        <table className={styles.keys}>
          <tbody>
            {PRESENT_SHORTCUTS.map((k) => (
              <tr key={k.label}>
                <td>{t(k.label)}</td>
                <td className={styles.keyCaps}>
                  {k.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {state?.shortcuts === false && <p className={styles.keysNote}>{t("Turn on Enable Figma shortcuts in the options to use these keys.")}</p>}
      </Dialog>
    </div>
  );
}
