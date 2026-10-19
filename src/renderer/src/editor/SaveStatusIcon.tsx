/**
 * The save status in the header (atlas 22 §3.4; saveStatus.ts has the rules): no "Saved" label — an icon only when
 * changes wait too long or the file's link is down, its tooltip saying which; 60 s after changes start waiting a toast
 * that stays until they're saved, with Learn more; "Changes saved" when they are, online. (Figma's English for these
 * isn't read: atlas 22 §10 question 10.)
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Dialog, dismissToast, Icon, showToast, tooltipProps } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "./controller";
import { SAVE_STATUS, saveStatusOf, type SaveReason } from "./saveStatus";
import styles from "./SaveStatusIcon.module.css";

const REASON_TEXT: Record<Exclude<SaveReason, null>, string> = {
  disconnected: "You're offline. Your changes are saved on this computer and sent when you're back online.",
  local: "Your latest changes are still being saved on this computer.",
  server: "Your latest changes haven't reached the server yet. They're saved on this computer.",
};

export function SaveStatusIcon() {
  useT();
  const ed = useEditor();
  const tracker = saveStatusOf(ed);
  const state = useSyncExternalStore(tracker.subscribe, () => tracker.state.icon + "|" + tracker.state.reason + "|" + tracker.state.unsaved + "|" + tracker.state.online);
  const [icon, reason, unsaved, online] = state.split("|");
  const [learnMore, setLearnMore] = useState(false);
  const toast = useRef<number | null>(null);

  // 60 s after changes start waiting: a toast until they're saved; then "Changes saved" when it was shown and online.
  useEffect(() => {
    if (unsaved !== "true") {
      if (toast.current !== null) {
        dismissToast(toast.current);
        toast.current = null;
        if (online === "true") showToast({ message: t("Changes saved") });
      }
      return;
    }
    const timer = window.setTimeout(() => {
      toast.current = showToast({ message: t("You have unsaved changes"), duration: Infinity, action: { label: t("Learn more"), onAction: () => setLearnMore(true) } });
    }, SAVE_STATUS.toastMs);
    return () => window.clearTimeout(timer);
  }, [unsaved, online]);
  useEffect(() => () => void (toast.current !== null && dismissToast(toast.current)), []);

  const label = reason !== "null" ? t(REASON_TEXT[reason as Exclude<SaveReason, null>]) : "";
  return (
    <>
      {icon !== "null" && (
        <span className={styles.status} {...tooltipProps(label)} aria-label={label} role="img" data-save-status={icon} data-onboarding-key="multiplayer-save-status">
          <Icon name="24.warning" />
        </span>
      )}
      {learnMore && (
        <Dialog
          title={t("Your changes are safe")}
          open
          onClose={() => setLearnMore(false)}
          footer={
            <Button variant="primary" onClick={() => setLearnMore(false)}>
              {t("OK")}
            </Button>
          }
        >
          <p className={styles.text}>{t("Every change is saved on this computer as you make it, and a shared file's changes go to the server when it can be reached. Keep this file open until they're saved, or they're sent the next time it opens.")}</p>
        </Dialog>
      )}
    </>
  );
}
