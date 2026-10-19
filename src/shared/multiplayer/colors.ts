/**
 * Multiplayer colours (docs/multiplayer.md §6, §18.5; atlas 19 §4.1): each person in a file gets one of Figma's seven
 * — the room gives each session the colour fewest of the others have (`leastUsedColor`; Figma's server fills
 * `UserChange.color`) — for their cursor, name chip, selection outlines and avatar ring. Each has Figma's hover and
 * secondary shades (the bell's Stop, Ask to spotlight) per theme, and its text colour: near-black on yellow, else white.
 */

export interface MultiplayerColor {
  name: "grey" | "blue" | "purple" | "pink" | "red" | "yellow" | "green";
  light: { base: string; hover: string; secondary: string };
  dark: { base: string; hover: string; secondary: string };
  /** Text on it (Figma's `--color-textonmultiplayer<name>`) */
  text: string;
}

/** Figma's order (`figma_app.min.js` module 37932; app.css's light and dark blocks) */
export const MULTIPLAYER_COLORS: readonly MultiplayerColor[] = [
  { name: "grey", light: { base: "#667799", hover: "#536383", secondary: "#394360" }, dark: { base: "#667799", hover: "#536383", secondary: "#394360" }, text: "#ffffff" },
  { name: "blue", light: { base: "#007be5", hover: "#0768cf", secondary: "#034ac1" }, dark: { base: "#0a6dc2", hover: "#105cad", secondary: "#184591" }, text: "#ffffff" },
  { name: "purple", light: { base: "#9747ff", hover: "#8638e5", secondary: "#681abb" }, dark: { base: "#8a38f5", hover: "#7a2ed6", secondary: "#50297a" }, text: "#ffffff" },
  { name: "pink", light: { base: "#ff24bd", hover: "#ea10ac", secondary: "#971172" }, dark: { base: "#f316b0", hover: "#d01b9c", secondary: "#68275e" }, text: "#ffffff" },
  { name: "red", light: { base: "#f24822", hover: "#dc3412", secondary: "#9f1f18" }, dark: { base: "#e03e1a", hover: "#c4381c", secondary: "#7c2622" }, text: "#ffffff" },
  { name: "yellow", light: { base: "#ffcd29", hover: "#ffc21a", secondary: "#eba611" }, dark: { base: "#f3c11b", hover: "#f2b50d", secondary: "#c58011" }, text: "rgba(0, 0, 0, 0.9)" },
  { name: "green", light: { base: "#14ae5c", hover: "#009951", secondary: "#036838" }, dark: { base: "#198f51", hover: "#078348", secondary: "#0a4c2d" }, text: "#ffffff" },
];

/**
 * The palette agents on the canvas and the notification avatars draw from (before Phase 6 people used it too: twelve
 * saturated colours, distinct on the light and dark canvas).
 */
export const PEER_COLORS = ["#f24822", "#9747ff", "#0d99ff", "#14ae5c", "#ff7262", "#ffcd29", "#1bc4b5", "#ff24bd", "#667799", "#a259ff", "#fe7a00", "#4d6aff"] as const;

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** A session's colour index when the room gave none (a room from before Phase 6): by its session, in Figma's order */
export function colorIndexOf(sessionID: number, given?: number): number {
  return Number.isInteger(given) && given! >= 0 && given! < MULTIPLAYER_COLORS.length ? given! : mod(sessionID - 1, MULTIPLAYER_COLORS.length);
}

/** A person's colour for the canvas and the chrome, in the theme shown */
export function peerColor(sessionID: number, given?: number, theme: "light" | "dark" = "light"): string {
  return MULTIPLAYER_COLORS[colorIndexOf(sessionID, given)][theme].base;
}

/** The colour a new session gets: the one fewest of `used` (the others' indices) have; ties go to the first in order */
export function leastUsedColor(used: Iterable<number>): number {
  const counts = new Array<number>(MULTIPLAYER_COLORS.length).fill(0);
  for (const i of used) if (i >= 0 && i < counts.length) counts[i]++;
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
  return best;
}

/**
 * An avatar without a photo (Figma, `3187.min.js`): the user id's last four characters as an integer, mod 7, into the
 * same seven; an id whose end isn't a number by a 31-multiplier hash of the whole id.
 */
export function avatarColorIndex(userId: string): number {
  const tail = userId.slice(-4);
  if (/^\d+$/.test(tail)) return Number(tail) % MULTIPLAYER_COLORS.length;
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (Math.imul(h, 31) + userId.charCodeAt(i)) | 0;
  return mod(h, MULTIPLAYER_COLORS.length);
}
