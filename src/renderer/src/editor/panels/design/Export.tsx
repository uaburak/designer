/**
 * The Design panel's Export section (UI3; help.figma.com 360040028114,
 * 13402894554519; atlas 15 §3–4). "+" adds an export setting — 1x, then 2x
 * "@2x", then 3x "@3x", then 1x again (Figma's defaults) — each row: the
 * scale ("1x", typed or picked: 0.5x … 4x, 512w, 512h, up to 1024x and
 * 32768 px, ↑ / ↓ by 0.5, ⇧ by 1; SVG and PDF are 1x only; an "@2x" the
 * scale gave follows it), the format (PNG, JPG, SVG, PDF), "…" for the
 * setting's details (Suffix, Color profile; Quality, Image resampling;
 * Ignore overlapping layers; Include bounding box and Outline text when the
 * layers hold text, Include "id" attribute, Simplify stroke when a stroke is
 * inside or outside — by format), minus.
 * Under the rows, "Export Frame 1" (one layer) / "Export 3 layers", and the
 * Preview of the first setting (one layer only). With nothing selected the
 * settings are the page's: its canvas exports. Stored as `exportSettings`
 * (schema ExportSettings) on the layer or page.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Icon, IconButton, MenuButton, PanelSection, Popover, Select, Tabs, TextInput, cx } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { canExport, exportItems, renderExport, useExportAllowed, type ExportItem } from "../../exporting";
import { useDocumentVersion } from "../../hooks";
import { mixed, sameData } from "../../model/mixed";
import {
  EXPORT_FORMATS,
  QUALITY_LEVELS,
  SCALE_PRESETS,
  exportSettingsOf,
  formatOf,
  isVectorFormat,
  nextExportSetting,
  nudgeConstraint,
  parseScale,
  qualityFor,
  qualityLevel,
  scaleLabel,
  withConstraint,
  withFormat,
  type QualityLevel,
  type ExportFormat,
  type ExportSettings,
} from "../../model/exports";
import { useKeeps } from "./shared";
import { writeKeepingAnimated } from "../../motion/export/animatedSettings";
import { timelineOf } from "../../motion/export/exportAnimated";
import { ExportAnimatedTab } from "./ExportAnimated";
import { Grip, moved, useReorder } from "./reorder";
import styles from "./Design.module.css";
import own from "./Export.module.css";
import { t, tp, useT } from "@/i18n";

/** A layer (or the page) the section exports. */
/** Live's name for the scale field and its group. */
export const SCALE_LABEL = "Export constraints for content scale or width/height dimensions";

export interface ExportTarget {
  guid: Guid;
  name?: string;
  type?: string;
  exportSettings?: unknown;
}

function writeSettings(ed: EditorController, refs: readonly Guid[], list: ExportSettings[], label: string) {
  // Motion's Animated tab keeps its own entry on each layer (round 8e).
  writeKeepingAnimated(ed, refs, list, label);
}

/** A timeline root with something on it to export animated: keyframes, clips, an animated instance or audio. */
function hasMotion(ed: EditorController, root: Guid): boolean {
  if (!timelineOf(ed, root)) return false;
  const model = ed.engine.motionTimeline(root);
  return !!model && (model.audio.length > 0 || model.layers.some((l) => l.tracks.length > 0 || l.clips.length > 0 || !!l.instance));
}

/** Hidden for a viewer the file or the org doesn't let export (docs/governance.md §2.7: "hidden or disabled"). */
export function ExportSection(props: { targets: ExportTarget[]; page: boolean }) {
  const ed = useEditor();
  return useExportAllowed(ed) ? <ExportSectionBody {...props} /> : null;
}

