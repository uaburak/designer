/**
 * A Social file's Prototype tab (docs/social.md §33, the owner's ask 2026-11-03): the board played as Instagram's app,
 * live from the document — no frames to draw, no flow to wire. The panel's whole body below its tabs is the phone's
 * screen at 9:16 (1080 × 1920, a story fits it exactly); the panel's width follows its height (SocialRightPanel).
 *
 * - **Profile**: the board's brand (name, initial), its counts (posts, campaigns, approved), New post / New story, the
 *   campaigns that hold stories as story rings, then the feed posts three to a row at 3:4 (Instagram's profile grid).
 *   With no stories only "New" shows; with no posts the grid's first cell is a dashed "+" — both make a post of that
 *   format on the board and open it in the asset view, its own canvas, for the user to design (or the agent, later).
 * - **Post**: a tap on a cell shows that post alone (not the feed under it): its picture, a badge with when it went out
 *   (else when it is planned; §35), its caption and hashtags. The caption hovered shows a Copy button at its top right (caption and hashtags to the clipboard, a toast);
 *   a double-click edits it in place (⌘↵ or a click away saves it as the Post tab's caption, Esc leaves it).
 * - **Story**: a ring plays its campaign's stories full screen with Instagram's bars and each one's date badge, five
 *   seconds each; a tap on the
 *   left third goes back, elsewhere forward; the last one, or ✕, comes back to the profile.
 *
 * The pictures are the engine's renders of the posts (renderNodeThumbnailPixels), drawn again when the board changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { cx, showToast } from "@/ds";
import { intlLocale, t, useT } from "@/i18n";
import { formatById } from "@shared/social/formats";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { canWritePosts, editorWriter, newPost, setPost } from "./actions";
import { AvatarPicture, EditableField, saveBrandProfile, useBrandProfile, type BrandProfile } from "./BrandProfile";
import { openPost } from "./focus";
import { useSocialBoard, type PostRow, type SocialBoard } from "./socialState";
import styles from "./SocialPreview.module.css";

/** Five seconds a story, as Instagram's. */
export const STORY_MS = 5000;

const STORY_FORMAT = "instagram.story";
const FEED_FORMAT = "instagram.post";

type Screen = { kind: "profile" } | { kind: "post"; id: Guid } | { kind: "story"; ring: string; index: number };

/** A story: Instagram's story format, else a brand's own size as tall as one (9:16 or taller). */
export function isStory(row: Pick<PostRow, "data" | "width" | "height">): boolean {
  const f = formatById(row.data.formatId);
  if (f) return f.id === STORY_FORMAT;
  return row.width > 0 && row.height / row.width >= 16 / 9 - 0.01;
}

export interface StoryRing {
  id: string;
  name: string;
  stories: PostRow[];
}

/** The profile's parts from the board: the feed (a carousel's first slide), the story rings (by campaign), the counts. */
export function profileOf(board: SocialBoard): { feed: PostRow[]; rings: StoryRing[]; approved: number } {
  const feed: PostRow[] = [];
  const rings: StoryRing[] = [];
  for (const g of board.groups) {
    const stories: PostRow[] = [];
    for (const p of g.posts) {
      if (isStory(p)) stories.push(p);
      else if (!p.data.group || p.data.group.index === 0) feed.push(p);
    }
    if (stories.length) rings.push({ id: g.campaign?.id ?? "none", name: g.campaign?.name ?? t("Stories"), stories });
  }
  return { feed, rings, approved: board.posts.filter((p) => p.data.status === "approved").length };
}

/** A post of `formatId` on the board with the board's brand, opened in the asset view (its own canvas). */
export function startPost(ed: EditorController, formatId: string, brandId: string | null): void {
  if (!canWritePosts(ed)) return;
  try {
    openPost(ed, newPost(ed, editorWriter(ed), { formatId, brandId, campaignId: null }));
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e), kind: "error" });
  }
}

/** Caption and hashtags as they would be posted. */
export function captionText(row: Pick<PostRow, "data">): string {
  const tags = row.data.hashtags.map((h) => `#${h}`).join(" ");
  return [row.data.caption.trim(), tags].filter(Boolean).join("\n\n");
}

