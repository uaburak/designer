/**
 * Fill and Stroke (UI3): the paints top first, each a row — swatch (colour,
 * gradient or image) → the DS ColorPicker; the hex for a solid, the type's
 * name ("Linear", "Radial", "Angular", "Diamond", "Image") otherwise; opacity
 * — with its eye and minus; "+" adds one; different paint lists read "Click +
 * to replace mixed fills". Stroke adds position, weight, individual strokes
 * (frames, rectangles) and the stroke settings popover (Stroke.tsx).
 *
 * The picker edits every paint type (model/paints.ts maps it to the schema's
 * Paint 1:1). While it shows a gradient on one layer, the engine's on-canvas
 * gradient handles are on (E5 `startPaintEdit`), the picker's stop and the
 * canvas's stop follow each other. An image paint gets Choose image…,
 * Rotate 90º and the adjustment sliders. A picker drag previews in one open
 * transaction and commits on release.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Banner, ColorInput, ColorPicker, contrastCategoryOf, Icon, IconButton, isMixed, MenuButton, MIXED, NumericInput, PanelSection, selectionCategory, Slider, cx, type ChangeInfo, type ContrastCategory, type PickerPaint } from "@/ds";
import { useColorFormat } from "../../colorFormat";
import { useTextSummary } from "./useTextSummary";
import { openMakeImage } from "../../imageTools/ImageToolbar";
import type { Color, Guid, Paint } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { mixedPaints } from "../../model/mixed";
import { adjustmentValue, fromPicker, gradientRotated90, hashBytes, IMAGE_ADJUSTMENTS, isGradientType, isImageLike, paintGifHash, paintImageHash, paintLabel, paintSwatch, paintVideoHash, progressivePaintFields, rotated90, toPicker, withAdjustment, type FullPaint } from "../../model/paints";
import { formatMediaTime } from "../../model/prototype";
import { sniffVideoMime } from "@/present/presentationVideos";
import { regradient, type PaintUse } from "../../model/selectionColors";
import { pickImageFiles } from "../../canvas/ImagePlacer";
import { gifFrames, gifStill, type GifFrames } from "../../images";
import { startGradientEdit } from "../../vectorEdit";
import { useDocumentVersion, useLocalAssets, useUI } from "../../hooks";
import { pageColors, writeSelectionColor } from "./SelectionColors";
import { ShaderEffects } from "./Effects";
import { ShaderParams } from "./ShaderSettings";
import { SHADER_FILLS, shaderPaint, type ShaderFields } from "../../model/shaders";
import { StrokeRows, firstStrokeFields } from "./Stroke";
import { Grip, moved, useReorder } from "./reorder";
import { useRowSelection } from "../../propertyRows";
import { isFrameNode, typeOf, type PanelNode } from "./shared";
import { styleWeight } from "../../model/text";
import { BoundPaintRow, paintScope } from "./Variables";
import { remoteDefaultValue, useRemoteAssets } from "../libraries/remoteAssets";
import { AppliedStyle, StylesButton, sharedStyle } from "./Styles";
import { VariableList } from "../variables/VariablePicker";
import { paintVariable, resolveVariable, scopeAllows } from "../../model/variables";
import { applyStyle, bindPaint, createCollection, createVariable, resolveAt } from "../../variables";
import { CreateStylePopover } from "../variables/EditStyle";
import { MotionField } from "../../motion/panels/MotionField";
import { t, useT } from "@/i18n";
import styles from "./Design.module.css";

type PaintField = "fillPaints" | "strokePaints";

/** What the open picker edits. */
export type PickerTarget =
  | { kind: "paint"; field: PaintField; index: number; anchor: DOMRect; /** "Apply styles and variables" opens it on Libraries (live) */ tab?: "libraries" }
  | { kind: "page"; page: Guid; anchor: DOMRect }
  /** A Selection colors row: every paint that used the colour (or gradient) when the picker opened */
  | { kind: "colors"; uses: PaintUse[]; anchor: DOMRect };

function writePaints(ed: EditorController, refs: readonly Guid[], field: PaintField, paints: Paint[], label: string, info: ChangeInfo) {
  ed.edit(label, info, () => {
    ed.engine.setProps(refs, { [field]: paints });
  });
}

/** Figma's first paint: white in a frame's fill, #D9D9D9 in a shape's, black for a stroke; then 20% black. */
export function newPaint(field: PaintField, nodes: readonly { type?: string; resizeToFit?: boolean }[], existing: number): Paint {
  if (existing > 0) return { type: "SOLID", color: hexToColor("#000000"), opacity: 0.2, visible: true };
  if (field === "strokePaints") return { type: "SOLID", color: hexToColor("#000000"), opacity: 1, visible: true };
  return { type: "SOLID", color: hexToColor(nodes.every((n) => isFrameNode(n as PanelNode)) ? "#ffffff" : "#d9d9d9"), opacity: 1, visible: true };
}

/** The picker's remembered swatch set (Figma's localStorage key). */
const SWATCH_SET_KEY = "library-color-swatch-selected-swatch-set-id";

/**
 * A swatch set's colours (atlas 07 §5.6): the COLOR variables in their order (`valueOf`: each one's colour), then the
 * fill styles (each style's top visible solid paint), as hex or rgba(); each colour once.
 */