function ExportSectionBody({ targets, page }: { targets: ExportTarget[]; page: boolean }) {
  useT();
  const ed = useEditor();
  const kept = useKeeps("exportSettings");
  const refs = targets.map((t) => t.guid);
  const shared = mixed(targets.map((t) => exportSettingsOf(t)), sameData);
  const isMixed = shared !== undefined && typeof shared === "symbol";
  const list = (shared === undefined || isMixed ? [] : [...(shared as ExportSettings[])]) as ExportSettings[];
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  // Static (today's) | Animated (docs/motion.md §7.1: the animated formats of a timeline root).
  const [chosenTab, setTab] = useState<"static" | "animated">("static");
  // The Static / Animated strip only when there is something to export animated — a timeline root with keyframes,
  // clips, an animated instance or audio among the targets; else Export is Figma's header with "+" alone (A-live O5).
  const version = useDocumentVersion();
  const animatable = useMemo(() => {
    void version;
    return !page && targets.some((tg) => hasMotion(ed, tg.guid));
  }, [ed, targets, page, version]);
  const tab = animatable ? chosenTab : "static";
  const exporting = canExport(ed);
  const add = () => writeSettings(ed, refs, isMixed ? [nextExportSetting([])] : [...list, nextExportSetting(list)], "Add export settings");
  const set = (i: number, next: ExportSettings, label = "Export settings") => writeSettings(ed, refs, list.map((x, j) => (j === i ? next : x)), label);
  const empty = !isMixed && list.length === 0;
  const items: ExportItem[] = targets
    .map((t) => ({ ref: page ? null : t.guid, name: t.name ?? "", settings: exportSettingsOf(t) }))
    .filter((i) => i.settings.length > 0);
  const label = targets.length === 1 ? t("Export {name}", { name: targets[0].name ?? "" }) : tp(targets.length, "Export {n} layer", "Export {n} layers");
  // Rows in list order (the first setting on top); a grip drags one to another place (help 360040028114).
  const { container: reorderRef, grip, dragging, line: dropLine } = useReorder((from, to) => writeSettings(ed, refs, moved(list, from, to), "Reorder export settings"));
  const run = async () => {
    setBusy(true);
    try {
      await exportItems(ed, items);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelSection title={t("Export")} empty={empty && tab === "static"} actions={<IconButton icon="24.plus.small" label={t("Add export settings")} tone="secondary" disabled={!kept || tab !== "static"} onClick={add} />}>
      {animatable && <Tabs className={own.tabs} label={t("Export kind")} value={tab} tabs={[{ value: "static", label: t("Static") }, { value: "animated", label: t("Animated") }]} onChange={(v) => setTab(v as "static" | "animated")} />}
      {tab === "animated" && <ExportAnimatedTab targets={targets} page={page} />}
      {tab === "static" && isMixed && <div className={styles.note}>{t("Click + to replace mixed export settings")}</div>}
      {tab === "static" && list.length > 0 && (
        <div ref={reorderRef} className={styles.reorderList}>
      {list.map((s, i) => {
        const format = formatOf(s);
        const vector = isVectorFormat(format);
        return (
          <div key={i} className={cx(styles.paintRow, dragging === i && styles.rowDragging)} data-export-row={i} data-reorder-row="">
            {list.length > 1 && <Grip {...grip(i)} />}
            {/* Live (design/rectangle-with-export.txt): the scale (49 + its 24 list, 1 apart: "Export constraints for content
                scale or width/height dimensions" / "Select an option"), "Export file type" (74, outlined), "Advanced export
                settings" and "Remove". */}
            <div className={own.fields}>
              <div role="group" aria-label={t(SCALE_LABEL)} className={own.scaleGroup}>
                <TextInput
                  className={own.scale}
                  label={t(SCALE_LABEL)}
                  value={scaleLabel(s)}
                  disabled={vector}
                  onCommit={(v) => {
                    const c = parseScale(v);
                    if (c) set(i, withConstraint(s, c), "Export scale");
                  }}
                  onKeyDownCapture={(e) => {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    e.preventDefault();
                    set(i, withConstraint(s, nudgeConstraint(s.constraint, e.key === "ArrowUp", e.shiftKey)), "Export scale");
                  }}
                />
                <MenuButton
                  label={t("Select an option")}
                  disabled={vector}
                  entries={SCALE_PRESETS.map((p) => ({ id: p, label: p, checked: p === scaleLabel(s) }))}
                  onSelect={(p) => {
                    const c = parseScale(p);
                    if (c) set(i, withConstraint(s, c), "Export scale");
                  }}
                  className={own.scaleMenu}
                >
                  <Icon name="16.chevron.down" />
                </MenuButton>
              </div>
              <span className={own.formatSlot}>
              {/* Live: the field's label, kept for assistive tech and clipped from view (97,800 "Export file type") */}
              <span className={own.formatLegend}>{t("Export file type")}</span>
              <Select
                className={own.format}
                variant="outlined"
                below
                label={t("Export file type")}
                value={format}
                options={EXPORT_FORMATS.map((f) => ({ value: f.value, label: f.label }))}
                onChange={(v) => set(i, withFormat(s, v as ExportFormat), "Export format")}
              />
              </span>
            </div>
            <IconButton
              icon="24.adjust.small"
              label={t("Advanced export settings")}
              tone="secondary"
              aria-expanded={open?.index === i}
              onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })}
            />
            <IconButton icon="24.minus.small" label={t("Remove")} tone="secondary" onClick={() => writeSettings(ed, refs, list.filter((_, j) => j !== i), "Remove export settings")} />
          </div>
        );
      })}
          {dropLine !== null && <div className={styles.dropLine} style={{ top: dropLine }} />}
        </div>
      )}
      {tab === "static" && !empty && (
        <div className={own.actions}>
          <Button variant="secondary" fullWidth loading={busy} disabled={!exporting || !items.length} onClick={() => void run()} data-export-button="">
            {label}
          </Button>
        </div>
      )}
      {tab === "static" && !empty && !isMixed && (
        <>
          <button type="button" className={own.disclosure} aria-expanded={preview} onClick={() => setPreview(!preview)}>
            <Icon name={preview ? "16.chevron.down" : "16.chevron.right"} />
            <span>{t("Preview")}</span>
          </button>
          {preview && targets.length === 1 && list[0] && <ExportPreview refs={page ? [] : [targets[0].guid]} setting={list[0]} />}
        </>
      )}
      {open && list[open.index] && (
        <ExportSettingsPopover setting={list[open.index]} refs={page ? [] : refs} anchor={open.anchor} onClose={() => setOpen(null)} onChange={(next) => set(open.index, next)} />
      )}
    </PanelSection>
  );
}