export function SocialPreview() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const brand = useBrandProfile();
  const [screen, setScreen] = useState<Screen>({ kind: "profile" });
  const profile = useMemo(() => profileOf(board), [board]);
  // A post or ring removed meanwhile (an undo, a delete) shows the profile.
  const post = screen.kind === "post" ? (board.posts.find((p) => p.id === screen.id) ?? null) : null;
  const ring = screen.kind === "story" ? (profile.rings.find((r) => r.id === screen.ring) ?? null) : null;
  const who = brand;
  return (
    <div className={styles.screen} data-social-preview={screen.kind}>
      {screen.kind === "post" && post ? (
        <PostScreen row={post} who={who} onBack={() => setScreen({ kind: "profile" })} />
      ) : screen.kind === "story" && ring && ring.stories[screen.index] ? (
        <StoryScreen ring={ring} index={screen.index} who={who} onIndex={(index) => setScreen(index < 0 || index >= ring.stories.length ? { kind: "profile" } : { kind: "story", ring: ring.id, index })} />
      ) : (
        <Profile
          board={board}
          profile={profile}
          who={who}
          onPost={(id) => setScreen({ kind: "post", id })}
          onRing={(id) => setScreen({ kind: "story", ring: id, index: 0 })}
          onNew={(formatId) => startPost(ed, formatId, board.brandId ?? brand.brand?.id ?? null)}
        />
      )}
    </div>
  );
}

type Who = BrandProfile;

