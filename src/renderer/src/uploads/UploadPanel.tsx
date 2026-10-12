/**
 * The upload panel (docs/multiplayer.md §5.1; docs/design-system.md §4.22a): bottom-right in Home and in every editor,
 * like Figma's import panel — each file going to the server with where it goes, how far along it is, a check when done,
 * the error with Retry when it failed, Cancel on hover while it goes. Figma has no upload panel of this kind for moves
 * and shares; its words where it has them ("Uploading", "Retry", "Cancel"), ours otherwise (marked in the docs).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, IconButton, Portal, cx } from "@/ds";
import { uploadInFlight, type UploadEvent, type UploadProgress } from "@shared/multiplayer/uploads";
import styles from "./UploadPanel.module.css";

/** The panel hides this long after the last upload finished (none failed) */
export const UPLOAD_PANEL_HIDE_MS = 4000;

/** What the panel reads and does (the store client's `multiplayer`, or a test's) */
export interface UploadSource {
  uploads(): Promise<UploadProgress[]>;
  watchUploads(listener: (e: UploadEvent) => void): () => void;
  retryUpload(id: string): Promise<void>;
  cancelUpload(id: string): Promise<void>;
}

/** Sizes as macOS says them (1 MB = 1,000,000 bytes): "12.4 MB", "340 MB", "820 KB" */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const s = v >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();
  return `${s} ${units[i]}`;
}

export const percentOf = (u: Pick<UploadProgress, "bytesSent" | "bytesTotal">): number => (u.bytesTotal > 0 ? Math.min(100, Math.floor((u.bytesSent / u.bytesTotal) * 100)) : 0);

const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);

/** The panel's title: "Uploading 2 files", "Upload failed", "Uploaded 3 files" */
export function panelTitle(list: UploadProgress[]): string {
  const going = list.filter(uploadInFlight).length;
  if (going) return `Uploading ${files(going)}`;
  if (list.some((u) => u.state === "failed")) return "Upload failed";
  return `Uploaded ${files(list.length)}`;
}

/** The line under a row's bar */
function statusText(u: UploadProgress): string {
  if (u.state === "queued") return "Waiting to upload…";
  if (u.state === "retrying") return `Trying again (${u.attempt ?? 2})…`;
  if (u.state === "done") return u.bytesTotal ? formatBytes(u.bytesTotal) : "Uploaded";
  if (!u.bytesTotal) return "Preparing…";
  return `${formatBytes(u.bytesSent)} of ${formatBytes(u.bytesTotal)}`;
}

export interface UploadPanelProps {
  uploads: UploadProgress[];
  collapsed: boolean;
  onToggle(): void;
  onClose(): void;
  onRetry(id: string): void;
  onCancel(id: string): void;
  /** In an editor: left of the properties panel */
  placement?: "home" | "editor";
  /** The Gallery draws it in place */
  inline?: boolean;
}

/** The panel's look (presentational) */
export function UploadPanel({ uploads, collapsed, onToggle, onClose, onRetry, onCancel, placement = "home", inline = false }: UploadPanelProps) {
  const going = uploads.some(uploadInFlight);
  const panel = (
    <section role="region" aria-label="Uploads" data-ds="UploadPanel" className={cx(styles.panel, placement === "editor" && styles.editor, inline && styles.inline)}>
      <header className={styles.header}>
        <span className={styles.title} aria-live="polite">
          {panelTitle(uploads)}
        </span>
        <IconButton icon="24.chevron.down" label={collapsed ? "Expand" : "Collapse"} className={cx(styles.chevron, collapsed && styles.collapsedChevron)} onClick={onToggle} aria-expanded={!collapsed} />
        {!going && <IconButton icon="24.close.small" label="Close" onClick={onClose} />}
      </header>
      {!collapsed && (
        <ul className={styles.rows}>
          {uploads.map((u) => (
            <UploadRow key={u.id} u={u} onRetry={onRetry} onCancel={onCancel} />
          ))}
        </ul>
      )}
    </section>
  );
  return inline ? panel : <Portal>{panel}</Portal>;
}

