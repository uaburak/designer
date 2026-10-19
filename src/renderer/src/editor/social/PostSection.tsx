/**
 * The Post section (docs/social.md §6.5): the selected post's record, edited directly — Platform and Format (a change
 * resizes it, actions.ts `resizePost`), Brand (its mode and logo variant), Product (its packshot in the picture slot),
 * Template (swaps to another template's variant for the format; round 18b's templates.ts), Caption with its counter in the
 * format's unit (red past the limit, a dashed mark at the feed's fold), Hashtags as chips (typing "#", a space or Enter
 * makes one; counted against the format's limit), Alt text, Status, Campaign, the review's Problems (Fix runs the manager's
 * fix loop on it, Leave clears it) and Ask agent…. Several posts: the fields they share, "Mixed" where they differ; caption, hashtags
 * and alt text are a single post's. A slot layer selected inside a post shows its role (round 18b's slots). Every field
 * writes through actions.ts, one undo step each; a viewer reads them all, changes none.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, IconButton, MIXED, Select, cx, showToast, type Mixed } from "@/ds";
import { intlLocale, t, tp, useT } from "@/i18n";
import type { Guid, NodeChange } from "@/engine/codec";
import { captionReport } from "@shared/social/caption";
import { PLATFORMS, PLATFORM_NAMES, brandFormatId, formatById, formatsFor, nearestFormat, parseBrandFormatId, resolveFormat } from "@shared/social/formats";
import { POST_STATUSES, readSocial, type Platform, type PluginDataEntry, type PostStatus, type TemplateSlotData } from "@shared/social/types";
import type { Brand } from "@shared/studio/types";
import { useEditor, type EditorController } from "../controller";
import { useTopics } from "../hooks";
import { useBrands } from "../studio/forms";
import { canWritePosts, editorWriter, leaveProblems, resizePost, setPost, type PostPatch } from "./actions";
import { applyBrand, applyTemplate, setProduct } from "./templates/templates";
import { templateOptionsFor, useTemplates } from "./templates/TemplatesGallery";
import { askAgent, fixWithAgent } from "./SocialMode";
import { useSocialBoard, type PostRow } from "./socialState";
import styles from "./PostSection.module.css";

const STATUS_LABEL: Record<PostStatus, string> = { draft: "Draft", reviewed: "Reviewed", approved: "Approved", exported: "Exported" };
const ROLE_LABEL: Record<string, string> = { logo: "Logo", picture: "Picture", headline: "Headline", body: "Body", cta: "CTA", label: "Label", accent: "Accent", background: "Background" };
const NONE = "none";

/** One value for all, or Mixed. */
function shared<T>(values: readonly T[]): Mixed<T> {
  return values.every((v) => v === values[0]) ? values[0] : MIXED;
}

export function PostSection() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const version = useTopics(ed.store, ["selection"]);
  const { brands } = useBrands();
  const posts = useMemo(() => {
    void version;
    const sel = new Set(ed.store.selection.refs);
    return board.posts.filter((p) => sel.has(p.id));
  }, [ed, board, version]);
  if (!posts.length) return <SlotInfo board={board.posts} />;
  return <PostFields key={posts.map((p) => p.id).join(",")} posts={posts} brands={brands} campaigns={board.campaigns} />;
}

