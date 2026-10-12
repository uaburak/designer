/**
 * One Draw Layers row's preview (docs/draw.md §5.9): the layer drawn by the engine (layerThumbs.ts), fitted into the
 * row's 32 box; the layer type's glyph until the drawing arrives or when there is nothing to draw.
 */
import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { Icon, type IconName } from "@/ds";
import type { Guid } from "@/engine/codec";
import type { LayerThumbnails } from "./layerThumbs";
import styles from "./DrawPanels.module.css";

export function LayerThumb({ thumbs, node, icon }: { thumbs: LayerThumbnails; node: Guid; icon: IconName }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => thumbs.subscribe(node, redraw), [thumbs, node]);
  const pixels = thumbs.get(node);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !pixels) return;
    c.width = pixels.width;
    c.height = pixels.height;
    // The preview is 2× the box: shown at half its pixel size.
    c.style.width = `${pixels.width / 2}px`;
    c.style.height = `${pixels.height / 2}px`;
    try {
      c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(pixels.pixels), pixels.width, pixels.height), 0, 0);
    } catch {
      // (no 2D canvas: tests)
    }
  }, [pixels]);
  if (!pixels) return <Icon name={icon} size={16} />;
  return <canvas ref={canvas} className={styles.thumbCanvas} data-layer-thumb-drawn="" />;
}
