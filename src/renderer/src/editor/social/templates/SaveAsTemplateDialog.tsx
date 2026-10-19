/**
 * Save as template… (docs/social.md §4.4): a post's menu, the Post section and the command `social.save-as-template`
 * open it for one post. The name, the platforms, more formats (each a variant of its own), and the slots Save as
 * template infers — texts by size and order, the logo instance, the picture-filled layer, brand-bound fills — each
 * with its role (or none), whether a post may change it, and for text the most characters that fit, for the owner to
 * correct. Save makes the set (templates.ts `saveAsTemplate`, one undo step); a missing wiring is named and nothing
 * changes.
 */
import { useMemo, useState } from "react";
import { Button, Checkbox, Dialog, Select, TextInput, showToast } from "@/ds";
import { t, useT } from "@/i18n";
import type { Guid } from "@/engine/codec";
import { FIRST_PLATFORMS, PLATFORMS, PLATFORM_NAMES, formatById, formatsFor } from "@shared/social/formats";
import { SLOT_ROLES, type Platform, type SlotRole } from "@shared/social/types";
import { useEditor } from "../../controller";
import { useUI } from "../../hooks";
import { applySelection } from "../../agents/mcpTools";
import { editorWriter } from "../actions";
import { readPost } from "../posts";
import { ROLE_NAMES, TEXT_ROLES, inferSlots, saveAsTemplate } from "./templates";
import styles from "./Templates.module.css";

const NONE = "none";

export function SaveAsTemplateDialog() {
  const id = useUI((s) => s.socialSaveTemplate ?? null);
  return id ? <SaveAsTemplate key={id} id={id} /> : null;
}

interface SlotRow {
  nodeId: Guid;
  name: string;
  role: SlotRole | null;
  locked: boolean;
  maxChars: string;
}

function SaveAsTemplate({ id }: { id: Guid }) {
  useT();
  const ed = useEditor();
  const close = () => ed.ui.set({ socialSaveTemplate: null });
  const post = readPost(ed, id);
  const format = post ? formatById(post.formatId) : null;
  const [name, setName] = useState(() => ed.engine.readNode(id, { fields: ["name"] })?.name ?? t("Untitled template"));
  const [platforms, setPlatforms] = useState<Platform[]>(() => (format ? [format.platform] : [...FIRST_PLATFORMS]));
  const [formats, setFormats] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SlotRow[]>(() => inferSlots(ed, id).map((s) => ({ nodeId: s.nodeId, name: ed.engine.readNode(s.nodeId, { fields: ["name"] })?.name ?? s.nodeId, role: s.role, locked: false, maxChars: "" })));
  // More formats: the picked platforms' formats other than the post's own.
  const more = useMemo(() => platforms.flatMap((p) => formatsFor(p)).filter((f) => f.id !== post?.formatId), [platforms, post?.formatId]);
  const set = (i: number, patch: Partial<SlotRow>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const save = () => {
    const slots = rows.filter((r) => r.role).map((r) => ({ nodeId: r.nodeId, role: r.role!, locked: r.locked, maxChars: Number(r.maxChars) > 0 ? Math.round(Number(r.maxChars)) : null }));
    const done = saveAsTemplate(ed, editorWriter(ed), id, { name: name.trim() || t("Untitled template"), platforms, formats: formats.filter((f) => more.some((m) => m.id === f)), slots });
    if ("error" in done) return setError(done.error);
    close();
    showToast({ message: t("Template saved: {name}", { name: name.trim() || t("Untitled template") }) });
    const made = (done as { post?: Guid | null }).post;
    if (made) applySelection(ed, [made], false);
  };
  return (
    <Dialog
      title={t("Save as template")}
      size="medium"
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" onClick={save} data-save-template="">
            {t("Save as template")}
          </Button>
        </>
      }
    >
      <div className={styles.form} data-save-template-dialog={id}>
        <label className={styles.field}>
          <span className={styles.label}>{t("Name")}</span>
          <TextInput label={t("Name")} value={name} onChange={setName} autoFocus data-autofocus="" />
        </label>
        <div className={styles.field}>
          <span className={styles.label}>{t("Platforms")}</span>
          <div className={styles.checks}>
            {PLATFORMS.map((p) => (
              <Checkbox key={p} label={PLATFORM_NAMES[p]} checked={platforms.includes(p)} onChange={(on) => setPlatforms((list) => (on ? [...list, p] : list.filter((x) => x !== p)))} />
            ))}
          </div>
        </div>
        {more.length > 0 && (
          <div className={styles.field}>
            <span className={styles.label}>{t("Also as")}</span>
            <div className={styles.checks}>
              {more.map((f) => (
                <Checkbox key={f.id} label={`${t(f.name)} · ${f.width} × ${f.height}`} checked={formats.includes(f.id)} onChange={(on) => setFormats((list) => (on ? [...list, f.id] : list.filter((x) => x !== f.id)))} />
              ))}
            </div>
          </div>
        )}
        <div className={styles.field}>
          <span className={styles.label}>{t("Slots")}</span>
          {rows.length ? (
            <div className={styles.slots}>
              {rows.map((r, i) => (
                <div key={r.nodeId} className={styles.slot} data-template-slot={r.role ?? NONE}>
                  <span className={styles.slotName}>{r.name}</span>
                  <Select label={t("Role")} value={r.role ?? NONE} options={[...SLOT_ROLES.map((role) => ({ value: role, label: t(ROLE_NAMES[role]) })), "-", { value: NONE, label: t("Not a slot") }]} onChange={(v) => set(i, { role: v === NONE ? null : (v as SlotRole) })} />
                  <Checkbox label={t("Locked")} checked={r.locked} onChange={(locked) => set(i, { locked })} />
                  {r.role && TEXT_ROLES.includes(r.role) ? <TextInput label={t("Most characters")} placeholder={t("Any")} value={r.maxChars} onChange={(v) => set(i, { maxChars: v.replace(/\D/g, "") })} /> : <span />}
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.hint}>{t("No texts, logo, picture or brand colours found to make slots of.")}</p>
          )}
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
