const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** How long ago, as Figma's cards say it ("10 minutes ago", "1 day ago", "just now"). */
export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  for (const [unit, size] of UNITS) {
    if (diff >= size) return relative.format(-Math.floor(diff / size), unit);
  }
  return "just now";
}

/** A date, written out (the list view's columns, tooltips). */
export const longDate = (ms: number | null) => (ms ? new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
