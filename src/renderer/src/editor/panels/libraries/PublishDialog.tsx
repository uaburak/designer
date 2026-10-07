/**
 * Publish library (UI3; help.figma.com "Publish a library", R5): what changed since the last publish — new,
 * modified and removed components, styles and variables, each with a checkbox (deselecting a modified asset keeps
 * its last published version; a removed one stays published; what a selected asset uses goes with it: "Used by …",
 * its checkbox locked) — a description subscribers see with the update, components pasted from another library
 * (Move to this file / Publish as a copy) and the ones moved out to another library ("Moved to …"), what is hidden
 * when publishing, then progress and "Library published". Files in Drafts can't publish ("Move to a folder to
 * publish").
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Dialog, EmptyState, Icon, MIXED, Select, Spinner, TextArea, showToast } from "@/ds";
import type { LibraryAsset } from "../../../../../shared/store/types";
import { useEditor } from "../../controller";
import { useLibraries, useUI } from "../../hooks";
import { draftPublish, publishLibrary, publishPlan, type PublishDraft, type PublishItem } from "../../libraries";
import { NodeThumb, RemoteThumb } from "./Thumbs";
import styles from "./Libraries.module.css";

type Row = { key: string; name: string; kind: LibraryAsset["kind"]; status: "created" | "modified" | "removed"; item?: PublishItem; removed?: LibraryAsset };

/** "Used by Button", "Used by Button and Chip", "Used by Button and 2 others". */
export const usedByText = (names: readonly string[]): string =>
  names.length <= 1 ? `Used by ${names[0] ?? ""}` : names.length === 2 ? `Used by ${names[0]} and ${names[1]}` : `Used by ${names[0]} and ${names.length - 1} others`;

const STATUS_LABEL: Record<Row["status"], string> = { created: "New", modified: "Modified", removed: "Removed" };
const GROUPS: { title: string; kinds: LibraryAsset["kind"][] }[] = [
  { title: "Components", kinds: ["COMPONENT", "COMPONENT_SET"] },
  { title: "Styles", kinds: ["STYLE"] },
  { title: "Variables", kinds: ["VARIABLE_COLLECTION", "VARIABLE"] },
];

export function PublishDialog() {
  const open = useUI((s) => s.publishOpen);
  return open ? <Publish /> : null;
}

