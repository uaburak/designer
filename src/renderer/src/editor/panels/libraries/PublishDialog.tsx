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
import { componentPublishErrors, publishErrorLine } from "../../components";
import type { PropertyPublishError } from "../../model/components";
import { NodeThumb, RemoteThumb } from "./Thumbs";
import styles from "./Libraries.module.css";
import { intlLocale, t, tp, useT } from "@/i18n";

type Row = { key: string; name: string; kind: LibraryAsset["kind"]; status: "created" | "modified" | "removed"; item?: PublishItem; removed?: LibraryAsset; errors: PropertyPublishError[] };

/** "Used by Button", "Used by Button and Chip", "Used by Button and 2 others". */
export const usedByText = (names: readonly string[]): string =>
  names.length <= 1 ? t("Used by {name}", { name: names[0] ?? "" }) : names.length === 2 ? t("Used by {a} and {b}", { a: names[0], b: names[1] }) : tp(names.length - 1, "Used by {name} and {n} other", "Used by {name} and {n} others", { name: names[0] });

const STATUS_LABEL: Record<Row["status"], string> = { created: "New", modified: "Modified", removed: "Removed" };
const isComponentKind = (k: LibraryAsset["kind"]) => k === "COMPONENT" || k === "COMPONENT_SET";
const GROUPS: { title: string; kinds: LibraryAsset["kind"][] }[] = [
  { title: "Components", kinds: ["COMPONENT", "COMPONENT_SET"] },
  { title: "Styles", kinds: ["STYLE"] },
  { title: "Variables", kinds: ["VARIABLE_COLLECTION", "VARIABLE"] },
];

/** A failed publish, in words (the store's codes; an org library's server refusals come as `forbidden` with their code). */
export function publishErrorText(e: unknown): string {
  const code = (e as { code?: string }).code;
  const detail = ((e as { detail?: { code?: string } }).detail ?? {}).code;
  if (code === "draft-cannot-publish" || detail === "draft_cannot_publish") return t("Move this file to a folder to publish it");
  if (code === "branch-cannot-publish" || detail === "branch_cannot_publish") return t("Libraries can only be published from the main file");
  if (detail === "seat_required") return t("You need a Full seat to publish a library");
  if (code === "conflict") return t("Someone else published this library. Review the changes and publish again");
  if (code === "offline") return t("You're offline. Publish again when you're back online");
  return t("The library couldn't be published");
}

export function PublishDialog() {
  const open = useUI((s) => s.publishOpen);
  return open ? <Publish /> : null;
}

