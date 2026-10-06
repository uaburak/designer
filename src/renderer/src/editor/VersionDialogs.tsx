/**
 * Version history (docs/data.md §6), when the source keeps versions:
 * "Save to version history…" (⌥⌘S: a title and a description) and the
 * history itself — autosaves and named versions, newest first, each with
 * Restore (non-destructive: the version comes back as one undoable edit).
 */
import { useEffect, useState } from "react";
import { Button, Dialog, EmptyState, Spinner, TextArea, TextInput, showToast } from "@/ds";
import { useEditor } from "./controller";
import type { VersionInfo } from "./documentSource";
import { useUI } from "./hooks";
import { command, shortcutOf } from "./commands";
import styles from "./VersionDialogs.module.css";

const RESTORE_LABEL = "Restore version";

export function VersionDialogs() {
  const which = useUI((s) => s.versionDialog);
  if (which === "save") return <SaveVersion />;
  if (which === "history") return <History />;
  return null;
}

function SaveVersion() {
  const ed = useEditor();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    ed.ui.set({ versionDialog: null });
    ed.focusCanvas();
  };
  const save = async () => {
    if (!ed.source.saveVersion) return;
    setBusy(true);
    try {
      await ed.source.flush();
      await ed.source.saveVersion({ title: title.trim() || undefined, description: description.trim() || undefined });
      showToast({ message: "Version saved" });
      close();
    } catch {
      setBusy(false);
      showToast({ message: "The version couldn't be saved", kind: "error" });
    }
  };
  return (
    <Dialog
      title="Save to version history"
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <TextInput label="Title" placeholder="Title" value={title} onChange={setTitle} autoFocus />
        <TextArea label="Describe what changed" placeholder="Describe what changed" value={description} onChange={setDescription} />
      </div>
    </Dialog>
  );
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const KIND_TITLE: Record<VersionInfo["kind"], string> = { autosave: "Autosave", named: "Version", restore: "Restored version", publish: "Library published", import: "Imported" };

function History() {
  const ed = useEditor();
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const close = () => {
    ed.ui.set({ versionDialog: null });
    ed.focusCanvas();
  };
  useEffect(() => {
    let live = true;
    void ed.source
      .listVersions?.()
      .then((list) => live && setVersions([...list].sort((a, b) => b.createdAt - a.createdAt)))
      .catch(() => live && setVersions([]));
    return () => {
      live = false;
    };
  }, [ed]);
  const restore = async (v: VersionInfo) => {
    if (!ed.source.restoreVersion) return;
    try {
      await ed.source.flush();
      await ed.source.restoreVersion(v.id, (diff) => ed.batch(RESTORE_LABEL, () => void ed.engine.applyChanges(diff, "user")));
      showToast({ message: "Version restored" });
      close();
    } catch {
      showToast({ message: "The version couldn't be restored", kind: "error" });
    }
  };
  return (
    <Dialog title="Version history" size="medium" open onClose={close}>
      {versions === null ? (
        <div className={styles.loading}>
          <Spinner size={24} />
        </div>
      ) : versions.length === 0 ? (
        <EmptyState icon="24.recent" title="No versions yet" body={`Versions are saved as you work, and with Save to version history (${shortcutOf(command("file.save-version"))}).`} />
      ) : (
        <ul className={styles.list}>
          {versions.map((v) => (
            <li key={v.id} className={styles.row}>
              <span className={styles.text}>
                <span className={styles.title}>{v.title || KIND_TITLE[v.kind]}</span>
                <span className={styles.meta}>
                  {when(v.createdAt)}
                  {v.description ? ` · ${v.description}` : ""}
                </span>
              </span>
              <Button variant="secondary" onClick={() => void restore(v)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
