/**
 * The Design panel's Export section (UI3; help.figma.com 360040028114,
 * 13402894554519). "+" adds an export setting — 1x, then 2x "@2x", then 3x
 * "@3x" (Figma's defaults) — each row: the scale ("1x", typed or picked:
 * 0.5x … 4x, 512w, 512h; SVG and PDF are 1x only), the format (PNG, JPG,
 * SVG, PDF), "…" for the setting's details (Suffix; Color profile, Image
 * quality, Image resampling; Ignore overlapping layers, Include bounding box,
 * Include "id" attribute, Outline text, Simplify stroke — by format), minus.
 * Under the rows, "Export Frame 1" (one layer) / "Export 3 layers", and the
 * Preview of the first setting (one layer only). With nothing selected the
 * settings are the page's: its canvas exports. Stored as `exportSettings`
 * (schema ExportSettings) on the layer or page.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Icon, IconButton, MenuButton, PanelSection, Popover, Select, TextInput, cx } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { canExport, exportItems, renderExport, type ExportItem } from "../../exporting";
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
  parseScale,
  qualityOf,
  scaleLabel,
  withFormat,
  type ExportFormat,
  type ExportSettings,
} from "../../model/exports";
import { fields, useKeeps } from "./shared";
import { Grip, moved, useReorder } from "./reorder";
import styles from "./Design.module.css";
import own from "./Export.module.css";

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
  ed.setProps(refs, fields({ exportSettings: list } as never), label);
}

export function ExportSection({ targets, page }: { targets: ExportTarget[]; page: boolean }) {
  const ed = useEditor();
  const kept = useKeeps("exportSettings");
  const refs = targets.map((t) => t.guid);
  const shared = mixed(targets.map((t) => exportSettingsOf(t)), sameData);
  const isMixed = shared !== undefined && typeof shared === "symbol";
  const list = (shared === undefined || isMixed ? [] : [...(shared as ExportSettings[])]) as ExportSettings[];
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const exporting = canExport(ed);
  const add = () => writeSettings(ed, refs, isMixed ? [nextExportSetting([])] : [...list, nextExportSetting(list)], "Add export settings");
  const set = (i: number, next: ExportSettings, label = "Export settings") => writeSettings(ed, refs, list.map((x, j) => (j === i ? next : x)), label);
  const empty = !isMixed && list.length === 0;
  const items: ExportItem[] = targets
    .map((t) => ({ ref: page ? null : t.guid, name: t.name ?? "", settings: exportSettingsOf(t) }))
    .filter((i) => i.settings.length > 0);
  const label = targets.length === 1 ? `Export ${targets[0].name ?? ""}` : `Export ${targets.length} layers`;
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
    <PanelSection title="Export" empty={empty} actions={<IconButton icon="24.plus.small" label="Add export settings" tone="secondary" disabled={!kept} onClick={add} />}>
      {isMixed && <div className={styles.note}>Click + to replace mixed export settings</div>}
      {list.length > 0 && (
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
              <div role="group" aria-label={SCALE_LABEL} className={own.scaleGroup}>
                <TextInput
                  className={own.scale}
                  label={SCALE_LABEL}
                  value={scaleLabel(s)}
                  disabled={vector}
                  onCommit={(v) => {
                    const c = parseScale(v);
                    if (c) set(i, { ...s, constraint: c }, "Export scale");
                  }}
                />
                <MenuButton
                  label="Select an option"
                  disabled={vector}
                  entries={SCALE_PRESETS.map((p) => ({ id: p, label: p, checked: p === scaleLabel(s) }))}
                  onSelect={(p) => {
                    const c = parseScale(p);
                    if (c) set(i, { ...s, constraint: c }, "Export scale");
                  }}
                  className={own.scaleMenu}
                >
                  <Icon name="16.chevron.down" />
                </MenuButton>
              </div>
              <span className={own.formatSlot}>
              {/* Live: the field's label, kept for assistive tech and clipped from view (97,800 "Export file type") */}
              <span className={own.formatLegend}>Export file type</span>
              <Select
                className={own.format}
                variant="outlined"
                below
                label="Export file type"
                value={format}
                options={EXPORT_FORMATS.map((f) => ({ value: f.value, label: f.label }))}
                onChange={(v) => set(i, withFormat(s, v as ExportFormat), "Export format")}
              />
              </span>
            </div>
            <IconButton
              icon="24.adjust.small"
              label="Advanced export settings"
              tone="secondary"
              aria-expanded={open?.index === i}
              onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })}
            />
            <IconButton icon="24.minus.small" label="Remove" tone="secondary" onClick={() => writeSettings(ed, refs, list.filter((_, j) => j !== i), "Remove export settings")} />
          </div>
        );
      })}
          {dropLine !== null && <div className={styles.dropLine} style={{ top: dropLine }} />}
        </div>
      )}
      {!empty && (
        <div className={own.actions}>
          <Button variant="secondary" fullWidth loading={busy} disabled={!exporting || !items.length} onClick={() => void run()} data-export-button="">
            {label}
          </Button>
        </div>
      )}
      {!empty && !isMixed && (
        <>
          <button type="button" className={own.disclosure} aria-expanded={preview} onClick={() => setPreview(!preview)}>
            <Icon name={preview ? "16.chevron.down" : "16.chevron.right"} />
            <span>Preview</span>
          </button>
          {preview && targets.length === 1 && list[0] && <ExportPreview refs={page ? [] : [targets[0].guid]} setting={list[0]} />}
        </>
      )}
      {open && list[open.index] && (
        <ExportSettingsPopover setting={list[open.index]} anchor={open.anchor} onClose={() => setOpen(null)} onChange={(next) => set(open.index, next)} />
      )}
    </PanelSection>
  );
}