function Publish() {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  const [draft, setDraft] = useState<PublishDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveModes, setMoveModes] = useState<Map<string, "move" | "copy">>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // An org file (docs/data.md §16.6): "Allow any member of ‹org› to access the file" — checked when the library is
  // already published to the organization; changes the file's link access, so only for people who can share it.
  const org = state.org;
  const [toOrg, setToOrg] = useState<boolean | null>(null);
  const orgChecked = toOrg ?? org?.scope === "org";
  const close = () => {
    ed.ui.set({ publishOpen: false });
    ed.focusCanvas();
  };
  const inDrafts = state.inDrafts;
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (inDrafts) return;
    let live = true;
    void draftPublish(ed)
      .then((d) => {
        if (!live) return;
        setDraft(d);
        // A component with property errors (Figma's publish errors) isn't published: left out until it is fixed.
        const publishable = (i: PublishItem) => !isComponentKind(i.asset.kind) || componentPublishErrors(ed, i.asset.guid).length === 0;
        setSelected(new Set([...d.items.filter((i) => (i.status === "created" || i.status === "modified") && publishable(i)).map((i) => i.key), ...d.removed.map((r) => r.key)]));
        setMoveModes(new Map(d.moves.map((m) => [m.fromKey, "move" as const])));
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [ed, inDrafts, reload]);

  const rows = useMemo<Row[]>(() => {
    if (!draft) return [];
    return [
      ...draft.items
        .filter((i) => i.status === "created" || i.status === "modified")
        .map((i) => ({ key: i.key, name: i.asset.name, kind: i.asset.kind, status: i.status as Row["status"], item: i, errors: isComponentKind(i.asset.kind) ? componentPublishErrors(ed, i.asset.guid) : [] })),
      ...draft.removed.map((r) => ({ key: r.key, name: r.name, kind: r.kind, status: "removed" as const, removed: r, errors: [] })),
    ];
  }, [draft, ed]);
  const plan = useMemo(() => (draft ? publishPlan(draft, selected) : null), [draft, selected]);
  // A new or modified asset a published one uses goes with it: checked, and locked while that one is selected. One
  // with property errors can't be chosen (Figma's componentPropDefError).
  const locked = (r: Row) => r.errors.length > 0 || (r.status !== "removed" && !!plan?.usedBy.has(r.key));
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
      const published = await publishLibrary(ed, draft, { description: description.trim(), selected, moveModes, ...(org?.canShare ? { scope: orgChecked ? ("org" as const) : ("team" as const) } : {}) }, (done, total) => setProgress({ done, total }));
      // Published; should this file not have recorded it on its assets yet (an edit kept the engine busy), it says so.
      showToast(published.recorded ? { message: t("Library published"), kind: "success" } : { message: t("Library published, but this file couldn't record it yet"), kind: "error" });
      close();
    } catch (e) {
      setProgress(null);
      showToast({ message: publishErrorText(e), kind: "error" });
      // Someone published meanwhile (an org library, docs/data.md §16.6): the changes are looked for again.
      if ((e as { code?: string }).code === "conflict") setReload((n) => n + 1);
    }
  };
  const firstPublish = !state.own;
  const count = rows.filter(checked).length;
  const choosable = rows.filter((r) => r.errors.length === 0);
  const movedOut = draft?.movedOut ?? [];
  const nothing = !!draft && rows.length === 0 && !draft.moves.length && !movedOut.length;

  if (inDrafts) {
    return (
      <Dialog title={t("Publish library")} size="medium" open onClose={close} footer={<Button variant="secondary" onClick={close}>{t("Close")}</Button>}>
        <div className={styles.publishEmpty} data-publish-drafts="">
          <EmptyState icon="24.library" title={t("Move to a folder to publish")} body={t("Files in Drafts can't be published as libraries. Move this file to a folder, then publish its components, styles and variables for your team's files.")} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t("Publish library")}
      size="medium"
      open
      onClose={close}
      footer={
        <>
          {progress && (
            <span className={styles.progress} role="status">
              <Spinner /> {t("Publishing… {done}/{total}", { done: progress.done, total: progress.total })}
            </span>
          )}
          <Button variant="secondary" onClick={close} disabled={!!progress}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" loading={!!progress} disabled={!draft || (count === 0 && !draft.moves.length && !movedOut.length)} onClick={() => void publish()}>
            {t("Publish")}
          </Button>
        </>
      }
    >
      <div className={styles.publish} data-publish-dialog="">
        <div className={styles.publishFile}>
          <Icon name="24.library" className={styles.publishFileIcon} />
          <div className={styles.publishFileText}>
            <span className={styles.publishFileName}>{ed.ui.get().fileName}</span>
            <span className={styles.meta}>{firstPublish ? t("Not published yet") : t("Version {version} · published {date}", { version: state.own!.latestVersion, date: new Date(state.own!.lastPublishedAt).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" }) })}</span>
          </div>
        </div>
        <TextArea label={t("Description")} placeholder={t("Describe what changed (optional)")} value={description} onChange={setDescription} />
        {org && (
          <div className={styles.orgScope} data-publish-org-scope="">
            <Checkbox label={t("Allow any member of {org} to access the file", { org: org.orgName })} checked={orgChecked} disabled={!org.canShare || !!progress} onChange={setToOrg} />
            {!org.canShare && <span className={styles.orgScopeHint}>{t("Only people who can share this file can change who can access it")}</span>}
          </div>
        )}
        {error && <div className={styles.error}>{error}</div>}
        {!draft && !error && (
          <div className={styles.loading}>
            <Spinner /> {t("Looking for changes…")}
          </div>
        )}
        {nothing && <div className={styles.none}>{t("No changes to publish")}</div>}
        {draft && rows.length > 0 && (
          <div className={styles.changes} role="group" aria-label={t("Changes")}>
            <div className={styles.changesHeader}>
              <Checkbox label={tp(rows.length, "{count} of {n} change selected", "{count} of {n} changes selected", { count })} checked={count > 0 && count === choosable.length ? true : count === 0 ? false : MIXED} onChange={(on) => toggle(choosable.map((r) => r.key), on)} />
            </div>
            {GROUPS.map((g) => {
              const list = rows.filter((r) => g.kinds.includes(r.kind));
              if (!list.length) return null;
              return (
                <div key={g.title} className={styles.changeGroup}>
                  <div className={styles.changeGroupTitle}>
                    {t(g.title)} <span className={styles.meta}>{list.length}</span>
                  </div>
                  {list.map((r) => {
                    const users = plan?.usedBy.get(r.key);
                    return (
                      <label key={r.key} className={styles.changeRow} data-change={r.name} data-status={r.status} data-locked={locked(r) ? "" : undefined}>
                        <Checkbox label={r.name} hideLabel checked={checked(r)} disabled={locked(r)} onChange={(on) => toggle([r.key], on)} />
                        {r.item ? <NodeThumb node={r.item.asset.guid} kind={r.kind} size={32} /> : <RemoteThumb asset={r.removed!} size={32} />}
                        <span className={styles.changeText}>
                          <span className={styles.changeName}>{r.name}</span>
                          {r.errors.length ? (
                            <span className={styles.publishError} data-publish-error={r.errors[0].kind}>
                              {publishErrorLine(r.errors[0])}
                              {r.errors.length > 1 ? ` ${t("(+{n} more)", { n: r.errors.length - 1 })}` : ""}
                            </span>
                          ) : users?.length ? (
                            <span className={styles.meta}>{usedByText(users)}</span>
                          ) : null}
                        </span>
                        <span className={styles[`status_${r.status}`]}>{t(STATUS_LABEL[r.status])}</span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {draft && (draft.moves.length > 0 || movedOut.length > 0) && (
          <div className={styles.changeGroup} role="group" aria-label={t("Moved components")}>
            <div className={styles.changeGroupTitle}>{t("Moved components")}</div>
            {movedOut.map((m) => (
              <div key={m.key} className={styles.moveRow} data-moved-out={m.name}>
                <RemoteThumb asset={m.asset ?? { kind: m.kind, thumbnail: null }} size={32} />
                <div className={styles.moveText}>
                  <span className={styles.changeName}>{m.name}</span>
                  <span className={styles.meta}>{t("Moved to {name}", { name: m.toName })}</span>
                </div>
              </div>
            ))}
            {draft.moves.map((m) => (
              <div key={m.fromKey} className={styles.moveRow} data-move={m.item.asset.name}>
                <NodeThumb node={m.item.asset.guid} kind={m.item.asset.kind} size={32} />
                <div className={styles.moveText}>
                  <span className={styles.changeName}>{m.item.asset.name}</span>
                  <span className={styles.meta}>{t("From {name}", { name: m.fromName })}</span>
                </div>
                <Select
                  width="hug"
                  label={t("{name}: move or copy", { name: m.item.asset.name })}
                  value={moveModes.get(m.fromKey) ?? "move"}
                  options={[
                    { value: "move", label: t("Move to this file") },
                    { value: "copy", label: t("Publish as a copy") },
                  ]}
                  onChange={(v) => setMoveModes((x) => new Map(x).set(m.fromKey, v as "move" | "copy"))}
                />
              </div>
            ))}
          </div>
        )}
        {hiddenCount > 0 && <div className={styles.meta}>{tp(hiddenCount, "{n} asset is hidden when publishing", "{n} assets are hidden when publishing")}</div>}
      </div>
    </Dialog>
  );
}
