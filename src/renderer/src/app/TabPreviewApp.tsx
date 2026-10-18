import { useEffect, useState } from "react";
import type { TabPreview } from "@shared/ipc";
import { Icon, useThemeRoot } from "@/ds";
import { t, tp, useT } from "@/i18n";
import { desktopAs } from "./native";
import styles from "./TabPreview.module.css";

/**
 * `?tabpreview`: the card under a hovered tab (atlas 01 §2.2), in a transparent view of its own under the tab bar
 * (src/main/tabPreview.ts). Padding 8, radius 13, a 0.5px line; the thumbnail 16:9 (radius 8, the top of the design);
 * the name 13px medium; "Edited {time}" or "Last viewed {time}" 11px secondary, at most 210 wide; the memory line. It
 * fades in over 250 ms after 600 ms, at once when main says so (a card was up already, or the keyboard is in the bar).
 */
export default function TabPreviewApp() {
  useThemeRoot();
  useT();
  const api = desktopAs.tabbar();
  const [preview, setPreview] = useState<TabPreview | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    document.documentElement.dataset.transparent = "";
    if (!api) return;
    const off = api.tabs.onPreview((p) => {
      setNow(Date.now());
      setPreview(p);
    });
    // Listening: main sends the card that waited for the page.
    api.ready();
    return off;
  }, [api]);

  if (!preview) return null;
  return (
    <div key={preview.immediate ? "shown" : preview.tabId} data-ds="TabPreview" className={styles.card} data-immediate={preview.immediate || undefined}>
      <div className={styles.thumb}>{preview.image ? <img src={preview.image} alt="" draggable={false} /> : <Icon name={preview.kind === "prototype" ? "16.play" : "16.design"} />}</div>
      <div className={styles.title}>{preview.title}</div>
      {preview.time && <div className={styles.line}>{preview.time.kind === "edited" ? t("Edited {time}", { time: shellTimeAgo(preview.time.at, now) }) : t("Last viewed {time}", { time: shellTimeAgo(preview.time.at, now) })}</div>}
      {preview.memory && <div className={styles.line}>{memoryLine(preview.memory)}</div>}
    </div>
  );
}

/** "Memory usage: 412MB" / "Offloaded tab: 412MB freed up"; past 1024 MB in GB with one decimal (ours). */
export function memoryLine({ kind, mb }: NonNullable<TabPreview["memory"]>): string {
  const gb = mb >= 1024;
  const memory = gb ? (mb / 1024).toFixed(1) : String(Math.round(mb));
  if (kind === "freed") return gb ? t("Offloaded tab: {memory}GB freed up", { memory }) : t("Offloaded tab: {memory}MB freed up", { memory });
  return gb ? t("Memory usage: {memory}GB", { memory }) : t("Memory usage: {memory}MB", { memory });
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The desktop shell's own "time ago" (atlas 01 §2.2, `desktop_shell.js`), unlike Home's rounded buckets: each unit
 * truncated — seconds under a minute, minutes under an hour, hours under a day, days under 30 ("yesterday" for one),
 * months under 12 ("last month" for one), then years ("last year" for one).
 */
export function shellTimeAgo(then: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - then);
  if (ms < MINUTE) return tp(Math.floor(ms / SECOND), "{n} second ago", "{n} seconds ago");
  if (ms < HOUR) return tp(Math.floor(ms / MINUTE), "{n} minute ago", "{n} minutes ago");
  if (ms < DAY) return tp(Math.floor(ms / HOUR), "{n} hour ago", "{n} hours ago");
  const days = Math.floor(ms / DAY);
  if (days < 30) return days === 1 ? t("yesterday") : tp(days, "{n} day ago", "{n} days ago");
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? t("last month") : tp(months, "{n} month ago", "{n} months ago");
  const years = Math.floor(days / 365);
  return years <= 1 ? t("last year") : tp(years, "{n} year ago", "{n} years ago");
}
