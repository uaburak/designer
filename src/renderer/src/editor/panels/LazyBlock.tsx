/**
 * Long lists of component tiles (Assets, the swap picker) mounted a block at a time: the first blocks at once, the
 * rest as they come near the screen (a page of a few hundred icons rendered every tile in one task). A block not yet
 * mounted holds its place in the scroll with its estimated height; once mounted it stays.
 */
import { useEffect, useRef, useState } from "react";
import { watchVisible } from "../assetThumbs";

/** A block of tiles, mounted when it comes near the screen (or at once, `eager`) and kept. */
export function LazyBlock({ eager, height, children }: { eager: boolean; height: number; children: () => React.ReactNode }) {
  const [shown, setShown] = useState(eager);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (shown || !el) return;
    return watchVisible(el, (visible) => visible && setShown(true));
  }, [shown]);
  return shown ? children() : <div ref={ref} style={{ height }} data-lazy-block="" aria-hidden />;
}

/** `list` in blocks of `per`. */
export function blocksOf<T>(list: readonly T[], per: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per));
  return out;
}
