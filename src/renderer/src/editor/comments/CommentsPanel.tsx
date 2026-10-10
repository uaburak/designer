/**
 * The Comments panel (live: docs/research/figma/live/multiplayer/comments.md "Right panel", "The list"): a 41 px header
 * — search "Search" (aria "Search for comments"), [Sort/Filter], [Settings] •••; one row per thread (avatar, [More
 * Actions], [Mark as resolved], "#1 · Page", name and time, the text, "1 reply"), the open thread's row selected; the
 * empty state. A row's click opens its thread and brings it into view (its page, centred).
 */
import { useState } from "react";
import { Avatar, ContextMenu, Icon, MenuButton, SearchField, timeAgo, type MenuEntry } from "@/ds";
import { useCurrentPage } from "@/engine/hooks";
import type { CommentThread } from "@shared/comments";
import { runEditorCommand } from "../commands";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { commentsOf, listedThreads, useComments, type CommentsController } from "./commentsController";
import { canResolve, DeleteCommentDialog, MessageText, ResolveGlyph } from "./Thread";
import styles from "./Comments.module.css";

export function CommentsPanel() {
  const ed = useEditor();
  const c = commentsOf(ed);
  const v = useComments(ed);
  const page = useCurrentPage(ed.store);
  const shown = useUI((s) => s.comments !== false);
  if (!c) return null;
  const list = listedThreads(v, page);
  const unread = (v.data?.threads ?? []).some((t) => t.unread);
  const filtering = v.sort !== "date" || v.showResolved || v.onlyMine || v.onlyPage;
  const sortFilter: MenuEntry[] = [
    { header: "Sort" },
    { id: "sort-date", label: "Sort by date", checked: v.sort === "date" },
    { id: "sort-unread", label: "Sort by unread", checked: v.sort === "unread" },
    "-",
    { id: "showResolved", label: "Show resolved comments", checked: v.showResolved },
    { id: "onlyMine", label: "Only your threads", checked: v.onlyMine },
    { id: "onlyPage", label: "Only current page", checked: v.onlyPage },
  ];
  const settings: MenuEntry[] = [
    { id: "hide", label: shown ? "Hide comments" : "Show comments", shortcut: "⇧C" },
    "-",
    { header: "Comment notifications" },
    { id: "n-everything", label: "Everything", checked: v.notifications === "everything" },
    { id: "n-mentions", label: "Just mentions and replies", checked: v.notifications === "mentions" },
    { id: "n-nothing", label: "Nothing", checked: v.notifications === "nothing" },
    "-",
    { id: "read-all", label: "Mark all as read", disabled: !unread },
  ];
  const pageName = (id: string) => ed.store.pages.find((p) => p.guid === id)?.name ?? "";
  return (
    <div className={styles.panel} role="dialog" aria-label="Comments panel" data-comments-panel="">
      <div className={styles.panelHeader}>
        <SearchField className={styles.search} size="default" value={v.search} onChange={(s) => c.setSearch(s)} placeholder="Search" label="Search for comments" />
        <MenuButton
          label="Sort/Filter"
          entries={sortFilter}
          className={styles.headerButton}
          align="end"
          onSelect={(id) => {
            if (id === "sort-date") c.setSort("date");
            else if (id === "sort-unread") c.setSort("unread");
            else c.toggle(id as "showResolved" | "onlyMine" | "onlyPage");
          }}
        >
          <span data-on={filtering || undefined} className={styles.headerGlyph}>
            <Icon name="24.filter" />
          </span>
        </MenuButton>
        <MenuButton
          label="Settings"
          entries={settings}
          className={styles.headerButton}
          align="end"
          onSelect={(id) => {
            if (id === "hide") runEditorCommand(ed, "view.comments");
            else if (id === "read-all") void c.markAllRead();
            else if (id.startsWith("n-")) c.setNotifications(id === "n-mentions" ? "mentions" : id === "n-nothing" ? "nothing" : "everything");
          }}
        >
          <Icon name="24.more" />
        </MenuButton>
      </div>
      {v.data?.error && <p className={styles.panelError}>{v.data.error}</p>}
      {list.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <Icon name="24.comment" />
          </span>
          <p className={styles.emptyText}>
            {v.search.trim() ? "No comments match" : "Give feedback, ask a question, or just leave a note of appreciation. Click anywhere in the file to leave a comment."}
          </p>
        </div>
      ) : (
        <div className={styles.list} role="list">
          {list.map((t) => (
            <Row key={t.id} c={c} thread={t} selected={v.open === t.id} pageName={pageName(t.anchor.pageId)} people={v.people} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ c, thread, selected, pageName, people }: { c: CommentsController; thread: CommentThread; selected: boolean; pageName: string; people: { id: string; name: string; email: string }[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const data = c.view.data!;
  const first = thread.comments[0];
  const replies = thread.comments.length - 1;
  const last = thread.comments[thread.comments.length - 1];
  const entries: MenuEntry[] = [
    { id: "unread", label: thread.unread ? "Mark as read" : "Mark as unread" },
    { id: "link", label: "Copy link" },
    ...(first?.user.id === data.me.id ? [{ id: "delete", label: "Delete thread..." }] : []),
  ];
  return (
    <div
      role="listitem"
      tabIndex={0}
      className={styles.row}
      data-selected={selected || undefined}
      data-unread={thread.unread || undefined}
      data-thread-row={thread.id}
      aria-label={`Select comment by ${first?.user.name}, ${first?.message}, ${replies} ${replies === 1 ? "reply" : "replies"}`}
      onClick={() => c.openThread(thread.id, true)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), c.openThread(thread.id, true))}
    >
      <div className={styles.rowBox}>
        <div className={styles.rowTop}>
          {thread.unread && <span className={styles.unreadDot} aria-label="Unread" />}
          <Avatar name={first?.user.name ?? "?"} src={first?.user.picture ?? undefined} size={24} />
          <span className={styles.grow} />
          <button
            type="button"
            className={styles.iconButton}
            aria-label="More Actions"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
          >
            <Icon name="24.more" />
          </button>
          {canResolve(data, thread) && (
            <button
              type="button"
              className={styles.iconButton}
              aria-label={thread.resolvedAt ? "Mark as unresolved" : "Mark as resolved"}
              onClick={(e) => {
                e.stopPropagation();
                void c.resolve(thread.id, !thread.resolvedAt);
              }}
            >
              <ResolveGlyph done={!!thread.resolvedAt} />
            </button>
          )}
        </div>
        <div className={styles.rowMeta}>
          #{thread.number} · {pageName}
        </div>
        <div className={styles.rowWho}>
          <span className={styles.rowName}>{first?.user.name}</span> <span className={styles.rowTime}>{last ? timeAgo(last.createdAt) : ""}</span>
        </div>
        <p className={styles.rowText}>{first && <MessageText text={first.message} people={people} mentions={first.mentions} />}</p>
        {replies > 0 && <div className={styles.rowReplies}>{replies === 1 ? "1 reply" : `${replies} replies`}</div>}
      </div>
      {menu && (
        <ContextMenu
          at={menu}
          entries={entries}
          label="More Actions"
          onClose={() => setMenu(null)}
          onSelect={(id) => {
            setMenu(null);
            if (id === "unread") void c.markRead([thread.id], thread.unread);
            else if (id === "link") c.copyLink(thread.id);
            else if (id === "delete") setConfirming(true);
          }}
        />
      )}
      <DeleteCommentDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onDelete={() => {
          setConfirming(false);
          void c.remove(thread.id);
        }}
      />
    </div>
  );
}
