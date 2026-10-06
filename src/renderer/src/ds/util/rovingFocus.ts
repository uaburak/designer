/** The next enabled index from `from` in `dir`, wrapping; -1 when none is enabled. */
export function nextEnabled(count: number, enabled: (i: number) => boolean, from: number, dir: 1 | -1): number {
  const usable = Array.from({ length: count }, (_, i) => i).filter(enabled);
  if (!usable.length) return -1;
  const at = usable.indexOf(from);
  return usable[at < 0 ? (dir === 1 ? 0 : usable.length - 1) : (at + dir + usable.length) % usable.length];
}

/** Where a key moves roving focus in a row/column of items (null: not a move key). */
export function rovingTarget(key: string, count: number, enabled: (i: number) => boolean, from: number, orientation: "horizontal" | "vertical" | "both" = "both"): number | null {
  const fwd = orientation === "horizontal" ? ["ArrowRight"] : orientation === "vertical" ? ["ArrowDown"] : ["ArrowRight", "ArrowDown"];
  const back = orientation === "horizontal" ? ["ArrowLeft"] : orientation === "vertical" ? ["ArrowUp"] : ["ArrowLeft", "ArrowUp"];
  if (fwd.includes(key)) return nextEnabled(count, enabled, from, 1);
  if (back.includes(key)) return nextEnabled(count, enabled, from, -1);
  if (key === "Home") return nextEnabled(count, enabled, -1, 1);
  if (key === "End") return nextEnabled(count, enabled, -1, -1);
  return null;
}
