/**
 * Desktop notifications (docs/multiplayer.md §12): Figma's desktop app shows a notification on the computer for what
 * reaches the bell while the app isn't in front, as Settings › Notifications › "Send notifications to my computer"
 * says (the server decides per notification — `desktop` on the store's `notifications` event). A click brings the app
 * forward and opens the file — at the comment for a comment — the way a shared file's link does.
 */
import { BrowserWindow, Notification } from "electron";
import { desktopText, notificationLink } from "../shared/notifications";
import { onStoreReady } from "./storeHost";

/** Shown notifications are kept until closed: one collected by the GC no longer answers its click. */
const shown = new Set<Notification>();

export function initNotifications(open: (key: string, link: string) => void): void {
  let off: (() => void) | null = null;
  onStoreReady((client) => {
    off?.();
    off = client.notifications.watch((e) => {
      const item = e.item;
      if (!item || !e.desktop || !Notification.isSupported()) return;
      // In front, the bell shows it; the computer's notifications are for when the app isn't.
      if (BrowserWindow.getFocusedWindow()) return;
      const { title, body } = desktopText(item);
      const n = new Notification({ title, body });
      shown.add(n);
      const done = () => shown.delete(n);
      n.on("close", done);
      n.on("click", () => {
        done();
        const link = notificationLink(item);
        if (item.fileKey && link) open(item.fileKey, link);
        void client.notifications.markRead({ ids: [item.id] }).catch(() => {});
      });
      n.show();
    });
  });
}
