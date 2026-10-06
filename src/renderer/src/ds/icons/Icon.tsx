import type { CSSProperties } from "react";
import { ICONS, type IconEntry, type IconName } from "./registry";

export type { IconName } from "./registry";

/** Every icon name, sorted (the Gallery, tests). */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export const iconBox = (name: IconName): 16 | 24 => (ICONS[name] as IconEntry)[0];

export interface IconProps {
  name: IconName;
  /** Drawn size in px; default the name's box (16 or 24) */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** An accessible name; without it the icon is decorative */
  label?: string;
}

/**
 * One chrome icon (contract §1.13): an inline SVG in `currentColor`, its
 * box the name's prefix — a 24 icon is the whole 24px button box with the
 * glyph in its middle; the kit's secondary tone drawn at a third.
 */
export function Icon({ name, size, className, style, label }: IconProps) {
  const entry = ICONS[name] as IconEntry | undefined;
  if (!entry) return null;
  const [box, mode, ...paths] = entry;
  const px = size ?? box;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  const common = { width: px, height: px, className, style: { flexShrink: 0, ...style }, "data-ds": "Icon", ...a11y };
  if (typeof mode === "string") {
    const view = Number(mode.slice(1));
    const inset = (box - view) / 2;
    return (
      <svg {...common} viewBox={`${-inset} ${-inset} ${box} ${box}`} fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
        {paths.map((p, i) => (p.startsWith("f|") ? <path key={i} d={p.slice(2)} fill="currentColor" stroke="none" /> : <path key={i} d={p} />))}
      </svg>
    );
  }
  return (
    <svg {...common} viewBox={`0 0 ${box} ${box}`} fill="currentColor">
      {paths.map((p, i) => {
        const at = p.indexOf("|");
        const tone = at > 0 ? Number(p.slice(0, at)) : 0.9;
        const d = at > 0 ? p.slice(at + 1) : p;
        const opacity = tone >= 0.9 ? undefined : tone / 0.9;
        return <path key={i} d={d} fillRule={mode === 1 ? "evenodd" : undefined} clipRule={mode === 1 ? "evenodd" : undefined} fillOpacity={opacity} />;
      })}
    </svg>
  );
}
