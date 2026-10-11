/**
 * Settings › Notifications on its own, for the bell's gear until the Settings modal (Account | Community |
 * Notifications | Security, another workstream) opens at its Notifications tab — then this goes and the gear opens that.
 */
import { Dialog } from "@/ds";
import { NotificationsTab } from "../settings/NotificationsTab";
import styles from "./NotificationSettingsDialog.module.css";

export function NotificationSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog title="Notifications" size="large" open={open} onClose={onClose}>
      <div className={styles.body}>
        <NotificationsTab />
      </div>
    </Dialog>
  );
}
