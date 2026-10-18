/**
 * A thread's card (live: docs/research/figma/live/multiplayer/comments.md "The thread"): 360 wide; header "Comment"
 * with [Thread actions] •••, [Mark as resolved] and [Close comment]; each comment's avatar, name, relative time (the
 * full date in its tooltip), [Comment actions], text, reactions; the reply field "Reply" with your avatar.
 */
import { useRef, useState } from "react";
import { Avatar, Button, ContextMenu, Dialog, Icon, timeAgo, type MenuEntry } from "@/ds";
import { intlLocale, t, tp, useT } from "@/i18n";
import type { Comment, CommentSegment, CommentsState, CommentThread, MentionCandidate } from "@shared/comments";
import type { CommentsController } from "./commentsController";
import { AttachmentThumb, AttachmentViewer } from "./attachments";
import { Composer } from "./Composer";
import { SegmentsView } from "./richText";
import { EmojiPicker } from "./EmojiPicker";
import styles from "./Comments.module.css";

export const fullDate = (at: number) => new Intl.DateTimeFormat(intlLocale(), { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
/** "Just now", "2 minutes ago" (the thread's capitalised form of Figma's relative time) */
export const sinceCap = (at: number) => {
  const s = timeAgo(at);
  return s.charAt(0).toLocaleUpperCase(intlLocale()) + s.slice(1);
};

/** Text with @mentions in the brand colour; a message with rich segments drawn from them (richText.tsx) */
export function MessageText({ text, people, mentions, meta }: { text: string; people: MentionCandidate[]; mentions: string[]; meta?: CommentSegment[] }) {
  if (meta?.length) return <SegmentsView segments={meta} />;
  const names = people.filter((p) => mentions.includes(p.id) || mentions.includes(p.email)).map((p) => p.name);
  if (!names.length) return <>{text}</>;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")}))`, "g");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <span key={i} className={styles.mentionText}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function canResolve(data: CommentsState, thread: CommentThread): boolean {
  return data.canResolveAny || thread.comments[0]?.user.id === data.me.id;
}

type Confirm = { commentId: string } | null;

export function ThreadCard({ c, data, thread, people, style }: { c: CommentsController; data: CommentsState; thread: CommentThread; people: MentionCandidate[]; style: React.CSSProperties }) {
  useT();
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; comment: Comment | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const card = useRef<HTMLDivElement>(null);
  const mine = (x: Comment) => x.user.id === data.me.id;
  const first = thread.comments[0];
  const resolvable = canResolve(data, thread);

  const openMenu = (e: React.MouseEvent, entries: MenuEntry[], comment: Comment | null) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, entries, comment });
  };
  const threadEntries: MenuEntry[] = [
    { id: "unread", label: t("Mark as unread") },
    { id: "link", label: t("Copy link") },
    ...(first && mine(first) ? [{ id: "delete-thread", label: t("Delete thread...") }] : []),
  ];
  const onMenu = (id: string) => {
    const target = menu?.comment;
    setMenu(null);
    if (id === "unread") {
      void c.markRead([thread.id], false);
      c.openThread(null);
    } else if (id === "link") c.copyLink(thread.id);
    else if (id === "delete-thread") setConfirm({ commentId: thread.id });
    else if (id === "edit" && target) setEditing(target.id);
    else if (id === "delete" && target) setConfirm({ commentId: target.id });
  };

  return (
    <div
      ref={card}
      className={styles.thread}
      style={style}
      role="dialog"
      aria-label={t("Currently expanded comment thread. Close this dialog to return to the board.")}
      data-comment-thread={thread.id}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !menu && !confirm) {
          e.stopPropagation();
          c.openThread(null);
        }
      }}
    >
      <header className={styles.threadHeader}>
        <span className={styles.threadTitle}>{t("Comment")}</span>
        <span className={styles.grow} />
        <button type="button" className={styles.iconButton} aria-label={t("Thread actions")} data-open={menu?.comment === null || undefined} onClick={(e) => openMenu(e, threadEntries, null)}>
          <Icon name="24.more" />
        </button>
        {resolvable && (
          <button type="button" className={styles.iconButton} aria-label={thread.resolvedAt ? t("Mark as unresolved") : t("Mark as resolved")} data-resolved={thread.resolvedAt ? "" : undefined} onClick={() => void c.resolve(thread.id, !thread.resolvedAt)}>
            <ResolveGlyph done={!!thread.resolvedAt} />
          </button>
        )}
        <button type="button" className={styles.iconButton} aria-label={t("Close comment")} onClick={() => c.openThread(null)}>
          <Icon name="24.close.small" />
        </button>
      </header>
      <div className={styles.threadBody}>
        {thread.comments.map((x) => (
          <CommentRow
            key={x.id}
            c={c}
            comment={x}
            me={data.me.id}
            people={people}
            editing={editing === x.id}
            onStopEditing={() => setEditing(null)}
            onMenu={mine(x) ? (e) => openMenu(e, x.parentId === null ? [{ id: "edit", label: t("Edit") }] : [{ id: "edit", label: t("Edit") }, { id: "delete", label: t("Delete comment") }], x) : undefined}
          />
        ))}
      </div>
      <div className={styles.replyRow}>
        <Avatar name={data.me.name} src={data.me.picture ?? undefined} size={24} />
        <Composer key={thread.id} variant="reply" placeholder={t("Reply")} label={t("Reply to comment with {name}", { name: first?.user.name ?? "" })} people={people} me={data.me.id} images={c.attachments()} rich={c.rich()} onSubmit={(text, files, meta, mentions) => c.reply(thread.id, text, files, meta, mentions)} onCancel={() => c.openThread(null)} autoFocus />
      </div>
      {menu && <ContextMenu at={{ x: menu.x, y: menu.y }} entries={menu.entries} onSelect={onMenu} onClose={() => setMenu(null)} label={menu.comment ? t("Comment actions") : t("Thread actions")} />}
      <DeleteCommentDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onDelete={() => {
          const id = confirm?.commentId;
          setConfirm(null);
          if (id) void c.remove(id);
        }}
      />
    </div>
  );
}

