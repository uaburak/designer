/**
 * Figma's relative times on files ("Edited 34 minutes ago", "Edited 1 day ago", "Edited just now"):
 * minutes under an hour, hours under a day, days under a month, months under a year, then years.
 */
import { t, tp } from "@/i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const unit = (n: number, word: "minute" | "hour" | "day" | "month" | "year") => {
  switch (word) {
    case "minute":
      return tp(n, "{n} minute ago", "{n} minutes ago");
    case "hour":
      return tp(n, "{n} hour ago", "{n} hours ago");
    case "day":
      return tp(n, "{n} day ago", "{n} days ago");
    case "month":
      return tp(n, "{n} month ago", "{n} months ago");
    case "year":
      return tp(n, "{n} year ago", "{n} years ago");
  }
};

/** "just now", "1 minute ago", "3 hours ago", "1 day ago", "2 months ago", "1 year ago". */
export function timeAgo(then: number | Date, now: number | Date = Date.now()): string {
  const ms = Math.max(0, +now - +then);
  if (ms < MINUTE) return t("just now");
  if (ms < HOUR) return unit(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return unit(Math.floor(ms / HOUR), "hour");
  const days = Math.floor(ms / DAY);
  if (days < 30) return unit(days, "day");
  const months = Math.floor(days / 30.44);
  if (months < 12) return unit(Math.max(1, months), "month");
  return unit(Math.floor(days / 365.25), "year");
}

/** A file card's subtitle: "Edited 34 minutes ago". */
export const formatEdited = (editedAt: number | Date, now: number | Date = Date.now()) => t("Edited {time}", { time: timeAgo(editedAt, now) });
