/**
 * The posts table (docs/social.md §4.5, Buzz's table [ours]): Table in the toolbar's Social slot (`social.table`)
 * docks it along the editor's bottom like Motion's timeline. One row per post of the page, in campaign order: its
 * picture, name, format, brand, the template's text slots (a column per role any post has: Headline, Body, CTA,
 * Label), Caption, Hashtags, Alt text, Status. A cell edits in place — a text slot through its TEXT property
 * (templates.ts `fillSlots`), the rest through the post's record (actions.ts `setPost`) — one undo step per cell; a
 * paste of several cells from a spreadsheet fills rightwards and down from the cell, one undo step; a header's click
 * sorts the posts within each campaign by it (ascending, descending, back to the campaign's order); a row's click
 * selects the post. Import CSV… makes one post per row × format from a template as a new campaign (csvImport.ts).
 */
import { Fragment, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Dialog, Icon, IconButton, Select, TextInput, showToast } from "@/ds";
import { intlLocale, t, tp, useT } from "@/i18n";
import type { Guid } from "@/engine/codec";
import { formatById } from "@shared/social/formats";
import { POST_STATUSES, type PostStatus, type SlotRole } from "@shared/social/types";
import { useEditor, type EditorController } from "../../controller";
import { useTopics, useUI } from "../../hooks";
import { applySelection } from "../../agents/mcpTools";
import { useBrands } from "../../studio/forms";
import { canWritePosts, editorWriter, setPost, withinWrite, type PostPatch, type Writer } from "../actions";
import { boardBrand } from "../NewPostMenu";
import { PostThumb, formatLabel } from "../PostsList";
import { useSocialBoard } from "../socialState";
import { MAX_ROWS, importCsvPosts, parseCsv, readCsvPosts, type CsvPost } from "./csvImport";
import { ROLE_NAMES, TEXT_ROLES, fillSlots, fillSlotsNow, postSlots, slotTexts } from "./templates";
import { useTemplates } from "./TemplatesGallery";
import styles from "./Templates.module.css";

const STATUS_LABEL: Record<PostStatus, string> = { draft: "Draft", reviewed: "Reviewed", approved: "Approved", exported: "Exported" };

/** A column the table sorts by: the post's name, format, brand, a text slot's role, or a field of its record. */
export type SortColumn = "name" | "format" | "brand" | SlotRole | "caption" | "hashtags" | "alt" | "status";
/** The cells a paste fills: the text slots' and the record's text fields. */
export type PasteColumn = SlotRole | "caption" | "hashtags" | "alt";

const collator = () => new Intl.Collator(intlLocale(), { numeric: true, sensitivity: "base" });

/**
 * Rows sorted by a column's text, ascending (1) or descending (-1), the table's order kept between equal ones; empty
 * texts last either way [ours].
 */
export function sortRows<T>(rows: readonly T[], text: (row: T) => string, dir: 1 | -1): T[] {
  const c = collator();
  return rows
    .map((row, i) => ({ row, i, key: text(row) }))
    .sort((a, b) => (!a.key !== !b.key ? (a.key ? -1 : 1) : dir * c.compare(a.key, b.key) || a.i - b.i))
    .map((x) => x.row);
}

/**
 * A paste of several cells (tab-separated, from a spreadsheet): the cell pasted in and those right of it and below,
 * over the paste columns and the rows as the table shows them; what falls past the table's edge is dropped.
 */
export function pasteTargets(text: string, at: { row: number; column: number }, rows: readonly Guid[], columns: readonly PasteColumn[]): { id: Guid; column: PasteColumn; value: string }[] {
  const grid = parseCsv(text, "\t");
  return grid.flatMap((cells, r) => cells.flatMap((value, k) => (rows[at.row + r] && columns[at.column + k] ? [{ id: rows[at.row + r], column: columns[at.column + k], value }] : [])));
}

/** Whether a paste is several cells (a tab or a line break inside it; a spreadsheet's last line break doesn't count). */
export const isGridPaste = (text: string): boolean => /[\t\r\n]/.test(text.replace(/\r?\n$/, ""));

/**
 * The cells of a paste written as one undo step "Paste cells": text slots through their TEXT properties (a locked slot
 * left as it is), the record's fields through setPost. Returns the locked roles met.
 */
