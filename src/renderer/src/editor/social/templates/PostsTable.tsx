/**
 * The posts table (docs/social.md §4.5, Buzz's table [ours]): Table in the toolbar's Social slot (`social.table`)
 * docks it along the editor's bottom like Motion's timeline. One row per post of the page, in campaign order: its
 * picture, name, format, brand, the template's text slots (a column per role any post has: Headline, Body, CTA,
 * Label), Caption, Hashtags, Alt text, Status. A cell edits in place — a text slot through its TEXT property
 * (templates.ts `fillSlots`), the rest through the post's record (actions.ts `setPost`) — one undo step per cell; a
 * row's click selects the post. Import CSV… makes one post per row × format from a template as a new campaign
 * (csvImport.ts).
 */
import { Fragment, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Dialog, IconButton, Select, TextInput, showToast } from "@/ds";
import { t, tp, useT } from "@/i18n";
import type { Guid } from "@/engine/codec";
import { formatById } from "@shared/social/formats";
import { POST_STATUSES, type PostStatus, type SlotRole } from "@shared/social/types";
import { useEditor } from "../../controller";
import { useTopics, useUI } from "../../hooks";
import { applySelection } from "../../agents/mcpTools";
import { useBrands } from "../../studio/forms";
import { canWritePosts, editorWriter, setPost } from "../actions";
import { boardBrand } from "../NewPostMenu";
import { PostThumb, formatLabel } from "../PostsList";
import { useSocialBoard } from "../socialState";
import { MAX_ROWS, importCsvPosts, readCsvPosts, type CsvPost } from "./csvImport";
import { ROLE_NAMES, TEXT_ROLES, fillSlots, postSlots, slotTexts } from "./templates";
import { useTemplates } from "./TemplatesGallery";
import styles from "./Templates.module.css";

const STATUS_LABEL: Record<PostStatus, string> = { draft: "Draft", reviewed: "Reviewed", approved: "Approved", exported: "Exported" };

export function PostsTable() {
  const open = useUI((s) => s.mode === "social" && !!s.socialTable && !s.uiHidden);
  return open ? <Table /> : null;
}

function Table() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const { brands } = useBrands();
  const version = useTopics(ed.store, ["selection"]);
  const write = canWritePosts(ed);
  const selected = useMemo(() => {
    void version;
    return new Set(ed.store.selection.refs);
  }, [ed, version]);
  // The text roles any post's template has, in Figma's order of the roles.
  const rows = useMemo(() => board.groups.map((g) => ({ group: g, posts: g.posts.map((p) => ({ post: p, texts: slotTexts(ed, p.id), slots: postSlots(ed, p.id) })) })), [ed, board]);
  const roles = TEXT_ROLES.filter((r) => rows.some((g) => g.posts.some((p) => p.texts[r] !== undefined)));
  const w = editorWriter(ed);
  const patch = (id: Guid, p: Parameters<typeof setPost>[3]) => write && setPost(ed, w, [id], p);
  const fill = (id: Guid, role: SlotRole, value: string) => {
    if (!write) return;
    void fillSlots(ed, w, id, { [role]: value }).then((r) => {
      if (r.locked.length) showToast({ message: t("{role} is locked in this template", { role: t(ROLE_NAMES[role]) }) });
    });
  };
  const brandName = (id: string | null) => (id ? (brands?.find((b) => b.id === id)?.name ?? "") : "");
  return (
    <section className={styles.table} data-social-table="" aria-label={t("Posts table")}>
      <header className={styles.tableHeader}>
        <span className={styles.tableTitle}>{tp(board.posts.length, "{n} post", "{n} posts")}</span>
        <Button variant="secondary" disabled={!write} onClick={() => ed.ui.set({ socialCsvImport: true })} data-csv-import="">
          {t("Import CSV…")}
        </Button>
        <IconButton icon="24.close.small" label={t("Close table")} onClick={() => ed.ui.set({ socialTable: false })} />
      </header>
      <div className={styles.tableScroll}>
        <table className={styles.grid2}>
          <thead>
            <tr>
              <th className={styles.th} aria-label={t("Picture")} />
              <th className={styles.th}>{t("Name")}</th>
              <th className={styles.th}>{t("Format")}</th>
              <th className={styles.th}>{t("Brand")}</th>
              {roles.map((r) => (
                <th key={r} className={styles.th}>
                  {t(ROLE_NAMES[r])}
                </th>
              ))}
              <th className={styles.th}>{t("Caption")}</th>
              <th className={styles.th}>{t("Hashtags")}</th>
              <th className={styles.th}>{t("Alt text")}</th>
              <th className={styles.th}>{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ group, posts }) => (
              <Fragment key={group.campaign?.id ?? "none"}>
                {board.groups.length > 1 && (
                  <tr>
                    <td className={styles.campaign} colSpan={8 + roles.length}>
                      {group.campaign ? group.campaign.name || t("Untitled campaign") : t("No campaign")}
                    </td>
                  </tr>
                )}
                {posts.map(({ post, texts, slots }) => (
                  <tr key={post.id} className={styles.row} aria-selected={selected.has(post.id)} onClick={() => applySelection(ed, [post.id], true)} data-table-post={post.id}>
                    <td className={styles.td}>
                      <PostThumb row={post} />
                    </td>
                    <td className={styles.td}>
                      <span className={styles.cellText}>{post.name}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.cellText}>{formatLabel(post).name}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.cellText}>{brandName(post.data.brandId)}</span>
                    </td>
                    {roles.map((r) => (
                      <td key={r} className={styles.td}>
                        {texts[r] !== undefined ? <Cell label={t(ROLE_NAMES[r])} value={texts[r] ?? ""} disabled={!write || slots.some((s) => s.data.role === r && s.data.locked)} onCommit={(v) => fill(post.id, r, v)} data-cell={r} /> : null}
                      </td>
                    ))}
                    <td className={styles.td}>
                      <Cell label={t("Caption")} value={post.data.caption} disabled={!write} onCommit={(caption) => patch(post.id, { caption })} data-cell="caption" />
                    </td>
                    <td className={styles.td}>
                      <Cell label={t("Hashtags")} value={post.data.hashtags.map((h) => `#${h}`).join(" ")} disabled={!write} onCommit={(v) => patch(post.id, { hashtags: v.split(/[\s,]+/) })} data-cell="hashtags" />
                    </td>
                    <td className={styles.td}>
                      <Cell label={t("Alt text")} value={post.data.altText} disabled={!write} onCommit={(altText) => patch(post.id, { altText })} data-cell="alt" />
                    </td>
                    <td className={styles.td} onClick={(e) => e.stopPropagation()}>
                      <Select label={t("Status")} variant="ghost" value={post.data.status} disabled={!write} options={POST_STATUSES.map((s) => ({ value: s, label: t(STATUS_LABEL[s]) }))} onChange={(v) => patch(post.id, { status: v as PostStatus })} />
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <CsvImportDialog />
    </section>
  );
}

