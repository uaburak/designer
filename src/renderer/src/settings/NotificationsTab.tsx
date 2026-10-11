/**
 * Settings › Notifications (docs/multiplayer.md §12; the owner's 3.png / 4.png, Figma's wording and order): Desktop
 * notifications, Email notifications, Product tips and news. The choices live on the server (the store's
 * `notifications.prefs`); desktop ones decide what reaches the computer, email ones are kept — no email is sent yet.
 * A group under an unchecked "Send notifications …" is shown disabled, as Figma does. Props-less: the Settings modal
 * mounts it as its Notifications tab.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { Checkbox, RadioGroup, showToast, type RadioOption } from "@/ds";
import { getStoreClient } from "@/store";
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from "@shared/notifications";
import styles from "./NotificationsTab.module.css";

const COMMENTS: RadioOption[] = [
  { value: "all", label: "All comments, mentions, and replies" },
  { value: "mentions", label: "Only mentions and replies" },
  { value: "none", label: "None" },
];
const INVITES: RadioOption[] = [
  { value: "all", label: "All types of invites and requests" },
  { value: "response", label: "Only invites and requests that need my response" },
  { value: "none", label: "None" },
];
const COMMUNITY: RadioOption[] = [
  { value: "all", label: "All comments on my published resources" },
  { value: "mentions", label: "Only mentions and replies" },
  { value: "none", label: "None" },
];
const WORKSPACE: RadioOption[] = [
  { value: "all", label: "All activity on my workspace" },
  { value: "none", label: "None" },
];
/** Dev Mode's status notifications (docs/editor.md D-4; help.figma.com 26781702258583: "Status changes" / "Nothing") */
const DEV_MODE: RadioOption[] = [
  { value: "status", label: "Status changes" },
  { value: "none", label: "Nothing" },
];
const USER_GROUPS: RadioOption[] = [
  { value: "all", label: "Shared resources and when added to user groups" },
  { value: "shared", label: "Only shared resources" },
  { value: "none", label: "None" },
];

export function NotificationsTab(): JSX.Element {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let live = true;
    void getStoreClient()
      .notifications.prefs()
      .then(
        (p) => live && setPrefs(p),
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);

  /** Each change is saved at once (one after another), as Figma's settings are */
  const change = (next: NotificationPrefs) => {
    setPrefs(next);
    saving.current = saving.current.then(() =>
      getStoreClient()
        .notifications.setPrefs(next)
        .catch((e: unknown) => showToast({ kind: "error", message: e instanceof Error && e.message ? e.message : "Couldn’t save your notification settings" })),
    );
  };
  const desktop = (patch: Partial<NotificationPrefs["desktop"]>) => change({ ...prefs, desktop: { ...prefs.desktop, ...patch } });
  const email = (patch: Partial<NotificationPrefs["email"]>) => change({ ...prefs, email: { ...prefs.email, ...patch } });
  const emailOff = !prefs.email.enabled;

  return (
    <div className={styles.tab} data-testid="notifications-tab">
      <section className={styles.section} aria-labelledby="notif-desktop">
        <h3 id="notif-desktop" className={styles.title}>Desktop notifications</h3>
        <Checkbox className={styles.check} label="Send notifications to my computer" checked={prefs.desktop.enabled} onChange={(on) => desktop({ enabled: on })} />
        <Group title="File comments" disabled={!prefs.desktop.enabled} first>
          <RadioGroup className={styles.radios} label="File comments" options={COMMENTS} value={prefs.desktop.comments} disabled={!prefs.desktop.enabled} onChange={(v) => desktop({ comments: v as NotificationPrefs["desktop"]["comments"] })} />
        </Group>
        <Group title="Dev Mode" disabled={!prefs.desktop.enabled}>
          <RadioGroup className={styles.radios} label="Dev Mode" options={DEV_MODE} value={prefs.devMode} disabled={!prefs.desktop.enabled} onChange={(v) => change({ ...prefs, devMode: v === "none" ? "none" : "status" })} />
        </Group>
      </section>

      <section className={styles.section} aria-labelledby="notif-email">
        <h3 id="notif-email" className={styles.title}>Email notifications</h3>
        <Checkbox className={styles.check} label="Send notifications by email" checked={prefs.email.enabled} onChange={(on) => email({ enabled: on })} />
        <p className={styles.description}>You’ll still get other emails from Figma, like important account or billing info.</p>
        <Group title="File comments" disabled={emailOff} first afterText>
          <RadioGroup className={styles.radios} label="File comments" options={COMMENTS} value={prefs.email.comments} disabled={emailOff} onChange={(v) => email({ comments: v as NotificationPrefs["email"]["comments"] })} />
        </Group>
        <Group title="Invites and requests" disabled={emailOff}>
          <RadioGroup className={styles.radios} label="Invites and requests" options={INVITES} value={prefs.email.invites} disabled={emailOff} onChange={(v) => email({ invites: v as NotificationPrefs["email"]["invites"] })} />
        </Group>
        <Group title="Community comments" disabled={emailOff}>
          <RadioGroup className={styles.radios} label="Community comments" options={COMMUNITY} value={prefs.email.community} disabled={emailOff} onChange={(v) => email({ community: v as NotificationPrefs["email"]["community"] })} />
        </Group>
        <Group title="Workspace" disabled={emailOff}>
          <RadioGroup className={styles.radios} label="Workspace" options={WORKSPACE} value={prefs.email.workspace} disabled={emailOff} onChange={(v) => email({ workspace: v as NotificationPrefs["email"]["workspace"] })} />
        </Group>
        <Group title="User groups" disabled={emailOff}>
          <RadioGroup className={styles.radios} label="User groups" options={USER_GROUPS} value={prefs.email.userGroups} disabled={emailOff} onChange={(v) => email({ userGroups: v as NotificationPrefs["email"]["userGroups"] })} />
        </Group>
        <Group title="Activity digests" disabled={emailOff}>
          <Checkbox className={styles.digest} label="Activity on my Community resources · Weekly" checked={prefs.email.digest} disabled={emailOff} onChange={(on) => email({ digest: on })} />
        </Group>
      </section>

      <section className={styles.section} aria-labelledby="notif-news">
        <h3 id="notif-news" className={styles.title}>Product tips and news</h3>
        <Checkbox className={styles.check} label="Send me occasional emails with updates and promotions from Figma" checked={prefs.productNews} onChange={(on) => change({ ...prefs, productNews: on })} />
      </section>

      <p className={styles.footer}>
        You can unsubscribe from Figma emails any time. For more information, review our{" "}
        <a className={styles.link} href="https://www.figma.com/privacy/" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        .
      </p>
    </div>
  );
}

function Group({ title, disabled, first, afterText, children }: { title: string; disabled: boolean; first?: boolean; afterText?: boolean; children: React.ReactNode }) {
  return (
    <div className={styles.group} data-first={first || undefined} data-after-text={afterText || undefined} data-disabled={disabled || undefined}>
      <h4 className={styles.subtitle}>{title}</h4>
      {children}
    </div>
  );
}