function Profile({ board, profile, who, onPost, onRing, onNew }: { board: SocialBoard; profile: ReturnType<typeof profileOf>; who: Who; onPost: (id: Guid) => void; onRing: (id: string) => void; onNew: (formatId: string) => void }) {
  const ed = useEditor();
  const write = canWritePosts(ed);
  const first = profile.rings[0];
  return (
    <div className={styles.scroll} data-social-preview-profile="">
      <div className={styles.topBar}>
        <span className={styles.handle}>{who.handle}</span>
      </div>
      <div className={styles.head}>
        <button type="button" className={cx(styles.avatarRing, first && styles.hasStory)} disabled={!first} onClick={() => first && onRing(first.id)} aria-label={t("Stories")}>
          <AvatarPicture profile={who} className={styles.avatar} />
        </button>
        <div className={styles.stats}>
          <Stat n={profile.feed.length} label={t("posts")} />
          <Stat n={board.campaigns.length} label={t("campaigns")} />
          <Stat n={profile.approved} label={t("approved")} />
        </div>
      </div>
      <div className={styles.bio}>
        <EditableField value={who.brand?.name ?? ""} placeholder={who.pageName || t("Your brand")} label={t("Brand name")} className={styles.bioName} editingClassName={styles.bioEditing} placeholderClassName={styles.bioPlaceholder} onCommit={(name) => name && void saveBrandProfile(ed, who, { name })} data-social-preview-name="" />
        <EditableField value={who.description} placeholder={t("Double-click to write a description")} multiline maxLength={150} label={t("Description")} className={styles.bioText} editingClassName={styles.bioEditing} placeholderClassName={styles.bioPlaceholder} onCommit={(description) => void saveBrandProfile(ed, who, { description })} data-social-preview-bio="" />
      </div>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} disabled={!write} onClick={() => onNew(FEED_FORMAT)} data-social-preview-new="post">
          {t("New post")}
        </button>
        <button type="button" className={styles.button} disabled={!write} onClick={() => onNew(STORY_FORMAT)} data-social-preview-new="story">
          {t("New story")}
        </button>
      </div>
      <div className={styles.rings}>
        {profile.rings.map((r) => (
          <button key={r.id} type="button" className={styles.ringItem} onClick={() => onRing(r.id)} data-social-preview-ring={r.id}>
            <span className={cx(styles.ring, styles.hasStory)}>
              <NodeImage id={r.stories[0].id} rev={r.stories[0]} cssSize={64} className={styles.ringPicture} />
            </span>
            <span className={styles.ringName}>{r.name}</span>
          </button>
        ))}
        <button type="button" className={styles.ringItem} disabled={!write} onClick={() => onNew(STORY_FORMAT)} data-social-preview-new-ring="">
          <span className={cx(styles.ring, styles.newRing)}>
            <PlusGlyph />
          </span>
          <span className={styles.ringName}>{t("New")}</span>
        </button>
      </div>
      <div className={styles.tabs}>
        <span className={cx(styles.tab, styles.tabActive)}>
          <GridGlyph />
        </span>
      </div>
      <div className={styles.grid}>
        {profile.feed.map((p) => (
          <button key={p.id} type="button" className={styles.cell} onClick={() => onPost(p.id)} data-social-preview-cell={p.id} aria-label={p.name}>
            <NodeImage id={p.id} rev={p} cssSize={180} className={styles.cover} />
          </button>
        ))}
        {profile.feed.length === 0 && (
          <button type="button" className={cx(styles.cell, styles.newCell)} disabled={!write} onClick={() => onNew(FEED_FORMAT)} data-social-preview-new-cell="">
            <PlusGlyph />
            <span>{t("New post")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span className={styles.stat}>
      <strong>{n}</strong>
      <span>{label}</span>
    </span>
  );
}

function PostScreen({ row, who, onBack }: { row: PostRow; who: Who; onBack: () => void }) {
  const ratio = row.width > 0 ? row.height / row.width : 1.25;
  return (
    <>
      <div className={styles.navBar}>
        <button type="button" className={styles.back} onClick={onBack} aria-label={t("Back")} data-social-preview-back="">
          <BackGlyph />
        </button>
        <span className={styles.navTitle}>{t("Post")}</span>
      </div>
      <div className={styles.scroll} data-social-preview-post={row.id}>
        <div className={styles.postHead}>
          <AvatarPicture profile={who} className={styles.smallAvatar} />
          <span className={styles.postWho}>
            <strong>{who.handle}</strong>
          </span>
          <span className={styles.grow} />
          <DateBadge row={row} />
        </div>
        <div className={styles.media} style={{ aspectRatio: `1 / ${ratio}` }}>
          <NodeImage id={row.id} rev={row} cssSize={437 * Math.max(1, ratio)} className={styles.cover} />
        </div>
        <div className={styles.afterMedia} />
        <Caption row={row} handle={who.handle} />
      </div>
    </>
  );
}

/** The caption: hovered, a Copy button; double-clicked, edited in place (the post's caption, one undo step). */
function Caption({ row, handle }: { row: PostRow; handle: string }) {
  const ed = useEditor();
  const [editing, setEditing] = useState<string | null>(null);
  const write = canWritePosts(ed);
  const commit = (value: string) => {
    setEditing(null);
    if (value === row.data.caption || !canWritePosts(ed)) return;
    setPost(ed, editorWriter(ed), [row.id], { caption: value });
  };
  const copy = (e: MouseEvent) => {
    e.stopPropagation();
    const text = captionText(row);
    const done = () => showToast({ message: t("Caption copied") });
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => showToast({ message: t("The caption couldn't be copied"), kind: "error" }));
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(null);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(e.currentTarget.value);
    }
  };
  const empty = !row.data.caption.trim() && row.data.hashtags.length === 0;
  return (
    <div className={cx(styles.caption, editing !== null && styles.captionEditing)} onDoubleClick={() => write && editing === null && setEditing(row.data.caption)} data-social-preview-caption="">
      <strong className={styles.captionHandle}>{handle}</strong>
      {editing !== null ? (
        <textarea
          className={styles.captionInput}
          autoFocus
          value={editing}
          aria-label={t("Caption")}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={keys}
          rows={Math.max(3, editing.split("\n").length + 1)}
          data-social-preview-caption-input=""
        />
      ) : (
        <>
          {row.data.caption ? <span className={styles.captionText}>{row.data.caption}</span> : <span className={styles.captionEmpty}>{t("Double-click to write a caption")}</span>}
          {row.data.hashtags.length > 0 && <span className={styles.hashtags}>{row.data.hashtags.map((h) => `#${h}`).join(" ")}</span>}
          {!empty && (
            <button type="button" className={styles.copy} onClick={copy} title={t("Copy")} aria-label={t("Copy caption")} data-social-preview-copy="">
              <CopyGlyph />
            </button>
          )}
        </>
      )}
    </div>
  );
}