export function swatchColors(variables: readonly { id: string; type: string }[], styles: readonly { kind: string; node: unknown }[], valueOf: (id: string) => unknown): string[] {
  const css = (c: Color, opacity = 1) => {
    const a = (c.a ?? 1) * opacity;
    return a >= 1 ? colorToHex(c) : `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${Math.round(a * 100) / 100})`;
  };
  const colors = new Set<string>();
  for (const v of variables) {
    if (v.type !== "COLOR") continue;
    const value = valueOf(v.id);
    if (value && typeof value === "object" && "r" in value) colors.add(css(value as Color));
  }
  for (const s of styles) {
    if (s.kind !== "FILL") continue;
    const top = [...((s.node as { fillPaints?: Paint[] }).fillPaints ?? [])].reverse().find((p) => p.visible !== false && p.type === "SOLID" && p.color);
    if (top?.color) colors.add(css(top.color, top.opacity ?? 1));
  }
  return [...colors];
}

/**
 * The picker's swatch sets after "On this page" (atlas 07 §5.6): "Local assets" — the file's colour variables in their
 * order, then its fill styles — when it has any; then, past a line, each enabled library by name with its published
 * colour variables (their default mode's value) and fill styles (a swatch applies the colour, unbound, as Figma's);
 * the set picked last is remembered.
 */
function useSwatchSets(): { sets: { id: string; label: string; colors: string[]; separated?: boolean }[]; set: string; onSet: (id: string) => void } {
  useT();
  const assets = useLocalAssets();
  const remote = useRemoteAssets();
  const sets = useMemo(() => {
    const local = swatchColors(assets.variables, assets.styles, (id) => resolveVariable(id, assets.lookup));
    const out: { id: string; label: string; colors: string[]; separated?: boolean }[] = local.length ? [{ id: "local", label: t("Local assets"), colors: local }] : [];
    const libraries = [...remote].sort((a, b) => a.name.localeCompare(b.name));
    for (const lib of libraries) {
      const colors = swatchColors(lib.variables, lib.styles, (id) => {
        const v = lib.variables.find((x) => x.id === id);
        return !v ? null : v.remote.imported ? resolveVariable(id, assets.lookup) : remoteDefaultValue(v, lib.collections);
      });
      if (colors.length) out.push({ id: `library:${lib.library}`, label: lib.name, colors, separated: !out.some((s) => s.separated) });
    }
    return out;
  }, [assets, remote]);
  const [set, setSet] = useState(() => {
    try {
      return localStorage.getItem(SWATCH_SET_KEY) ?? "page";
    } catch {
      return "page";
    }
  });
  return {
    sets,
    set,
    onSet: (id) => {
      setSet(id);
      try {
        localStorage.setItem(SWATCH_SET_KEY, id);
      } catch {
        // no storage: this session only
      }
    },
  };
}

/** Re-renders when image URLs arrive (swatches, the picker's preview). */
function useImageUrls(ed: EditorController): void {
  useSyncExternalStore(ed.images.subscribe, ed.images.getVersion);
}

/** One paint row: swatch + hex (or the type's name) + opacity (Figma's names: "Solid color hex: D9D9D9", "Color"). */
export function PaintRow({ paint, label, onColor, onOpacity, onPick, className }: { paint: FullPaint; label: string; onColor: (hex: string, info: ChangeInfo, opacity?: number) => void; onOpacity: (o: number, info: ChangeInfo) => void; onPick: (anchor: DOMRect) => void; className?: string }) {
  useT();
  const ed = useEditor();
  useImageUrls(ed);
  const solid = paint.type === "SOLID";
  const url = ed.images.urlOf(paintImageHash(paint));
  const hex = solid ? colorToHex(paint.color ?? { r: 0, g: 0, b: 0 }) : "";
  return (
    <ColorInput
      className={className}
      label={t(label)}
      swatchLabel={solid ? t("Solid color hex: {hex}", { hex: hex.slice(1).toUpperCase() }) : t(paintLabel(paint))}
      color={solid ? hex : paintSwatch(paint, url)}
      valueLabel={solid ? undefined : t(paintLabel(paint))}
      opacity={toPercent(paint.opacity ?? 1)}
      onColor={onColor}
      onOpacity={onOpacity}
      onSwatchClick={onPick}
    />
  );
}

