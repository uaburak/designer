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
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Dialog, Icon, IconButton, MenuButton, NumericInput, PanelSection, Select, showToast, type MenuEntry } from "@/ds";
import { t, useT } from "@/i18n";
import type { Guid, NodeChange } from "@/engine/codec";
import { renderEngineExport, sniffMime } from "@/editor/exportCore";
import { EXPORT_FORMATS, exportFileName, exportSettingsOf, formatOf, nextExportSetting, parseScale, scaleLabel, SCALE_PRESETS, withFormat, zipStored, type ExportFormat, type ExportSettings } from "@/editor/model/exports";
import { useViewer } from "./context";
import { detectAssets, type AnnotationView, type Asset } from "./inspect/devMode";
import { typeLabel } from "./inspect/model";
import { NATIVE_SCALES, UNITS, type Language, type Unit, type UnitSettings } from "./inspect/units";
import type { CodegenLanguage } from "./context";
import styles from "./Viewer.module.css";

/** Codegen plugins' languages in the language menu (docs/plugins.md §7), after the built-in ones. */
export interface PluginLanguages {
  list: CodegenLanguage[];
  current: CodegenLanguage | null;
  onPick(l: CodegenLanguage | null): void;
}
export const pluginLanguageId = (l: CodegenLanguage) => `${l.pluginId}:${l.value}`;

/** The first-party languages' names in the dropdown (`dev_handoff.code.lang_*`) and on its button. */
const LANGUAGE_NAME: Record<Language, string> = { css: "CSS", swiftui: "SwiftUI", uikit: "UIKit", compose: "Compose", xml: "XML" };
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "css", label: "CSS" },
  { value: "swiftui", label: "iOS (SwiftUI)" },
  { value: "uikit", label: "iOS (UIKit)" },
  { value: "compose", label: "Android (Compose)" },
  { value: "xml", label: "Android (XML)" },
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

/**
 * The language dropdown (atlas 14 §10): CSS, iOS ▸ (SwiftUI, UIKit), Android ▸ (Compose, XML), the plugins' languages,
 * then (under Settings) px and the language's scaled unit, and "Set unit scale…".
 */
export function CodeSettings({ language, units, onLanguage, onUnits, plugins }: { language: Language; units: UnitSettings; onLanguage: (l: Language) => void; onUnits: (u: UnitSettings) => void; plugins?: PluginLanguages }) {
  useT();
  const [scaleOpen, setScaleOpen] = useState(false);
  const unit = units.unit[language];
  const chosen = plugins?.current ?? null;
  const pluginEntries: MenuEntry[] = plugins?.list.length ? ["-", { header: "Plugins" }, ...plugins.list.map((l) => ({ id: `plugin:${pluginLanguageId(l)}`, label: plugins.list.filter((x) => x.label === l.label).length > 1 ? `${l.label} (${l.pluginName})` : l.label, checked: !!chosen && pluginLanguageId(chosen) === pluginLanguageId(l) }))] : [];
  const item = (l: Language) => ({ id: `lang:${l}`, label: LANGUAGE_NAME[l], checked: !chosen && l === language });
  const entries: MenuEntry[] = [
    item("css"),
    { id: "ios", label: "iOS", checked: !chosen && (language === "swiftui" || language === "uikit"), items: [item("swiftui"), item("uikit")] },
    { id: "android", label: "Android", checked: !chosen && (language === "compose" || language === "xml"), items: [item("compose"), item("xml")] },
    ...pluginEntries,
    "-",
    { header: "Settings" },
    ...UNITS[language].map((u) => ({ id: `unit:${u.value}`, label: u.label, checked: u.value === unit })),
    { id: "scale", label: t("Set unit scale…") },
  ];
  const label = chosen ? chosen.label : LANGUAGE_NAME[language];
  return (
    <>
      <MenuButton
        label={t("Code language: {codeLanguage}", { codeLanguage: label })}
        entries={entries}
        className={styles.codeSettings}
        onSelect={(id) => {
          if (id.startsWith("plugin:")) plugins?.onPick(plugins.list.find((l) => pluginLanguageId(l) === id.slice(7)) ?? null);
          else if (id.startsWith("lang:")) {
            plugins?.onPick(null);
            onLanguage(id.slice(5) as Language);
          }
          else if (id.startsWith("unit:")) onUnits({ ...units, unit: { ...units.unit, [language]: id.slice(5) as Unit } });
          else if (id === "scale") setScaleOpen(true);
        }}
      >
        <span>{label}</span>
        {!chosen && <span className={styles.codeUnit}>{unit}</span>}
        <Icon name="16.chevron.down" />
      </MenuButton>
      {scaleOpen && <UnitScaleDialog language={language} units={units} onUnits={onUnits} onClose={() => setScaleOpen(false)} />}
    </>
  );
}

/** What each platform's scale factor means (the help's words; Figma's own descriptions are keys only, atlas 14 §16). */
const SCALE_DESCRIPTION: Record<"web" | "ios" | "android", string> = {
  web: "Relative to the root font size (e.g. 1rem = 16px by default)",
  ios: "Resolution-independent points: px divided by the scale factor",
  android: "Density-independent pixels: px divided by the scale factor",
};

/**
 * "Set unit scale…" (`unit_settings_modal_title`, atlas 14 §10): its own language dropdown; CSS's inspection scale
 * factor as a number (at least 0.1, two decimals) with "Only apply rem on text"; iOS's and Android's chosen from
 * 3, 2, 1, 1/2, 1/3. A change applies after 250 ms.
 */
function UnitScaleDialog({ language, units, onUnits, onClose }: { language: Language; units: UnitSettings; onUnits: (u: UnitSettings) => void; onClose: () => void }) {
  useT();
  const [lang, setLang] = useState(language);
  const [draft, setDraft] = useState(units);
  const latest = useRef(onUnits);
  useEffect(() => {
    latest.current = onUnits;
  }, [onUnits]);
  useEffect(() => {
    if (draft === units) return;
    const timer = setTimeout(() => latest.current(draft), 250);
    return () => clearTimeout(timer);
  }, [draft, units]);
  const css = lang === "css";
  const platform = css ? "web" : lang === "swiftui" || lang === "uikit" ? "ios" : "android";
  const setScale = (v: number) => setDraft((d) => ({ ...d, scale: { ...d.scale, [lang]: v } }));
  return (
    <Dialog title={t("Unit scale")} open onClose={onClose}>
      <div className={styles.unitScale}>
        <Select label={t("Code language")} value={lang} options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))} onChange={(v) => setLang(v as Language)} />
        {css ? (
          <NumericInput label={t("Inspection scale factor")} value={draft.scale.css} min={0.1} max={1000} precision={2} onChange={(v) => setScale(Math.max(0.1, Math.round(v * 100) / 100))} />
        ) : (
          <Select
            label={t("Scale factor")}
            value={String(NATIVE_SCALES.find((s) => Math.abs(s.value - draft.scale[lang]) < 1e-6)?.value ?? 1)}
            options={NATIVE_SCALES.map((s) => ({ value: String(s.value), label: s.label }))}
            onChange={(v) => setScale(Number(v))}
          />
        )}
      </div>
      <div className={styles.hint}>{t(SCALE_DESCRIPTION[platform])}</div>
      {css && <Checkbox label={t("Only apply rem on text")} checked={draft.remOnText} onChange={(v) => setDraft((d) => ({ ...d, remOnText: v === true }))} />}
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
