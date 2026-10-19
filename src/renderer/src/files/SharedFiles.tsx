/**
 * Home › Recents › "Shared files" (live Figma: Recents' tabs "Recently viewed | Shared files | Shared folders"; cards say
 * "From <name>" — docs/research/figma/live/multiplayer/home-shared-files.txt, R13 §3): the files on the server the user was
 * invited to or owns, newest share first. Opening one the first time makes its local copy from the room's snapshot; from
 * then on the store keeps it in step. "Open link…" takes a file's link (or `designer://` hands it over by itself).
 */
import { useEffect, useState } from "react";
import { Button, Dialog, EmptyState, FileCard, Spinner, TextInput } from "@/ds";
import { t, useT } from "@/i18n";
import { getStoreClient, thumbnailUrl } from "@/store";
import { intentFromLink, keyFromLink, type OpenIntent, type RemoteFile } from "@shared/multiplayer/types";
import { withLinkPassword } from "./LinkPassword";
import styles from "./Files.module.css";

interface Row extends RemoteFile {
  thumb: string | null;
}

/** Opens a shared file (its local copy), asking for the link's password when it has one; null when that was cancelled. */
export function openSharedFile(key: string, intent: OpenIntent = {}): Promise<{ fileKey: string } | null> {
  // Early: the file's tab opens at once and shows the document coming down (Figma's loader)
  return withLinkPassword((password) => getStoreClient().multiplayer.openShared(key, password, intent, { early: true }));
}

export function SharedFilesView({ layout, order = "default", onOpen, onError }: { layout: "grid" | "list"; /** By date shared: "default" newest first */ order?: "default" | "reversed"; onOpen: (fileKey: string, name: string, intent?: OpenIntent) => void; onError: (message: string) => void }) {
  useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const store = getStoreClient();
    void store.multiplayer.listRemote().then(
      async (files) => {
        // Local copies have thumbnails; files not opened yet show the empty card.
        const out: Row[] = [];
        for (const f of files.filter((x) => x.role !== "owner")) {
          const meta = f.fileKey ? await store.workspace.getFile(f.fileKey).catch(() => null) : null;
          out.push({ ...f, thumb: meta ? thumbnailUrl(meta) : null });
        }
        if (live) setRows(out);
      },
      (e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const open = async (f: Row) => {
    if (opening) return;
    setOpening(f.key);
    try {
      const r = await openSharedFile(f.key);
      if (r) onOpen(r.fileKey, f.name);
    } catch (e) {
      onError(t("Couldn’t open “{name}”: {error}", { name: f.name, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setOpening(null);
    }
  };

  if (failed) return <EmptyState size="page" icon="24.person" title={t("Couldn’t load shared files")} body={failed} />;
  if (!rows)
    return (
      <div className={styles.center} aria-busy>
        <Spinner size={24} />
      </div>
    );
  if (!rows.length) return <EmptyState size="page" icon="24.person" title={t("No shared files")} body={t("Files people share with you show up here.")} />;
  return (
    <div className={layout === "grid" ? styles.sharedGrid : styles.sharedListView} role="list" aria-label={t("Shared files")} data-shared-files="">
      {[...rows].sort((a, b) => (order === "default" ? b.sharedAt - a.sharedAt : a.sharedAt - b.sharedAt)).map((f) => (
        <div key={f.key} role="listitem" data-shared-file={f.key} aria-busy={opening === f.key || undefined}>
          <FileCard id={f.key} title={f.name} subtitle={f.ownerName ? t("From {name}", { name: f.ownerName }) : t("Shared with you")} thumbnail={f.thumb ?? undefined} selected={selected === f.key} onSelect={() => setSelected(f.key)} onOpen={() => void open(f)} />
        </div>
      ))}
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
