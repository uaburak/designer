/**
 * Figma's relative times on files ("Edited 34 minutes ago", "Edited yesterday", "Edited just now") — its moment-style
 * buckets, each rounded (docs/research/atlas/01-app-shell-home.md §5.5): just now under 45 s, then minutes, hours,
 * days, months (30 days) and years (365 days). Intl's long style with numeric "auto" says "yesterday", "last month"
 * and "last year" for one day, month and year back (the desktop app's strings, §10).
 */
import { useEffect, useState } from "react";
import { t, tp } from "@/i18n";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const unit = (n: number, word: "minute" | "hour" | "day" | "month" | "year") => {
  switch (word) {
    case "minute":
      return tp(n, "{n} minute ago", "{n} minutes ago");
    case "hour":
      return tp(n, "{n} hour ago", "{n} hours ago");
    case "day":
      return n === 1 ? t("yesterday") : tp(n, "{n} day ago", "{n} days ago");
    case "month":
      return n === 1 ? t("last month") : tp(n, "{n} month ago", "{n} months ago");
    case "year":
      return n === 1 ? t("last year") : tp(n, "{n} year ago", "{n} years ago");
  }
};

/**
 * "just now" (< 45 s), "1 minute ago" (< 90 s), "n minutes ago" (< 45 min), "1 hour ago" (< 90 min), "n hours ago"
 * (< 22 h), "yesterday" (< 36 h), "n days ago" (< 26 days), "last month" (< 45 days), "n months ago" (< 320 days),
 * then "last year" / "n years ago".
 */
export function timeAgo(then: number | Date, now: number | Date = Date.now()): string {
  const ms = Math.max(0, +now - +then);
  if (ms < 45 * SECOND) return t("just now");
  if (ms < 90 * SECOND) return unit(1, "minute");
  if (ms < 45 * MINUTE) return unit(Math.round(ms / MINUTE), "minute");
  if (ms < 90 * MINUTE) return unit(1, "hour");
  if (ms < 22 * HOUR) return unit(Math.round(ms / HOUR), "hour");
  if (ms < 36 * HOUR) return unit(1, "day");
  if (ms < 26 * DAY) return unit(Math.round(ms / DAY), "day");
  if (ms < 45 * DAY) return unit(1, "month");
  if (ms < 320 * DAY) return unit(Math.round(ms / (30 * DAY)), "month");
  return unit(Math.max(1, Math.round(ms / (365 * DAY))), "year");
}

/** A file card's subtitle: "Edited 34 minutes ago". */
export const formatEdited = (editedAt: number | Date, now: number | Date = Date.now()) => t("Edited {time}", { time: timeAgo(editedAt, now) });

/** How soon a time this old reads differently (Figma's cadence): every 30 s under an hour, 30 min under a day, else 6 h. */
export const refreshDelay = (age: number): number => (age < HOUR ? 30 * SECOND : age < DAY ? 30 * MINUTE : 6 * HOUR);

/**
 * The clock relative times are read against, moving at the cadence of the newest time shown (`newest`, ms; none: every
 * 30 s): "Edited just now" turns into "Edited 1 minute ago" without a reload.
 */
export function useNow(newest: number | null = null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), refreshDelay(newest === null ? 0 : now - newest));
    return () => window.clearTimeout(timer);
  }, [now, newest]);
  return now;
}
