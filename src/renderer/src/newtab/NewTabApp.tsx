/**
 * `?newtab`: Figma's desktop new-tab page (atlas 01 §3) — "+" and ⌘T open it in a tab of its own (a Home view, with
 * the store's port). A row of file types, "Create new file in" (Drafts or a folder), then the recent files; a file
 * picked here takes the page's tab (main's `nav:open-file` from a new-tab view), as in Figma.
 */
import "@/ds/global.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, Select, Spinner, timeAgo, TooltipManager, useThemeRoot, type SelectEntry } from "@/ds";
import { t, useT } from "@/i18n";
import type { FileListItem, Folder } from "@shared/store/types";
import { filesBackend, type FilesBackend } from "../files/storeAccess";
import { newDesignFile, openFile } from "../files/desktop";
import styles from "./NewTab.module.css";

/** Recent files listed (Figma's list scrolls; the rest are a click away in Home › Recents) */
export const NEW_TAB_RECENTS = 30;
const DRAFTS = "drafts";

/** "3 hours ago" capitalised, as the page shows it ("Just now", "Yesterday"…). */
export const capitalised = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

export default function NewTabApp() {
  useThemeRoot();
  useT();
  const [backend, setBackend] = useState<FilesBackend | null>(null);
  const [recents, setRecents] = useState<FileListItem[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [place, setPlace] = useState(DRAFTS);
  const list = useRef<HTMLDivElement>(null);

  const load = useCallback(async (b: FilesBackend) => {
    const [files, all] = await Promise.all([b.workspace.listFiles({ in: "recents" }), b.workspace.listFolders()]);
    setRecents(files.slice(0, NEW_TAB_RECENTS));
    setFolders(all.filter((f) => !f.trashedAt));
  }, []);

  useEffect(() => {
    let live = true;
    void filesBackend().then((b) => {
      if (!live) return;
      setBackend(b);
      void load(b).catch(() => setRecents([]));
    });
    // Shown again (another tab was in front): the recents as they are now.
    const visible = () => {
      if (document.visibilityState === "visible") void filesBackend().then((b) => load(b).catch(() => {}));
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  const folderId = place === DRAFTS ? null : place;
  const placeOptions = useMemo<SelectEntry[]>(() => [{ value: DRAFTS, label: t("Drafts"), icon: "16.document" }, ...(folders.length ? ["-" as const] : []), ...folders.map((f) => ({ value: f.id, label: f.name }))], [folders]);

  const create = () => backend && void newDesignFile(folderId, backend.workspace, { workspace: backend.workspace });
  const open = (file: FileListItem) => void openFile(file.fileKey, { title: file.name }, { workspace: backend?.workspace });

  // ↑ ↓ move between the recent files (scrolled into view smoothly); Enter opens.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-recent]") ?? [])];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  return (
    <div data-ds="NewTab" className={styles.page}>
      <div className={styles.column}>
        <div className={styles.top}>
          <div className={styles.types} role="group" aria-label={t("New file")}>
            <button type="button" className={styles.type} onClick={create}>
              <span className={styles.typeIcon}>
                <Icon name="16.design" />
              </span>
              {t("Design")}
            </button>
          </div>
          <div className={styles.place}>
            <span>{t("Create new file in")}</span>
            <Select label={t("Create new file in")} value={place} options={placeOptions} onChange={setPlace} variant="ghost" width="hug" />
          </div>
        </div>
        <h2 className={styles.heading}>{recents && !recents.length ? t("No recents") : t("Recents")}</h2>
        {!recents ? (
          <div className={styles.loading}>
            <Spinner size={16} />
          </div>
        ) : (
          <div ref={list} role="list" className={styles.list} onKeyDown={onKeyDown}>
            {recents.map((file) => (
              <RecentRow key={file.fileKey} file={file} image={backend?.thumbnailUrl(file) ?? null} onOpen={() => open(file)} />
            ))}
          </div>
        )}
        {!!recents?.length && (
          <button type="button" className={styles.more} onClick={() => desktopHome()}>
            {t("Browse more recent files")}
          </button>
        )}
      </div>
      <TooltipManager />
    </div>
  );
}

/** A recent file: its thumbnail (16:9, 48 high, the type's badge), its name and when it was viewed or edited. */
function RecentRow({ file, image, onOpen }: { file: FileListItem; image: string | null; onOpen: () => void }) {
  const when = file.lastViewedAt ?? file.updatedAt;
  return (
    <div
      role="listitem"
      tabIndex={0}
      data-recent={file.fileKey}
      className={styles.row}
      title={file.name}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <span className={styles.thumb}>
        {image && <img src={image} alt="" draggable={false} />}
        <span className={styles.badge}>
          <Icon name="16.design" />
        </span>
      </span>
      <span className={styles.meta}>
        <span className={styles.name}>{file.name}</span>
        <span className={styles.time}>{capitalised(timeAgo(when))}</span>
      </span>
    </div>
  );
}

/** Home in front (the footer's link): its Recents are what it opens on. */
function desktopHome() {
  const d = (window as unknown as { designer?: { tabs?: { activate?: (id: string) => void } } }).designer;
  d?.tabs?.activate?.("home");
}