/** Live: 320 × 128, "Delete comment", the warning, Cancel · Delete (red) */
export function DeleteCommentDialog({ open, onClose, onDelete }: { open: boolean; onClose(): void; onDelete(): void }) {
  useT();
  return (
    <Dialog
      title={t("Delete comment")}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="destructive" onClick={onDelete}>
            {t("Delete")}
          </Button>
        </>
      }
    >
      <p className={styles.confirmText}>{t("Are you sure you want to delete this comment? This action cannot be undone.")}</p>
    </Dialog>
  );
}

export function ResolveGlyph({ done }: { done: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className={styles.resolveGlyph} data-done={done || undefined}>
      <circle cx="12" cy="12" r="6.5" fill={done ? "currentColor" : "none"} stroke="currentColor" />
      <path d="M9.5 12.2l1.8 1.8 3.4-3.6" fill="none" stroke={done ? "var(--figma-color-bg)" : "currentColor"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CommentRow({ c, comment, me, people, editing, onStopEditing, onMenu }: { c: CommentsController; comment: Comment; me: string; people: MentionCandidate[]; editing: boolean; onStopEditing(): void; onMenu?: (e: React.MouseEvent) => void }) {
  useT();
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const reacted = (users: { id: string }[]) => users.some((u) => u.id === me);
  return (
    <article className={styles.comment} data-comment={comment.id}>
      <Avatar name={comment.user.name} src={comment.user.picture ?? undefined} size={24} />
      <div className={styles.commentMain}>
        <div className={styles.commentHead}>
          <span className={styles.commentName}>{comment.user.name}</span>
          <time className={styles.commentTime} dateTime={new Date(comment.createdAt).toISOString()} title={fullDate(comment.createdAt)} aria-label={fullDate(comment.createdAt)}>
            {sinceCap(comment.createdAt)}
          </time>
          <span className={styles.grow} />
          {onMenu && (
            <button type="button" className={styles.iconButton} aria-label={t("Comment actions")} onClick={onMenu}>
              <Icon name="24.more" />
            </button>
          )}
        </div>
        {editing ? (
          <Composer
            variant="edit"
            placeholder={t("Edit comment")}
            people={people}
            me={me}
            initial={comment.message}
            initialMeta={comment.messageMeta}
            rich={c.rich()}
            autoFocus
            onSubmit={async (text, _files, meta, mentions) => {
              const ok = await c.edit(comment.id, text, meta, mentions);
              if (ok) onStopEditing();
              return ok;
            }}
            onCancel={onStopEditing}
          />
        ) : (
          <div className={styles.commentTextRow}>
            <p className={styles.commentText}>
              <MessageText text={comment.message} people={people} mentions={comment.mentions} meta={comment.messageMeta} />
              {comment.editedAt ? <span className={styles.edited}> {t("(edited)")}</span> : null}
            </p>
            {!comment.reactions.length && (
              <button type="button" className={styles.iconButton} aria-label={t("Add reaction")} onClick={(e) => setPicker(e.currentTarget)}>
                <SmileyGlyph />
              </button>
            )}
          </div>
        )}
        {!editing && !!comment.attachments?.length && (
          <div className={styles.commentFiles}>
            {comment.attachments.map((a, i) => (
              <AttachmentThumb key={a.id} images={c.ed.source.images} a={a} size={comment.attachments!.length === 1 ? 200 : 96} onOpen={() => setViewing(i)} />
            ))}
          </div>
        )}
        {viewing !== null && comment.attachments && <AttachmentViewer images={c.ed.source.images} list={comment.attachments} at={viewing} onClose={() => setViewing(null)} />}
        {comment.reactions.length > 0 && (
          <div className={styles.reactions}>
            {comment.reactions.map((r) => {
              const on = reacted(r.users);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  className={styles.reaction}
                  data-on={on || undefined}
                  aria-label={t(on ? "{users} reacted with [\"{emoji}\"], clicking will remove your reaction" : "{users} reacted with [\"{emoji}\"], clicking will add your reaction", { users: tp(r.users.length, "{n} user", "{n} users"), emoji: r.emoji })}
                  title={r.users.map((u) => u.name).join(", ")}
                  onClick={() => void c.react(comment.id, r.emoji, !on)}
                >
                  <span className={styles.reactionEmoji}>{r.emoji}</span>
                  <span className={styles.reactionCount}>{r.users.length}</span>
                </button>
              );
            })}
            <button type="button" className={styles.reactionAdd} aria-label={t("Add reaction")} onClick={(e) => setPicker(e.currentTarget)}>
              <SmileyGlyph />
            </button>
          </div>
        )}
      </div>
      {picker && (
        <EmojiPicker
          anchor={picker}
          onPick={(e) => {
            setPicker(null);
            const r = comment.reactions.find((x) => x.emoji === e);
            void c.react(comment.id, e, !(r && reacted(r.users)));
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </article>
  );
}

export function SmileyGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" />
      <circle cx="9.75" cy="10.5" r="0.9" fill="currentColor" />
      <circle cx="14.25" cy="10.5" r="0.9" fill="currentColor" />
      <path d="M9.3 13.6a3.2 3.2 0 0 0 5.4 0" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