export function PaintsSection({ title, field, nodes, onPick, className }: { title: "Fill" | "Stroke"; field: PaintField; nodes: PanelNode[]; onPick: (t: PickerTarget) => void; /** Draw: larger previews (docs/draw.md §5.3) */ className?: string }) {
  useT();
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const refs = nodes.map((n) => n.guid);
  // A text's fills are its runs' (the edited selection's while editing): Mixed where they differ (Figma).
  const texts = useMemo(() => (field === "fillPaints" && nodes.length && nodes.every((n) => n.type === "TEXT") ? nodes : []), [field, nodes]);
  const runs = useTextSummary(texts);
  const fromNodes = mixedPaints(nodes.map((n) => n[field] ?? []));
  const shared = runs && runs.values.fillPaints !== undefined ? (runs.mixed.has("fillPaints") ? MIXED : (runs.values.fillPaints as Paint[])) : fromNodes;
  const paints = (shared === undefined || isMixed(shared) ? [] : [...shared]) as FullPaint[];
  const word = title === "Fill" ? "fill" : "stroke";
  const label = title === "Fill" ? "Fill" : "Stroke";
  const add = () => {
    const next = isMixed(shared) ? [newPaint(field, nodes, 0)] : [...paints, newPaint(field, nodes, paints.length)];
    if (field !== "strokePaints" || paints.length) return void ed.setProps(refs, { [field]: next }, `Add ${word}`);
    // The first stroke: weight 1 and, on closed shapes, Inside (live: Add stroke on a rectangle shows "Inside").
    ed.batch(`Add ${word}`, () => nodes.forEach((n) => ed.engine.setProps([n.guid], { [field]: next, ...firstStrokeFields(n, nodes[0]?.strokeWeight || 1) })));
  };
  const empty = !isMixed(shared) && paints.length === 0;
  const stroked = field === "strokePaints" && (isMixed(shared) || paints.length > 0);
  const slot = field === "fillPaints" ? "fill" : "stroke";
  const styled = sharedStyle(nodes, slot);
  const hasStyle = !!styled && styled !== "mixed";
  // Rows show the top paint first: display index d is paint n − 1 − d.
  const n = paints.length;
  const { container: reorderRef, grip, dragging, line: dropLine } = useReorder((from, to) => ed.setProps(refs, { [field]: moved(paints, n - 1 - from, n - 1 - to) }, `Reorder ${word}s`));
  // A click on a row's empty part selects it (⇧ a range): ⌘C / ⌘V / Delete act on the selected rows (propertyRows.ts).
  const rows = useRowSelection(field === "fillPaints" ? "fill" : "stroke", n);
  return (
    <PanelSection
      title={t(title)}
      empty={empty}
      className={className}
      actions={
        <>
          <StylesButton
            nodes={nodes}
            slot={slot}
            mixed={isMixed(shared) && !styled}
            // Live (popovers/fill-styles-variables.txt): the colour picker on its Libraries tab, for the top paint.
            onOpenPicker={paints.length && !hasStyle ? (anchor) => onPick({ kind: "paint", field, index: paints.length - 1, anchor, tab: "libraries" }) : undefined}
          />
          {/* Figma's live panel: "Add stroke fill" once a stroke exists, "Add stroke" / "Add fill" otherwise */}
          {!hasStyle && <IconButton icon="24.plus.small" label={field === "strokePaints" && !empty ? t("Add stroke fill") : field === "strokePaints" ? t("Add stroke") : t("Add fill")} tone="secondary" onClick={add} />}
        </>
      }
    >
      {hasStyle && <AppliedStyle nodes={nodes} slot={slot} />}
      {!hasStyle && isMixed(shared) && <div className={styles.note}>{t("Click + to replace mixed content")}</div>}
      {!hasStyle && n > 0 && (
        <div ref={reorderRef} className={styles.reorderList}>
          {paints
            .map((p, i) => ({ p, i }))
            .reverse()
            .map(({ p, i }, d) => (
              <div key={i} className={cx(styles.paintRow, dragging === d && styles.rowDragging, rows.isSelected(i) && styles.rowSelected)} data-paint-row={p.type} data-reorder-row="" {...rows.rowProps(d)}>
                {n > 1 && <Grip {...grip(d)} />}
                {paintVariable(p) ? (
                  <BoundPaintRow nodes={nodes} field={field} index={i} paint={p} className={cx(styles.paintField, p.visible === false && styles.paintHidden)} />
                ) : (
                  // Motion mode: a solid paint's row joined with its colour's keyframe diamond (Figma's Fill row, docs/motion.md §6.5)
                  <MotionField field={{ type: "INDEXED_ITEM", collection: field === "fillPaints" ? "fills" : "strokes", index: i }} disabled={p.type !== "SOLID"} className={styles.paintField}>
                    <PaintRow
                      className={cx(styles.paintField, p.visible === false && styles.paintHidden)}
                      paint={p}
                      label="Color"
                      onColor={(hex, info, o) => writePaints(ed, refs, field, paints.map((q, j) => (j === i ? { ...q, color: hexToColor(hex, 1), ...(o !== undefined ? { opacity: o / 100 } : {}) } : q)), `${label} colour`, info)}
                      onOpacity={(o, info) => writePaints(ed, refs, field, paints.map((q, j) => (j === i ? { ...q, opacity: o / 100 } : q)), `${label} opacity`, info)}
                      onPick={(anchor) => onPick({ kind: "paint", field, index: i, anchor })}
                    />
                  </MotionField>
                )}
                <IconButton
                  icon={p.visible === false ? "24.hidden.small" : "24.eye.small"}
                  label={t("Toggle visibility")}
                  data-paint-visibility={p.visible === false ? "hidden" : "visible"}
                  tone="secondary"
                  onClick={() => ed.setProps(refs, { [field]: paints.map((q, j) => (j === i ? { ...q, visible: q.visible === false } : q)) }, p.visible === false ? `Show ${word}` : `Hide ${word}`)}
                />
                <IconButton icon="24.minus.small" label={t("Remove")} tone="secondary" onClick={() => ed.setProps(refs, { [field]: paints.filter((_, j) => j !== i) }, `Remove ${word}`)} />
              </div>
            ))}
          {dropLine !== null && <div className={styles.dropLine} style={{ top: dropLine }} />}
        </div>
      )}
      {stroked && <StrokeRows nodes={nodes} labels={labels} />}
    </PanelSection>
  );
}

