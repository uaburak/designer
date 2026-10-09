/**
 * Where an agent's image will land, over the canvas while it is being made (agents/imagePlaceholder.ts): grey with a
 * soft light sweeping across, over the selected layer it will fill (its bounds, rotation and corners) or where the new
 * layer will go; it follows pan and zoom. When the picture lands the reveal plays over it (a last brighter sweep, then
 * the grey dissolves); when the turn ends without one it fades out. Canvas chrome like the rulers and the image
 * placer: never a layer of the document, never in undo or the file. Positioned straight from the camera (no React
 * render per camera change).
 */
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useEditor } from "../controller";
import { agentsOf } from "../agents/service";
import styles from "./AgentImagePlaceholders.module.css";

/** Below this on screen (px) the placeholder drops its caption. */
const CAPTION_MIN = 120;

export function AgentImagePlaceholders() {
  const ed = useEditor();
  const placeholders = agentsOf(ed).placeholders;
  const items = useSyncExternalStore(placeholders.subscribe, placeholders.list);
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = layer.current;
      if (!el) return;
      const c = ed.store.camera;
      const z = c.zoom;
      const page = ed.store.page;
      for (const node of Array.from(el.children) as HTMLElement[]) {
        const p = items.find((x) => x.id === node.dataset.placeholder);
        if (!p) continue;
        const { m, width, height, radius, ellipse } = p.target.shape;
        node.hidden = p.target.page !== page;
        // The layer's own rectangle on screen: its rotation from its transform, its size at the zoom (so the caption
        // and the sweep keep their screen size).
        node.style.transform = `matrix(${m[0]}, ${m[3]}, ${m[1]}, ${m[4]}, ${m[2] * z + c.x}, ${m[5] * z + c.y})`;
        node.style.width = `${width * z}px`;
        node.style.height = `${height * z}px`;
        node.style.borderRadius = ellipse ? "50%" : radius ? radius.map((r) => `${r * z}px`).join(" ") : "";
        node.toggleAttribute("data-small", Math.min(width, height) * z < CAPTION_MIN);
      }
    };
    place();
    const offs = [ed.store.subscribe("camera", place), ed.store.subscribe("page", place)];
    return () => offs.forEach((off) => off());
  }, [ed, items]);
  if (!items.length) return null;
  return (
    <div ref={layer} className={styles.layer} aria-hidden>
      {items.map((p) => (
        <div key={p.id} className={styles.placeholder} data-placeholder={p.id} data-agent-image-placeholder={p.state} data-fills={p.target.nodeId ? "" : undefined}>
          <span className={styles.caption}>Making an image…</span>
        </div>
      ))}
    </div>
  );
}
