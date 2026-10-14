// Pictures inside the designs on the collages' canvases: flat drawings (the files' content, not the site's look), so
// the pages need no image files. Orbit, Bloom and Verda are fictional.

/** Orbit's sky: a sun behind two clouds. */
export function Sky() {
  return (
    <svg viewBox="0 0 186 190" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="186" height="190" fill="#CFE6FF" />
      <circle cx="112" cy="78" r="38" fill="#FFD66B" />
      <rect x="34" y="96" width="120" height="40" rx="20" fill="#fff" />
      <circle cx="78" cy="96" r="24" fill="#fff" />
      <circle cx="110" cy="102" r="18" fill="#fff" />
      <rect x="96" y="146" width="74" height="22" rx="11" fill="#fff" opacity="0.8" />
      <path d="M0 176c30-10 60-10 93 0s63 10 93 0v14H0Z" fill="#9CC9F5" />
    </svg>
  );
}

/** A plant shop's hero: a pot and leaves. */
export function Plant({ ground = "#DCEFD9", bare }: { ground?: string; /** The plant alone (its background removed) */ bare?: boolean }) {
  return (
    <svg viewBox="0 0 200 200" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {!bare && <rect width="200" height="200" fill={ground} />}
      {!bare && <circle cx="150" cy="44" r="22" fill="#FFF6D6" />}
      <path d="M100 128C70 120 54 92 60 64c26 8 40 34 40 64Z" fill="#2F7D4F" />
      <path d="M100 128c30-8 46-36 40-64-26 8-40 34-40 64Z" fill="#3F9A63" />
      <path d="M100 130c-4-30 4-58 0-84 12 22 14 56 0 84Z" fill="#2A6B44" />
      <path d="M70 128h60l-8 48H78l-8-48Z" fill="#C8693F" />
      <rect x="66" y="122" width="68" height="12" rx="3" fill="#B35A33" />
    </svg>
  );
}

/** A bottle on a soft field (Studio's product picture). */
export function Bottle({ ground = "#E6EFE0", label = "Root Tonic" }: { ground?: string; label?: string }) {
  return (
    <svg viewBox="0 0 200 250" width="100%" height="100%" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <rect width="200" height="250" fill={ground} />
      <g transform="translate(25 72) scale(0.75)">
        <ellipse cx="100" cy="214" rx="64" ry="10" fill="#000" opacity="0.08" />
        <rect x="82" y="40" width="36" height="26" rx="6" fill="#1F3F2F" />
        <rect x="62" y="64" width="76" height="150" rx="18" fill="#2F5D45" />
        <rect x="68" y="118" width="64" height="40" rx="4" fill="#F4EFE2" />
        <text x="100" y="143" textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="11" fontWeight="700" fill="#2F5D45">
          {label}
        </text>
      </g>
    </svg>
  );
}
