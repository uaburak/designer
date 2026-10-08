/**
 * The presentation view (Figma's, R8 §9, help.figma.com 360040318013 "Presentation view layout"): a prototype played by
 * the engine's player (engine/src/proto/Player) on an engine of its own — the same Wasm renderer as the canvas —, over
 * the page's prototype background, its videos played by the browser (presentationVideos.ts). The toolbar: left, the
 * sidebar toggle (the left sidebar lists the page's flows with their descriptions) and comments (shown, disabled:
 * there is no multiplayer); the file and the flow; right, Share, the options menu (Enable Figma shortcuts, Show hints
 * on click, Show sidebar, Hide UI, Keyboard shortcuts, then the scale options — "Recommended" and "Other" without a
 * device, Responsive / Fixed size with one) and full screen. Below: ← → (previous / next frame), the device's scaling
 * menu (with a device: Fit device on screen, Zoom device to fill screen, Show device at 100%, Show device frame) and
 * Restart. Keys as Figma's: → Space N next frame, ← previous, R restart, Z the next scale option, F full screen (with
 * "Enable Figma shortcuts"), ? the keyboard shortcuts, Esc leaves (in this tab); interactions with Key / Gamepad
 * triggers take their keys first.
 *
 * The document comes from a PresentationSource: the store's file opened read-only in a tab of its own (PresentRoute),
 * or the editor's engine when presenting in its own tab; its live changes keep the prototype current.
 *
 * Options (help.figma.com 360040318013): without a device Actual size (100%), Responsive, Fit width, Fit width and
 * height, Fill screen; with one Responsive / Fixed size, Fit device on screen, Zoom device to fill screen, Show device
 * at 100%, Show device frame. The `inline` variant is the editor's inline preview (InlinePreview.tsx): its own bar of
 * ← →, Restart, the overflow menu, open in presentation view and ×.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog, Icon, IconButton, MenuButton, Spinner, ToggleIconButton, showToast, type MenuEntry } from "@/ds";
import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, Status } from "@/engine/abi";
import { Engine, type ImageSource, type PresentScale, type PresentState } from "@/engine/Engine";
import type { Guid } from "@/engine/codec";
import { PresentationVideos } from "./presentationVideos";
import styles from "./Present.module.css";

export interface PresentationSource {
  /** The file's name (the top bar) */
  fileName: string;
  /** The document: a kiwi Message (the store's snapshot or the editor's own encoding), and journal frames after it */
  load(): Promise<{ bytes: Uint8Array; frames?: Uint8Array[] }>;
  /** Live changes (kiwi NODE_CHANGES Messages) until the returned function is called */
  subscribe?(apply: (bytes: Uint8Array) => void): () => void;
  images?: ImageSource;
}

