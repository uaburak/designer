/**
 * The Animated tab's settings stored on the layer (docs/motion.md §7.1; round 8e): one entry of the layer's
 * `exportSettings` with Figma's Motion fields — `imageType` MP4 / WEBM / GIF / LOTTIE / DOTLOTTIE (SVG with
 * `svgAnimated`), `constraint` the Size (CONTENT_SCALE, or a custom size as CONTENT_WIDTH / CONTENT_HEIGHT), `frameRate`
 * 13, `loopCount` 14 (GIF: 0 loops forever, 1 plays once), `quality` (Low / Medium / High as 0.25 / 0.5 / 1 [ours]).
 * The Static tab's rows are the other entries (model/exports.ts `exportSettingsOf` leaves this one out, and a static
 * edit keeps it: `writeKeepingAnimated`). Saved, copied and undone with the layer, as Figma's are.
 */
import type { Guid } from "@/engine/codec";
import { DEFAULT_ANIMATED_EXPORT, FRAME_RATES, type AnimatedExportSettings, type AnimatedFormat } from "@shared/motion/types";
import type { ExportSettings } from "@shared/schema/document.generated";
import type { EditorController } from "../../controller";
import { isAnimatedSetting } from "../../model/exports";
import { fields } from "../../panels/design/shared";

const QUALITY_VALUE: Record<AnimatedExportSettings["quality"], number> = { LOW: 0.25, MEDIUM: 0.5, HIGH: 1 };

/** The tab's settings as the layer's entry. */
export function entryOf(s: AnimatedExportSettings): ExportSettings {
  const size = "scale" in s.size ? { type: "CONTENT_SCALE" as const, value: s.size.scale } : s.size.width > 0 ? { type: "CONTENT_WIDTH" as const, value: s.size.width } : { type: "CONTENT_HEIGHT" as const, value: s.size.height };
  return {
    imageType: s.format === "SVG" ? "SVG" : s.format,
    ...(s.format === "SVG" ? { svgAnimated: true } : {}),
    constraint: size,
    frameRate: s.fps,
    loopCount: s.loop ? 0 : 1,
    quality: QUALITY_VALUE[s.quality],
  };
}

/** The layer's entry as the tab's settings (what's missing: the defaults). */
export function settingsOf(e: ExportSettings): AnimatedExportSettings {
  const format: AnimatedFormat = e.imageType === "SVG" ? "SVG" : (e.imageType as AnimatedFormat);
  const c = e.constraint;
  const size: AnimatedExportSettings["size"] =
    !c || c.type === "CONTENT_SCALE" ? { scale: c?.value ?? 1 } : c.type === "CONTENT_WIDTH" ? { width: c.value ?? 0, height: 0 } : { width: 0, height: c.value ?? 0 };
  const fps = (FRAME_RATES as readonly number[]).includes(e.frameRate ?? 0) ? (e.frameRate as AnimatedExportSettings["fps"]) : DEFAULT_ANIMATED_EXPORT.fps;
  const q = e.quality ?? 1;
  return { format, size, fps, quality: q <= 0.25 ? "LOW" : q <= 0.5 ? "MEDIUM" : "HIGH", loop: (e.loopCount ?? 0) === 0 };
}

const listOf = (ed: EditorController, ref: Guid): ExportSettings[] => {
  const v = (ed.engine.readNode(ref) as { exportSettings?: unknown } | null)?.exportSettings;
  return Array.isArray(v) ? (v as ExportSettings[]) : [];
};

/** A layer's Animated tab settings (null: none stored, the tab's defaults then). */
export function animatedSettingOf(ed: EditorController, ref: Guid): AnimatedExportSettings | null {
  const e = listOf(ed, ref).find(isAnimatedSetting);
  return e ? settingsOf(e) : null;
}

/** The tab's settings onto each layer: its entry replaced (or added after the static ones), one undo step. */
export function writeAnimatedSetting(ed: EditorController, refs: readonly Guid[], s: AnimatedExportSettings): void {
  if (!refs.length) return;
  const entry = entryOf(s);
  ed.engine.txnBegin("Export settings");
  try {
    for (const ref of refs) ed.setProps([ref], fields({ exportSettings: [...listOf(ed, ref).filter((x) => !isAnimatedSetting(x)), entry] } as never), "Export settings");
  } finally {
    ed.engine.txnCommit();
  }
}

/** The Static tab's write (Export.tsx): its rows on each layer, the layer's animated entry kept after them. */
export function writeKeepingAnimated(ed: EditorController, refs: readonly Guid[], list: ExportSettings[], label: string): void {
  const kept = refs.map((ref) => listOf(ed, ref).filter(isAnimatedSetting));
  if (kept.every((k) => !k.length)) {
    ed.setProps(refs, fields({ exportSettings: list } as never), label);
    return;
  }
  ed.engine.txnBegin(label);
  try {
    refs.forEach((ref, i) => ed.setProps([ref], fields({ exportSettings: [...list, ...kept[i]] } as never), label));
  } finally {
    ed.engine.txnCommit();
  }
}
