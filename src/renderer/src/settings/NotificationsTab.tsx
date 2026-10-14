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
import { t, useT } from "@/i18n";
import styles from "./NotificationsTab.module.css";

/** A list's options in the current language */
const translated = (options: RadioOption[]): RadioOption[] => options.map((o) => ({ ...o, label: t(o.label) }));

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
  useT();
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
        .catch((e: unknown) => showToast({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Couldn’t save your notification settings") })),
    );
  };
  const desktop = (patch: Partial<NotificationPrefs["desktop"]>) => change({ ...prefs, desktop: { ...prefs.desktop, ...patch } });
  const email = (patch: Partial<NotificationPrefs["email"]>) => change({ ...prefs, email: { ...prefs.email, ...patch } });
  const emailOff = !prefs.email.enabled;
  // The footer's sentence around its link, the link's place in it per language
  const privacy = t("You can unsubscribe from Figma emails any time. For more information, review our {link}.").split("{link}");

  return (
    <div className={styles.tab} data-testid="notifications-tab">
      <section className={styles.section} aria-labelledby="notif-desktop">
        <h3 id="notif-desktop" className={styles.title}>{t("Desktop notifications")}</h3>
        <Checkbox className={styles.check} label={t("Send notifications to my computer")} checked={prefs.desktop.enabled} onChange={(on) => desktop({ enabled: on })} />
        <Group title={t("File comments")} disabled={!prefs.desktop.enabled} first>
          <RadioGroup className={styles.radios} label={t("File comments")} options={translated(COMMENTS)} value={prefs.desktop.comments} disabled={!prefs.desktop.enabled} onChange={(v) => desktop({ comments: v as NotificationPrefs["desktop"]["comments"] })} />
        </Group>
        <Group title={t("Dev Mode")} disabled={!prefs.desktop.enabled}>
          <RadioGroup className={styles.radios} label={t("Dev Mode")} options={translated(DEV_MODE)} value={prefs.devMode} disabled={!prefs.desktop.enabled} onChange={(v) => change({ ...prefs, devMode: v === "none" ? "none" : "status" })} />
        </Group>
      </section>

      <section className={styles.section} aria-labelledby="notif-email">
        <h3 id="notif-email" className={styles.title}>{t("Email notifications")}</h3>
        <Checkbox className={styles.check} label={t("Send notifications by email")} checked={prefs.email.enabled} onChange={(on) => email({ enabled: on })} />
        <p className={styles.description}>{t("You’ll still get other emails from Figma, like important account or billing info.")}</p>
        <Group title={t("File comments")} disabled={emailOff} first afterText>
          <RadioGroup className={styles.radios} label={t("File comments")} options={translated(COMMENTS)} value={prefs.email.comments} disabled={emailOff} onChange={(v) => email({ comments: v as NotificationPrefs["email"]["comments"] })} />
        </Group>
        <Group title={t("Invites and requests")} disabled={emailOff}>
          <RadioGroup className={styles.radios} label={t("Invites and requests")} options={translated(INVITES)} value={prefs.email.invites} disabled={emailOff} onChange={(v) => email({ invites: v as NotificationPrefs["email"]["invites"] })} />
        </Group>
        <Group title={t("Community comments")} disabled={emailOff}>
          <RadioGroup className={styles.radios} label={t("Community comments")} options={translated(COMMUNITY)} value={prefs.email.community} disabled={emailOff} onChange={(v) => email({ community: v as NotificationPrefs["email"]["community"] })} />
        </Group>
        <Group title={t("Workspace")} disabled={emailOff}>
          <RadioGroup className={styles.radios} label={t("Workspace")} options={translated(WORKSPACE)} value={prefs.email.workspace} disabled={emailOff} onChange={(v) => email({ workspace: v as NotificationPrefs["email"]["workspace"] })} />
        </Group>
        <Group title={t("User groups")} disabled={emailOff}>
          <RadioGroup className={styles.radios} label={t("User groups")} options={translated(USER_GROUPS)} value={prefs.email.userGroups} disabled={emailOff} onChange={(v) => email({ userGroups: v as NotificationPrefs["email"]["userGroups"] })} />
        </Group>
        <Group title={t("Activity digests")} disabled={emailOff}>
          <Checkbox className={styles.digest} label={t("Activity on my Community resources · Weekly")} checked={prefs.email.digest} disabled={emailOff} onChange={(on) => email({ digest: on })} />
        </Group>
      </section>

      <section className={styles.section} aria-labelledby="notif-news">
        <h3 id="notif-news" className={styles.title}>{t("Product tips and news")}</h3>
        <Checkbox className={styles.check} label={t("Send me occasional emails with updates and promotions from Figma")} checked={prefs.productNews} onChange={(on) => change({ ...prefs, productNews: on })} />
      </section>

      <p className={styles.footer}>
        {privacy[0]}
        <a className={styles.link} href="https://www.figma.com/privacy/" target="_blank" rel="noreferrer">
          {t("Privacy Policy")}
        </a>
        {privacy[1]}
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
