/**
 * Dev Mode sections of the viewer's Inspect panel beyond the basics (docs/research/figma/R9-dev-mode.md):
 * - the code settings menu: the language, its units and "Set unit scale…" (help 15023202277399);
 * - Annotations (20774752502935): the layer's notes and pinned properties;
 * - Assets (15023124644247): the icons and images inside the layer — icons as SVG / PNG / JPG / PDF, images as
 *   "Source image file" or "Layer export";
 * - Export: the layer's export settings (or 1x PNG), "+" for more, each a scale and a format (PNG, JPG, SVG, PDF),
 *   drawn by the engine's exporters (E7: exportCore.ts) — "Export ‹layer›".
 * Downloads are the browser's (a ZIP for several files).
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, Icon, IconButton, MenuButton, NumericInput, PanelSection, Select, showToast, type MenuEntry } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";
import { renderEngineExport, sniffMime } from "@/editor/exportCore";
import { EXPORT_FORMATS, exportFileName, exportSettingsOf, formatOf, nextExportSetting, parseScale, scaleLabel, SCALE_PRESETS, withFormat, zipStored, type ExportFormat, type ExportSettings } from "@/editor/model/exports";
import { useViewer } from "./context";
import { detectAssets, type AnnotationView, type Asset } from "./inspect/devMode";
import { typeLabel } from "./inspect/model";
import { UNITS, type Language, type Unit, type UnitSettings } from "./inspect/units";
import styles from "./Viewer.module.css";

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "css", label: "CSS" },
  { value: "swiftui", label: "iOS (SwiftUI)" },
  { value: "compose", label: "Android (Compose)" },
];

/** Saves files: one as itself, several as a ZIP (a browser download). */
export function download(files: readonly { name: string; bytes: Uint8Array }[], zipName: string): void {
  if (!files.length) return;
  const one = files.length === 1;
  const bytes = one ? files[0].bytes : zipStored(files);
  const name = one ? files[0].name.replace(/\//g, "-") : zipName;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: one ? "application/octet-stream" : "application/zip" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ---- Code settings -------------------------------------------------------------------------------------------------

/** The language dropdown: the languages, then (under Settings) the units of the chosen one and "Set unit scale…". */
export function CodeSettings({ language, units, onLanguage, onUnits }: { language: Language; units: UnitSettings; onLanguage: (l: Language) => void; onUnits: (u: UnitSettings) => void }) {
  const [scaleOpen, setScaleOpen] = useState(false);
  const unit = units.unit[language];
  const entries: MenuEntry[] = [
    ...LANGUAGES.map((l) => ({ id: `lang:${l.value}`, label: l.label, checked: l.value === language })),
    "-",
    { header: "Settings" },
    ...UNITS[language].map((u) => ({ id: `unit:${u.value}`, label: u.label, checked: u.value === unit })),
    { id: "scale", label: "Set unit scale…" },
  ];
  const label = `${LANGUAGES.find((l) => l.value === language)?.label ?? "CSS"}`;
  return (
    <>
      <MenuButton
        label="Code settings"
        entries={entries}
        className={styles.codeSettings}
        onSelect={(id) => {
          if (id.startsWith("lang:")) onLanguage(id.slice(5) as Language);
          else if (id.startsWith("unit:")) onUnits({ ...units, unit: { ...units.unit, [language]: id.slice(5) as Unit } });
          else if (id === "scale") setScaleOpen(true);
        }}
      >
        <span>{label}</span>
        <span className={styles.codeUnit}>{unit}</span>
        <Icon name="16.chevron.down" />
      </MenuButton>
      {scaleOpen && <UnitScaleDialog language={language} units={units} onUnits={onUnits} onClose={() => setScaleOpen(false)} />}
    </>
  );
}

/** "Set unit scale…": the root font size for CSS rems, the scale factor for points / dp / sp. */
function UnitScaleDialog({ language, units, onUnits, onClose }: { language: Language; units: UnitSettings; onUnits: (u: UnitSettings) => void; onClose: () => void }) {
  const css = language === "css";
  const [value, setValue] = useState(css ? units.rootFontSize : units.scale);
  return (
    <Dialog
      title="Unit scale"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onUnits(css ? { ...units, rootFontSize: value } : { ...units, scale: value });
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className={styles.unitScale}>
        <span>{css ? "Root font size" : language === "swiftui" ? "1pt =" : "1dp ="}</span>
        <NumericInput label={css ? "Root font size" : "Scale factor"} value={value} min={0.01} max={1000} onChange={(v) => setValue(v)} unit="px" />
      </div>
    </Dialog>
  );
}

// ---- Annotations ---------------------------------------------------------------------------------------------------

export function AnnotationsSection({ notes }: { notes: AnnotationView[] }) {
  if (!notes.length) return null;
  return (
    <PanelSection title="Annotations">
      {notes.map((a, i) => (
        <div key={i} className={styles.annotation} data-annotation="">
          {a.text && <div className={styles.annotationText}>{a.text}</div>}
          {a.properties.map((p) => (
            <div key={p.label} className={styles.annotationProp}>
              <span>{p.label}</span>
              <span>{p.value}</span>
            </div>
          ))}
        </div>
      ))}
    </PanelSection>
  );
}

// ---- Assets --------------------------------------------------------------------------------------------------------

const ICON_FORMATS: ExportFormat[] = ["SVG", "PNG", "JPEG", "PDF"];

function thumbnail(engine: ReturnType<typeof useViewer>["engine"], id: Guid): string | null {
  try {
    const px = engine.renderNodeThumbnailPixels({ node: id, maxSize: 48 });
    if (!px) return null;
    const c = document.createElement("canvas");
    c.width = px.width;
    c.height = px.height;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
    return c.toDataURL();
  } catch {
    return null;
  }
}

export function AssetsSection({ id }: { id: Guid }) {
  const { doc } = useViewer();
  const assets = useMemo(() => detectAssets(id, (x) => doc.assetNode(x)), [doc, id]);
  if (!assets.length) return null;
  return (
    <PanelSection title="Assets">
      {assets.map((a) => (
        <AssetRow key={a.id} asset={a} />
      ))}
    </PanelSection>
  );
}

function AssetRow({ asset }: { asset: Asset }) {
  const { engine, preview } = useViewer();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    // Drawn after the panel: a thumbnail is a small offscreen render.
    const t = setTimeout(() => setSrc(thumbnail(engine, asset.id)), 0);
    return () => clearTimeout(t);
  }, [engine, asset.id]);
  const [choice, setChoice] = useState<string>(asset.kind === "icon" ? "SVG" : "SOURCE");
  const options =
    asset.kind === "icon"
      ? ICON_FORMATS.map((f) => ({ value: f, label: EXPORT_FORMATS.find((x) => x.value === f)?.label ?? f }))
      : [
          { value: "SOURCE", label: "Source image file" },
          { value: "LAYER", label: "Layer export" },
        ];
  const run = async () => {
    const name = asset.name || "Image";
    if (choice === "SOURCE" && asset.imageHash) {
      const bytes = await preview.image(asset.imageHash);
      if (!bytes) return void showToast({ message: "This image isn't in the preview" });
      const ext = sniffMime(bytes)?.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      return download([{ name: `${name}.${ext}`, bytes }], `${name}.zip`);
    }
    const format = (choice === "LAYER" ? "PNG" : choice) as ExportFormat;
    const settings = withFormat(nextExportSetting([]), format);
    const r = await renderEngineExport(engine, (h) => preview.image(h), [asset.id], settings);
    if ("error" in r) return void showToast({ message: `Couldn't export: ${r.error}` });
    download([{ name: exportFileName(name, settings), bytes: r.bytes }], `${name}.zip`);
  };
  return (
    <div className={styles.assetRow} data-asset={asset.kind}>
      <span className={styles.assetThumb}>{src ? <img src={src} alt="" /> : <Icon name={asset.kind === "icon" ? "16.vector" : "16.image"} />}</span>
      <span className={styles.assetName} title={asset.name}>
        {asset.name}
      </span>
      <Select label="Format" value={choice} options={options} onChange={setChoice} variant="ghost" width="hug" />
      <IconButton icon="24.external" label={`Download ${asset.name}`} onClick={() => void run()} />
    </div>
  );
}

