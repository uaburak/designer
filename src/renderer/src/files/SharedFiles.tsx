/**
 * Home › Shared with me (docs/multiplayer.md §3): the files on the server the user owns or was invited to. Opening one
 * the first time makes its local copy from the room's snapshot; from then on the store keeps it in step with the room.
 */
import { useEffect, useState } from "react";
import { Button, Dialog, EmptyState, Spinner, TextInput } from "@/ds";
import { keyFromLink } from "@shared/multiplayer/types";
import { getStoreClient } from "@/store";
import type { RemoteFile } from "@shared/multiplayer/types";
import styles from "./Files.module.css";

const roleLabel = (r: RemoteFile["role"]) => (r === "owner" ? "Owner" : r === "editor" ? "Can edit" : "Can view");

export function SharedFilesDialog({ onClose, onOpen, onError }: { onClose: () => void; onOpen: (fileKey: string, name: string) => void; onError: (message: string) => void }) {
  const [files, setFiles] = useState<RemoteFile[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [link, setLink] = useState("");

  useEffect(() => {
    let live = true;
    getStoreClient()
      .multiplayer.listRemote()
      .then(
        (f) => live && setFiles(f),
        (e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      live = false;
    };
  }, []);

  const open = async (f: Pick<RemoteFile, "key" | "name">) => {
    setOpening(f.key);
    try {
      const { fileKey } = await getStoreClient().multiplayer.openShared(f.key);
      onOpen(fileKey, f.name);
      onClose();
    } catch (e) {
      onError(`Couldn’t open “${f.name}”: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOpening(null);
    }
  };
  const linkKey = keyFromLink(link);

  return (
    <Dialog title="Shared with me" size="medium" open onClose={onClose}>
      <div className={styles.sharedLink}>
        <TextInput label="File link" placeholder="Paste a file’s link to open it" value={link} onChange={setLink} onCommit={setLink} data-shared-link="" />
        <Button variant="secondary" disabled={!linkKey || !!opening} loading={!!linkKey && opening === linkKey} onClick={() => linkKey && void open({ key: linkKey, name: "the linked file" })}>
          Open link
        </Button>
      </div>
      {failed ? (
        <EmptyState icon="24.person" title="Couldn’t load shared files" body={failed} />
      ) : !files ? (
        <Spinner size={16} />
      ) : !files.length ? (
        <EmptyState icon="24.person" title="No shared files yet" body="Files you share, and files people invite you to, show up here." />
      ) : (
        <ul className={styles.sharedList} data-shared-files="">
          {files.map((f) => (
            <li key={f.key} className={styles.sharedRow} data-shared-file={f.key}>
              <span className={styles.sharedName}>{f.name}</span>
              <span className={styles.sharedRole}>{roleLabel(f.role)}</span>
              <Button variant={f.fileKey ? "secondary" : "primary"} loading={opening === f.key} disabled={!!opening} onClick={() => void open(f)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