/** A cell: a ghost field written when it is left (Enter / Tab); a click in it doesn't select the row. */
function Cell({ label, value, disabled, onCommit, ...rest }: { label: string; value: string; disabled: boolean; onCommit: (v: string) => void; "data-cell": string }) {
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <TextInput label={label} variant="ghost" value={value} disabled={disabled} className={styles.cell} onCommit={(v) => v !== value && onCommit(v)} {...rest} />
    </span>
  );
}

/** "‹file name›" without its extension, the new campaign's default name. */
const baseName = (name: string) => name.replace(/\.[^.]+$/, "");

function CsvImportDialog() {
  const open = useUI((s) => !!s.socialCsvImport);
  return open ? <CsvImport /> : null;
}

function CsvImport() {
  useT();
  const ed = useEditor();
  const { brands } = useBrands();
  const templates = useTemplates();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; posts: CsvPost[]; columns: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string>(templates[0]?.key ?? "");
  const template = templates.find((x) => x.key === key) ?? null;
  const [formats, setFormats] = useState<string[] | null>(null);
  const chosen = formats ?? (template ? [Object.values(template.data.formats)[0]].filter(Boolean) : []);
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => ed.ui.set({ socialCsvImport: false });
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const read = readCsvPosts(await f.text());
    if ("error" in read) {
      setFile(null);
      return setError(read.error);
    }
    setError(null);
    setFile({ name: f.name, posts: read.posts, columns: read.columns });
    if (!campaign) setCampaign(baseName(f.name));
  };
  const run = async () => {
    if (!file || !template || !chosen.length || busy) return;
    setBusy(true);
    try {
      const made = await importCsvPosts(ed, editorWriter(ed), file.posts, { key: template.key, formatIds: chosen, campaign: campaign.trim() || baseName(file.name), brandId: boardBrand(ed, brands)?.id ?? null, brands: brands ?? [] });
      close();
      showToast({ message: tp(made.length, "{n} post made", "{n} posts made") });
      if (made.length) applySelection(ed, made, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("Import CSV")}
      size="medium"
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" disabled={!file || !template || !chosen.length || busy} onClick={() => void run()} data-csv-run="">
            {file ? tp(file.posts.length * chosen.length, "Make {n} post", "Make {n} posts") : t("Make posts")}
          </Button>
        </>
      }
    >
      <div className={styles.form} data-csv-dialog="">
        <div className={styles.field}>
          <span className={styles.label}>{t("File")}</span>
          <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => void pick(e.currentTarget.files?.[0])} data-csv-file="" />
          <Button variant="secondary" onClick={() => input.current?.click()}>
            {file ? file.name : t("Choose a CSV file…")}
          </Button>
          <p className={styles.hint}>
            {file
              ? t("{rows} · columns: {columns}", { rows: tp(file.posts.length, "{n} row", "{n} rows"), columns: file.columns.join(", ") })
              : t("A header row names the columns: headline, body, cta, label, caption, hashtags, alt, product, brand. At most {max} rows.", { max: String(MAX_ROWS) })}
          </p>
        </div>
        <label className={styles.field}>
          <span className={styles.label}>{t("Template")}</span>
          <Select
            label={t("Template")}
            value={key || "none"}
            disabled={!templates.length}
            options={templates.length ? templates.map((x) => ({ value: x.key, label: x.name })) : [{ value: "none", label: t("No templates yet") }]}
            onChange={(v) => {
              setKey(v);
              setFormats(null);
            }}
          />
        </label>
        {template && (
          <div className={styles.field}>
            <span className={styles.label}>{t("Formats")}</span>
            <div className={styles.checks}>
              {Object.entries(template.data.formats).map(([variant, id]) => (
                <Checkbox key={variant} label={formatById(id) ? t(formatById(id)!.name) : variant} checked={chosen.includes(id)} onChange={(on) => setFormats(on ? [...chosen, id] : chosen.filter((x) => x !== id))} />
              ))}
            </div>
          </div>
        )}
        <label className={styles.field}>
          <span className={styles.label}>{t("Campaign")}</span>
          <TextInput label={t("Campaign")} value={campaign} placeholder={t("New campaign")} onChange={setCampaign} />
        </label>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
