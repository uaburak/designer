/**
 * A chunk's layer on two sides of a preview, as Compare changes draws designs (devmode/CompareChanges.tsx): each side
 * opened read-only through `branches.openSide`, loaded into an engine of its own on a hidden canvas, the chunk's
 * display node exported as a PNG. "Side by side" (the default) or "Overlay" with the right side's opacity; Zoom out,
 * Zoom in and Fit (R21 [merge] / [review]).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, IconButton, SegmentedControl, Spinner } from "@/ds";
import { Engine } from "@/engine/Engine";
import { t, useT } from "@/i18n";
import type { Message } from "@/engine/codec";
import { mergedDocument } from "@/store/documentSource";
import type { DiffChunk } from "../../../../shared/merge/types";
import { useEditor } from "../controller";
import { renderEngineExport } from "../exportCore";
import type { BranchesRepository } from "../../../../shared/merge/branches";
import styles from "./Branching.module.css";

export type PreviewSide = "base" | "main" | "branch" | "merged";
export interface SideSpec {
  side: PreviewSide;
  caption: string;
}

/**
 * The engines a preview's sides were loaded into, one per side, until the window closes. `destroy` frees them; the
 * next `engine` call starts afresh — React's StrictMode runs a window's cleanup and effects twice on mount, and the
 * window kept a destroyed SideDocs whose every side failed ("Preview unavailable"). Use it through `useSideDocs`.
 */
export class SideDocs {
  private readonly engines = new Map<string, Promise<Engine>>();
  private readonly canvases = new Set<HTMLCanvasElement>();
  /** Bumped by `destroy`: an engine still loading for an earlier generation is dropped when it's ready */
  private generation = 0;
  constructor(
    private readonly branches: BranchesRepository,
    private readonly images: ((hash: string) => Promise<Uint8Array | null>) | null
  ) {}

  engine(previewId: string, side: PreviewSide): Promise<Engine> {
    const key = `${previewId}|${side}`;
    let e = this.engines.get(key);
    if (!e) {
      const gen = this.generation;
      e = (async () => {
        const opened = await this.branches.openSide(previewId, side);
        if (gen !== this.generation) throw new Error("closed");
        const canvas = document.createElement("canvas");
        canvas.className = styles.hiddenCanvas;
        canvas.setAttribute("aria-hidden", "true");
        document.body.appendChild(canvas);
        this.canvases.add(canvas);
        const engine = await Engine.create(canvas, { sessionID: 1, theme: "DARK" });
        if (gen !== this.generation) {
          engine.destroy();
          canvas.remove();
          this.canvases.delete(canvas);
          throw new Error("closed");
        }
        if (this.images) engine.setImageSource(this.images);
        engine.load(mergedDocument(opened) as Message);
        engine.setViewerMode(true);
        return engine;
      })();
      this.engines.set(key, e);
      e.catch(() => this.engines.get(key) === e && this.engines.delete(key));
    }
    return e;
  }

  destroy(): void {
    this.generation++;
    for (const e of this.engines.values()) void e.then((x) => x.destroy(), () => {});
    this.engines.clear();
    for (const c of this.canvases) c.remove();
    this.canvases.clear();
  }
}

/** A window's SideDocs, freed when it closes */
export function useSideDocs(branches: BranchesRepository, images: ((hash: string) => Promise<Uint8Array | null>) | null): SideDocs {
  const docs = useMemo(() => new SideDocs(branches, images), [branches]); // eslint-disable-line react-hooks/exhaustive-deps -- one per window
  useEffect(() => () => docs.destroy(), [docs]);
  return docs;
}

/** A design's PNG from an engine (null: not on this side, or nothing to draw), scaled to fit 1200 px. */
async function snapshot(engine: Engine, images: ((h: string) => Promise<Uint8Array | null>) | null, ref: string): Promise<string | null> {
  const n = engine.readNode(ref, { fields: ["size"] }) as { size?: { x: number; y: number } } | null;
  if (!n?.size) return null;
  const scale = Math.min(2, 1200 / Math.max(1, n.size.x, n.size.y));
  const out = await renderEngineExport(engine, images, [ref], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: scale } } as never);
  if (!("bytes" in out)) return null;
  return URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: "image/png" }));
}

