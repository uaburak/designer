// `/api/releases` (docs/site.md §3): reading it, and choosing what the Download buttons offer.

export type Platform = "mac" | "windows";

export interface ReleaseFile {
  name: string;
  size: number;
}

export interface Release {
  version: string;
  date: string;
  notes: string;
  files: Partial<Record<Platform, ReleaseFile>>;
}

export interface Offer {
  platform: Platform;
  version: string;
  date: string;
  file: ReleaseFile;
}

/** Keeps only well-formed releases, in the file's order (newest first). */
export function parseReleases(json: unknown): Release[] {
  const list = (json as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is Release => {
    if (!r || typeof r !== "object") return false;
    const x = r as Release;
    return typeof x.version === "string" && typeof x.date === "string" && !!x.files && typeof x.files === "object";
  }).map((r) => ({ ...r, notes: typeof r.notes === "string" ? r.notes : "" }));
}

/** The newest release that has a file for the platform (a Mac-only release leaves Windows on the one before). */
export function offerFor(releases: Release[], platform: Platform): Offer | null {
  for (const r of releases) {
    const file = r.files[platform];
    if (file && typeof file.name === "string" && typeof file.size === "number") {
      return { platform, version: r.version, date: r.date, file };
    }
  }
  return null;
}

export function formatSize(bytes: number): string {
  if (!(bytes > 0)) return "";
  const mb = bytes / 1_000_000;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-20" → "Oct 20, 2026" (the date as written, no time zone shift). */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

/** The visitor's desktop platform, or null for anything else (phones and tablets included). */
export function detectPlatform(nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> & {
  userAgentData?: { platform?: string };
}): Platform | null {
  const hint = nav.userAgentData?.platform ?? "";
  const ua = nav.userAgent ?? "";
  const plat = nav.platform ?? "";
  if (/android|iphone|ipad|ipod|mobile/i.test(ua)) return null;
  if (/^windows$/i.test(hint) || /win/i.test(plat) || /windows nt/i.test(ua)) return "windows";
  if (/^macos$/i.test(hint) || /mac/i.test(plat) || /macintosh/i.test(ua)) {
    // iPadOS reports a Mac; a touch screen gives it away.
    return (nav.maxTouchPoints ?? 0) > 1 ? null : "mac";
  }
  return null;
}

let cached: Promise<Release[] | null> | null = null;

/** The releases, or null when the list could not be read. Fetched once per page. */
export function loadReleases(): Promise<Release[] | null> {
  cached ??= fetch("/api/releases", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(parseReleases)
    .catch(() => null);
  return cached;
}
