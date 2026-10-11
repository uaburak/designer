/**
 * The bell's state (docs/multiplayer.md §12): the counts the store hears on the person's inbox socket, and Figma's red
 * dot — "a red dot over the bell when you have a new notification" (help.figma.com 360039813234): new since the
 * notifications were last opened (the owner's 1.png: 22 unread, no dot), so the time they were last opened is kept
 * per person on this machine.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { getStoreClient } from "@/store";

const SEEN_KEY = "designer.notifications.seenAt.v1";

function seenAt(userId: string): number {
  try {
    return Number((JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>)[userId]) || 0;
  } catch {
    return 0;
  }
}

function setSeenAt(userId: string, at: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    all[userId] = at;
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {
    // a per-viewer convenience only
  }
}

export interface BellState {
  unread: number;
  pending: number;
  /** Something arrived since the notifications were last opened */
  fresh: boolean;
  /** The notifications were opened now: the dot goes */
  markSeen(): void;
}

export function useNotificationsBell(userId: string | null): BellState {
  const [counts, setCounts] = useState({ unread: 0, pending: 0 });
  const [newest, setNewest] = useState(0);
  const [seenBump, setSeenBump] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when markSeen wrote it
  const seen = useMemo(() => (userId ? seenAt(userId) : 0), [userId, seenBump]);
  useEffect(() => {
    if (!userId) return;
    const client = getStoreClient();
    let live = true;
    const read = () =>
      void client.notifications.list({ limit: 1 }).then(
        (p) => {
          if (!live) return;
          setCounts({ unread: p.unread, pending: p.pending });
          setNewest(p.items[0]?.updatedAt ?? 0);
        },
        () => {},
      );
    read();
    const off = client.notifications.watch((e) => {
      setCounts({ unread: e.unread, pending: e.pending });
      if (e.item) setNewest((n) => Math.max(n, e.item!.updatedAt));
    });
    return () => {
      live = false;
      off();
    };
  }, [userId]);
  const markSeen = useCallback(() => {
    if (!userId) return;
    const at = Math.max(Date.now(), newest);
    setSeenAt(userId, at);
    setSeenBump((n) => n + 1);
  }, [userId, newest]);
  return { ...counts, fresh: !!userId && newest > seen, markSeen };
}
