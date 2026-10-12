/** A folder's glyph in its colour (the DS's `--ds-color-folder-*` tokens); a team's or an org's square icon. */
import { useEffect, useState } from "react";
import { FolderGlyph as DsFolderGlyph, folderColor, initials } from "@/ds";
import type { FolderColor } from "@shared/store/types";
import styles from "./Files.module.css";

export function FolderGlyph({ color, size = 24 }: { color: FolderColor; size?: 16 | 24 | 48 }) {
  return (
    <span data-folder-color={color} style={{ display: "inline-flex" }} aria-hidden>
      <DsFolderGlyph color={folderColor(color)} size={size} />
    </span>
  );
}

// ---- icons the server keeps (docs/multiplayer.md §14.16) -------------------------------------------------------------

/** Turns a server icon URL into a picture the page may show (the store's `orgs.iconData`); set by Home */
let iconLoader: ((iconUrl: string) => Promise<string | null>) | null = null;
const loaded = new Map<string, string | null>();
const waiting = new Map<string, Promise<string | null>>();

/** Home gives the store's `orgs.iconData` (null: none — every icon shows its initial) */
export function setIconLoader(load: ((iconUrl: string) => Promise<string | null>) | null): void {
  iconLoader = load;
}

/** The picture of `iconUrl` once had (data: URLs as they are), else null. */
export function iconSrc(iconUrl: string | null | undefined): string | null {
  if (!iconUrl) return null;
  if (iconUrl.startsWith("data:image/")) return iconUrl;
  return loaded.get(iconUrl) ?? null;
}

/** Asks the loader for `iconUrl` once (a failure is asked again later) */
export function loadIcon(iconUrl: string | null | undefined): Promise<string | null> {
  if (!iconUrl) return Promise.resolve(null);
  const have = iconSrc(iconUrl);
  if (have || loaded.has(iconUrl)) return Promise.resolve(have);
  if (!iconLoader) return Promise.resolve(null);
  let p = waiting.get(iconUrl);
  if (!p) {
    p = iconLoader(iconUrl)
      .catch(() => null)
      .then((src) => {
        waiting.delete(iconUrl);
        if (src) loaded.set(iconUrl, src);
        return src;
      });
    waiting.set(iconUrl, p);
  }
  return p;
}

/** `iconUrl`'s picture: null until loaded (and when it can't be) */
export function useIconSrc(iconUrl: string | null | undefined): string | null {
  const [, bump] = useState(0);
  const src = iconSrc(iconUrl);
  useEffect(() => {
    if (!iconUrl || src) return;
    let live = true;
    void loadIcon(iconUrl).then((s) => live && s && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [iconUrl, src]);
  return src;
}

/**
 * A team's or an org's icon (1.png: the team page's 40 square, radius 5, its initial in white on green; the sidebar's
 * 16 circle): the uploaded icon (`iconUrl`, §14.16) when it has one, a data: URL set before that (`src`), else the
 * name's initial (Figma's fallback).
 */
export function TeamIcon({ name, src, iconUrl, size = 16 }: { name: string; src?: string | null; iconUrl?: string | null; size?: 16 | 24 | 32 | 40 | 64 }) {
  const loadedSrc = useIconSrc(iconUrl);
  const shown = loadedSrc ?? src ?? null;
  return (
    // The initial is drawn by CSS (attr): it isn't part of the row's text or its accessible name
    <span data-team-icon="" className={styles.teamIcon} data-size={size} data-initial={shown ? undefined : initials(name, 1)} aria-hidden>
      {shown && <img src={shown} alt="" />}
    </span>
  );
}
