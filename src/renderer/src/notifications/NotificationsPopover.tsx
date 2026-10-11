/**
 * Figma's notifications (docs/multiplayer.md §12; the owner's 2.png, measured at 2x): a 384-wide panel under the bell —
 * "All notifications ⌄" (a menu: all, or one file's) and the settings gear; the tabs All | Requests | Unread (n) with
 * "Mark all as read"; rows newest first (the avatar with what happened as a badge, the person, "<what> · <file>", the
 * comment, the date, a blue dot while unread). A row opens its file (at the comment); a request has Deny / Approve.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, ContextMenu, Icon, IconButton, Portal, useDismiss, useFocusScope, type MenuEntry } from "@/ds";
import { getStoreClient } from "@/store";
import { PEER_COLORS } from "@shared/multiplayer/colors";
import { isCommentKind, isDevStatusKind, notificationAction, notificationDate, type NotificationFilter, type NotificationItem, type NotificationPage } from "@shared/notifications";
import styles from "./Notifications.module.css";

/** Live (2.png): the panel's left edge 62 left of the bell's, 2 under it */
const LEFT_OF_ANCHOR = 62;
const GAP = 2;
const BOTTOM = 16;

export interface NotificationsPopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
  /** A row: its file, at the comment for a comment */
  onOpen: (n: NotificationItem) => void;
  /** The gear: Settings › Notifications */
  onOpenSettings: () => void;
}

/** A person's colour for their initial (Figma colours initials avatars per person) */
export function personColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PEER_COLORS[Math.abs(h) % PEER_COLORS.length];
}

const TABS: { id: NotificationFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "requests", label: "Requests" },
  { id: "unread", label: "Unread" },
];

export function NotificationsPopover({ anchor, onClose, onOpen, onOpenSettings }: NotificationsPopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<NotificationFilter>("all");
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** "Today" for the rows' dates: when the panel opened */
  const [now] = useState(() => Date.now());
  const loadingMore = useRef(false);
  useDismiss(panel, onClose, { ignore: anchor, enabled: !menu });
  useFocusScope(panel);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const top = r.bottom + GAP;
    el.style.left = `${Math.max(8, Math.min(r.left - LEFT_OF_ANCHOR, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${top}px`;
    el.style.maxHeight = `${window.innerHeight - top - BOTTOM}px`;
  }, [anchor]);

  /** Bumped to read the first page again */
  const [generation, setGeneration] = useState(0);
  const load = useCallback(() => setGeneration((g) => g + 1), []);
  useEffect(() => {
    let live = true;
    getStoreClient()
      .notifications.list({ filter: tab, fileKey })
      .then(
        (p) => {
          if (!live) return;
          setPage(p);
          setError(null);
        },
        (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      live = false;
    };
  }, [tab, fileKey, generation]);
  // Something new (or read elsewhere): the first page again.
  useEffect(() => getStoreClient().notifications.watch(() => load()), [load]);

  const more = () => {
    if (!page?.next || loadingMore.current) return;
    loadingMore.current = true;
    void getStoreClient()
      .notifications.list({ filter: tab, fileKey, before: page.next })
      .then(
        (p) => setPage((cur) => (cur ? { ...p, items: [...cur.items, ...p.items.filter((n) => !cur.items.some((c) => c.id === n.id))] } : p)),
        () => {},
      )
      .finally(() => (loadingMore.current = false));
  };

  const markAll = () => {
    setPage((p) => (p ? { ...p, unread: 0, items: tab === "unread" ? [] : p.items.map((n) => ({ ...n, read: true })) } : p));
    void getStoreClient().notifications.markRead({ all: true }).catch(() => void load());
  };

  const open = (n: NotificationItem) => {
    if (!n.read) void getStoreClient().notifications.markRead({ ids: [n.id] }).catch(() => {});
    if (n.fileKey) onOpen(n);
    onClose();
  };

  const answer = (n: NotificationItem, approve: boolean) => {
    setBusy(n.id);
    void getStoreClient()
      .notifications.answer(n.id, approve)
      .then(
        () => load(),
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(null));
  };

  const files = page?.files ?? [];
  const filterLabel = fileKey ? (files.find((f) => f.key === fileKey)?.name ?? "All notifications") : "All notifications";
  const menuEntries: MenuEntry[] = [{ id: "all", label: "All notifications", checked: fileKey === null }, ...(files.length ? (["-"] as MenuEntry[]) : []), ...files.map((f) => ({ id: `file:${f.key}`, label: f.name || "Untitled", checked: fileKey === f.key }))];
  const unread = page?.unread ?? 0;
  const items = page?.items ?? [];

  return (
    <Portal anchor={anchor}>
      <div ref={panel} role="dialog" aria-label="Notifications" tabIndex={-1} className={styles.popover} onKeyDown={(e) => e.key === "Escape" && !menu && (e.stopPropagation(), onClose())}>
        <div className={styles.header}>
          <button
            ref={filterButton}
            type="button"
            className={styles.filter}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={() => {
              const r = filterButton.current!.getBoundingClientRect();
              setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
            }}
          >
            <span className={styles.filterLabel}>{filterLabel}</span>
            <Icon name="16.chevron.down" />
          </button>
          <IconButton icon="24.settings.small" label="Notification settings" onClick={onOpenSettings} />
        </div>
        <div className={styles.tabs}>
          <div role="tablist" aria-label="Notifications" className={styles.tabList}>
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={styles.tab} onClick={() => setTab(t.id)}>
                {t.id === "unread" && unread > 0 ? `Unread (${unread})` : t.label}
              </button>
            ))}
          </div>
          <button type="button" className={styles.markAll} disabled={unread === 0} onClick={markAll}>
            Mark all as read
          </button>
        </div>
        <div
          className={styles.list}
          role="list"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) more();
          }}
        >
          {page === null && !error ? null : items.length === 0 ? (
            <div className={styles.empty}>{error ? "Couldn’t load notifications. Check your connection and try again." : tab === "requests" ? "No requests" : tab === "unread" ? "No unread notifications" : "No notifications yet"}</div>
          ) : (
            items.map((n) => <Row key={n.id} n={n} now={now} busy={busy === n.id} onOpen={() => open(n)} onAnswer={(approve) => answer(n, approve)} />)
          )}
        </div>
      </div>
      {menu && (
        <ContextMenu
          at={menu}
          entries={menuEntries}
          ignore={filterButton}
          onSelect={(id) => setFileKey(id.startsWith("file:") ? id.slice(5) : null)}
          onClose={() => setMenu(null)}
        />
      )}
    </Portal>
  );
}

