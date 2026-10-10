/**
 * Home › Recents › "Shared files" (live Figma: Recents' tabs "Recently viewed | Shared files | Shared folders"; cards say
 * "From <name>" — docs/research/figma/live/multiplayer/home-shared-files.txt, R13 §3): the files on the server the user was
 * invited to or owns, newest share first. Opening one the first time makes its local copy from the room's snapshot; from
 * then on the store keeps it in step. "Open link…" takes a file's link (or `designer://` hands it over by itself).
 */
import { useEffect, useState } from "react";
import { Button, Dialog, EmptyState, FileCard, Spinner, TextInput } from "@/ds";
import { getStoreClient, thumbnailUrl } from "@/store";
import { keyFromLink, type RemoteFile } from "@shared/multiplayer/types";
import styles from "./Files.module.css";

interface Row extends RemoteFile {
  thumb: string | null;
}

export function SharedFilesView({ layout, onOpen, onError }: { layout: "grid" | "list"; onOpen: (fileKey: string, name: string) => void; onError: (message: string) => void }) {
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
      const { fileKey } = await getStoreClient().multiplayer.openShared(f.key);
      onOpen(fileKey, f.name);
    } catch (e) {
      onError(`Couldn’t open “${f.name}”: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOpening(null);
    }
  };

  if (failed) return <EmptyState size="page" icon="24.person" title="Couldn’t load shared files" body={failed} />;
  if (!rows)
    return (
      <div className={styles.center} aria-busy>
        <Spinner size={24} />
      </div>
    );
  if (!rows.length) return <EmptyState size="page" icon="24.person" title="No shared files" body="Files people share with you show up here." />;
  return (
    <div className={layout === "grid" ? styles.sharedGrid : styles.sharedListView} role="list" aria-label="Shared files" data-shared-files="">
      {rows.map((f) => (
        <div key={f.key} role="listitem" data-shared-file={f.key} aria-busy={opening === f.key || undefined}>
          <FileCard id={f.key} title={f.name} subtitle={f.ownerName ? `From ${f.ownerName}` : "Shared with you"} thumbnail={f.thumb ?? undefined} selected={selected === f.key} onSelect={() => setSelected(f.key)} onOpen={() => void open(f)} />
        </div>
      ))}
    </div>
  );
}

/** Opens a shared file by its link (or key): the browser's paste, or a link that didn't come through designer://. */
export function OpenLinkDialog({ onClose, onOpen, onError }: { onClose: () => void; onOpen: (fileKey: string, name: string) => void; onError: (message: string) => void }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const key = keyFromLink(link);
  const open = async () => {
    if (!key) return;
    setBusy(true);
    try {
      const { fileKey } = await getStoreClient().multiplayer.openShared(key);
      onOpen(fileKey, "");
      onClose();
    } catch (e) {
      onError(`Couldn’t open the link: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Open link"
      size="small"
      open
      onClose={onClose}
      footer={
        <Button variant="primary" disabled={!key || busy} loading={busy} onClick={() => void open()}>
          Open
        </Button>
      }
    >
      <TextInput label="File link" placeholder="Paste a file’s link" value={link} onChange={setLink} onCommit={setLink} autoFocus data-shared-link="" />
    </Dialog>
  );
}
