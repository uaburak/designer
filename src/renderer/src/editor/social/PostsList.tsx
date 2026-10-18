/**
 * The Posts list (docs/social.md §6.2): the page's posts grouped by campaign (the page's campaigns in their order, then
 * "No campaign"), each group a disclosure with its name (double-click renames) and post count; a row (32) shows the
 * post's picture, name, format, platform and one state glyph — ✓ reviewed / approved, ⚠ problems (count), ● draft, ⇩
 * exported — and ▶ when it animates. A click selects the post and zooms to it, ⇧ / ⌘ add or take it out; the context
 * menu resizes, duplicates for another format, moves to a campaign, asks the agent, deletes. Save as template… and
 * Export… are rounds 18b / 18d's (shown, off).
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ContextMenu, EmptyState, Icon, TextInput, cx, showToast, tooltipProps, type MenuEntry } from "@/ds";
import { t, tp, useT } from "@/i18n";
import type { Guid } from "@/engine/codec";
import { PLATFORMS, PLATFORM_NAMES, formatById, formatsFor, parseBrandFormatId } from "@shared/social/formats";
import type { SocialCampaign } from "@shared/social/types";
import { useEditor, type EditorController } from "../controller";
import { useTopics } from "../hooks";
import { applySelection } from "../agents/mcpTools";
import { canWritePosts, editorWriter, newCampaign, resizePost, setCampaign, setPost, withinWrite } from "./actions";
import { askAgent } from "./SocialMode";
import { useSocialBoard, type CampaignGroup, type PostRow } from "./socialState";
import styles from "./SocialLeftPanel.module.css";

/** The platform's two-letter mark beside a post [ours: no platform logos in the chrome] */
const PLATFORM_MARK: Record<string, string> = { instagram: "IG", linkedin: "in", facebook: "FB", x: "X", tiktok: "TT", youtube: "YT", pinterest: "P" };

/** A post's format name and platform (a brand's own size: its id's format, no platform). */
function formatLabel(row: PostRow): { name: string; platform: string | null } {
  const f = formatById(row.data.formatId);
  if (f) return { name: t(f.name), platform: f.platform };
  const own = parseBrandFormatId(row.data.formatId);
  return { name: own ? `${Math.round(row.width)} × ${Math.round(row.height)}` : row.data.formatId, platform: null };
}