// ---- Export --------------------------------------------------------------------------------------------------------

const VIEWER_SCALES = SCALE_PRESETS.filter((s) => s !== "512w" && s !== "512h");

export function ExportSection({ id, node }: { id: Guid; node: NodeChange }) {
  const { engine, preview } = useViewer();
  const [rows, setRows] = useState<ExportSettings[]>(() => {
    const own = exportSettingsOf(node as { exportSettings?: unknown });
    return own.length ? own : [nextExportSetting([])];
  });
  const [busy, setBusy] = useState(false);
  const name = node.name || typeLabel(node);
  const run = async () => {
    setBusy(true);
    try {
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (const s of rows) {
        const r = await renderEngineExport(engine, (h) => preview.image(h), [id], s);
        if ("error" in r) throw new Error(r.error);
        files.push({ name: exportFileName(name, s), bytes: r.bytes });
      }
      download(files, `${name.replace(/[/\\:]/g, "-")}.zip`);
    } catch (e) {
      showToast({ message: `Couldn't export: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };
  const set = (i: number, s: ExportSettings) => setRows((list) => list.map((x, k) => (k === i ? s : x)));
  return (
    <PanelSection title="Export" actions={<IconButton icon="24.plus.small" label="Add export settings" onClick={() => setRows((list) => [...list, nextExportSetting(list)])} />}>
      {rows.map((s, i) => {
        const format = formatOf(s);
        const vector = format === "SVG" || format === "PDF";
        return (
          <div key={i} className={styles.exportRow} data-export-row={i}>
            <Select
              label="Scale"
              value={vector ? "1x" : scaleLabel(s)}
              disabled={vector}
              options={VIEWER_SCALES.map((v) => ({ value: v, label: v }))}
              onChange={(v) => {
                const c = parseScale(v);
                if (c) set(i, { ...s, constraint: c, suffix: c.type === "CONTENT_SCALE" && c.value !== 1 ? `@${c.value}x` : "" });
              }}
              width={72}
            />
            <Select label="Format" value={format} options={EXPORT_FORMATS} onChange={(v) => set(i, withFormat(s, v as ExportFormat))} width={80} />
            <span className={styles.grow} />
            {rows.length > 1 && <IconButton icon="24.minus.small" label="Remove export settings" onClick={() => setRows((list) => list.filter((_, k) => k !== i))} />}
          </div>
        );
      })}
      <Button variant="secondary" fullWidth loading={busy} onClick={() => void run()} data-export-button="">
        Export {name}
      </Button>
      <div className={styles.hint}>{rows.map((s) => exportFileName(name, s)).join(", ")}</div>
    </PanelSection>
  );
}