export interface PresentationViewProps {
  source: PresentationSource;
  /** The canvas's id (the engine finds its canvas by selector; two presentations at once need two) */
  canvasId?: string;
  /** "inline": the editor's inline preview — its own bar, no footer, never full screen */
  variant?: "full" | "inline";
  /** Inline: extra overflow menu entries and their handler (Follow prototype, Resize window to 100%, …) */
  extraOptions?: MenuEntry[];
  onExtraOption?: (id: string) => void;
  /** Inline: Restart (default: the engine's, from the flow's start) and "Open in presentation view" */
  onRestart?: () => void;
  onOpenFull?: () => void;
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
  /** Share (the toolbar's): default, the presentation's link copied */
  onShare?: () => void;
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
 * The scale options Figma recommends for the file (help "Play your prototypes", the table under "Fill screen"): the
 * default first. First frame wider than 1024 px: Actual size, Responsive; narrower: Actual size, Fit width and height;
 * every frame 16:9 or a Presentation device: Fill screen, Actual size; a Custom device: Fit width and height, Fill
 * screen, Actual size.
 */
export function recommendedScales(state: PresentState | null): PresentScale[] {
  if (state?.deviceType === "PRESENTATION" || state?.allWide) return ["FILL", "ACTUAL"];
  if (state?.deviceType === "CUSTOM") return ["FIT", "FILL", "ACTUAL"];
  return (state?.firstFrameWidth ?? 0) > 1024 ? ["ACTUAL", "RESPONSIVE"] : ["ACTUAL", "FIT"];
}

/** The view's own options (not the engine's): Figma's shortcuts, the sidebar, the UI. */
export interface ViewOptions {
  shortcuts: boolean;
  sidebar: boolean;
  hideUi: boolean;
}

/** The options menu's entries for a state (the full view's; the inline preview has its own). */
export function presentOptions(state: PresentState | null, view: ViewOptions = { shortcuts: true, sidebar: false, hideUi: false }): MenuEntry[] {
  const device = !!state?.device;
  const scale = state?.scale;
  const recommended = recommendedScales(state);
  const scaleEntry = (v: PresentScale) => ({ id: `scale:${v}`, label: SCALES.find((s) => s.value === v)!.label, checked: scale === v });
  return [
    { id: "shortcuts", label: "Enable Figma shortcuts", checked: view.shortcuts },
    { id: "hints", label: "Show hints on click", checked: state?.hints !== false },
    { id: "sidebar", label: "Show sidebar", checked: view.sidebar },
    { id: "hide-ui", label: "Hide UI", checked: view.hideUi },
    "-",
    ...(device
      ? [{ id: "responsive:on", label: "Responsive", checked: !!state?.responsive }, { id: "responsive:off", label: "Fixed size", checked: !state?.responsive }]
      : [
          { header: "Recommended" },
          ...recommended.map(scaleEntry),
          { header: "Other" },
          ...SCALES.filter((s) => !recommended.includes(s.value)).map((s) => scaleEntry(s.value)),
        ]),
    "-",
    { id: "keys", label: "Keyboard shortcuts", shortcut: "?" },
  ];
}

/** With a device: the bottom bar's device menu (help: "Use the device switcher … access other scaling options"). */
export function deviceOptions(state: PresentState | null): MenuEntry[] {
  const scale = state?.scale;
  return [
    ...DEVICE_SCALES.map((s) => ({ id: `scale:${s.value}`, label: s.label, checked: scale === s.value || (s.value === "FIT" && (scale === "FIT_WIDTH" || scale === "RESPONSIVE")) })),
    ...(state?.hasDeviceFrame ? ["-" as const, { id: "frame", label: "Show device frame", checked: state.deviceFrame !== false }] : []),
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
  if (!preset) return "Device";
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

/** Applies an options menu entry (presentOptions' ids) to the engine. */
export function applyPresentOption(engine: Engine, state: PresentState | null, id: string): void {
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

export function PresentationView({ source, page, node, onClose, onReady, onShare, canvasId = "present-canvas", variant = "full", extraOptions, onExtraOption, onRestart, onOpenFull, onState }: PresentationViewProps) {
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
  const videoHost = useRef<HTMLDivElement>(null);
  // The view's own options: the flows sidebar (remembered), the UI hidden, the keyboard shortcuts dialog.
  const [sidebar, setSidebarState] = useState(readSidebar);
  const [hideUi, setHideUi] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const setSidebar = useCallback((on: boolean) => {
    setSidebarState(on);
    try {
      localStorage.setItem(SIDEBAR_KEY, on ? "1" : "0");
    } catch {
      /* not remembered */
    }
  }, []);

  const readState = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || engine.destroyed) return;
    const s = engine.presentState();
    for (const e of s.events) if (e.type === "OPEN_URL" && e.url) window.open(e.url, e.newTab ? "_blank" : "_self", "noopener");
    const { events: _events, ...rest } = s;
    void _events;
    const key = JSON.stringify(rest);
    if (key !== lastState.current) {
      lastState.current = key;
      setState(s);
      onStateRef.current?.(s);
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let engine: Engine | null = null;
    const cleanups: (() => void)[] = [];
    (async () => {
      const [created, doc] = await Promise.all([Engine.create(canvas, { theme: "DARK", wire: "kiwi", sessionID: 1 }), source.load()]);
      if (disposed) return created.destroy();
      engine = created;
      engineRef.current = engine;
      window.__designerPresent = engine;
      if (source.images) engine.setImageSource(source.images);
      engine.loadKiwi(doc.bytes, page ? { page } : {});
      for (const frame of doc.frames ?? []) engine.applyChangesKiwi(frame, "load");
      // The size first: the player lays the screen out in the canvas.
      const observer = new ResizeObserver(() => {
        const r = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        if (r.width > 0 && r.height > 0 && engine && !engine.destroyed) {
          engine.setViewport(r.width, r.height, dpr, Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr)));
          readState();
        }
      });
      observer.observe(canvas);
      cleanups.push(() => observer.disconnect());
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      engine.setViewport(Math.max(1, r.width), Math.max(1, r.height), dpr, Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr)));
      const status = engine.presentStart({ ...(page ? { page } : {}), ...(node ? { node } : {}) });
      if (status !== Status.OK) {
        setError("This page has no frames to present");
        return;
      }
      if (source.subscribe) cleanups.push(source.subscribe((bytes) => engine && !engine.destroyed && engine.applyChangesKiwi(bytes, "remote")));
      // The videos: played by the browser, decided by the player.
      const videos = new PresentationVideos(engine, source.images, videoHost.current);
      cleanups.push(() => videos.dispose());
      (window as unknown as { __designerVideos?: PresentationVideos }).__designerVideos = videos;
      // After delay, transitions and the scale change the state without input: read it a few times a second.
      const timer = window.setInterval(readState, 150);
      cleanups.push(() => window.clearInterval(timer));
      readState();
      if (!inline) canvas.focus({ preventScroll: true });
      onReady?.(engine);
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      disposed = true;
      for (const c of cleanups.splice(0)) c();
      if (window.__designerPresent === engine) delete window.__designerPresent;
      engine?.destroy();
      engineRef.current = null;
    };
    // The source, page and start are fixed for a mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Keys: the prototype's first (Key / Gamepad), then the presentation's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine || engine.destroyed) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.closest("[role='menu']"))) return;
      if (e.type === "keyup") {
        engine.presentKey("up", e.keyCode, modsOf(e));
        return;
      }
      // The inline preview's R: from the last frame selected on the canvas.
      if (inline && onRestart && e.code === "KeyR" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        onRestart();
        readState();
        return;
      }
      if (engine.presentKey("down", e.keyCode, modsOf(e))) {
        e.preventDefault();
        readState();
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
        showToast({ message: "Comments aren't available in this app" });
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
  };
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
  const flowMenu: MenuEntry[] = flows.length
    ? flows.map((f) => ({ id: f.node, label: f.name || "Flow", checked: state?.flow === f.node }))
    : [{ id: "none", label: "No flows on this page", disabled: true }];
  const options: MenuEntry[] = inline ? (extraOptions ?? []) : presentOptions(state, { shortcuts: state?.shortcuts !== false, sidebar, hideUi });
  const onOption = (id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (inline) onExtraOption?.(id);
    else if (id === "sidebar") setSidebar(!sidebar);
    else if (id === "hide-ui") {
      const next = !hideUi;
      setHideUi(next);
      // Figma: "Remind you how to restore the toolbar and footer."
      if (next) showToast({ message: "UI hidden. Use the options button in the corner to show it again." });
    } else if (id === "keys") setKeysOpen(true);
    else applyPresentOption(engine, state, id);
    readState();
    canvasRef.current?.focus({ preventScroll: true });
  };
  const share = () => {
    if (onShare) return onShare();
    const url = new URL(window.location.href);
    if (state?.screen) url.searchParams.set("node", state.screen);
    void navigator.clipboard?.writeText(url.toString()).then(
      () => showToast({ message: "Link copied to clipboard" }),
      () => showToast({ message: "The link couldn't be copied", kind: "error" }),
    );
  };
  const restart = () => {
    if (onRestart) {
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
    if (!engine || id === "none") return;
    engine.presentStart({ node: id });
    readState();
  };

  const canvas = (
    <canvas
      ref={canvasRef}
      // Its own id: the engine finds its canvas by selector, and the editor's is "engine-canvas".
      id={canvasId}
      className={styles.canvas}
      tabIndex={0}
      aria-label="Prototype"
      style={{ cursor: state?.scrubbing ? "grabbing" : state?.hotspot ? "pointer" : "default" }}
      onPointerDown={onPointer}
      onPointerMove={onPointer}
      onPointerUp={onPointer}
      onPointerCancel={onPointer}
      onPointerLeave={onPointer}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
  if (inline)
    return (
      <div className={styles.inline} data-presentation="inline">
        <header className={styles.inlineBar}>
          <IconButton icon="24.arrow.left" label="Back" disabled={!state?.canBack && !state?.canPrevious} onClick={() => command(state?.canBack ? "back" : "previous")} />
          <IconButton icon="24.arrow.right" label="Forward" disabled={!state?.canNext} onClick={() => command("next")} />
          <IconButton icon="24.rotate" label="Restart" shortcut="R" onClick={restart} />
          <span className={styles.inlineTitle}>{state?.screenName ?? ""}</span>
          <MenuButton label="Preview options" entries={options} onSelect={onOption} className={styles.chip}>
            <Icon name="24.more" />
          </MenuButton>
          {onOpenFull && <IconButton icon="24.new.tab" label="Open in presentation view" onClick={onOpenFull} />}
          {onClose && <IconButton icon="24.close.small" label="Close preview" onClick={onClose} />}
        </header>
        <div className={styles.stage}>
          {canvas}
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

  const optionsButton = (
    <MenuButton label="Options" entries={options} onSelect={onOption} className={styles.chip}>
      <Icon name="24.settings.small" />
      <Icon name="16.chevron.down" />
    </MenuButton>
  );
  return (
    <div className={styles.root} data-presentation data-hide-ui={hideUi || undefined}>
      {!hideUi && (
        <header className={styles.top}>
          <ToggleIconButton icon="24.sidebar.closed" label={sidebar ? "Hide sidebar" : "Show sidebar"} pressed={sidebar} onPressedChange={setSidebar} />
          {/* Comments need other people (multiplayer): shown as Figma has it, not available here. */}
          <IconButton icon="24.comment" label="Comments aren't available in this app" shortcut="C" disabled />
          <MenuButton label="Flows" entries={flowMenu} onSelect={startFlow} className={styles.flowButton}>
            <span className={styles.title}>
              <span className={styles.file}>{source.fileName}</span>
              {state?.flowName ? <span className={styles.flow}>{state.flowName}</span> : null}
            </span>
            <Icon name="16.chevron.down" />
          </MenuButton>
          <span className={styles.grow} />
          <span className={styles.screen}>{state?.screenName ?? ""}</span>
          <span className={styles.grow} />
          <Button variant="primary" onClick={share}>
            Share
          </Button>
          {optionsButton}
          <IconButton icon="24.expand" label="Full screen" shortcut="F" onClick={toggleFullscreen} />
          {onClose && <IconButton icon="24.close.small" label="Close presentation" onClick={onClose} />}
        </header>
      )}
      <div className={styles.body}>
        {sidebar && !hideUi && (
          <aside className={styles.sidebar} aria-label="Flows">
            <div className={styles.sidebarHeader}>Flows</div>
            {flows.length === 0 && <p className={styles.sidebarEmpty}>No flows on this page</p>}
            <ul className={styles.flowList}>
              {flows.map((f) => {
                const current = state?.flow === f.node;
                return (
                  <li key={f.node}>
                    <button type="button" className={styles.flowRow} aria-current={current || undefined} data-flow={f.node} onClick={() => startFlow(f.node)}>
                      <Icon name="24.play.small" />
                      <span className={styles.flowName}>{f.name || "Flow"}</span>
                    </button>
                    {current && f.description ? <p className={styles.flowDescription}>{f.description}</p> : null}
                  </li>
                );
              })}
            </ul>
          </aside>
        )}
        <div className={styles.stage}>
          {canvas}
          <div ref={videoHost} className={styles.videos} aria-hidden />
          {hideUi && <div className={styles.corner}>{optionsButton}</div>}
          {!state && !error && (
            <div className={styles.center}>
              <Spinner />
            </div>
          )}
          {error && <div className={styles.center}>{error}</div>}
        </div>
      </div>
      {!hideUi && (
        <footer className={styles.bottom}>
          <span className={styles.grow} />
          <IconButton icon="24.arrow.left" label="Previous frame" shortcut="←" disabled={!state?.canPrevious} onClick={() => command("previous")} />
          <IconButton icon="24.arrow.right" label="Next frame" shortcut="→" disabled={!state?.canNext} onClick={() => command("next")} />
          <span className={styles.grow} />
          {state?.device && (
            <MenuButton label="Device" entries={deviceOptions(state)} onSelect={onOption} placement="top" className={styles.chip}>
              <span>{deviceName(state.devicePreset)}</span>
              <Icon name="16.chevron.down" />
            </MenuButton>
          )}
          <button type="button" className={styles.restart} onClick={restart}>
            Restart
          </button>
        </footer>
      )}
      <Dialog title="Keyboard shortcuts" open={keysOpen} onClose={() => setKeysOpen(false)}>
        <table className={styles.keys}>
          <tbody>
            {PRESENT_SHORTCUTS.map((k) => (
              <tr key={k.label}>
                <td>{k.label}</td>
                <td className={styles.keyCaps}>
                  {k.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {state?.shortcuts === false && <p className={styles.keysNote}>Turn on Enable Figma shortcuts in the options to use these keys.</p>}
      </Dialog>
    </div>
  );
}
