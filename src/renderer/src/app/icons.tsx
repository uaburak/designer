import type { ReactNode } from "react";

/**
 * The shell's own icons — the home's sidebar, the tab bar, the file cards —
 * drawn after Figma's desktop app: 1px round strokes in the current colour,
 * the glyph in the middle of a 24px box (16px ones in a 16px box). Figma's
 * kit icons (components/admin/figmaIcons.tsx) are used where the kit has
 * one; these are what it doesn't.
 */

type Props = { size?: number; className?: string };

function stroke(view: 16 | 24, children: ReactNode) {
  return function Icon({ size = view, className }: Props) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${view} ${view}`} fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
        {children}
      </svg>
    );
  };
}

export const HomeIcon = stroke(24, <path d="M5.5 10.6L12 5.2l6.5 5.4v8a.9.9 0 0 1-.9.9h-3.85v-5.1h-3.5v5.1H6.4a.9.9 0 0 1-.9-.9z" />);

export const ClockIcon = stroke(24, <><circle cx="12" cy="12" r="7.5" /><path d="M12 8v4.25l2.75 1.75" /></>);

export const GlobeIcon = stroke(24, <><circle cx="12" cy="12" r="7.5" /><path d="M4.5 12h15" /><path d="M12 4.5c2 2 3.1 4.6 3.1 7.5S14 17.5 12 19.5c-2-2-3.1-4.6-3.1-7.5S10 6.5 12 4.5z" /></>);

export const FileIcon = stroke(24, <><path d="M6.5 4.5h7.25l3.75 3.75V19.5h-11z" /><path d="M13.5 4.5v4h4" /></>);

export const GridIcon = stroke(24, <><rect x="5.5" y="5.5" width="5" height="5" rx="1.25" /><rect x="13.5" y="5.5" width="5" height="5" rx="1.25" /><rect x="5.5" y="13.5" width="5" height="5" rx="1.25" /><rect x="13.5" y="13.5" width="5" height="5" rx="1.25" /></>);

export const ListIcon = stroke(24, <><path d="M9.5 7.5h9M9.5 12h9M9.5 16.5h9" /><path d="M5.5 7.5h.01M5.5 12h.01M5.5 16.5h.01" strokeWidth={1.75} /></>);

export const LibraryIcon = stroke(24, <><rect x="4.5" y="5.5" width="15" height="13" rx="1.5" /><path d="M4.5 9.5h15M9.5 9.5v9" /></>);

export const TrashIcon = stroke(24, <><path d="M5.5 7.5h13" /><path d="M9.5 7.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" /><path d="M7 7.5l.75 11.07a1 1 0 0 0 1 .93h6.5a1 1 0 0 0 1-.93L17 7.5" /><path d="M10.5 11v5.5M13.5 11v5.5" /></>);

export const PersonIcon = stroke(24, <><circle cx="12" cy="8.75" r="3.75" /><path d="M5 19.5c.7-3.3 3.4-5.2 7-5.2s6.3 1.9 7 5.2" /></>);

export const SearchIcon = stroke(24, <><circle cx="11" cy="11" r="5.5" /><path d="M15 15l4 4" /></>);

/** The header's folder, filled as Figma's. */
export const FolderIcon = ({ size = 32, className }: Props) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h6.4c.66 0 1.3.26 1.77.73L15.5 8.5h11A2.5 2.5 0 0 1 29 11v12.5a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 3 23.5z" fill="currentColor" />
    <path d="M9 21.5h7" stroke="var(--f-bg)" strokeOpacity="0.55" strokeWidth={1.5} strokeLinecap="round" />
  </svg>
);

export const StarIcon = ({ size = 24, className, filled = false }: Props & { filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1} strokeLinejoin="round" aria-hidden className={className}>
    <path d="M12 4.6l2.2 4.6 5 .66-3.64 3.48.9 4.96L12 15.94 7.54 18.3l.9-4.96L4.8 9.86l5-.66z" />
  </svg>
);

export const ArrowLeftIcon = stroke(24, <path d="M13.5 8.5L10 12l3.5 3.5" />);
export const ArrowRightIcon = stroke(24, <path d="M10.5 8.5L14 12l-3.5 3.5" />);

export const ExternalIcon = stroke(24, <><path d="M11 7.5H8a1 1 0 0 0-1 1V16a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-3" /><path d="M13.5 6.5H17.5V10.5" /><path d="M17.5 6.5l-6 6" /></>);

export const SunMoonIcon = stroke(24, <><circle cx="12" cy="12" r="5.5" /><path d="M12 6.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" /></>);

export const CloseIcon = stroke(16, <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />);

export const PlusIcon = stroke(24, <path d="M12 7v10M7 12h10" />);

export const ChevronDownIcon = stroke(16, <path d="M5.5 7l2.5 2.5L10.5 7" />);

export const PlayIcon = ({ size = 16, className }: Props) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" aria-hidden className={className}>
    <path d="M5.5 4.2v7.6a.3.3 0 0 0 .45.26l6.2-3.8a.3.3 0 0 0 0-.52l-6.2-3.8a.3.3 0 0 0-.45.26z" />
  </svg>
);

/** A file's kind, as Figma marks it on a card and a tab: a coloured square with the kind's glyph. A project is a design file (blue). */
export function FileKind({ kind, size = 20 }: { kind: "design" | "preview" | "library"; size?: number }) {
  const fill = kind === "design" ? "#0c8ce9" : kind === "preview" ? "#9747ff" : "#14ae5c";
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden className="shrink-0">
      <rect width="20" height="20" rx="4" fill={fill} />
      {kind === "design" && (
        // A pen nib.
        <g fill="none" stroke="#fff" strokeWidth={1.1} strokeLinejoin="round" strokeLinecap="round">
          <path d="M10 4.6l3.6 5.2-1.5 4.6H7.9L6.4 9.8z" />
          <path d="M10 4.6v4.2" />
          <circle cx="10" cy="9.6" r="0.9" fill="#fff" stroke="none" />
          <path d="M8 15.4h4" />
        </g>
      )}
      {kind === "preview" && <path d="M8 6.2v7.6l6-3.8z" fill="#fff" />}
      {kind === "library" && <path d="M6.5 5.5h4a1.5 1.5 0 0 1 1.5 1.5v7.5a1.2 1.2 0 0 0-1.2-1.2H6.5zM13.5 5.5h-1.5" fill="none" stroke="#fff" strokeWidth={1.1} strokeLinejoin="round" />}
    </svg>
  );
}

/** The app's mark: the sign-in screen's, the about's. */
export function AppMark({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <defs>
        <linearGradient id="app-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0c8ce9" />
          <stop offset="1" stopColor="#9747ff" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#app-mark)" />
      <g fill="none" stroke="#fff" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round">
        <path d="M24 11l8.6 12.4-3.6 11H19l-3.6-11z" />
        <path d="M24 11v10" />
        <path d="M19 38h10" />
      </g>
      <circle cx="24" cy="23.2" r="2.2" fill="#fff" />
    </svg>
  );
}