/**
 * "Choose image…": a new image into the paint (its scale mode and adjustments kept) — or a video (help: "Use the video
 * importer from the fill color picker"), which makes it a VIDEO paint over the video's poster frame; an animated GIF
 * keeps the GIF beside its first frame. `drop`: the fields the new kind doesn't keep.
 */
async function chooseImageFor(ed: EditorController, apply: (p: Partial<FullPaint>, drop: string[]) => void): Promise<void> {
  const files = await pickImageFiles(false);
  if (!files.length || ed.engine.destroyed) return;
  const [img] = await ed.images.import(files);
  if (!img) return;
  const image = { image: { hash: hashBytes(img.hash), name: img.name }, originalImageWidth: img.width, originalImageHeight: img.height };
  const gif = ["animatedImage", "animationFrame"];
  if (img.video) apply({ ...image, type: "VIDEO", video: { hash: hashBytes(img.video) } } as Partial<FullPaint>, gif);
  else if (img.animated) apply({ ...image, type: "IMAGE", animatedImage: { hash: hashBytes(img.animated) }, animationFrame: 0 } as Partial<FullPaint>, ["video"]);
  else apply({ ...image, type: "IMAGE" }, ["video", ...gif]);
}

/**
 * A video fill's preview in the picker (help: "From the Fill section, you can play and preview your video fill, jump
 * to a specific timestamp, or scrub through the video"): play / pause, a scrubber and the time. Nothing it does is
 * stored.
 */
function VideoPreview({ hash }: { hash: string }) {
  useT();
  const ed = useEditor();
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    let made: string | null = null;
    let live = true;
    void ed.images.bytes(hash).then((bytes) => {
      if (!live || !bytes) return;
      made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniffVideoMime(bytes) || "video/mp4" }));
      setUrl(made);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [ed, hash]);
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  return (
    <div className={styles.videoPreview} data-video-preview>
      {url && (
        <video
          ref={video}
          className={styles.videoPreviewMedia}
          src={url}
          muted
          playsInline
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        />
      )}
      <div className={styles.videoPreviewBar}>
        <IconButton icon={playing ? "24.pause" : "24.play"} label={playing ? t("Pause") : t("Play")} onClick={toggle} disabled={!url} />
        <input
          type="range"
          aria-label={t("Scrub video")}
          className={styles.slider}
          min={0}
          max={duration || 1}
          step={0.01}
          value={time}
          style={{ ["--fill" as string]: `${duration ? (time / duration) * 100 : 0}%` }}
          onChange={(e) => {
            const at = Number(e.currentTarget.value);
            setTime(at);
            if (video.current) video.current.currentTime = at;
          }}
        />
        <span className={styles.videoPreviewTime}>{`${formatMediaTime(Math.floor(time))} / ${formatMediaTime(Math.round(duration))}`}</span>
      </div>
    </div>
  );
}

/** Figma's one-time hint under a GIF's frame picker (its user flag `dismissed_gifs_cover_frame_hint`), kept per machine. */
const GIF_HINT_KEY = "dismissed_gifs_cover_frame_hint";

/**
 * A GIF fill's controls in the picker, in place of the adjustments (atlas 07 §8.5, Figma's GIF frame picker): Play /
 * Stop runs the GIF; the "GIF frame" slider (0 … frames − 1, ⇧ by 10, off while playing) shows a frame and, let go,
 * makes it the cover frame — `onCover` stores its still as the paint's image with `animationFrame`. Then the one-time
 * hint (its English worded from the keys `gifs_in_figma_prototypes` / `choose_which_frame_displayed`). Frames are read
 * with the platform's ImageDecoder; without one the GIF only plays.
 */
function GifPreview({ hash, frame: cover, onCover }: { hash: string; frame: number; onCover: (frame: number, still: Blob) => void }) {
  useT();
  const ed = useEditor();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [frames, setFrames] = useState<GifFrames | null>(null);
  const [frame, setFrame] = useState(cover);
  const [playing, setPlaying] = useState(false);
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(GIF_HINT_KEY) === null;
    } catch {
      return true;
    }
  });
  useEffect(() => {
    let made: string | null = null;
    let read: GifFrames | null = null;
    let live = true;
    void ed.images.bytes(hash).then(async (bytes) => {
      if (!live || !bytes) return;
      made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/gif" }));
      setUrl(made);
      read = await gifFrames(bytes);
      if (live) setFrames(read);
      else read?.close();
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      read?.close();
    };
  }, [ed, hash]);
  // The frame shown while not playing.
  useEffect(() => {
    if (!frames || playing) return;
    let live = true;
    void frames.frame(frame).then((f) => {
      const el = canvas.current;
      if (!f) return;
      if (live && el) {
        el.width = f.bitmap.width;
        el.height = f.bitmap.height;
        el.getContext("2d")?.drawImage(f.bitmap, 0, 0);
      }
      f.bitmap.close();
    });
    return () => {
      live = false;
    };
  }, [frames, frame, playing]);
  const setCover = (k: number) => {
    if (!frames) return;
    void frames.frame(k).then(async (f) => {
      if (!f) return;
      const still = await gifStill(f.bitmap);
      f.bitmap.close();
      onCover(k, still);
    });
  };
  return (
    <div className={styles.videoPreview} data-gif-preview>
      {playing || !frames ? url && <img className={styles.videoPreviewMedia} src={url} alt="" /> : <canvas ref={canvas} className={styles.videoPreviewMedia} />}
      <div className={styles.videoPreviewBar}>
        <IconButton icon={playing ? "24.pause" : "24.play"} label={playing ? t("Stop") : t("Play")} onClick={() => setPlaying(!playing)} disabled={!url} />
        <Slider
          label={t("GIF frame")}
          value={frame}
          min={0}
          max={Math.max(1, (frames?.count ?? 1) - 1)}
          step={1}
          disabled={!frames || playing}
          onChange={(k, info) => {
            setFrame(k);
            if (info.final && k !== cover) setCover(k);
          }}
        />
      </div>
      {hint && (
        <Banner
          onDismiss={() => {
            setHint(false);
            try {
              localStorage.setItem(GIF_HINT_KEY, "1");
            } catch {
              // no storage: this session only
            }
          }}
        >
          <strong>{t("GIFs in prototypes")}</strong> {t("Choose which frame is displayed")}
        </Banner>
      )}
    </div>
  );
}

