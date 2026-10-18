/**
 * The plugins' chrome over the editor (docs/plugins.md §3.2, §6): each run's UI window — a ds floating panel holding a
 * sandboxed, opaque-origin iframe (no `allow-same-origin`) — and Figma's "Running ‹name›" toast (a spinner, Cancel =
 * Stop; a check when the run ends under it). Mounting it attaches the editor's plugin service (EditorApp's one line).
 * Messages are accepted only from the window's own iframe (`event.source`), `{pluginMessage}` unwrapped as Figma's;
 * `pluginDrop` becomes figma.on("drop").
 */
import { useEffect, useRef, useState } from "react";
import { IconButton, Portal, Toast } from "@/ds";
import { t, useT } from "@/i18n";
import { getStoreClient } from "@/store";
import { useEditor } from "../../controller";
import { attachPlugins, usePluginService, usePlugins, type PluginServiceOptions } from "../service";
import { centred, savePosition, TITLE_BAR, usePluginUi, type PluginUiStore, type PluginWindowState } from "./store";
import { NewPluginDialog } from "./NewPluginDialog";
import styles from "./PluginLayer.module.css";

/** Figma's iframe sandbox: scripts, forms, popups, modals, downloads — never same-origin. */
export const PLUGIN_IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** A run's iframe and its messaging: in a floating window, or docked in Dev Mode's Plugins panel. */
export function PluginFrame({ w, ui, className }: { w: PluginWindowState; ui: PluginUiStore; className?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
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
  if (!w.src) return null;
  return (
    <iframe
      ref={frame}
      title={w.title}
      className={className ?? styles.frame}
      sandbox={PLUGIN_IFRAME_SANDBOX}
      allow="clipboard-write"
      {...("url" in w.src ? { src: w.src.url } : { srcDoc: w.src.srcdoc })}
      onLoad={onLoad}
    />
  );
}

function PluginWindow({ w, ui }: { w: PluginWindowState; ui: PluginUiStore }) {
  useT();
  const [dragging, setDragging] = useState(false);
  const at = w.position ?? centred(w);

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
        <IconButton icon="24.close.small" label={t("Close")} onClick={() => ui.handlers.get(w.runId)?.close()} />
      </div>
      <PluginFrame w={w} ui={ui} />
    </div>
  );
}

function Windows({ ui }: { ui: PluginUiStore }) {
  useT();
  const snap = usePluginUi(ui);
  // Docked windows (Dev Mode's inspect plugins) are drawn by the Plugins panel.
  const floating = snap.windows.filter((w) => !w.docked);
  if (!floating.length && !snap.running.length) return null;
  return (
    <Portal>
      {floating.map((w) => (
        <PluginWindow key={w.runId} w={w} ui={ui} />
      ))}
      {snap.running.length > 0 && (
        <div className={styles.running}>
          {snap.running.map((r) =>
            r.state === "done" ? (
              <Toast key={r.runId} static icon="24.check" message={t("Running {name}", { name: r.name })} />
            ) : (
              <Toast key={r.runId} static spinner message={t("Running {name}", { name: r.name })} action={{ label: t("Cancel"), onAction: () => ui.stoppers.get(r.runId)?.() }} />
            )
          )}
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
