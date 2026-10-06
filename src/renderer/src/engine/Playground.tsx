/**
 * The engine's playground (`?engine` in the app, or `npm run engine:dev` on
 * its own): the canvas full-size on Figma's dark canvas with a sample
 * document, and a thin bar showing the store at work — the tool, undo, the
 * zoom and the selection, each read with useSyncExternalStore.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { ToolName } from "./abi";
import { IS_MAC } from "./CanvasController";
import type { Engine, EngineOptions } from "./Engine";
import { EngineCanvas } from "./EngineCanvas";
import { EngineStore } from "./EngineStore";
import { useCamera, useNode, useSelection, useTool, useUndoState } from "./hooks";
import { SAMPLE_DOCUMENT } from "./sampleDocument";

declare global {
  interface Window {
    /** The playground's engine, for scripts and the console. */
    __designerEngine?: Engine;
  }
}

const OPTIONS: EngineOptions = { sessionID: 1, theme: "DARK" };

const TOOL_BUTTONS: { tool: ToolName; label: string; key: string }[] = [
  { tool: "MOVE", label: "Move", key: "V" },
  { tool: "FRAME", label: "Frame", key: "F" },
  { tool: "RECTANGLE", label: "Rectangle", key: "R" },
  { tool: "ELLIPSE", label: "Ellipse", key: "O" },
  { tool: "HAND", label: "Hand tool", key: "H" },
  { tool: "TEXT", label: "Text", key: "T" },
];

const bar: CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 16,
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: 4,
  background: "#2c2c2c",
  border: "1px solid #444",
  borderRadius: 13,
  boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
  font: "500 11px/16px 'Inter Variable', Inter, system-ui, sans-serif",
  color: "#fff",
  userSelect: "none",
};

const button = (active: boolean, disabled = false): CSSProperties => ({
  height: 32,
  padding: "0 10px",
  border: 0,
  borderRadius: 8,
  background: active ? "#0c8ce9" : "transparent",
  color: disabled ? "#777" : "#fff",
  font: "inherit",
  cursor: disabled ? "default" : "pointer",
});

function Toolbar({ store }: { store: EngineStore }) {
  const tool = useTool(store);
  const undo = useUndoState(store);
  const engine = store.engine;
  const focusCanvas = () => document.getElementById("engine-canvas")?.focus({ preventScroll: true });
  return (
    <div style={bar}>
      {TOOL_BUTTONS.map((b) => (
        <button
          key={b.tool}
          title={`${b.label} (${b.key})`}
          style={button(tool === b.tool)}
          onClick={() => {
            engine.setTool(b.tool);
            focusCanvas();
          }}
        >
          {b.label}
        </button>
      ))}
      <span style={{ width: 1, height: 20, background: "#444", margin: "0 4px" }} />
      <button title={undo.undoLabel ? `Undo ${undo.undoLabel}` : "Undo"} disabled={!undo.canUndo} style={button(false, !undo.canUndo)} onClick={() => (engine.undo(), focusCanvas())}>
        Undo
      </button>
      <button title={undo.redoLabel ? `Redo ${undo.redoLabel}` : "Redo"} disabled={!undo.canRedo} style={button(false, !undo.canRedo)} onClick={() => (engine.redo(), focusCanvas())}>
        Redo
      </button>
      <span style={{ width: 1, height: 20, background: "#444", margin: "0 4px" }} />
      <Zoom store={store} />
      <SelectionInfo store={store} />
    </div>
  );
}

function Zoom({ store }: { store: EngineStore }) {
  const camera = useCamera(store);
  return (
    <button title="Zoom to fit (⇧1)" style={{ ...button(false), minWidth: 52 }} onClick={() => store.engine.command("ZOOM_TO_FIT")}>
      {Math.round(camera.zoom * 100)}%
    </button>
  );
}

function SelectionInfo({ store }: { store: EngineStore }) {
  const selection = useSelection(store);
  const first = selection.refs[0] ?? null;
  const node = useNode(store, first);
  const text =
    selection.refs.length === 0
      ? "Nothing selected"
      : selection.refs.length > 1
        ? `${selection.refs.length} layers`
        : node
          ? `${node.name} · ${round(node.size?.x ?? 0)} × ${round(node.size?.y ?? 0)}`
          : "";
  return <span style={{ padding: "0 10px", color: "#b3b3b3", whiteSpace: "nowrap", minWidth: 160 }}>{text}</span>;
}

const round = (n: number) => Math.round(n * 100) / 100;

export default function Playground() {
  const [store, setStore] = useState<EngineStore | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onReady = useCallback((engine: Engine) => {
    window.__designerEngine = engine; // for scripts/engine-shot.mjs and the console
    setStore(new EngineStore(engine));
  }, []);
  const onError = useCallback((e: Error) => setError(e.message), []);
  useEffect(() => () => store?.dispose(), [store]);

  // ⌘-wheel in the page must not zoom the browser instead of the canvas.
  useEffect(() => {
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    window.addEventListener("wheel", stop, { passive: false });
    return () => window.removeEventListener("wheel", stop);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#1e1e1e", overflow: "hidden" }}>
      <EngineCanvas document={SAMPLE_DOCUMENT} options={OPTIONS} onReady={onReady} onError={onError} />
      {store && <Toolbar store={store} />}
      {error && (
        <p style={{ position: "absolute", top: 16, left: 16, margin: 0, color: "#f24822", font: "13px Inter, system-ui, sans-serif" }}>
          The engine could not start: {error}
        </p>
      )}
      <p
        style={{
          position: "absolute",
          top: 12,
          left: 16,
          margin: 0,
          color: "#898989",
          font: "11px/16px 'Inter Variable', Inter, system-ui, sans-serif",
          pointerEvents: "none",
        }}
      >
        Engine playground · drag to select or move · {IS_MAC ? "⌘" : "Ctrl"}-click selects deep · scroll to pan, pinch or {IS_MAC ? "⌘" : "Ctrl"}-scroll to zoom · Space-drag pans · ⇧0 ⇧1 ⇧2
      </p>
    </div>
  );
}