/** Under the image's scale mode: Rotate 90º and Figma's adjustment sliders (−100…100, 0 in the middle). */
function ImageControls({ paint, onChange }: { paint: FullPaint; onChange: (next: FullPaint, info: ChangeInfo) => void }) {
  return (
    <div className={styles.imageControls}>
      {IMAGE_ADJUSTMENTS.map(({ field, label }) => (
        <AdjustmentSlider key={field} label={label} value={adjustmentValue(paint, field)} onChange={(v, info) => onChange(withAdjustment(paint, field, v), info)} />
      ))}
    </div>
  );
}

/** One adjustment: its name, a slider from −100 to 100 (a drag is one undo step), double-click resets. */
function AdjustmentSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number, info: ChangeInfo) => void }) {
  useT();
  const dragging = useRef(false);
  return (
    <label className={styles.adjustment}>
      <span className={styles.adjustmentLabel}>{t(label)}</span>
      <input
        type="range"
        aria-label={t(label)}
        className={styles.slider}
        min={-100}
        max={100}
        step={1}
        value={value}
        style={{ ["--fill" as string]: `${(value + 100) / 2}%` }}
        onPointerDown={() => (dragging.current = true)}
        onChange={(e) => onChange(Number(e.currentTarget.value), { final: !dragging.current, source: dragging.current ? "drag" : "step" })}
        onPointerUp={(e) => {
          dragging.current = false;
          onChange(Number(e.currentTarget.value), { final: true, source: "drag" });
        }}
        onDoubleClick={() => onChange(0, { final: true, source: "pick" })}
      />
    </label>
  );
}

/**
 * The picker's gradient stop, shared with the engine's on-canvas handles: the handles are on while the picker
 * shows a gradient of one layer; a stop picked on either side selects it on the other.
 */
function useGradientHandles(ed: EditorController, refs: readonly Guid[], field: PaintField | null, index: number, gradient: boolean): [number, (i: number) => void] {
  const [stop, setStop] = useState(0);
  const handles = useRef<ReturnType<typeof startGradientEdit>>(null);
  const ref = refs.length === 1 ? refs[0] : null;
  useEffect(() => {
    if (!gradient || !ref || !field) return;
    const h = startGradientEdit(ed.engine, ref, field, index);
    handles.current = h;
    const off = ed.engine.onAny((e) => {
      const ev = e as unknown as { type: string; active?: boolean; stop?: number };
      if (ev.type === "PAINT_EDIT" && ev.active && typeof ev.stop === "number") setStop(ev.stop);
    });
    return () => {
      off();
      handles.current = null;
      h?.end();
    };
  }, [ed, ref, field, index, gradient]);
  return [
    stop,
    (i: number) => {
      setStop(i);
      handles.current?.setStop(i);
    },
  ];
}

