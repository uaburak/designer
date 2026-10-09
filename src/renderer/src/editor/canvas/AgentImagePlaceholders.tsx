/**
 * Where an agent's image will land, over the canvas while it is being made (agents/imagePlaceholder.ts): a soft
 * gradient with a light sweeping across — Figma AI's placeholder look — that follows pan and zoom and fades out when
 * the turn ends without placing it. Canvas chrome like the rulers and the image placer: never a layer of the
 * document, never in undo or the file. Positioned straight from the camera (no React render per camera change).
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
      const page = ed.store.page;
      for (const node of Array.from(el.children) as HTMLElement[]) {
        const p = items.find((x) => x.id === node.dataset.placeholder);
        if (!p) continue;
        const { x, y, width, height } = p.target.world;
        node.hidden = p.target.page !== page;
        node.style.transform = `translate(${x * c.zoom + c.x}px, ${y * c.zoom + c.y}px)`;
        node.style.width = `${width * c.zoom}px`;
        node.style.height = `${height * c.zoom}px`;
        node.toggleAttribute("data-small", Math.min(width, height) * c.zoom < CAPTION_MIN);
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
        <div key={p.id} className={styles.placeholder} data-placeholder={p.id} data-agent-image-placeholder={p.state}>
          <span className={styles.caption}>Making an image…</span>
        </div>
      ))}
    </div>
  );
}