export function pasteCells(ed: EditorController, w: Writer, cells: readonly { id: Guid; column: PasteColumn; value: string }[]): SlotRole[] {
  const locked = new Set<SlotRole>();
  const by = new Map<Guid, { texts: Partial<Record<SlotRole, string>>; patch: PostPatch }>();
  for (const c of cells) {
    const one = by.get(c.id) ?? { texts: {}, patch: {} };
    if (c.column === "caption") one.patch.caption = c.value;
    else if (c.column === "hashtags") one.patch.hashtags = c.value.split(/[\s,]+/);
    else if (c.column === "alt") one.patch.altText = c.value;
    else one.texts[c.column] = c.value;
    by.set(c.id, one);
  }
  if (!by.size) return [];
  w("Paste cells", () => {
    for (const [id, { texts, patch }] of by) {
      if (Object.keys(texts).length) fillSlotsNow(ed, id, texts).locked.forEach((r) => locked.add(r));
      if (Object.keys(patch).length) setPost(ed, withinWrite, [id], patch);
    }
  });
  return [...locked];
}

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
  const [sort, setSort] = useState<{ column: SortColumn; dir: 1 | -1 } | null>(null);
  const brandName = (id: string | null) => (id ? (brands?.find((b) => b.id === id)?.name ?? "") : "");
  // The text roles any post's template has, in Figma's order of the roles.
  const all = useMemo(() => board.groups.map((g) => ({ group: g, posts: g.posts.map((p) => ({ post: p, texts: slotTexts(ed, p.id), slots: postSlots(ed, p.id) })) })), [ed, board]);
  const roles = TEXT_ROLES.filter((r) => all.some((g) => g.posts.some((p) => p.texts[r] !== undefined)));
  // Sorted within each campaign (the campaigns stay in the page's order).
  type Row = (typeof all)[number]["posts"][number];
  const textOf = (column: SortColumn, { post, texts }: Row): string =>
    column === "name" ? post.name : column === "format" ? formatLabel(post).name : column === "brand" ? brandName(post.data.brandId) : column === "caption" ? post.data.caption : column === "hashtags" ? post.data.hashtags.join(" ") : column === "alt" ? post.data.altText : column === "status" ? String(POST_STATUSES.indexOf(post.data.status) + 1) : (texts[column] ?? "");
  const rows = sort ? all.map((g) => ({ ...g, posts: sortRows(g.posts, (r) => textOf(sort.column, r), sort.dir) })) : all;
  const shown = rows.flatMap((g) => g.posts.map((p) => p.post.id));
  const pasteColumns: PasteColumn[] = [...roles, "caption", "hashtags", "alt"];
  const w = editorWriter(ed);
  const patch = (id: Guid, p: Parameters<typeof setPost>[3]) => write && setPost(ed, w, [id], p);
  const fill = (id: Guid, role: SlotRole, value: string) => {
    if (!write) return;
    void fillSlots(ed, w, id, { [role]: value }).then((r) => {
      if (r.locked.length) showToast({ message: t("{role} is locked in this template", { role: t(ROLE_NAMES[role]) }) });
    });
  };
  // A paste of several cells fills from this one rightwards and down, one undo step.
  const paste = (id: Guid, column: PasteColumn, text: string) => {
    if (!write) return;
    const locked = pasteCells(ed, w, pasteTargets(text, { row: shown.indexOf(id), column: pasteColumns.indexOf(column) }, shown, pasteColumns));
    if (locked.length) showToast({ message: t("{role} is locked in this template", { role: locked.map((r) => t(ROLE_NAMES[r])).join(", ") }) });
  };
  // A header's click: ascending, descending, then the campaign's own order again.
  const sortBy = (column: SortColumn) => setSort((s) => (s?.column !== column ? { column, dir: 1 } : s.dir === 1 ? { column, dir: -1 } : null));
  const th = (column: SortColumn, label: string) => (
    <th key={column} className={styles.th} aria-sort={sort?.column === column ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className={styles.sort} onClick={() => sortBy(column)} data-sort={column}>
        {label}
        {sort?.column === column && <Icon name={sort.dir === 1 ? "16.arrow.up" : "16.arrow.down"} className={styles.sortIcon} />}
      </button>
    </th>
  );
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
              {th("name", t("Name"))}
              {th("format", t("Format"))}
              {th("brand", t("Brand"))}
              {roles.map((r) => th(r, t(ROLE_NAMES[r])))}
              {th("caption", t("Caption"))}
              {th("hashtags", t("Hashtags"))}
              {th("alt", t("Alt text"))}
              {th("status", t("Status"))}
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
                        {texts[r] !== undefined ? <Cell label={t(ROLE_NAMES[r])} value={texts[r] ?? ""} disabled={!write || slots.some((s) => s.data.role === r && s.data.locked)} onCommit={(v) => fill(post.id, r, v)} onPasteGrid={(text) => paste(post.id, r, text)} data-cell={r} /> : null}
                      </td>
                    ))}
                    <td className={styles.td}>
                      <Cell label={t("Caption")} value={post.data.caption} disabled={!write} onCommit={(caption) => patch(post.id, { caption })} onPasteGrid={(text) => paste(post.id, "caption", text)} data-cell="caption" />
                    </td>
                    <td className={styles.td}>
                      <Cell label={t("Hashtags")} value={post.data.hashtags.map((h) => `#${h}`).join(" ")} disabled={!write} onCommit={(v) => patch(post.id, { hashtags: v.split(/[\s,]+/) })} onPasteGrid={(text) => paste(post.id, "hashtags", text)} data-cell="hashtags" />
                    </td>
                    <td className={styles.td}>
                      <Cell label={t("Alt text")} value={post.data.altText} disabled={!write} onCommit={(altText) => patch(post.id, { altText })} onPasteGrid={(text) => paste(post.id, "alt", text)} data-cell="alt" />
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

/**
 * A cell: a ghost field written when it is left (Enter / Tab); a click in it doesn't select the row; a paste of
 * several cells (a spreadsheet's) goes to `onPasteGrid` instead of the field.
 */
function Cell({ label, value, disabled, onCommit, onPasteGrid, ...rest }: { label: string; value: string; disabled: boolean; onCommit: (v: string) => void; onPasteGrid: (text: string) => void; "data-cell": string }) {
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      onPaste={(e) => {
        const text = e.clipboardData.getData("text/plain");
        if (disabled || !isGridPaste(text)) return;
        e.preventDefault();
        onPasteGrid(text);
      }}
    >
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