/** The one colour picker of the Design panel, for a paint of the selection, a Selection colors row, or the page. */
export function PaintPicker({ target, nodes, pageColor, canvasColor, onClose }: { target: PickerTarget; nodes: PanelNode[]; pageColor: Color | null; /** The page as drawn (the default one is dark in the dark theme): what the contrast check reads behind a top-level layer */ canvasColor: Color; onClose: () => void }) {
  useT();
  const ed = useEditor();
  const [model, setModel] = useColorFormat();
  useImageUrls(ed);
  // "On this page": read once when the picker opens.
  const documentColors = useMemo(() => pageColors(ed), [ed]);
  const swatches = useSwatchSets();
  const refs = nodes.map((n) => n.guid);
  const field = target.kind === "paint" ? target.field : null;
  const index = target.kind === "paint" ? target.index : 0;
  const shared = field ? mixedPaints(nodes.map((n) => n[field] ?? [])) : undefined;
  const paints = (shared === undefined || isMixed(shared) ? null : [...shared]) as FullPaint[] | null;
  const paint = paints?.[index];
  const [stop, setStop] = useGradientHandles(ed, refs, field, index, !!paint && isGradientType(paint.type));
  const assets = useLocalAssets();
  const [creatingStyle, setCreatingStyle] = useState(false);
  const [shaders, setShaders] = useState<HTMLElement | null>(null);
  const patternSource = paint?.type === "PATTERN" ? guidOf(paint.sourceNodeId) : null;
  const patternPreview = useNodePreview(ed, patternSource);
  const [pickingSource, setPickingSource] = usePatternSourcePick(ed, refs, field, index, paints);

  if (target.kind === "page") {
    const color = pageColor ?? hexToColor("#f5f5f5");
    return (
      <ColorPicker
        value={{ type: "SOLID", color: { ...color, a: 1 }, opacity: color.a ?? 1 }}
        paintTypes={["SOLID"]}
        documentColors={documentColors}
        swatchSets={swatches.sets}
        swatchSet={swatches.set}
        onSwatchSetChange={swatches.onSet}
        anchor={target.anchor}
        colorModel={model}
        onColorModelChange={setModel}
        onChange={(next, info) => ed.edit("Page colour", info, () => void ed.engine.setProps([target.page], { backgroundColor: { ...(next.color ?? color), a: next.opacity ?? 1 } }))}
        onCancel={() => ed.cancelEdit()}
        onClose={onClose}
      />
    );
  }
  if (target.kind === "colors") {
    const first = target.uses[0];
    const node = first ? ed.engine.readNode(first.guid) : null;
    const used = node && first ? (node[first.field]?.[first.index] as FullPaint | undefined) : undefined;
    if (!used) return null;
    const gradient = isGradientType(used.type);
    return (
      <ColorPicker
        value={toPicker(used)}
        paintTypes={gradient ? ["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"] : ["SOLID"]}
        documentColors={documentColors}
        swatchSets={swatches.sets}
        swatchSet={swatches.set}
        onSwatchSetChange={swatches.onSet}
        anchor={target.anchor}
        colorModel={model}
        onColorModelChange={setModel}
        onChange={(next, info) => (gradient ? writeGradientUses(ed, target.uses, next, info) : writeSelectionColor(ed, target.uses, { color: next.color, opacity: next.opacity }, info))}
        onCancel={() => ed.cancelEdit()}
        onClose={onClose}
      />
    );
  }
  if (!paints || !paint || !field) return null;
  const write = (next: FullPaint, info: ChangeInfo, label: string) => writePaints(ed, refs, field, paints.map((q, j) => (j === index ? next : q)), label, info);
  const label = field === "fillPaints" ? "Fill" : "Stroke";
  const slot = field === "fillPaints" ? "fill" : "stroke";
  // The hex field's suggestions: this file's colour variables this paint may take, at their value here
  const scope = paintScope(nodes, field);
  const colorVariables = assets.variables
    .filter((v) => v.type === "COLOR" && scopeAllows(v.scopes, scope))
    .flatMap((v) => {
      const c = resolveAt(ed, v.id, refs[0] ?? null);
      return c && typeof c === "object" && "r" in c ? [{ id: v.id, name: v.name, color: c as Color }] : [];
    });
  // The picker's "+" (Figma's live "New style or variable"): a style from this paint, or a colour variable bound to it.
  const newVariable = () => {
    if (paint.type !== "SOLID" || !paint.color) return;
    const collection = assets.collections[0]?.id ?? createCollection(ed);
    if (!collection) return;
    const id = createVariable(ed, collection, "COLOR", "", { kind: "literal", value: { ...paint.color, a: paint.opacity ?? 1 } });
    if (id) bindPaint(ed, refs, field, index, id);
  };
  const headerActions = (
    <MenuButton
      label={t("New style or variable")}
      className={styles.iconMenu}
      entries={[
        { id: "style", label: t("Create style") },
        { id: "variable", label: t("Create variable"), disabled: paint.type !== "SOLID" },
      ]}
      onSelect={(id) => (id === "style" ? setCreatingStyle(true) : newVariable())}
    >
      <Icon name="24.plus.small" />
    </MenuButton>
  );
  if (creatingStyle) return <CreateStylePopover kind="FILL" slot={slot} from={refs[0] ?? null} applyTo={refs} anchor={target.anchor} onClose={() => { setCreatingStyle(false); onClose(); }} />;
  return (
    <>
    <ColorPicker
      headerActions={headerActions}
      value={toPicker(paint)}
      colorVariables={colorVariables}
      onPickVariable={(id) => bindPaint(ed, refs, field, index, id)}
      initialTab={(target.kind === "paint" && target.tab) || (paintVariable(paint) ? "libraries" : "custom")}
      offsetX={target.kind === "paint" && target.tab === "libraries" ? 0 : -1}
      libraries={
        <VariableList
          types={["COLOR"]}
          scope={paintScope(nodes, field)}
          current={paintVariable(paint)}
          consumer={refs[0] ?? null}
          styleKind="FILL"
          onPick={(v) => bindPaint(ed, refs, field, index, v.id)}
          onPickStyle={(st) => applyStyle(ed, refs, slot, st.id)}
          label={t("Libraries")}
          colorTab
          onDone={onClose}
        />
      }
      documentColors={documentColors}
      swatchSets={swatches.sets}
      swatchSet={swatches.set}
      onSwatchSetChange={swatches.onSet}
      anchor={target.anchor}
      colorModel={model}
      onColorModelChange={setModel}
      stop={stop}
      onStopChange={setStop}
      imageUrl={ed.images.urlOf(paintImageHash(paint))}
      onMakeImage={refs.length === 1 ? () => (onClose(), openMakeImage(ed, refs[0])) : undefined}
      onChooseImage={
        ed.images.store
          ? () =>
              void chooseImageFor(ed, (img, drop) => {
                const next = { ...paint, ...img } as FullPaint;
                for (const key of drop) delete (next as Record<string, unknown>)[key];
                write(next, { final: true, source: "pick" }, img.type === "VIDEO" ? "Choose video" : "Choose image");
              })
          : undefined
      }
      // One pattern per paint list (atlas 07 §3.2): the Pattern tab is off while another paint is one.
      disabledTypes={paints.some((p, j) => j !== index && p.type === "PATTERN") ? ["PATTERN"] : undefined}
      imageAction={
        isImageLike(paint) ? (
          <span className={styles.imageActions}>
            {/* Tile: the "Scaling factor" (Paint.scale, 0.01–100, atlas 07 §8.3) */}
            {paint.imageScaleMode === "TILE" && (
              <NumericInput
                className={styles.tileScale}
                label={t("Scaling factor")}
                value={Math.round((paint.scale ?? 1) * 100)}
                min={1}
                max={10000}
                precision={0}
                unit="%"
                onChange={(v, info) => write({ ...paint, scale: Math.min(100, Math.max(0.01, v / 100)) }, info, "Image scale")}
                onCancel={() => ed.cancelEdit()}
              />
            )}
            <IconButton icon="24.rotate" label={t("Rotate 90º")} onClick={() => write(rotated90(paint), { final: true, source: "pick" }, "Rotate image")} />
          </span>
        ) : undefined
      }
      imageControls={
        // Live (popovers/fill-picker-image / -video): an image's adjustments; a video has none (its preview plays it).
        paint.type === "VIDEO" ? (
          paintVideoHash(paint) ? <VideoPreview hash={paintVideoHash(paint)!} /> : undefined
        ) : paintGifHash(paint) ? (
          <GifPreview
            hash={paintGifHash(paint)!}
            frame={(paint as { animationFrame?: number }).animationFrame ?? 0}
            onCover={(frame, still) =>
              void ed.images.import([Object.assign(still, { name: (paint.image as { name?: string } | undefined)?.name ?? "Image" })]).then(([img]) => {
                if (!img || ed.engine.destroyed) return;
                const name = (paint.image as { name?: string } | undefined)?.name;
                const next = { ...paint, image: { hash: hashBytes(img.hash), ...(name ? { name } : {}) }, animationFrame: frame, ...progressivePaintFields(img) } as FullPaint;
                write(next, { final: true, source: "pick" }, "GIF cover frame");
              })
            }
          />
        ) : isImageLike(paint) ? (
          <ImageControls paint={paint} onChange={(next, info) => write(next, info, "Image adjustments")} />
        ) : undefined
      }
      pattern={
        paint.type === "PATTERN"
          ? {
              source: patternSource ? (ed.engine.readNode(patternSource)?.name ?? null) : null,
              previewUrl: patternPreview,
              selecting: pickingSource,
              onSelectSource: () => setPickingSource((on) => !on),
            }
          : undefined
      }
      onShaders={(picker) => setShaders(picker)}
      shader={
        // A shader fill (round 11): its preset and parameters in place of a type's controls (unverified layout).
        paint.type === "CUSTOM" ? (
          <ShaderParams
            target={paint as FullPaint & ShaderFields}
            onChange={(next, info) => write(next as FullPaint, info, "Shader fill")}
            onCancel={() => ed.cancelEdit()}
            onChoose={(button) => setShaders(button.closest<HTMLElement>('[data-ds="Popover"]') ?? button)}
          />
        ) : undefined
      }
      contrastBackground={paint.type === "SOLID" && nodes.length === 1 ? backgroundBehind(ed, refs[0], canvasColor) : null}
      contrastCategory={contrastCategoryOfNodes(nodes)}
      onRotateGradient={isGradientType(paint.type) ? () => write(gradientRotated90(paint), { final: true, source: "pick" }, "Rotate gradient") : undefined}
      onChange={(next: PickerPaint, info) => {
        let out = fromPicker(paint, next);
        // A new image fill without an image yet: Figma asks for one (the picker's "Choose image…").
        if ((next.type === "IMAGE" || next.type === "VIDEO") && paint.type !== next.type && !out.image) out = { ...out, opacity: 1 };
        write(out, info, `${label} colour`);
      }}
      onCancel={() => ed.cancelEdit()}
      onClose={onClose}
    />
    {shaders && (
      <ShaderEffects
        anchor={shaders}
        placement="left"
        title={t("Shader fills")}
        list={SHADER_FILLS}
        onboarding={false}
        onPick={(preset) => {
          // The paint becomes the preset's shader (its opacity, visibility and blend mode kept).
          write(shaderPaint(paint as FullPaint & ShaderFields, preset) as FullPaint, { final: true, source: "pick" }, "Shader fill");
          setShaders(null);
        }}
        onClose={() => setShaders(null)}
      />
    )}
    </>
  );
}

