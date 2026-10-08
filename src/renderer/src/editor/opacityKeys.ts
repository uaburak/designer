/**
 * Figma's opacity keys (live Figma, docs/research/figma/live/behaviour/keys.md): a digit sets the selection's
 * opacity — "5" 50 %, "0" 100 % — and a second digit typed within about 450–500 ms makes it two digits: "4","5"
 * 45 %, "0","5" 5 %, "1","0" 10 %. Pure: the caller keeps the buffer and writes the opacity.
 */
export interface OpacityBuffer {
  digit: number;
  at: number;
}

/** The window a second digit joins the first in (live: 450 ms joined, 500 ms didn't). */
export const OPACITY_KEY_WINDOW_MS = 475;

export function opacityForDigit(buffer: OpacityBuffer | null, digit: number, now: number): { opacity: number; buffer: OpacityBuffer | null } {
  if (buffer && now - buffer.at < OPACITY_KEY_WINDOW_MS) return { opacity: (buffer.digit * 10 + digit) / 100, buffer: null };
  return { opacity: digit === 0 ? 1 : digit / 10, buffer: { digit, at: now } };
}