function PostFields({ posts, brands, campaigns }: { posts: PostRow[]; brands: Brand[] | null; campaigns: { id: string; name: string }[] }) {
  useT();
  const ed = useEditor();
  const templates = useTemplates();
  const write = canWritePosts(ed);
  const ids = posts.map((p) => p.id);
  const run = (fn: () => void) => {
    if (write) fn();
  };
  const patch = (p: PostPatch) => run(() => setPost(ed, editorWriter(ed), ids, p));
  const formats = posts.map((p) => resolveFormat(p.data.formatId, brands ?? undefined));
  const platformOf = (id: string): string => formatById(id)?.platform ?? (parseBrandFormatId(id) ? "brand" : NONE);
  const platform = shared(posts.map((p) => platformOf(p.data.formatId)));
  const formatId = shared(posts.map((p) => p.data.formatId));
  const brandId = shared(posts.map((p) => p.data.brandId ?? NONE));
  const brand = typeof brandId === "string" ? (brands?.find((b) => b.id === brandId) ?? null) : null;
  const productId = shared(posts.map((p) => p.data.productIds[0] ?? NONE));
  const status = shared(posts.map((p) => p.data.status));
  const campaignId = shared(posts.map((p) => p.data.campaignId ?? NONE));
  const one = posts.length === 1 ? posts[0] : null;
  const templateKey = shared(posts.map((p) => p.data.template?.key ?? NONE));
  const templateOptions = templateOptionsFor(templates, typeof formatId === "string" ? formatId : null);
  const failed = (e: unknown) => showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
  // Format options: the platform's formats, or the brand's own sizes.
  const formatOptions =
    platform === "brand"
      ? (brands ?? []).flatMap((b) => b.formats.map((f) => ({ value: brandFormatId(b.id, f.id), label: `${f.name} · ${f.width} × ${f.height}` })))
      : typeof platform === "string" && platform !== NONE
        ? formatsFor(platform as Platform).map((f) => ({ value: f.id, label: t(f.name), hint: `${f.width} × ${f.height}` }))
        : [];
  const resize = (next: string) =>
    run(() => {
      const own = parseBrandFormatId(next);
      const format = own ? brands?.find((b) => b.id === own.brandId)?.formats.find((f) => f.id === own.formatId) : undefined;
      resizePost(ed, editorWriter(ed), ids, next, { duplicate: false, format });
    });
  return (
    <div className={styles.section} data-post-section={ids.join(",")}>
      <div className={styles.pair}>
        <Field label={t("Platform")}>
          <Select
            label={t("Platform")}
            value={platform}
            disabled={!write}
            options={[...PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAMES[p] })), ...(platform === "brand" ? [{ value: "brand", label: t("Brand's own") }] : [])]}
            onChange={(p) => {
              const first = posts[0];
              const next = nearestFormat(first.width, first.height, p as Platform) ?? formatsFor(p as Platform)[0];
              if (next) resize(next.id);
            }}
            data-post-field="platform"
          />
        </Field>
        <Field label={t("Format")}>
          <Select label={t("Format")} value={formatId} disabled={!write || !formatOptions.length} options={formatOptions} onChange={resize} data-post-field="format" />
        </Field>
      </div>
      <div className={styles.pair}>
        <Field label={t("Brand")}>
          <Select
            label={t("Brand")}
            value={brandId}
            disabled={!write}
            options={[...(brands ?? []).map((b) => ({ value: b.id, label: b.name })), { value: NONE, label: t("No brand") }]}
            // A brand: its mode on the Brand collection and its logo variant (templates.ts applyBrand), the product cleared.
            onChange={(v) => (v === NONE ? patch({ brandId: null, productIds: [] }) : run(() => void applyBrand(ed, editorWriter(ed), ids, v).catch(failed)))}
            data-post-field="brand"
          />
        </Field>
        <Field label={t("Product")}>
          <Select
            label={t("Product")}
            value={productId}
            disabled={!write || !brand}
            options={[...(brand?.products ?? []).map((p) => ({ value: p.id, label: p.name })), { value: NONE, label: t("No product") }]}
            // A product: its first packshot in the picture slot too, in the same step.
            onChange={(v) => run(() => void setProduct(ed, editorWriter(ed), ids, brand?.id ?? null, v === NONE ? null : v).catch(failed))}
            data-post-field="product"
          />
        </Field>
      </div>
      <Field label={t("Template")}>
        <Select
          label={t("Template")}
          value={templateKey === NONE || templateOptions.some((o) => o.value === templateKey) ? templateKey : NONE}
          disabled={!write || !templateOptions.length}
          options={[...templateOptions, ...(templateOptions.length ? (["-"] as const) : []), { value: NONE, label: t("None"), disabled: templateKey !== NONE }]}
          onChange={(key) => key !== NONE && run(() => void applyTemplate(ed, editorWriter(ed), ids, { key, ...(typeof brandId === "string" && brandId !== NONE ? { brandId } : {}) }).catch(failed))}
          data-post-field="template"
        />
      </Field>
      {one ? (
        <>
          <Caption key={`caption:${one.data.caption}`} post={one} format={formats[0]} disabled={!write} onCommit={(caption) => patch({ caption })} />
          <Hashtags post={one} format={formats[0]} disabled={!write} onChange={(hashtags) => patch({ hashtags })} />
          <Field label={t("Alt text")}>
            <CommitArea key={`alt:${one.data.altText}`} label={t("Alt text")} value={one.data.altText} rows={2} disabled={!write} placeholder={t("Describe the picture for people who can't see it")} onCommit={(altText) => patch({ altText })} />
          </Field>
        </>
      ) : (
        <p className={styles.note}>{t("Select one post to edit its caption, hashtags and alt text.")}</p>
      )}
      <div className={styles.pair}>
        <Field label={t("Status")}>
          <Select label={t("Status")} value={status} disabled={!write} options={POST_STATUSES.map((s) => ({ value: s, label: t(STATUS_LABEL[s]) }))} onChange={(v) => patch({ status: v as PostStatus })} data-post-field="status" />
        </Field>
        <Field label={t("Campaign")}>
          <Select label={t("Campaign")} value={campaignId} disabled={!write} options={[...campaigns.map((c) => ({ value: c.id, label: c.name || t("Untitled campaign") })), { value: NONE, label: t("No campaign") }]} onChange={(v) => patch({ campaignId: v === NONE ? null : v })} data-post-field="campaign" />
        </Field>
      </div>
      {one && one.data.problems.length > 0 && <Problems post={one} disabled={!write} />}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => askAgent(ed, ids)} data-post-ask="">
          {t("Ask agent…")}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}