function Publish() {
  const ed = useEditor();
  const state = useLibraries();
  const [draft, setDraft] = useState<PublishDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveModes, setMoveModes] = useState<Map<string, "move" | "copy">>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const close = () => {
    ed.ui.set({ publishOpen: false });
    ed.focusCanvas();
  };
  const inDrafts = state.inDrafts;
  useEffect(() => {
    if (inDrafts) return;
    let live = true;
    void draftPublish(ed)
      .then((d) => {
        if (!live) return;
        setDraft(d);
        setSelected(new Set([...d.items.filter((i) => i.status === "created" || i.status === "modified").map((i) => i.key), ...d.removed.map((r) => r.key)]));
        setMoveModes(new Map(d.moves.map((m) => [m.fromKey, "move" as const])));
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [ed, inDrafts]);

  const rows = useMemo<Row[]>(() => {
    if (!draft) return [];
    return [
      ...draft.items.filter((i) => i.status === "created" || i.status === "modified").map((i) => ({ key: i.key, name: i.asset.name, kind: i.asset.kind, status: i.status as Row["status"], item: i })),
      ...draft.removed.map((r) => ({ key: r.key, name: r.name, kind: r.kind, status: "removed" as const, removed: r })),
    ];
  }, [draft]);
  const plan = useMemo(() => (draft ? publishPlan(draft, selected) : null), [draft, selected]);
  // A new or modified asset a published one uses goes with it: checked, and locked while that one is selected.
  const locked = (r: Row) => r.status !== "removed" && !!plan?.usedBy.has(r.key);
  const checked = (r: Row) => (r.status === "removed" ? selected.has(r.key) : !!plan?.chosen.has(r.key));
  const hiddenCount = draft?.hiddenCount ?? 0;
  const toggle = (keys: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const publish = async () => {
    if (!draft) return;
    setProgress({ done: 0, total: draft.items.length });
    try {
      const published = await publishLibrary(ed, draft, { description: description.trim(), selected, moveModes }, (done, total) => setProgress({ done, total }));
      // Published; should this file not have recorded it on its assets yet (an edit kept the engine busy), it says so.
      showToast(published.recorded ? { message: "Library published", kind: "success" } : { message: "Library published, but this file couldn't record it yet", kind: "error" });
      close();
    } catch (e) {
      setProgress(null);
      const code = (e as { code?: string }).code;
      showToast({ message: code === "draft-cannot-publish" ? "Move this file to a folder to publish it" : "The library couldn't be published", kind: "error" });
    }
  };
  const firstPublish = !state.own;
  const count = rows.filter(checked).length;
  const movedOut = draft?.movedOut ?? [];
  const nothing = !!draft && rows.length === 0 && !draft.moves.length && !movedOut.length;

  if (inDrafts) {
    return (
      <Dialog title="Publish library" size="medium" open onClose={close} footer={<Button variant="secondary" onClick={close}>Close</Button>}>
        <div className={styles.publishEmpty} data-publish-drafts="">
          <EmptyState icon="24.library" title="Move to a folder to publish" body="Files in Drafts can't be published as libraries. Move this file to a folder, then publish its components, styles and variables for your team's files." />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Publish library"
      size="medium"
      open
      onClose={close}
      footer={
        <>
          {progress && (
            <span className={styles.progress} role="status">
              <Spinner /> Publishing… {progress.done}/{progress.total}
            </span>
          )}
          <Button variant="secondary" onClick={close} disabled={!!progress}>
            Cancel
          </Button>
          <Button variant="primary" loading={!!progress} disabled={!draft || (count === 0 && !draft.moves.length && !movedOut.length)} onClick={() => void publish()}>
            Publish
          </Button>
        </>
      }
    >
      <div className={styles.publish} data-publish-dialog="">
        <div className={styles.publishFile}>
          <Icon name="24.library" className={styles.publishFileIcon} />
          <div className={styles.publishFileText}>
            <span className={styles.publishFileName}>{ed.ui.get().fileName}</span>
            <span className={styles.meta}>{firstPublish ? "Not published yet" : `Version ${state.own!.latestVersion} · published ${new Date(state.own!.lastPublishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}</span>
          </div>
        </div>
        <TextArea label="Description" placeholder="Describe what changed (optional)" value={description} onChange={setDescription} />
        {error && <div className={styles.error}>{error}</div>}
        {!draft && !error && (
          <div className={styles.loading}>
            <Spinner /> Looking for changes…
          </div>
        )}
        {nothing && <div className={styles.none}>No changes to publish</div>}
        {draft && rows.length > 0 && (
          <div className={styles.changes} role="group" aria-label="Changes">
            <div className={styles.changesHeader}>
              <Checkbox label={`${count} of ${rows.length} ${rows.length === 1 ? "change" : "changes"} selected`} checked={count === rows.length ? true : count === 0 ? false : MIXED} onChange={(on) => toggle(rows.map((r) => r.key), on)} />
            </div>
            {GROUPS.map((g) => {
              const list = rows.filter((r) => g.kinds.includes(r.kind));
              if (!list.length) return null;
              return (
                <div key={g.title} className={styles.changeGroup}>
                  <div className={styles.changeGroupTitle}>
                    {g.title} <span className={styles.meta}>{list.length}</span>
                  </div>
                  {list.map((r) => {
                    const users = plan?.usedBy.get(r.key);
                    return (
                      <label key={r.key} className={styles.changeRow} data-change={r.name} data-status={r.status} data-locked={locked(r) ? "" : undefined}>
                        <Checkbox label={r.name} hideLabel checked={checked(r)} disabled={locked(r)} onChange={(on) => toggle([r.key], on)} />
                        {r.item ? <NodeThumb node={r.item.asset.guid} kind={r.kind} size={32} /> : <RemoteThumb asset={r.removed!} size={32} />}
                        <span className={styles.changeText}>
                          <span className={styles.changeName}>{r.name}</span>
                          {users?.length ? <span className={styles.meta}>{usedByText(users)}</span> : null}
                        </span>
                        <span className={styles[`status_${r.status}`]}>{STATUS_LABEL[r.status]}</span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {draft && (draft.moves.length > 0 || movedOut.length > 0) && (
          <div className={styles.changeGroup} role="group" aria-label="Moved components">
            <div className={styles.changeGroupTitle}>Moved components</div>
            {movedOut.map((m) => (
              <div key={m.key} className={styles.moveRow} data-moved-out={m.name}>
                <RemoteThumb asset={m.asset ?? { kind: m.kind, thumbnail: null }} size={32} />
                <div className={styles.moveText}>
                  <span className={styles.changeName}>{m.name}</span>
                  <span className={styles.meta}>Moved to {m.toName}</span>
                </div>
              </div>
            ))}
            {draft.moves.map((m) => (
              <div key={m.fromKey} className={styles.moveRow} data-move={m.item.asset.name}>
                <NodeThumb node={m.item.asset.guid} kind={m.item.asset.kind} size={32} />
                <div className={styles.moveText}>
                  <span className={styles.changeName}>{m.item.asset.name}</span>
                  <span className={styles.meta}>From {m.fromName}</span>
                </div>
                <Select
                  width="hug"
                  label={`${m.item.asset.name}: move or copy`}
                  value={moveModes.get(m.fromKey) ?? "move"}
                  options={[
                    { value: "move", label: "Move to this file" },
                    { value: "copy", label: "Publish as a copy" },
                  ]}
                  onChange={(v) => setMoveModes((x) => new Map(x).set(m.fromKey, v as "move" | "copy"))}
                />
              </div>
            ))}
          </div>
        )}
        {hiddenCount > 0 && <div className={styles.meta}>{hiddenCount === 1 ? "1 asset is hidden when publishing" : `${hiddenCount} assets are hidden when publishing`}</div>}
      </div>
    </Dialog>
  );
}