function StoryScreen({ ring, index, who, onIndex }: { ring: StoryRing; index: number; who: Who; onIndex: (index: number) => void }) {
  const row = ring.stories[index];
  // The timer runs per story, not per render (the board re-renders this on every edit)
  const next = useRef(onIndex);
  useLayoutEffect(() => {
    next.current = onIndex;
  });
  useEffect(() => {
    const timer = window.setTimeout(() => next.current(index + 1), STORY_MS);
    return () => window.clearTimeout(timer);
  }, [index, ring.id]);
  if (!row) return null;
  return (
    <div
      className={styles.story}
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        onIndex(e.clientX - box.left < box.width / 3 ? index - 1 : index + 1);
      }}
      data-social-preview-story={row.id}
    >
      <NodeImage id={row.id} rev={row} cssSize={780} className={styles.cover} />
      <div className={styles.storyTop}>
        <div className={styles.bars}>
          {ring.stories.map((s, i) => (
            <span key={s.id} className={styles.storyBar}>
              <span className={cx(styles.storyFill, i < index && styles.storyDone, i === index && styles.storyNow)} style={i === index ? { animationDuration: `${STORY_MS}ms` } : undefined} />
            </span>
          ))}
        </div>
        <div className={styles.storyWho}>
          <AvatarPicture profile={who} className={styles.smallAvatar} />
          <strong>{who.handle}</strong>
          <DateBadge row={row} onMedia />
          <span className={styles.grow} />
          <button
            type="button"
            className={styles.storyClose}
            onClick={(e) => {
              e.stopPropagation();
              onIndex(-1);
            }}
            aria-label={t("Close")}
            data-social-preview-close=""
          >
            <CloseGlyph />
          </button>
        </div>
      </div>
    </div>
  );
}

/** When a post went out (its date, or only that it did: status Posted), else when it is planned, else that it isn't (§35). */
export function postDate(row: Pick<PostRow, "data">): { kind: "published" | "scheduled" | "none"; at: number | null } {
  if (row.data.publishedAt != null || row.data.status === "posted") return { kind: "published", at: row.data.publishedAt ?? null };
  if (row.data.scheduledAt != null) return { kind: "scheduled", at: row.data.scheduledAt };
  return { kind: "none", at: null };
}

/** The post's date as a badge: Posted (green), Scheduled (blue), Not scheduled (muted). */
function DateBadge({ row, onMedia }: { row: PostRow; onMedia?: boolean }) {
  const d = postDate(row);
  const when = d.at === null ? "" : new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d.at);
  const label = d.kind === "published" ? (when ? t("Posted {date}", { date: when }) : t("Posted")) : d.kind === "scheduled" ? t("Scheduled {date}", { date: when }) : t("Not scheduled");
  return (
    <span className={cx(styles.badge, onMedia && styles.badgeOnMedia)} data-kind={d.kind} data-social-preview-date={d.kind}>
      <CalendarGlyph />
      {label}
    </span>
  );
}

/** A post drawn by the engine at `cssSize` CSS px on its long side (× the screen's density), again when `rev` changes. */
export function NodeImage({ id, rev, cssSize, className }: { id: Guid; rev: unknown; cssSize: number; className?: string }) {
  const ed = useEditor();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const c = canvas.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx || ed.engine.destroyed) return;
      try {
        const px = ed.engine.renderNodeThumbnailPixels({ node: id, maxSize: Math.round(cssSize * Math.min(2, window.devicePixelRatio || 1)) });
        if (!px) return;
        c.width = px.width;
        c.height = px.height;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
      } catch {
        // No picture from this engine: the cell stays empty.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [ed, id, rev, cssSize]);
  return <canvas ref={canvas} className={className} aria-hidden />;
}

// Instagram's glyphs (the app's own outlines, 24 px), in the text colour.
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
export function PlusGlyph({ className = styles.glyph }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M12 5v14M5 12h14" {...stroke} />
    </svg>
  );
}
function GridGlyph() {
  return (
    <svg viewBox="0 0 24 24" className={styles.glyph} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="1" {...stroke} />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" {...stroke} />
    </svg>
  );
}
function BackGlyph() {
  return (
    <svg viewBox="0 0 24 24" className={styles.glyph} aria-hidden>
      <path d="M15 4l-8 8 8 8" {...stroke} strokeWidth={2} />
    </svg>
  );
}
function CalendarGlyph() {
  return (
    <svg viewBox="0 0 24 24" className={styles.smallGlyph} aria-hidden>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" {...stroke} strokeWidth={2} />
      <path d="M3.5 10h17M8 3v4M16 3v4" {...stroke} strokeWidth={2} />
    </svg>
  );
}
function CopyGlyph() {
  return (
    <svg viewBox="0 0 24 24" className={styles.smallGlyph} aria-hidden>
      <rect x="8" y="8" width="13" height="13" rx="2.5" {...stroke} strokeWidth={2} />
      <path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8" {...stroke} strokeWidth={2} />
    </svg>
  );
}
function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" className={styles.glyph} aria-hidden>
      <path d="M5 5l14 14M19 5L5 19" {...stroke} strokeWidth={2.2} />
    </svg>
  );
}
