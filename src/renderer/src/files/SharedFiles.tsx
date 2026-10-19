/**
 * Home › Shared (the owner's Home, 2026-10-19: a sidebar page in Recents' place; live Figma keeps the same lists as
 * Recents' tabs — docs/research/figma/live/multiplayer/home-shared-files.txt, R13 §3): the files on the server other
 * people shared with the user ("Shared with you", each card "From <name>") and the ones the user shared ("Shared by
 * you"), newest share first, in Home's grid or list with Home's cards. Opening one the first time makes its local copy
 * from the room's snapshot; from then on the store keeps it in step. "Open link…" takes a file's link (or
 * `designer://` hands it over by itself). Signed out or offline, Figma's empty states.
 */
import { useEffect, useState } from "react";
import { Button, CollectionView, Dialog, EmptyState, FileCard, FileKindIcon, ListHeader, ListRow, Spinner, TextInput, type ListColumn } from "@/ds";
import { timeAgo } from "@/ds/util/time";
import { t, useT } from "@/i18n";
import { getStoreClient } from "@/store";
import { intentFromLink, keyFromLink, type OpenIntent, type RemoteFile } from "@shared/multiplayer/types";
import type { FileKey } from "@shared/store/types";
import { withLinkPassword } from "./LinkPassword";
import styles from "./Files.module.css";

/** Where the Shared page reads from (FilesBackend.shared): the store's `multiplayer` repository in the app */
export interface SharedSource {
  /** The files on the server the user owns or was invited to (`multiplayer.listRemote`) */
  list(): Promise<RemoteFile[]>;
  /** Its local copy, made the first time (asking for the link's password when it has one); null: cancelled */
  open(key: string, intent?: OpenIntent): Promise<{ fileKey: FileKey } | null>;
  /** A local copy's card picture; null: the empty card */
  thumbnail?(fileKey: FileKey): Promise<string | null>;
}

/** The page's two lists: what others shared with the user, what the user shared */
export type SharedTab = "with-you" | "by-you";
export const SHARED_TABS: readonly (readonly [SharedTab, string])[] = [
  ["with-you", "Shared with you"],
  ["by-you", "Shared by you"],
];

/** The files a tab lists, by date shared (`default`: newest first) */
export function sharedRows<T extends Pick<RemoteFile, "role" | "sharedAt">>(files: readonly T[], tab: SharedTab, order: "default" | "reversed" = "default"): T[] {
  return files.filter((f) => (tab === "by-you") === (f.role === "owner")).sort((a, b) => (order === "default" ? b.sharedAt - a.sharedAt : a.sharedAt - b.sharedAt));
}

/** Opens a shared file (its local copy), asking for the link's password when it has one; null when that was cancelled. */
export function openSharedFile(key: string, intent: OpenIntent = {}): Promise<{ fileKey: string } | null> {
  // Early: the file's tab opens at once and shows the document coming down (Figma's loader)
  return withLinkPassword((password) => getStoreClient().multiplayer.openShared(key, password, intent, { early: true }));
}

interface Row extends RemoteFile {
  thumb: string | null;
}

export interface SharedFilesViewProps {
  source: SharedSource | null;
  tab: SharedTab;
  layout: "grid" | "list";
  /** By date shared: "default" newest first */
  order?: "default" | "reversed";
  /** Signed in to the server (the lists are the account's); false: the log-in empty state */
  signedIn: boolean;
  onLogIn?: () => void;
  now: number;
  onOpen: (fileKey: string, name: string, intent?: OpenIntent) => void;
  onError: (message: string) => void;
  /** The star on a file this computer has a copy of (Starred is per local file); absent: no star */
  star?: { isStarred: (fileKey: FileKey) => boolean; set: (fileKey: FileKey, on: boolean) => void };
}