/**
 * What the layers hold that some rows depend on (the page: everything): text (Figma's text-node export options —
 * Include bounding box, Outline text) and a stroke SVG can only draw as a mask, inside or outside (Simplify stroke).
 */
function useExportContent(refs: readonly Guid[]): { text: boolean; maskableStroke: boolean } {
  const ed = useEditor();
  const version = useDocumentVersion();
  const key = refs.join(",");
  return useMemo(() => {
    if (!key) return { text: true, maskableStroke: true };
    const nodes = ed.engine.readNodes(key.split(","), { fields: ["type", "strokePaints", "strokeWeight", "strokeAlign"], subtree: true, visibleOnly: true, limit: 5000 });
    const stroked = (n: NodeChange) => (n.strokeWeight ?? 1) > 0 && (n.strokePaints ?? []).some((p) => p.visible !== false) && (n.strokeAlign === "INSIDE" || n.strokeAlign === "OUTSIDE");
    return { text: nodes.some((n) => n.type === "TEXT"), maskableStroke: nodes.some(stroked) };
    // The document's version re-reads the layers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed, key, version]);
}

/** The "…" popover: the setting's details, by format (Figma's ExportSettings, 240 wide; atlas 15 §4). */
export function ExportSettingsPopover({ setting, refs, anchor, onChange, onClose }: { setting: ExportSettings; refs: readonly Guid[]; anchor: HTMLElement; onChange: (s: ExportSettings) => void; onClose: () => void }) {
  useT();
  const ed = useEditor();
  const content = useExportContent(refs);
  const format = formatOf(setting);
  const check = (label: string, value: boolean, next: (v: boolean) => ExportSettings) => (
    <div className={styles.settingsWide} data-export-check="">
      <Checkbox label={t(label)} checked={value} onChange={(v) => onChange(next(v))} />
    </div>
  );
  return (
    // Live (popovers/export-advanced-settings.txt): "Export", rows from 52 every 32 — labels 16, fields 100 wide at 124
    // (Suffix "None", Color profile "sRGB (same as file)", Image resampling "Detailed"), Ignore overlapping layers.
    <Popover anchor={anchor} title={t("Export")} width={240} onClose={onClose} label={t("Export settings")}>
      <div className={cx(styles.settings, own.exportSettings)} data-export-settings="">
        <span className={styles.settingsLabel}>{t("Suffix")}</span>
        <TextInput label={t("Suffix")} placeholder={t("None")} value={setting.suffix ?? ""} onCommit={(v) => onChange({ ...setting, suffix: v })} />
        {/* Every format (CMYK is Buzz's print only) */}
        <span className={styles.settingsLabel}>{t("Color profile")}</span>
        <Select
          label={t("Color profile")}
          variant="ghost"
          value={setting.colorProfile ?? "DOCUMENT"}
          options={[
            // "Same as file": the file's own profile, named (atlas 07 §16: not always sRGB)
            { value: "DOCUMENT", label: ed.engine.colorProfile === "DISPLAY_P3" ? t("Display P3 (same as file)") : t("sRGB (same as file)") },
            { value: "SRGB", label: "sRGB" },
            { value: "DISPLAY_P3_V4", label: "Display P3" },
          ]}
          onChange={(v) => onChange({ ...setting, colorProfile: v as ExportSettings["colorProfile"] })}
        />
        {(format === "JPEG" || format === "PDF") && (
          <>
            {/* High, Medium, Low: JPEG 1 / 0.8 / 0.75, PDF 1 / 0.76 / 0.5 */}
            <span className={styles.settingsLabel}>{t("Image quality")}</span>
            <Select
              label={t("Image quality")}
              variant="ghost"
              value={qualityLevel(setting)}
              options={QUALITY_LEVELS.map((q) => ({ value: q.value, label: t(q.label) }))}
              onChange={(v) => onChange({ ...setting, quality: qualityFor(setting, v as QualityLevel) })}
            />
          </>
        )}
        {format !== "SVG" && (
          <>
            <span className={styles.settingsLabel}>{t("Image resampling")}</span>
            <Select
              label={t("Image resampling")}
              variant="ghost"
              value={setting.useBicubicSampler === false ? "standard" : "detailed"}
              options={[
                { value: "detailed", label: t("Detailed") },
                { value: "standard", label: t("Standard") },
              ]}
              onChange={(v) => onChange({ ...setting, useBicubicSampler: v !== "standard" })}
            />
          </>
        )}
        {format !== "PDF" && check("Ignore overlapping layers", setting.contentsOnly !== false, (v) => ({ ...setting, contentsOnly: v }))}
        {content.text && check("Include bounding box", setting.useAbsoluteBounds === true, (v) => ({ ...setting, useAbsoluteBounds: v }))}
        {format === "SVG" && check('Include "id" attribute', setting.svgIDMode === "ALWAYS", (v) => ({ ...setting, svgIDMode: v ? "ALWAYS" : "IF_NEEDED" }))}
        {format === "SVG" && content.text && check("Outline text", setting.svgOutlineText !== false, (v) => ({ ...setting, svgOutlineText: v }))}
        {format === "SVG" && content.maskableStroke && check("Simplify stroke", setting.svgForceStrokeMasks !== true, (v) => ({ ...setting, svgForceStrokeMasks: !v }))}
      </div>
    </Popover>
  );
}

/** The first setting's image, drawn again when the document changes (a moment after). */
function ExportPreview({ refs, setting }: { refs: Guid[]; setting: ExportSettings }) {
  useT();
  const ed = useEditor();
  const version = useDocumentVersion();
  const [url, setUrl] = useState<string | null>(null);
  const key = refs.join(",");
  // PDF previews as its 1x image; SVG as itself.
  const shown = useMemo<ExportSettings>(() => (formatOf(setting) === "PDF" ? { ...setting, imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 1 } } : setting), [setting]);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    const timer = setTimeout(async () => {
      const r = await renderExport(ed, key ? key.split(",") : [], shown);
      if (cancelled || "error" in r) return;
      const type = formatOf(shown) === "SVG" ? "image/svg+xml" : formatOf(shown) === "JPEG" ? "image/jpeg" : "image/png";
      made = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type }));
      setUrl(made);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (made) URL.revokeObjectURL(made);
    };
  }, [ed, key, shown, version]);
  return (
    <div className={own.preview} data-export-preview="">
      {url ? <img src={url} alt={t("Export preview")} /> : null}
    </div>
  );
}