/** The "…" popover: the setting's details, by format. */
export function ExportSettingsPopover({ setting, anchor, onChange, onClose }: { setting: ExportSettings; anchor: HTMLElement; onChange: (s: ExportSettings) => void; onClose: () => void }) {
  const format = formatOf(setting);
  const raster = format === "PNG" || format === "JPEG";
  const quality = QUALITY_LEVELS.reduce((best, q) => (Math.abs(q.quality - qualityOf(setting)) < Math.abs(best.quality - qualityOf(setting)) ? q : best));
  const check = (label: string, value: boolean, next: (v: boolean) => ExportSettings) => (
    <div className={styles.settingsWide} data-export-check="">
      <Checkbox label={label} checked={value} onChange={(v) => onChange(next(v))} />
    </div>
  );
  return (
    // Live (popovers/export-advanced-settings.txt): "Export", rows from 52 every 32 — labels 16, fields 100 wide at 124
    // (Suffix "None", Color profile "sRGB (same as file)", Image resampling "Detailed"), Ignore overlapping layers.
    <Popover anchor={anchor} title="Export" width={240} onClose={onClose} label="Export settings">
      <div className={cx(styles.settings, own.exportSettings)} data-export-settings="">
        <span className={styles.settingsLabel}>Suffix</span>
        <TextInput label="Suffix" placeholder="None" value={setting.suffix ?? ""} onCommit={(v) => onChange({ ...setting, suffix: v })} />
        {raster && (
          <>
            <span className={styles.settingsLabel}>Color profile</span>
            <Select
              label="Color profile"
              variant="ghost"
              value={setting.colorProfile ?? "DOCUMENT"}
              options={[
                { value: "DOCUMENT", label: "sRGB (same as file)" },
                { value: "SRGB", label: "sRGB" },
                { value: "DISPLAY_P3_V4", label: "Display P3" },
              ]}
              onChange={(v) => onChange({ ...setting, colorProfile: v as ExportSettings["colorProfile"] })}
            />
          </>
        )}
        {(format === "JPEG" || format === "PDF") && (
          <>
            <span className={styles.settingsLabel}>Image quality</span>
            <Select label="Image quality" variant="ghost" value={quality.value} options={QUALITY_LEVELS.map((q) => ({ value: q.value, label: q.label }))} onChange={(v) => onChange({ ...setting, quality: QUALITY_LEVELS.find((q) => q.value === v)?.quality })} />
          </>
        )}
        {format !== "SVG" && (
          <>
            <span className={styles.settingsLabel}>Image resampling</span>
            <Select
              label="Image resampling"
              variant="ghost"
              value={setting.useBicubicSampler === false ? "basic" : "detailed"}
              options={[
                { value: "detailed", label: "Detailed" },
                { value: "basic", label: "Basic" },
              ]}
              onChange={(v) => onChange({ ...setting, useBicubicSampler: v !== "basic" })}
            />
          </>
        )}
        {format !== "PDF" && check("Ignore overlapping layers", setting.contentsOnly !== false, (v) => ({ ...setting, contentsOnly: v }))}
        {/* Not in the live PNG settings; kept for SVG (unverified there) */}
        {format === "SVG" && check("Include bounding box", setting.useAbsoluteBounds === true, (v) => ({ ...setting, useAbsoluteBounds: v }))}
        {format === "SVG" && check('Include "id" attribute', setting.svgIDMode === "ALWAYS", (v) => ({ ...setting, svgIDMode: v ? "ALWAYS" : "IF_NEEDED" }))}
        {format === "SVG" && check("Outline text", setting.svgOutlineText !== false, (v) => ({ ...setting, svgOutlineText: v }))}
        {format === "SVG" && check("Simplify stroke", setting.svgForceStrokeMasks !== true, (v) => ({ ...setting, svgForceStrokeMasks: !v }))}
      </div>
    </Popover>
  );
}

/** The first setting's image, drawn again when the document changes (a moment after). */
function ExportPreview({ refs, setting }: { refs: Guid[]; setting: ExportSettings }) {
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
      {url ? <img src={url} alt="Export preview" /> : null}
    </div>
  );
}