function Row({ n, now, busy, onOpen, onAnswer }: { n: NotificationItem; now: number; busy: boolean; onOpen: () => void; onAnswer: (approve: boolean) => void }) {
  const request = n.kind === "edit-request";
  const dev = isDevStatusKind(n.kind);
  const plugin = n.kind === "plugin_request" || n.kind === "plugin_request_answer";
  const badge = isCommentKind(n.kind) ? (n.kind === "reaction" ? (n.count === 1 && n.emoji ? <span className={styles.emoji}>{n.emoji}</span> : <Icon name="16.emoji" />) : <Icon name="24.comment" size={16} />) : dev ? <Icon name="24.dev-brackets" size={16} /> : plugin ? <Icon name="24.plugin" size={16} /> : null;
  return (
    <div
      role="listitem"
      className={styles.row}
      data-unread={!n.read || undefined}
      tabIndex={0}
      onClick={(e) => !(e.target as Element).closest("button") && onOpen()}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()}
    >
      <span className={styles.avatarWrap} data-badge={badge ? "" : undefined}>
        <span className={styles.avatar} style={{ background: personColor(n.actor.id) }} aria-hidden="true">
          {(n.actor.name.trim()[0] ?? "?").toLocaleUpperCase()}
        </span>
        {badge && <span className={styles.badge}>{badge}</span>}
      </span>
      <span className={styles.main}>
        <span className={styles.top}>
          <span className={styles.name}>{n.actor.name}</span>
          <span className={styles.date}>{notificationDate(n.updatedAt, now)}</span>
          <span className={styles.dotSlot}>{!n.read && <span className={styles.dot} aria-label="Unread" />}</span>
        </span>
        <span className={styles.action}>
          {notificationAction(n)} · {n.fileName || "Untitled"}
        </span>
        {n.text && n.count === 1 && !dev && !plugin && <span className={styles.text}>{n.text}</span>}
        {/* Figma's status emails link "Inspect in Dev Mode" to the file's ready-for-dev view (help.figma.com 26781702258583) */}
        {dev && n.fileKey && (
          <span className={styles.actions}>
            <Button variant="secondary" onClick={onOpen} data-notification="inspect">
              Inspect in Dev Mode
            </Button>
          </span>
        )}
        {n.kind === "plugin_request" && n.state && <span className={styles.answered} data-notification="plugin-request">{n.state === "pending" ? "Review it in Admin › Resources" : n.state === "approved" ? "Approved" : "Declined"}</span>}
        {request &&
          (n.state === "pending" ? (
            <span className={styles.actions}>
              <Button variant="secondary" disabled={busy} onClick={() => onAnswer(false)}>
                Deny
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => onAnswer(true)}>
                Approve
              </Button>
            </span>
          ) : (
            <span className={styles.answered}>{n.state === "approved" ? "Approved" : "Denied"}</span>
          ))}
      </span>
    </div>
  );
}
