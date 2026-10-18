/**
 * The savepoint modal (docs/data.md §6; atlas 16 §3.2): "Add to version history" (⌥⌘S, the history's +) or "Edit
 * version information" (a version's Name this version / Edit version info, a double-click in the history) — a title
 * and a description; Save stays off until the title has text. Outside history mode, "Show full version history" opens
 * it. The history itself is VersionHistory.tsx.
 */
import { t, useT } from "@/i18n";
import { useState } from "react";
import { Button, Dialog, TextArea, TextInput, showToast } from "@/ds";
import { useEditor } from "./controller";
import type { VersionInfo } from "./documentSource";
import { useUI } from "./hooks";
import { versionsChanged } from "./VersionHistory";
import styles from "./VersionDialogs.module.css";

export function VersionDialogs() {
  const savepoint = useUI((s) => s.savepoint ?? null);
  return savepoint ? <Savepoint key={savepoint.version?.id ?? "new"} version={savepoint.version} /> : null;
}

function Savepoint({ version }: { version: VersionInfo | null }) {
  useT();
  const ed = useEditor();
  const history = useUI((s) => s.versionDialog === "history");
  const [title, setTitle] = useState(version?.title ?? "");
  const [description, setDescription] = useState(version?.description ?? "");
  const [busy, setBusy] = useState(false);
  const close = () => {
    ed.ui.set({ savepoint: null });
    if (!history) ed.focusCanvas();
  };
  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      if (version) await ed.source.updateVersion?.(version.id, { title: title.trim(), description: description.trim() });
      else {
        if (!ed.source.saveVersion) return;
        await ed.source.flush();
        await ed.source.saveVersion({ title: title.trim(), description: description.trim() || undefined });
        showToast({ message: t("Version saved") });
      }
      versionsChanged();
      close();
    } catch {
      setBusy(false);
      showToast({ message: t("The version couldn't be saved"), kind: "error" });
    }
  };
  return (
    <Dialog
      title={version ? t("Edit version information") : t("Add to version history")}
      open
      onClose={close}
      footer={
        <>
          {!version && !history && ed.source.listVersions && (
            <Button variant="link" className={styles.fullHistory} onClick={() => ed.ui.set({ savepoint: null, versionDialog: "history", historyVersion: null })}>
              {t("Show full version history")}
            </Button>
          )}
          <Button variant="secondary" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void save()}>
            {t("Save")}
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextInput label={t("Title")} placeholder={t("Title")} value={title} onChange={setTitle} autoFocus />
        <TextArea label={t("Describe what changed")} placeholder={t("Describe what changed")} value={description} onChange={setDescription} />
      </form>
    </Dialog>
  );
}
