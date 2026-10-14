/**
 * The upload panel (docs/multiplayer.md §5.1; docs/design-system.md §4.22a): bottom-right in Home and in every editor,
 * like Figma's import panel — each file going to the server with where it goes, how far along it is, a check when done,
 * the error with Retry when it failed, Cancel on hover while it goes. Figma has no upload panel of this kind for moves
 * and shares; its words where it has them ("Uploading", "Retry", "Cancel"), ours otherwise (marked in the docs).
 * Wecra 1.1 (docs/cloud.md §4): while a file goes, its speed and the time left ("3.2 MB/s · About 2 minutes left", ours).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, IconButton, Portal, cx } from "@/ds";
import { t, tp, useT } from "@/i18n";
import { isDownload, uploadInFlight, type UploadEvent, type UploadProgress } from "@shared/multiplayer/uploads";
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

/** The time left as the panel says it: "12 seconds left", "About 1 minute left", "About 2 hours left" (ours) */
export function timeLeftText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return tp(s, "{n} second left", "{n} seconds left");
  const m = Math.round(s / 60);
  if (m < 60) return tp(m, "About {n} minute left", "About {n} minutes left");
  const h = Math.round(m / 60);
  return tp(h, "About {n} hour left", "About {n} hours left");
}

/** The speed line of a file going up: "3.2 MB/s · About 2 minutes left"; null until the speed is known */
export function speedText(u: Pick<UploadProgress, "state" | "bytesPerSecond" | "secondsLeft">): string | null {
  if (u.state !== "uploading" || u.bytesPerSecond === undefined) return null;
  const speed = `${formatBytes(Math.round(u.bytesPerSecond))}/s`;
  return u.secondsLeft === undefined || u.bytesPerSecond <= 0 ? speed : `${speed} · ${timeLeftText(u.secondsLeft)}`;
}

export const percentOf = (u: Pick<UploadProgress, "bytesSent" | "bytesTotal">): number => (u.bytesTotal > 0 ? Math.min(100, Math.floor((u.bytesSent / u.bytesTotal) * 100)) : 0);

const files = (n: number) => tp(n, "{n} file", "{n} files");

/**
 * The panel's title: "Uploading 2 files", "Upload failed", "Uploaded 3 files"; Wecra 1.1.1, with files' images coming
 * down (docs/cloud.md §4.1): "Downloading 1 file", "Download failed", "Downloaded 1 file", and with both going
 * "Transferring 3 files" (ours)
 */
export function panelTitle(list: UploadProgress[]): string {
  const going = list.filter(uploadInFlight);
  const down = going.filter(isDownload).length;
  if (going.length) return down === going.length ? t("Downloading {files}", { files: files(down) }) : down ? t("Transferring {files}", { files: files(going.length) }) : t("Uploading {files}", { files: files(going.length) });
  const failed = list.filter((u) => u.state === "failed");
  if (failed.length) return failed.every(isDownload) ? t("Download failed") : t("Upload failed");
  return list.every(isDownload) ? t("Downloaded {files}", { files: files(list.length) }) : t("Uploaded {files}", { files: files(list.length) });
}

/** The line under a row's bar */
function statusText(u: UploadProgress): string {
  const down = isDownload(u);
  if (u.state === "queued") return down ? t("Waiting to download…") : t("Waiting to upload…");
  if (u.state === "retrying") return t("Trying again ({n})…", { n: u.attempt ?? 2 });
  if (u.state === "done") return u.bytesTotal ? formatBytes(u.bytesTotal) : down ? t("Downloaded") : t("Uploaded");
  if (!u.bytesTotal) return t("Preparing…");
  return t("{sent} of {total}", { sent: formatBytes(u.bytesSent), total: formatBytes(u.bytesTotal) });
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
  useT();
  const going = uploads.some(uploadInFlight);
  const panel = (
    <section role="region" aria-label={uploads.some(isDownload) ? t("Transfers") : t("Uploads")} data-ds="UploadPanel" className={cx(styles.panel, placement === "editor" && styles.editor, inline && styles.inline)}>
      <header className={styles.header}>
        <span className={styles.title} aria-live="polite">
          {panelTitle(uploads)}
        </span>
        <IconButton icon="24.chevron.down" label={collapsed ? t("Expand") : t("Collapse")} className={cx(styles.chevron, collapsed && styles.collapsedChevron)} onClick={onToggle} aria-expanded={!collapsed} />
        {!going && <IconButton icon="24.close.small" label={t("Close")} onClick={onClose} />}
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
  useT();
  const pct = percentOf(u);
  const failed = u.state === "failed";
  const done = u.state === "done";
  const speed = speedText(u);
  const down = isDownload(u);
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
            {u.error || (down ? t("Couldn’t download this file’s images.") : t("Couldn’t upload this file."))}
          </div>
        ) : (
          <>
            {!done && (
              <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={down ? t("Downloading images for {name}", { name: u.name }) : t("Uploading {name}", { name: u.name })}>
                <div className={cx(styles.fill, (u.state === "queued" || !u.bytesTotal) && styles.waiting)} style={{ width: `${pct}%` }} />
              </div>
            )}
            <div className={styles.meta}>
              <span>{statusText(u)}</span>
              {!done && u.bytesTotal > 0 && <span className={styles.pct}>{pct}%</span>}
            </div>
            {speed && (
              <div className={styles.speed} data-upload-speed="">
                {speed}
              </div>
            )}
          </>
        )}
      </div>
      <div className={styles.end}>
        {done && (
          <span className={styles.check} aria-label={down ? t("Downloaded") : t("Uploaded")}>
            <Icon name="24.check" />
          </span>
        )}
        {failed && u.retryable && (
          <Button variant="secondary" onClick={() => onRetry(u.id)}>
            {t("Retry")}
          </Button>
        )}
        {!done && !down && (
          <span className={cx(styles.cancel, failed && styles.cancelShown)}>
            <IconButton icon="24.close.small" label={t("Cancel upload")} tooltip={t("Cancel")} onClick={() => onCancel(u.id)} />
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
