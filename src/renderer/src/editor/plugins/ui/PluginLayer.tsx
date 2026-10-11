/**
 * The plugins' chrome over the editor (docs/plugins.md §3.2, §6): each run's UI window — a ds floating panel holding a
 * sandboxed, opaque-origin iframe (no `allow-same-origin`) — and the "Running ‹name›" toast with ✕ = Stop. Mounting it
 * attaches the editor's plugin service (EditorApp's one line). Messages are accepted only from the window's own
 * iframe (`event.source`), `{pluginMessage}` unwrapped as Figma's; `pluginDrop` becomes figma.on("drop").
 */
import { useEffect, useRef, useState } from "react";
import { IconButton, Portal, Toast } from "@/ds";
import { getStoreClient } from "@/store";
import { useEditor } from "../../controller";
import { attachPlugins, usePluginService, usePlugins, type PluginServiceOptions } from "../service";
import { usePluginUi, type PluginUiStore, type PluginWindowState } from "./store";
import { NewPluginDialog } from "./NewPluginDialog";
import styles from "./PluginLayer.module.css";

/** Figma's iframe sandbox: scripts, forms, popups, modals, downloads — never same-origin. */
export const PLUGIN_IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";
const TITLE_BAR = 40;
const POSITIONS_KEY = "designer.plugins.positions";

function savedPosition(pluginId: string): { x: number; y: number } | null {
  try {
    const all = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}") as Record<string, { x: number; y: number }>;
    return all[pluginId] ?? null;
  } catch {
    return null;
  }
}
function savePosition(pluginId: string, at: { x: number; y: number }): void {
  try {
    const all = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}") as Record<string, { x: number; y: number }>;
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ ...all, [pluginId]: at }));
  } catch {
    // Private mode: the default place next time.
  }
}

function PluginWindow({ w, ui }: { w: PluginWindowState; ui: PluginUiStore }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [dragging, setDragging] = useState(false);
  const at = w.position ?? savedPosition(w.pluginId) ?? { x: Math.max(8, window.innerWidth - w.width - 256), y: 56 };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const data = e.data as { pluginMessage?: unknown; pluginDrop?: unknown; pluginId?: string } | null;
      if (!data || typeof data !== "object") return;
      const h = ui.handlers.get(w.runId);
      if ("pluginMessage" in data) h?.message(data.pluginMessage, e.origin);
      else if ("pluginDrop" in data) {
        const d = data.pluginDrop as { clientX?: number; clientY?: number } & Record<string, unknown>;
        h?.drop?.(d, { x: Number(d.clientX) || 0, y: Number(d.clientY) || 0 });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [ui, w.runId]);

  const onLoad = () => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    // An opaque origin: messages go out with "*" (Figma's).
    ui.frames.set(w.runId, { post: (m) => win.postMessage(m, "*") });
    ui.handlers.get(w.runId)?.loaded();
  };

  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const start = { x: e.clientX, y: e.clientY, at };
    setDragging(true);
    const move = (ev: PointerEvent) => ui.patchWindow(w.runId, { position: { x: Math.round(start.at.x + ev.clientX - start.x), y: Math.max(0, Math.round(start.at.y + ev.clientY - start.y)) } });
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const now = ui.window(w.runId)?.position;
      if (now) savePosition(w.pluginId, now);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="dialog"
      aria-label={w.title}
      data-plugin-window={w.runId}
      hidden={!w.visible}
      className={`${styles.window} ${dragging ? styles.dragging : ""}`}
      style={{ left: at.x, top: at.y, width: w.width, height: w.height + TITLE_BAR }}
    >
      <div className={styles.titleBar} onPointerDown={startDrag}>
        <span className={styles.title}>{w.title}</span>
        <IconButton icon="24.close.small" label="Close" onClick={() => ui.handlers.get(w.runId)?.close()} />
      </div>
      {w.src && (
        <iframe
          ref={frame}
          title={w.title}
          className={styles.frame}
          sandbox={PLUGIN_IFRAME_SANDBOX}
          allow="clipboard-write"
          {...("url" in w.src ? { src: w.src.url } : { srcDoc: w.src.srcdoc })}
          onLoad={onLoad}
        />
      )}
    </div>
  );
}

function Windows({ ui }: { ui: PluginUiStore }) {
  const snap = usePluginUi(ui);
  if (!snap.windows.length && !snap.running.length) return null;
  return (
    <Portal>
      {snap.windows.map((w) => (
        <PluginWindow key={w.runId} w={w} ui={ui} />
      ))}
      {snap.running.length > 0 && (
        <div className={styles.running}>
          {snap.running.map((r) => (
            <Toast key={r.runId} static message={`Running ${r.name}`} onClose={() => ui.stoppers.get(r.runId)?.()} />
          ))}
        </div>
      )}
    </Portal>
  );
}

export function PluginLayer() {
  const ed = useEditor();
  useEffect(() => {
    const store = (() => {
      try {
        return (getStoreClient() as { plugins?: PluginServiceOptions["store"] }).plugins ?? null;
      } catch {
        return null;
      }
    })();
    return attachPlugins(ed, { store });
  }, [ed]);
  const service = usePluginService(ed);
  const snap = usePlugins(service);
  if (!service) return null;
  return (
    <>
      <Windows ui={service.ui} />
      {snap?.creating && <NewPluginDialog service={service} onClose={() => service.openNewPlugin(false)} />}
    </>
  );
}