type Shot = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; url: string | null };

function useShot(docs: SideDocs, previewId: string, side: PreviewSide, ref: string): Shot {
  const ed = useEditor();
  const key = `${previewId}|${side}|${ref}`;
  const [held, setShot] = useState<{ key: string; shot: Shot } | null>(null);
  useEffect(() => {
    let off = false;
    let url: string | null = null;
    const images = ed.source.images ? (h: string) => ed.source.images!.get(h) : null;
    docs
      .engine(previewId, side)
      .then((engine) => snapshot(engine, images, ref))
      .then(
        (u) => {
          url = u;
          if (!off) setShot({ key, shot: { state: "ready", url: u } });
        },
        (e) => !off && setShot({ key, shot: { state: "error", message: e instanceof Error ? e.message : String(e) } })
      );
    return () => {
      off = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [docs, previewId, side, ref, ed, key]);
  return held?.key === key ? held.shot : { state: "loading" };
}

export function ChunkCompare({ docs, previewId, chunk, sides, modes = true }: { docs: SideDocs; previewId: string; chunk: DiffChunk; sides: SideSpec[]; modes?: boolean }) {
  useT();
  const [view, setView] = useState<"side" | "overlay">("side");
  const [opacity, setOpacity] = useState(50);
  const [zoom, setZoom] = useState(1);
  const left = useShot(docs, previewId, sides[0].side, chunk.displayNode);
  const right = useShot(docs, previewId, sides[sides.length - 1].side, chunk.displayNode);
  const shots = sides.length === 1 ? [left] : [left, right];
  const stage = useRef<HTMLDivElement>(null);
  const figure = (shot: Shot, spec: SideSpec) => (
    <figure key={spec.side} className={styles.figure} data-side={spec.side}>
      <figcaption>{spec.caption}</figcaption>
      <div className={styles.figureBody}>
        {shot.state === "loading" ? (
          <Spinner size={16} />
        ) : shot.state === "error" ? (
          <span className={styles.hint}>{t("Preview unavailable")}</span>
        ) : shot.url ? (
          <img src={shot.url} alt={spec.caption} style={{ transform: `scale(${zoom})` }} />
        ) : (
          <span className={styles.hint}>{t("Not in this version")}</span>
        )}
      </div>
    </figure>
  );
  return (
    <div className={styles.compareArea} data-chunk-compare={chunk.index}>
      <div className={styles.compareBar}>
        {modes && sides.length > 1 && (
          <SegmentedControl
            label={t("View")}
            value={view}
            options={[
              { value: "side", label: t("Side by side") },
              { value: "overlay", label: t("Overlay") },
            ]}
            onChange={(v) => setView(v as "side" | "overlay")}
          />
        )}
        {view === "overlay" && sides.length > 1 && <input type="range" min={0} max={100} value={opacity} aria-label={t("Opacity")} className={styles.slider} onChange={(e) => setOpacity(Number(e.target.value))} />}
        <span className={styles.grow} />
        <IconButton icon="24.minus.small" label={t("Zoom out")} onClick={() => setZoom((z) => Math.max(0.25, z / 1.5))} />
        <button type="button" className={styles.fit} onClick={() => setZoom(1)}>
          {t("Fit")}
        </button>
        <IconButton icon="24.plus" label={t("Zoom in")} onClick={() => setZoom((z) => Math.min(4, z * 1.5))} />
      </div>
      <div ref={stage} className={view === "side" || sides.length === 1 ? styles.sideBySide : styles.overlay}>
        {view === "side" || sides.length === 1 ? (
          shots.map((s, i) => figure(s, sides[i]))
        ) : left.state === "error" && right.state === "error" ? (
          <EmptyState icon="24.warning" title={t("Preview unavailable")} body={left.message} />
        ) : (
          <>
            {left.state === "ready" && left.url && <img src={left.url} alt={sides[0].caption} style={{ transform: `scale(${zoom})` }} />}
            {right.state === "ready" && right.url && <img src={right.url} alt={sides[1].caption} style={{ opacity: opacity / 100, transform: `scale(${zoom})` }} />}
          </>
        )}
      </div>
    </div>
  );
}
