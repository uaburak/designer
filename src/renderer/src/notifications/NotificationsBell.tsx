/**
 * The bell at the right of Home's account row (the owner's 1.png), opening the notifications (2.png). Figma: "a red
 * dot over the bell when you have a new notification" — new since they were last opened (useNotifications.ts).
 */
import { useState } from "react";
import { Icon, tooltipProps } from "@/ds";
import { t, useT } from "@/i18n";
import type { NotificationItem } from "@shared/notifications";
import { NotificationsPopover } from "./NotificationsPopover";
import { useNotificationsBell } from "./useNotifications";
import styles from "./Notifications.module.css";

export interface NotificationsBellProps {
  /** The signed-in person (the dot's "last opened" is theirs) */
  userId: string;
  onOpen: (n: NotificationItem) => void;
  onOpenSettings: () => void;
}

export function NotificationsBell({ userId, onOpen, onOpenSettings }: NotificationsBellProps) {
  useT();
  /** The bell while the notifications are open */
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const bell = useNotificationsBell(userId);
  const close = () => {
    bell.markSeen();
    setAnchor(null);
  };
  return (
    <>
      <button
        type="button"
        className={styles.bell}
        aria-label={bell.unread ? t("Notifications, {n} unread", { n: bell.unread }) : t("Notifications")}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        {...(anchor ? {} : tooltipProps(t("Notifications")))}
        onClick={(e) => {
          if (anchor) return close();
          bell.markSeen();
          setAnchor(e.currentTarget);
        }}
      >
        <Icon name="24.bell" />
        {bell.fresh && !anchor && <span className={styles.fresh} />}
      </button>
      {anchor && (
        <NotificationsPopover
          anchor={anchor}
          onClose={close}
          onOpen={onOpen}
          onOpenSettings={() => {
            close();
            onOpenSettings();
          }}
        />
      )}
    </>
  );
}