export function PostsList() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const selectionVersion = useTopics(ed.store, ["selection"]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selected = useMemo(() => new Set(ed.store.selection.refs), [ed, selectionVersion]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; ids: Guid[] } | null>(null);
  if (!board.posts.length && !board.campaigns.length) return <EmptyState icon="24.social" title={t("No posts yet")} body={t("Ask the agent for posts, or start one with + New post.")} />;
  const order = board.groups.flatMap((g) => g.posts.map((p) => p.id));
  const click = (e: MouseEvent, id: Guid) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const next = selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id];
      ed.engine.setSelection(order.filter((x) => next.includes(x)));
      return;
    }
    applySelection(ed, [id], true);
  };
  const openMenu = (e: MouseEvent, id: Guid) => {
    e.preventDefault();
    const ids = selected.has(id) ? order.filter((x) => selected.has(x)) : [id];
    if (!selected.has(id)) ed.engine.setSelection([id]);
    setMenu({ at: { x: e.clientX, y: e.clientY }, ids });
  };
  return (
    <div className={styles.posts} role="tree" aria-label={t("Posts")} data-social-posts="">
      {board.groups.map((g) => {
        const key = g.campaign?.id ?? "";
        const open = !closed.has(key);
        return (
          <div key={key} role="group" className={styles.group} data-campaign={key}>
            <GroupHeader
              group={g}
              open={open}
              renaming={!!g.campaign && renaming === g.campaign.id}
              onToggle={() => setClosed((s) => (s.has(key) ? new Set([...s].filter((x) => x !== key)) : new Set([...s, key])))}
              onRename={() => g.campaign && canWritePosts(ed) && setRenaming(g.campaign.id)}
              onRenamed={(name) => {
                setRenaming(null);
                if (g.campaign && name.trim() && name.trim() !== g.campaign.name) setCampaign(ed, editorWriter(ed), board.page, { ...g.campaign, name: name.trim() });
              }}
            />
            {open && g.posts.map((p) => <PostItem key={p.id} row={p} selected={selected.has(p.id)} onClick={(e) => click(e, p.id)} onMenu={(e) => openMenu(e, p.id)} />)}
          </div>
        );
      })}
      {menu && (
        <ContextMenu
          context
          at={menu.at}
          label={t("Post")}
          entries={postMenu(ed, menu.ids, board.campaigns)}
          onSelect={(id) => {
            const made = runPostMenu(ed, id, menu.ids, board.page);
            if (made) setRenaming(made);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function GroupHeader({ group, open, renaming, onToggle, onRename, onRenamed }: { group: CampaignGroup; open: boolean; renaming: boolean; onToggle: () => void; onRename: () => void; onRenamed: (name: string) => void }) {
  useT();
  const name = group.campaign?.name || (group.campaign ? t("Untitled campaign") : t("No campaign"));
  return (
    <div className={styles.groupHeader} data-campaign-header="">
      <button type="button" className={styles.disclosure} aria-expanded={open} aria-label={open ? t("Collapse") : t("Expand")} onClick={onToggle}>
        <span className={cx(styles.chevron, !open && styles.chevronClosed)}>
          <Icon name="16.chevron.down" />
        </span>
      </button>
      {renaming ? (
        <div className={styles.rename}>
          <TextInput label={t("Campaign name")} value={group.campaign?.name ?? ""} autoFocus onCommit={onRenamed} onExit={() => onRenamed(group.campaign?.name ?? "")} />
        </div>
      ) : (
        <span className={styles.groupName} onDoubleClick={onRename}>
          {name}
        </span>
      )}
      <span className={styles.groupCount}>{group.posts.length}</span>
    </div>
  );
}

function PostItem({ row, selected, onClick, onMenu }: { row: PostRow; selected: boolean; onClick: (e: MouseEvent) => void; onMenu: (e: MouseEvent) => void }) {
  useT();
  const f = formatLabel(row);
  const d = row.data;
  const problems = d.problems.length;
  return (
    <button type="button" role="treeitem" aria-selected={selected} className={styles.post} data-post={row.id} onClick={onClick} onContextMenu={onMenu}>
      <PostThumb row={row} />
      <span className={styles.postText}>
        <span className={styles.postName}>{row.name}</span>
        <span className={styles.postFormat}>{f.name}</span>
      </span>
      {f.platform && (
        <span className={styles.platform} {...tooltipProps(PLATFORM_NAMES[f.platform as keyof typeof PLATFORM_NAMES])}>
          {PLATFORM_MARK[f.platform]}
        </span>
      )}
      {row.animated && (
        <span className={styles.glyph} {...tooltipProps(t("Animated"))} data-animated="">
          <Icon name="16.play" />
        </span>
      )}
      {problems > 0 ? (
        <span className={cx(styles.glyph, styles.problems)} {...tooltipProps(tp(problems, "{n} problem", "{n} problems"))} data-state="problems">
          <Icon name="16.warning" />
          {problems}
        </span>
      ) : d.status === "exported" ? (
        <span className={styles.glyph} {...tooltipProps(t("Exported"))} data-state="exported">
          <Icon name="16.arrow.down" />
        </span>
      ) : d.status === "reviewed" || d.status === "approved" ? (
        <span className={cx(styles.glyph, styles.done)} {...tooltipProps(d.status === "approved" ? t("Approved") : t("Reviewed"))} data-state={d.status}>
          <Icon name="16.check" />
        </span>
      ) : (
        <span className={styles.glyph} {...tooltipProps(t("Draft"))} data-state="draft">
          <span className={styles.draftDot} />
        </span>
      )}
    </button>
  );
}

/** The post's picture, 24 px (rendered at 2× by the engine), drawn again when the board changes. */
function PostThumb({ row }: { row: PostRow }) {
  const ed = useEditor();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const c = canvas.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx || ed.engine.destroyed) return;
      try {
        const px = ed.engine.renderNodeThumbnailPixels({ node: row.id, maxSize: 48 });
        if (!px) return;
        c.width = px.width;
        c.height = px.height;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
      } catch {
        // No thumbnail from this engine: the square stays empty.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [ed, row]);
  return <canvas ref={canvas} className={styles.thumb} aria-hidden />;
}

const RESIZE = "resize:";
const DUPLICATE = "duplicate:";
const MOVE = "move:";
const NEW_CAMPAIGN = "move-new";

/** Platform › format submenus for "Resize to" / "Duplicate for". */
function formatItems(prefix: string): MenuEntry[] {
  return PLATFORMS.map((p) => ({ id: `${prefix}platform:${p}`, label: PLATFORM_NAMES[p], items: formatsFor(p).map((f) => ({ id: `${prefix}${f.id}`, label: t(f.name), hint: `${f.width} × ${f.height}` })) }));
}

export function postMenu(ed: EditorController, ids: readonly Guid[], campaigns: readonly SocialCampaign[]): MenuEntry[] {
  const write = canWritePosts(ed);
  return [
    { id: "resize", label: t("Resize to"), disabled: !write, items: formatItems(RESIZE) },
    { id: "duplicate", label: t("Duplicate for"), disabled: !write, items: formatItems(DUPLICATE) },
    {
      id: "move",
      label: t("Move to campaign"),
      disabled: !write,
      items: [...campaigns.map((c) => ({ id: `${MOVE}${c.id}`, label: c.name || t("Untitled campaign") })), { id: `${MOVE}`, label: t("No campaign") }, "-", { id: NEW_CAMPAIGN, label: t("New campaign") }],
    },
    "-",
    { id: "ask", label: t("Ask agent…") },
    { id: "template", label: t("Save as template…"), disabled: true },
    { id: "export", label: t("Export…"), disabled: true },
    "-",
    { id: "delete", label: t("Delete"), disabled: !write || !ids.length },
  ];
}

/** Runs a post menu's pick; a new campaign's id when one was made (its name is edited next). */
export function runPostMenu(ed: EditorController, id: string, ids: readonly Guid[], page: Guid): string | null {
  const w = editorWriter(ed);
  try {
    if (id.startsWith(RESIZE)) resizePost(ed, w, ids, id.slice(RESIZE.length), { duplicate: false });
    else if (id.startsWith(DUPLICATE)) {
      const copies = resizePost(ed, w, ids, id.slice(DUPLICATE.length), { duplicate: true });
      if (copies.length) applySelection(ed, copies, true);
    } else if (id === NEW_CAMPAIGN) {
      const campaign = newCampaign(t("New campaign"), ed.ui.get().socialBrandId ?? null);
      w("Move to campaign", () => {
        setCampaign(ed, withinWrite, page, campaign);
        setPost(ed, withinWrite, ids, { campaignId: campaign.id });
      });
      return campaign.id;
    } else if (id.startsWith(MOVE)) setPost(ed, w, ids, { campaignId: id.slice(MOVE.length) || null });
    else if (id === "ask") askAgent(ed, ids);
    else if (id === "delete") {
      ed.engine.setSelection([...ids]);
      ed.engine.command("DELETE");
    }
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
  }
  return null;
}
