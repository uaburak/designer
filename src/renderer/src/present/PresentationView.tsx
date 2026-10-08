/**
 * The presentation view (Figma's, R8 §9): a prototype played by the engine's player (engine/src/proto/Player) on an
 * engine of its own — the same Wasm renderer as the canvas —, over the page's prototype background. Above it, the
 * file and the flow being played (a menu of the page's flows); right, the options (Show hints on click, the scale
 * options); below, ← → (previous / next frame) and Restart. Keys as Figma's: → Space N next frame, ← previous,
 * R restart, Z the next scale option, F full screen, Esc leaves (in this tab); interactions with Key / Gamepad
 * triggers take their keys first.
 *
 * The document comes from a PresentationSource: the store's file opened read-only in a tab of its own (PresentRoute),
 * or the editor's engine when presenting in its own tab; its live changes keep the prototype current.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, IconButton, MenuButton, Spinner, type MenuEntry } from "@/ds";
import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, Status } from "@/engine/abi";
import { Engine, type ImageSource, type PresentScale, type PresentState } from "@/engine/Engine";
import type { Guid } from "@/engine/codec";
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
  /** The page; default: the document's first page */
  page?: Guid | null;
  /** Where to start: a frame (or a layer in one); default: the first flow's start */
  node?: Guid | null;
  /** Leave (Esc, ×) — absent in a tab of its own */
  onClose?: () => void;
  /** The engine is up and presenting (scripts, tests) */
  onReady?: (engine: Engine) => void;
}

const SCALES: { value: PresentScale; label: string; device: string }[] = [
  { value: "ACTUAL", label: "Actual size (100%)", device: "Show device at 100%" },
  { value: "FIT_WIDTH", label: "Fit width", device: "Fit width" },
  { value: "FIT", label: "Fit width and height", device: "Fit device on screen" },
  { value: "FILL", label: "Fill screen", device: "Zoom device to fill screen" },
];

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

export function PresentationView({ source, page, node, onClose, onReady }: PresentationViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [state, setState] = useState<PresentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastState = useRef("");

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
      // After delay, transitions and the scale change the state without input: read it a few times a second.
      const timer = window.setInterval(readState, 150);
      cleanups.push(() => window.clearInterval(timer));
      readState();
      canvas.focus({ preventScroll: true });
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
      if (engine.presentKey("down", e.keyCode, modsOf(e))) {
        e.preventDefault();
        readState();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else onClose();
      } else if (e.code === "KeyF") {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else void document.documentElement.requestFullscreen?.().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [onClose, readState]);

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
  const device = !!state?.device;
  const options: MenuEntry[] = [
    { id: "hints", label: "Show hints on click", checked: state?.hints !== false },
    "-",
    ...SCALES.map((s) => ({ id: `scale:${s.value}`, label: device ? s.device : s.label, checked: state?.scale === s.value, shortcut: s.value === state?.scale ? "Z" : undefined })),
  ];
  const onOption = (id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (id === "hints") engine.presentSetOptions({ hints: state?.hints === false });
    else if (id.startsWith("scale:")) engine.presentSetOptions({ scale: id.slice(6) as PresentScale });
    readState();
    canvasRef.current?.focus({ preventScroll: true });
  };
  const startFlow = (id: string) => {
    const engine = engineRef.current;
    if (!engine || id === "none") return;
    engine.presentStart({ node: id });
    readState();
  };

  return (
    <div className={styles.root} data-presentation>
      <header className={styles.top}>
        <MenuButton label="Flows" entries={flowMenu} onSelect={startFlow} className={styles.flowButton}>
          <Icon name="24.sidebar.closed" />
          <span className={styles.title}>
            <span className={styles.file}>{source.fileName}</span>
            {state?.flowName ? <span className={styles.flow}>{state.flowName}</span> : null}
          </span>
          <Icon name="16.chevron.down" />
        </MenuButton>
        <span className={styles.grow} />
        <span className={styles.screen}>{state?.screenName ?? ""}</span>
        <span className={styles.grow} />
        <MenuButton label="Options" entries={options} onSelect={onOption} className={styles.chip}>
          <Icon name="24.more" />
        </MenuButton>
        {onClose && <IconButton icon="24.close.small" label="Close presentation" onClick={onClose} />}
      </header>
      <div className={styles.stage}>
        <canvas
          ref={canvasRef}
          // Its own id: the engine finds its canvas by selector, and the editor's is "engine-canvas".
          id="present-canvas"
          className={styles.canvas}
          tabIndex={0}
          aria-label="Prototype"
          style={{ cursor: state?.hotspot ? "pointer" : "default" }}
          onPointerDown={onPointer}
          onPointerMove={onPointer}
          onPointerUp={onPointer}
          onPointerCancel={onPointer}
          onPointerLeave={onPointer}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!state && !error && (
          <div className={styles.center}>
            <Spinner />
          </div>
        )}
        {error && <div className={styles.center}>{error}</div>}
      </div>
      <footer className={styles.bottom}>
        <span className={styles.grow} />
        <IconButton icon="24.arrow.left" label="Previous frame" shortcut="←" disabled={!state?.canPrevious} onClick={() => command("previous")} />
        <IconButton icon="24.arrow.right" label="Next frame" shortcut="→" disabled={!state?.canNext} onClick={() => command("next")} />
        <span className={styles.grow} />
        <button type="button" className={styles.restart} onClick={() => command("restart")}>
          Restart
        </button>
      </footer>
    </div>
  );
}