export function SharedFilesView({ source, tab, layout, order = "default", signedIn, onLogIn, now, onOpen, onError, star }: SharedFilesViewProps) {
  useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!source || !signedIn) return;
    let live = true;
    void source.list().then(
      async (files) => {
        // Local copies have thumbnails; files not opened yet show the empty card.
        const out = await Promise.all(files.map(async (f): Promise<Row> => ({ ...f, thumb: f.fileKey && source.thumbnail ? await source.thumbnail(f.fileKey).catch(() => null) : null })));
        if (live) setRows(out);
      },
      (e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [source, signedIn, attempt]);

  const open = async (f: Row) => {
    if (opening || !source) return;
    setOpening(f.key);
    try {
      const r = await source.open(f.key);
      if (r) onOpen(r.fileKey, f.name);
    } catch (e) {
      onError(t("Couldn’t open “{name}”: {error}", { name: f.name, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setOpening(null);
    }
  };

  const withYou = tab === "with-you";
  if (!signedIn || !source)
    return (
      <div className={styles.empty} data-shared-empty="signed-out">
        <EmptyState size="page" icon="24.person" title={t("Log in to see shared files")} body={t("Files people share with you, and the ones you share, show up here.")} action={onLogIn ? { label: t("Log in"), onClick: onLogIn } : undefined} />
      </div>
    );
  if (failed) {
    const retry = () => {
      setFailed(null);
      setAttempt((n) => n + 1);
    };
    return (
      <div className={styles.empty} data-shared-empty="failed">
        <EmptyState size="page" icon="24.offline" title={t("Couldn’t load shared files")} body={failed} action={{ label: t("Try again"), onClick: retry }} />
      </div>
    );
  }
  if (!rows)
    return (
      <div className={styles.center} aria-busy>
        <Spinner size={24} />
      </div>
    );
  const shown = sharedRows(rows, tab, order);
  if (!shown.length)
    return (
      <div className={styles.empty} data-shared-empty="none">
        {withYou ? (
          <EmptyState size="page" icon="24.person" title={t("No shared files")} body={t("Files people share with you show up here.")} />
        ) : (
          <EmptyState size="page" icon="24.link" title={t("You haven’t shared any files")} body={t("Files you share with others show up here.")} />
        )}
      </div>
    );

  // "From <name>" under a file shared with the user; when it was shared under the user's own
  const subtitle = (f: Row) => (withYou ? (f.ownerName ? t("From {name}", { name: f.ownerName }) : t("Shared with you")) : t("Shared {time}", { time: timeAgo(f.sharedAt, now) }));
  const columns: ListColumn[] = [
    { id: "name", label: t("Name") },
    { id: "who", label: withYou ? t("Shared by") : t("Your role"), width: "minmax(0, var(--ds-size-panel))" },
    { id: "date", label: t("Date shared"), width: "minmax(0, var(--ds-size-panel))" },
  ];
  const events = (f: Row) => ({
    selected: selected === f.key,
    onSelect: () => setSelected(f.key),
    onOpen: () => void open(f),
  });
  return (
    <div className={styles.content} data-layout={layout} data-shared-files={tab} aria-busy={opening ? true : undefined}>
      <CollectionView
        className={styles.collection}
        layout={layout}
        label={withYou ? t("Shared with you") : t("Shared by you")}
        header={layout === "list" ? <ListHeader columns={columns} sort={{ column: "date", direction: order === "default" ? "descending" : "ascending" }} /> : undefined}
        onNavigate={(id) => setSelected(id)}
        onClearSelection={() => setSelected(null)}
      >
        {shown.map((f) =>
          layout === "list" ? (
            <ListRow
              key={f.key}
              id={f.key}
              data-shared-file={f.key}
              columns={columns}
              cells={{
                name: (
                  <span className={styles.rowName}>
                    <span className={styles.kindCell}>
                      <FileKindIcon />
                    </span>
                    <span className={styles.rowTitle}>{f.name}</span>
                  </span>
                ),
                who: withYou ? (f.ownerName ?? "—") : t("Owner"),
                date: timeAgo(f.sharedAt, now),
              }}
              {...events(f)}
            />
          ) : (
            <div key={f.key} className={styles.dragWrap} data-shared-file={f.key}>
              <FileCard
                id={f.key}
                title={f.name}
                subtitle={subtitle(f)}
                thumbnail={f.thumb ?? undefined}
                starred={!!f.fileKey && !!star?.isStarred(f.fileKey)}
                onStar={f.fileKey && star ? (on) => star.set(f.fileKey!, on) : undefined}
                {...events(f)}
              />
            </div>
          ),
        )}
      </CollectionView>
    </div>
  );
}

/** Opens a shared file by its link (or key): the browser's paste, or a link that didn't come through designer://. */
export function OpenLinkDialog({ onClose, onOpen, onError }: { onClose: () => void; onOpen: (fileKey: string, name: string, intent?: OpenIntent) => void; onError: (message: string) => void }) {
  useT();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const key = keyFromLink(link);
  const open = async () => {
    if (!key) return;
    setBusy(true);
    try {
      const intent = intentFromLink(link);
      const r = await openSharedFile(key, intent);
      if (!r) return;
      onOpen(r.fileKey, "", intent);
      onClose();
    } catch (e) {
      onError(t("Couldn’t open the link: {error}", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("Open link")}
      size="small"
      open
      onClose={onClose}
      footer={
        <Button variant="primary" disabled={!key || busy} loading={busy} onClick={() => void open()}>
          {t("Open")}
        </Button>
      }
    >
      <TextInput label={t("File link")} placeholder={t("Paste a file’s link")} value={link} onChange={setLink} onCommit={setLink} autoFocus data-shared-link="" />
    </Dialog>
  );
}