/** A multi-line field written once when it is left (or ⌘↩); Esc puts it back. */
function CommitArea({ label, value, rows, disabled, placeholder, onCommit, onDraft }: { label: string; value: string; rows: number; disabled?: boolean; placeholder?: string; onCommit: (v: string) => void; onDraft?: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const text = draft ?? value;
  return (
    <textarea
      className={styles.area}
      aria-label={label}
      rows={rows}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        onDraft?.(e.target.value);
      }}
      onBlur={(e) => {
        const typed = e.currentTarget.value;
        const keep = draft !== null && !cancelled.current && typed !== value;
        cancelled.current = false;
        setDraft(null);
        onDraft?.(value);
        if (keep) onCommit(typed);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Caption with its counter: count / max in the format's unit, red past it; the fold marked on the bar. */
function Caption({ post, format, disabled, onCommit }: { post: PostRow; format: ReturnType<typeof resolveFormat>; disabled: boolean; onCommit: (v: string) => void }) {
  useT();
  const [typing, setTyping] = useState(post.data.caption);
  const report = captionReport(typing, post.data.hashtags, format && "caption" in format ? format : null);
  const fmt = (n: number) => n.toLocaleString(intlLocale());
  return (
    <div className={styles.field}>
      <span className={styles.label}>
        {t("Caption")}
        <span className={cx(styles.counter, report.over && styles.over)} data-caption-count={report.count} data-over={report.over || undefined}>
          {report.max ? `${fmt(report.count)} / ${fmt(report.max)}` : fmt(report.count)}
        </span>
      </span>
      <CommitArea label={t("Caption")} value={post.data.caption} rows={4} disabled={disabled} placeholder={t("Write a caption, or ask the agent")} onCommit={onCommit} onDraft={setTyping} />
      {report.max > 0 && (
        <div className={styles.meter} aria-hidden>
          <span className={cx(styles.meterFill, report.over && styles.meterOver)} style={{ width: `${Math.min(100, (report.count / report.max) * 100)}%` }} />
          {report.fold !== null && <span className={styles.fold} style={{ left: `${(report.fold / report.max) * 100}%` }} title={t("Feed shows {n} characters before “more”", { n: String(report.fold) })} data-caption-fold={report.fold} />}
        </div>
      )}
    </div>
  );
}

/** Hashtags as chips: "#", a space, a comma or Enter makes one; ⌫ in the empty field takes the last back. */
function Hashtags({ post, format, disabled, onChange }: { post: PostRow; format: ReturnType<typeof resolveFormat>; disabled: boolean; onChange: (tags: string[]) => void }) {
  useT();
  const [typed, setTyped] = useState("");
  const tags = post.data.hashtags;
  const max = format && "caption" in format ? format.caption.hashtags : undefined;
  const commit = (raw: string) => {
    const tag = raw.replace(/^#+/, "").trim();
    setTyped("");
    if (tag) onChange([...tags, tag]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if ((e.key === " " || e.key === "Enter" || e.key === "," || (e.key === "#" && typed.replace(/^#+/, ""))) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit(typed);
    } else if (e.key === "Backspace" && !typed && tags.length) onChange(tags.slice(0, -1));
  };
  return (
    <div className={styles.field}>
      <span className={styles.label}>
        {t("Hashtags")}
        <span className={cx(styles.counter, max !== undefined && tags.length > max && styles.over)}>{max !== undefined ? `${tags.length} / ${max}` : tags.length}</span>
      </span>
      <div className={styles.chips} data-post-hashtags="">
        {tags.map((tag, i) => (
          <span key={`${tag}:${i}`} className={styles.chip}>
            #{tag}
            {!disabled && <IconButton icon="24.close.small" tone="secondary" label={t("Remove {tag}", { tag: `#${tag}` })} onClick={() => onChange(tags.filter((_, k) => k !== i))} />}
          </span>
        ))}
        {!disabled && <input className={styles.chipInput} aria-label={t("Add hashtag")} placeholder={tags.length ? "" : t("#hashtag")} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={onKey} onBlur={() => typed && commit(typed)} />}
      </div>
    </div>
  );
}

function Problems({ post, disabled }: { post: PostRow; disabled: boolean }) {
  useT();
  const ed = useEditor();
  return (
    <div className={styles.field} data-post-problems="">
      <span className={styles.label}>{tp(post.data.problems.length, "{n} problem", "{n} problems")}</span>
      {post.data.problems.map((p) => (
        <div key={p.id} className={styles.problem} data-problem={p.id}>
          <span className={styles.problemText}>{p.detail}</span>
          <Button variant="secondary" disabled={disabled} onClick={() => fixWithAgent(ed, post, p)} data-problem-fix="">
            {t("Fix")}
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={() => leaveProblems(ed, editorWriter(ed), post.id, [p.id])}>
            {t("Leave")}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** A slot layer selected inside a post (templates, round 18b): its role, whether it is locked, what drives it. */
function SlotInfo({ board }: { board: readonly PostRow[] }) {
  useT();
  const ed = useEditor();
  const slot = selectedSlot(ed, board);
  if (!slot) return <p className={styles.note}>{t("Select a post to see its platform, caption and status.")}</p>;
  return (
    <div className={styles.section} data-slot-info="">
      <div className={styles.pair}>
        <Field label={t("Role")}>
          <span className={styles.value}>{t(ROLE_LABEL[slot.data.role] ?? slot.data.role)}</span>
        </Field>
        <Field label={t("Locked")}>
          <span className={styles.value}>{slot.data.locked ? t("Yes") : t("No")}</span>
        </Field>
      </div>
      {slot.data.property && (
        <Field label={t("Property")}>
          <span className={styles.value}>{slot.data.property.split("#")[0]}</span>
        </Field>
      )}
      {slot.data.maxChars !== null && slot.chars !== null && (
        <Field label={t("Characters")}>
          <span className={cx(styles.value, slot.chars > slot.data.maxChars && styles.over)}>{`${slot.chars} / ${slot.data.maxChars}`}</span>
        </Field>
      )}
    </div>
  );
}

/** The one selected layer's slot record, when it sits inside a post. */
function selectedSlot(ed: EditorController, board: readonly PostRow[]): { data: TemplateSlotData; chars: number | null } | null {
  const sel = ed.store.selection.refs;
  if (sel.length !== 1 || !board.length) return null;
  const n = ed.engine.readNode(sel[0], { fields: ["pluginData", "characters", "parentIndex"] }) as (NodeChange & { pluginData?: PluginDataEntry[]; characters?: string }) | null;
  const data = readSocial<TemplateSlotData>(n?.pluginData, "slot");
  if (!n || !data?.role) return null;
  const posts = new Set<Guid>(board.map((p) => p.id));
  let parent = n.parentIndex?.guid;
  for (let i = 0; parent && i < 200; i++) {
    if (posts.has(parent)) return { data, chars: typeof n.characters === "string" ? n.characters.length : null };
    parent = ed.engine.readNode(parent, { fields: ["parentIndex"] })?.parentIndex?.guid;
  }
  return null;
}
