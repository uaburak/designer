/**
 * The Image tool (⇧⌘K "Image/video…", File ▸ "Place image…") and image drops,
 * as Figma: the file picker (several files), then — with layers selected —
 * the images fill them in order; the rest ride on the pointer and each click
 * places one (a drag sizes it, aspect kept); Esc drops the rest. Files dropped
 * on the canvas are placed at the drop point, in the frame there.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { showToast } from "@/ds";
import type { Paint } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { isMediaFile, VIDEO_ACCEPT, type ImportedImage } from "../images";
import { DEFAULT_VIDEO_PLAYBACK, mediaPaint } from "../model/paints";
import { placeImages } from "../placeImages";
import styles from "./ImagePlacer.module.css";

// "Place image/video" (help: "Use the Place image/video tool to add videos in bulk").
const ACCEPT = `image/png,image/jpeg,image/gif,image/webp,${VIDEO_ACCEPT}`;

/** Opens the system's file picker for images (resolves with what was chosen; nothing when cancelled). */
export function pickImageFiles(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.multiple = multiple;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Layers an image can fill (not groups, sections or the page). */
const fillable = (ed: EditorController) =>
  ed.selectedNodes().filter((n) => !(n.type === "FRAME" && n.resizeToFit) && n.type !== "GROUP" && n.type !== "SECTION" && n.type !== "BOOLEAN_OPERATION");

/** ⇧⌘K: choose images; fill the selected layers with them, then place the rest by clicking. */
export async function chooseAndPlaceImages(ed: EditorController): Promise<void> {
  if (!ed.images.store) return void showToast({ message: "Images can't be added to this file" });
  const files = await pickImageFiles();
  if (!files.length || ed.engine.destroyed) return;
  const images = await ed.images.import(files);
  if (!images.length) return void showToast({ message: "Couldn't read that file" });
  const targets = fillable(ed);
  const fills = Math.min(targets.length, images.length);
  if (fills) {
    ed.batch("Place image", () => {
      for (let i = 0; i < fills; i++) {
        const img = images[i];
        ed.engine.setProps([targets[i].guid], { fillPaints: [mediaPaint(img) as Paint], ...(img.video ? { videoPlayback: { ...DEFAULT_VIDEO_PLAYBACK } } : {}) });
      }
    });
  }
  const rest = images.slice(fills);
  if (rest.length) ed.ui.set({ placingImages: rest });
  ed.focusCanvas();
}

/** Files dropped on the canvas: imported and placed at the drop point. */
export function attachImageDrop(ed: EditorController, area: HTMLElement): () => void {
  const over = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const drop = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter(isMediaFile);
    if (!files.length) return;
    e.preventDefault();
    const r = (ed.canvas ?? area).getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    void ed.images.import(files).then((images) => {
      if (images.length && !ed.engine.destroyed) placeImages(ed, images, at);
      ed.focusCanvas();
    });
  };
  area.addEventListener("dragover", over);
  area.addEventListener("drop", drop);
  return () => {
    area.removeEventListener("dragover", over);
    area.removeEventListener("drop", drop);
  };
}

/** Keeps a component in step with the image URLs as they load. */
function useImageVersion(ed: EditorController): number {
  return useSyncExternalStore(ed.images.subscribe, ed.images.getVersion);
}

/** While images wait to be placed: the overlay that takes the clicks, and the thumbnail at the pointer. */
export function ImagePlacer() {
  const ed = useEditor();
  const [queue, setQueue] = useState<readonly ImportedImage[] | null>(() => ed.ui.get().placingImages);
  useEffect(() => ed.ui.subscribe(() => setQueue(ed.ui.get().placingImages)), [ed]);
  useImageVersion(ed);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!queue?.length) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      ed.ui.set({ placingImages: null });
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [ed, queue]);

  if (!queue?.length) return null;
  const first = queue[0];
  const url = ed.images.urlOf(first.hash);
  const local = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  /** The dragged box with the image's aspect (the larger side follows the pointer). */
  const box = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const aspect = first.width / Math.max(1, first.height);
    let w = Math.abs(b.x - a.x);
    let h = Math.abs(b.y - a.y);
    if (w / Math.max(1, h) > aspect) h = w / aspect;
    else w = h * aspect;
    return { x: b.x < a.x ? a.x - w : a.x, y: b.y < a.y ? a.y - h : a.y, w, h };
  };
  const zoom = ed.engine.getCamera().zoom;

  return (
    <div
      className={styles.overlay}
      data-image-placer=""
      onPointerMove={(e) => {
        const p = local(e);
        setPointer(p);
        if (press.current && Math.hypot(p.x - press.current.x, p.y - press.current.y) >= 3) setDrag(box(press.current, p));
      }}
      onPointerLeave={() => setPointer(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        press.current = local(e);
      }}
      onPointerUp={(e) => {
        const start = press.current;
        press.current = null;
        if (!start) return;
        const dragged = drag;
        setDrag(null);
        const size = dragged && dragged.w >= 2 ? { x: Math.round(dragged.w / zoom), y: Math.round(dragged.h / zoom) } : undefined;
        const at = dragged && dragged.w >= 2 ? { x: dragged.x, y: dragged.y } : local(e);
        placeImages(ed, [first], at, size);
        ed.ui.set({ placingImages: queue.length > 1 ? queue.slice(1) : null });
        if (queue.length <= 1) ed.focusCanvas();
      }}
    >
      {drag && <div className={styles.box} style={{ left: drag.x, top: drag.y, width: drag.w, height: drag.h }} />}
      {pointer && !drag && (
        <div className={styles.thumb} style={{ left: pointer.x + 12, top: pointer.y + 12, backgroundImage: url ? `url("${url}")` : undefined }}>
          {queue.length > 1 && <span className={styles.count}>{queue.length}</span>}
        </div>
      )}
    </div>
  );
}