/** A PATTERN paint's source as "s:l" (the engine writes `{sessionID, localID}`; a string is taken too). */
export function guidOf(v: unknown): Guid | null {
  if (typeof v === "string") return /^\d+:\d+$/.test(v) ? v : null;
  if (v && typeof v === "object" && "sessionID" in v && "localID" in v) return `${(v as { sessionID: number }).sessionID}:${(v as { localID: number }).localID}`;
  return null;
}

/** A layer's picture (the engine's node render) as a data URL, for the Pattern tab's preview. */
function useNodePreview(ed: EditorController, guid: Guid | null): string | null {
  const version = useDocumentVersion();
  return useMemo(() => {
    void version;
    if (!guid || typeof document === "undefined") return null;
    const render = (ed.engine as unknown as { renderNodeThumbnailPixels?: (o: { node: Guid; maxSize: number }) => { width: number; height: number; pixels: Uint8Array } | null }).renderNodeThumbnailPixels;
    let px: { width: number; height: number; pixels: Uint8Array } | null = null;
    try {
      px = render ? render.call(ed.engine, { node: guid, maxSize: 412 }) : null;
    } catch {
      px = null;
    }
    if (!px || !px.width || !px.height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = px.width;
    canvas.height = px.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
    return canvas.toDataURL("image/png");
  }, [ed, guid, version]);
}

/**
 * "Select source…" (the Pattern tab): the next layer clicked on the canvas — its top-level layer, as a click selects —
 * becomes the pattern's source; the selection is left alone (the press never reaches the canvas). Esc or the button
 * again stops picking. Unverified: what Figma's cursor shows meanwhile.
 */
function usePatternSourcePick(ed: EditorController, refs: readonly Guid[], field: PaintField | null, index: number, paints: FullPaint[] | null): [boolean, (f: (on: boolean) => boolean) => void] {
  const [on, setOn] = useState(false);
  const latest = useRef({ refs, field, index, paints });
  useEffect(() => {
    latest.current = { refs, field, index, paints };
  });
  useEffect(() => {
    if (!on) return;
    const canvas = document.getElementById("engine-canvas");
    const down = (e: PointerEvent) => {
      if (!canvas || e.target !== canvas || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const r = canvas.getBoundingClientRect();
      const { refs, field, index, paints } = latest.current;
      const top = topLevelAt(ed, e.clientX - r.left, e.clientY - r.top, refs);
      setOn(false);
      if (!top || !field || !paints?.[index]) return;
      const [session, local] = top.split(":").map(Number);
      const next = paints.map((p, i) => (i === index ? { ...p, sourceNodeId: { sessionID: session, localID: local } } : p));
      writePaints(ed, refs, field, next, "Pattern source", { final: true, source: "pick" });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOn(false);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [ed, on]);
  return [on, setOn];
}

/** The top-level layer (child of the page) under a canvas point, never one of `not` or their ancestors. */
export function topLevelAt(ed: EditorController, x: number, y: number, not: readonly Guid[]): Guid | null {
  for (const id of ed.engine.hitTest(x, y)) {
    let n = ed.store.readNode(id);
    for (let depth = 0; n && depth < 256; depth++) {
      const parent = n.parentIndex?.guid ? ed.store.readNode(n.parentIndex.guid) : null;
      if (!parent || parent.type === "CANVAS") return not.includes(n.guid) ? null : n.guid;
      n = parent;
    }
  }
  return null;
}

/**
 * What's behind a layer for "Check color contrast": the nearest parent's top visible solid fill, else the page's
 * colour (white when it has none).
 */
/**
 * What the contrast check reads the layers as (atlas 07 §5.7, Figma's `J3`): a text by its runs' sizes and weights
 * (the base style and its overrides), anything else a graphic; null when normal text is mixed with other kinds.
 */
export function contrastCategoryOfNodes(nodes: readonly PanelNode[]): ContrastCategory | null {
  type Run = { fontSize?: number; fontName?: { style?: string } };
  const kinds = new Set(
    nodes.map((n) => {
      const base = n as PanelNode & Run & { styleOverrideTable?: Run[] };
      const runs = [base, ...(base.styleOverrideTable ?? [])].map((r) => ({ fontSize: r.fontSize ?? base.fontSize, fontWeight: styleWeight((r.fontName ?? base.fontName)?.style ?? "Regular").weight }));
      return contrastCategoryOf(typeOf(n), runs);
    })
  );
  return selectionCategory(kinds);
}

function backgroundBehind(ed: EditorController, ref: Guid | undefined, canvasColor: Color): Color {
  let id = ref ? ed.engine.readNode(ref)?.parentIndex?.guid : undefined;
  for (let i = 0; id && i < 64; i++) {
    const n = ed.engine.readNode(id);
    if (!n || n.type === "CANVAS" || n.type === "DOCUMENT") break;
    const top = [...(n.fillPaints ?? [])].reverse().find((p) => p.visible !== false && p.type === "SOLID" && (p.opacity ?? 1) > 0);
    if (top?.color) return { ...top.color, a: 1 };
    id = n.parentIndex?.guid;
  }
  return { ...canvasColor, a: 1 };
}

/** A gradient row of Selection colors edited: every use takes the new stops (each keeps its own handles). */
function writeGradientUses(ed: EditorController, uses: readonly PaintUse[], next: PickerPaint, info: ChangeInfo) {
  ed.edit("Selection colors", info, () => {
    const ids = [...new Set(uses.map((u) => u.guid))];
    const fresh = new Map(ed.engine.readNodes(ids).map((n) => [n.guid, n]));
    for (const [guid, f] of regradient(fresh, uses, { type: next.type, stops: next.stops, opacity: next.opacity, blendMode: next.blendMode })) ed.engine.setProps([guid], f);
  });
}