function UploadRow({ u, onRetry, onCancel }: { u: UploadProgress; onRetry(id: string): void; onCancel(id: string): void }) {
  const pct = percentOf(u);
  const failed = u.state === "failed";
  const done = u.state === "done";
  return (
    <li className={cx(styles.row, failed && styles.failed)} data-state={u.state} aria-label={u.name}>
      <span className={styles.fileIcon}>
        <Icon name="24.file" />
      </span>
      <div className={styles.body}>
        <div className={styles.name} title={u.name}>
          {u.name}
        </div>
        {u.destination && (
          <div className={styles.secondary} title={u.destination}>
            {u.destination}
          </div>
        )}
        {failed ? (
          <div className={styles.error} role="alert">
            {u.error || "Couldn’t upload this file."}
          </div>
        ) : (
          <>
            {!done && (
              <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Uploading ${u.name}`}>
                <div className={cx(styles.fill, (u.state === "queued" || !u.bytesTotal) && styles.waiting)} style={{ width: `${pct}%` }} />
              </div>
            )}
            <div className={styles.meta}>
              <span>{statusText(u)}</span>
              {!done && u.bytesTotal > 0 && <span className={styles.pct}>{pct}%</span>}
            </div>
          </>
        )}
      </div>
      <div className={styles.end}>
        {done && (
          <span className={styles.check} aria-label="Uploaded">
            <Icon name="24.check" />
          </span>
        )}
        {failed && u.retryable && (
          <Button variant="secondary" onClick={() => onRetry(u.id)}>
            Retry
          </Button>
        )}
        {!done && (
          <span className={cx(styles.cancel, failed && styles.cancelShown)}>
            <IconButton icon="24.close.small" label="Cancel upload" tooltip="Cancel" onClick={() => onCancel(u.id)} />
          </span>
        )}
      </div>
    </li>
  );
}

/** The uploads as the store says them, newest last */
export function useUploads(source: UploadSource | null) {
  const [byId, setById] = useState<Map<string, UploadProgress>>(new Map());
  useEffect(() => {
    if (!source) return;
    let live = true;
    const off = source.watchUploads((e) =>
      setById((m) => {
        const next = new Map(m);
        if ("removed" in e) next.delete(e.removed);
        else next.set(e.upload.id, e.upload);
        return next;
      }),
    );
    source.uploads().then(
      (list) => live && setById((m) => new Map([...list.map((u) => [u.id, u] as const), ...m])),
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, [source]);
  const uploads = useMemo(() => [...byId.values()].sort((a, b) => a.startedAt - b.startedAt), [byId]);
  const forget = useCallback((ids: string[]) => setById((m) => new Map([...m].filter(([id]) => !ids.includes(id)))), []);
  return { uploads, forget };
}

/** The panel, wired to a source: shown while there are uploads, hidden 4 s after they all finished, or when closed */
export function Uploads({ source, placement = "home" }: { source: UploadSource | null; placement?: "home" | "editor" }) {
  const { uploads, forget } = useUploads(source);
  const [collapsed, setCollapsed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const allDone = uploads.length > 0 && uploads.every((u) => u.state === "done");
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!allDone) return;
    timer.current = window.setTimeout(() => forget(uploads.map((u) => u.id)), UPLOAD_PANEL_HIDE_MS);
    return () => window.clearTimeout(timer.current);
  }, [allDone, uploads, forget]);
  if (!uploads.length) return null;
  return (
    <UploadPanel
      uploads={uploads}
      collapsed={collapsed}
      placement={placement}
      onToggle={() => setCollapsed((c) => !c)}
      // Closing forgets what is shown (nothing is going); a new upload opens it again
      onClose={() => forget(uploads.filter((u) => !uploadInFlight(u)).map((u) => u.id))}
      onRetry={(id) => void source?.retryUpload(id).catch(() => {})}
      onCancel={(id) => void source?.cancelUpload(id).catch(() => {})}
    />
  );
}
