/**
 * Dev Mode's Inspect panel (help.figma.com "Guide to Dev Mode" A–J, "Guide to inspecting", "Use code snippets in
 * Dev Mode"; docs/research/figma/dev-mode.md), read-only:
 *
 * - nothing selected: the page, the code language (CSS, iOS, Android), the file's variables ("Open variables table");
 * - a layer: its name and type; the component it comes from; the box model (size, position in its parent, padding);
 *   the code in the chosen language (CSS in Figma's groups Layout / Style / Typography, each with Copy); the colours
 *   with their variables (collection and mode) or styles; typography with its text style; effects; Export (PNG / JPG
 *   at 0.5×–4×, rendered here by the engine) when the preview allows it.
 *
 * Every value is copied with a click.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Button, CodeBlock, Dialog, EmptyState, Icon, PanelSection, ScrollArea, Select, Swatch, showToast } from "@/ds";
import { useCurrentPage, useSelection } from "@/engine/hooks";
import type { Effect, Guid, NodeChange, Paint } from "@/engine/codec";
import { cssLines, cssSnippet } from "./inspect/css";
import { cornersOf, cssColor, hexOf, isAutoLayout, num, paddingOf, rotationOf, sizingOf, typeLabel, typographyOf, visibleEffects, visiblePaints } from "./inspect/model";
import { compose, swiftUI } from "./inspect/native";
import { useViewer } from "./context";
import { layerIcon } from "./LeftPanel";
import type { VariableUse } from "./viewerDoc";
import styles from "./Viewer.module.css";

type Language = "css" | "swiftui" | "compose";
const LANGUAGES: { value: Language; label: string }[] = [
  { value: "css", label: "CSS" },
  { value: "swiftui", label: "iOS (SwiftUI)" },
  { value: "compose", label: "Android (Compose)" },
];
const LANGUAGE_KEY = "designer-viewer-language";

function storedLanguage(): Language {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return v === "swiftui" || v === "compose" ? v : "css";
  } catch {
    return "css";
  }
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => showToast({ message: "Copied to clipboard" }),
    () => showToast({ message: "Couldn't copy" }),
  );
}

/** A value Dev Mode copies when clicked. */
function Value({ label, value, copyText, lead, sub }: { label?: string; value: ReactNode; copyText: string; lead?: ReactNode; sub?: string | null }) {
  return (
    <button type="button" className={styles.value} onClick={() => copy(copyText)} title="Copy">
      {lead}
      {label && <span className={styles.valueLabel}>{label}</span>}
      <span className={styles.valueText}>{value}</span>
      {sub && <span className={styles.valueSub}>{sub}</span>}
    </button>
  );
}

export function InspectPanel() {
  const { store, preview } = useViewer();
  const selection = useSelection(store);
  const [language, setLanguage] = useState<Language>(storedLanguage);
  const choose = (l: Language) => {
    setLanguage(l);
    try {
      localStorage.setItem(LANGUAGE_KEY, l);
    } catch {
      // the choice lasts this session
    }
  };
  const inspect = preview.manifest.options.inspect;
  return (
    <aside className={styles.right} aria-label="Inspect panel" data-panel="inspect">
      <div className={styles.rightHeader}>
        <span className={styles.rightTab} aria-current="page">
          Inspect
        </span>
      </div>
      <ScrollArea className={styles.rightBody}>
        {!inspect ? (
          <EmptyState icon="24.info" title="Inspect is off" body="The person who shared this preview turned off Inspect." />
        ) : selection.refs.length === 0 ? (
          <NothingSelected language={language} onLanguage={choose} />
        ) : selection.refs.length > 1 ? (
          <div className={styles.multi}>{selection.refs.length} layers selected</div>
        ) : (
          <LayerInspect key={selection.refs[0]} id={selection.refs[0]} language={language} onLanguage={choose} />
        )}
      </ScrollArea>
    </aside>
  );
}

function LanguageSelect({ language, onLanguage }: { language: Language; onLanguage: (l: Language) => void }) {
  return <Select label="Language" value={language} options={LANGUAGES} onChange={(v) => onLanguage(v as Language)} variant="ghost" width="hug" />;
}

// ---- Nothing selected ------------------------------------------------------------------------------------------

function NothingSelected({ language, onLanguage }: { language: Language; onLanguage: (l: Language) => void }) {
  const { engine, store, preview } = useViewer();
  const page = useCurrentPage(store);
  const pageInfo = preview.manifest.pages.find((p) => p.id === page);
  const [table, setTable] = useState(false);
  const collections = useMemo(() => {
    try {
      return engine.variableCollections({ includeRemote: true });
    } catch {
      return [];
    }
  }, [engine]);
  const count = collections.reduce((n, c) => n + c.variableIds.length, 0);
  return (
    <>
      <div className={styles.layerHeader}>
        <Icon name="16.page" />
        <div className={styles.layerTitle}>
          <span className={styles.layerName}>{pageInfo?.name ?? "Page"}</span>
          <span className={styles.layerType}>Page</span>
        </div>
      </div>
      <PanelSection title="Code" actions={<LanguageSelect language={language} onLanguage={onLanguage} />}>
        <div className={styles.hint}>Select a layer to see its code.</div>
      </PanelSection>
      {pageInfo && pageInfo.frames.length > 0 && (
        <PanelSection title="Frames">
          {pageInfo.frames.map((f) => (
            <button
              key={f.id}
              type="button"
              className={styles.frameRow}
              onClick={() => {
                engine.setSelection([f.id]);
                engine.command("ZOOM_TO_SELECTION");
              }}
            >
              <Icon name={f.type === "SECTION" ? "16.section" : f.type === "SYMBOL" ? "16.component" : f.type === "INSTANCE" ? "16.instance" : "16.frame"} />
              <span>{f.name}</span>
            </button>
          ))}
        </PanelSection>
      )}
      <PanelSection title="Variables">
        {count ? (
          <Button variant="secondary" onClick={() => setTable(true)}>
            Open variables table
          </Button>
        ) : (
          <div className={styles.hint}>This file has no variables.</div>
        )}
      </PanelSection>
      {table && <VariablesTable onClose={() => setTable(false)} />}
    </>
  );
}

function formatResolved(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object" && v && "r" in v) return cssColor(v as { r: number; g: number; b: number; a: number });
  if (typeof v === "number") return num(v);
  return String(v);
}

/** Dev Mode's read-only variables table: every collection's variables, one column per mode; a click copies. */
function VariablesTable({ onClose }: { onClose: () => void }) {
  const { engine } = useViewer();
  const collections = useMemo(() => engine.variableCollections({ includeRemote: true }), [engine]);
  const [current, setCurrent] = useState(collections[0]?.id ?? "");
  const c = collections.find((x) => x.id === current) ?? collections[0];
  const vars = useMemo(() => (c ? engine.variables(c.id, { includeRemote: true }) : []), [engine, c]);
  return (
    <Dialog title="Variables" size="large" open onClose={onClose}>
      <div className={styles.varsLayout}>
        <nav className={styles.varsNav} aria-label="Collections">
          {collections.map((x) => (
            <button key={x.id} type="button" className={styles.varsCollection} aria-current={x.id === c?.id || undefined} onClick={() => setCurrent(x.id)}>
              {x.name}
            </button>
          ))}
        </nav>
        <div className={styles.varsTable} role="table" aria-label={c?.name}>
          <div className={styles.varsRow} role="row">
            <span role="columnheader">Name</span>
            {c?.modes.map((m) => (
              <span key={m.modeId} role="columnheader">
                {m.name}
              </span>
            ))}
          </div>
          {vars.map((v) => (
            <div key={v.id} className={styles.varsRow} role="row">
              <button type="button" role="cell" className={styles.varsCell} onClick={() => copy(v.name)}>
                {v.name}
              </button>
              {c?.modes.map((m) => {
                const value = v.resolvedValuesByMode[m.modeId];
                const text = formatResolved(value);
                return (
                  <button key={m.modeId} type="button" role="cell" className={styles.varsCell} onClick={() => copy(text)}>
                    {v.resolvedType === "COLOR" && value && typeof value === "object" ? <Swatch color={hexOf(value as never)} /> : null}
                    {text}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ---- One layer --------------------------------------------------------------------------------------------------

function LayerInspect({ id, language, onLanguage }: { id: Guid; language: Language; onLanguage: (l: Language) => void }) {
  const { engine, doc, preview } = useViewer();
  const input = useMemo(() => doc.inspect(id), [doc, id]);
  if (!input) return <EmptyState icon="24.info" title="This layer can't be inspected" />;
  const n = input.node;
  const tree = doc.tree(engine.getSelection().pageId);
  const row = tree.nodes.get(id);
  return (
    <>
      <div className={styles.layerHeader}>
        <Icon name={row ? layerIcon(row) : "16.frame"} />
        <div className={styles.layerTitle}>
          <span className={styles.layerName}>{n.name || typeLabel(n)}</span>
          <span className={styles.layerType}>{typeLabel(n)}</span>
        </div>
      </div>
      <ComponentSection id={id} />
      <LayoutSection node={n} sizing={sizingOf(input)} parentBox={doc.parentOf(id) ? doc.pageBox(doc.parentOf(id)!) : null} box={doc.pageBox(id)} />
      <CodeSection input={input} language={language} onLanguage={onLanguage} />
      <ColorsSection node={n} variables={input.variables} styles={input.styles ?? {}} />
      {n.type === "TEXT" && <TypographySection node={n} styleName={input.styles?.text} variables={input.variables} />}
      <EffectsSection effects={visibleEffects(n.effects)} styleName={input.styles?.effect} />
      {preview.manifest.options.export && <ExportSection id={id} node={n} />}
    </>
  );
}

function ComponentSection({ id }: { id: Guid }) {
  const { engine } = useViewer();
  const info = useMemo(() => {
    try {
      return engine.componentInfo(id);
    } catch {
      return null;
    }
  }, [engine, id]);
  if (!info || info.kind === "NONE" || info.kind === "COMPONENT_SUBLAYER" || info.kind === "INSTANCE_SUBLAYER") return null;
  const variant = info.variantProperties ? Object.entries(info.variantProperties) : [];
  const props = info.properties.filter((p) => p.type !== "VARIANT");
  return (
    <PanelSection title={info.kind === "INSTANCE" || info.kind === "NESTED_INSTANCE" ? "Instance" : "Component"}>
      {info.main && <Value label="Main component" value={info.main.name} copyText={info.main.name} />}
      {variant.map(([k, v]) => (
        <Value key={k} label={k} value={v} copyText={`${k}=${v}`} />
      ))}
      {props.map((p) => (
        <Value key={p.id} label={p.name} value={String(p.value ?? p.defaultValue ?? "")} copyText={String(p.value ?? p.defaultValue ?? "")} />
      ))}
    </PanelSection>
  );
}

function LayoutSection({ node, sizing, box, parentBox }: { node: NodeChange; sizing: { width: string; height: string }; box: { x: number; y: number; width: number; height: number } | null; parentBox: { x: number; y: number } | null }) {
  const size = node.size ?? { x: 0, y: 0 };
  const left = box ? box.x - (parentBox?.x ?? 0) : 0;
  const top = box ? box.y - (parentBox?.y ?? 0) : 0;
  const auto = isAutoLayout(node);
  const p = auto ? paddingOf(node) : null;
  const rot = rotationOf(node);
  const corners = cornersOf(node);
  return (
    <PanelSection title="Layout">
      <div className={styles.boxModel} aria-label="Box model">
        {p && (
          <>
            <span className={styles.boxModelLabel}>Padding</span>
            <button type="button" className={styles.boxTop} onClick={() => copy(`${num(p.top)}px`)}>
              {num(p.top)}
            </button>
            <button type="button" className={styles.boxRight} onClick={() => copy(`${num(p.right)}px`)}>
              {num(p.right)}
            </button>
            <button type="button" className={styles.boxBottom} onClick={() => copy(`${num(p.bottom)}px`)}>
              {num(p.bottom)}
            </button>
            <button type="button" className={styles.boxLeft} onClick={() => copy(`${num(p.left)}px`)}>
              {num(p.left)}
            </button>
          </>
        )}
        <button type="button" className={styles.boxSize} onClick={() => copy(`width: ${num(size.x)}px;\nheight: ${num(size.y)}px;`)}>
          {num(size.x)} × {num(size.y)}
        </button>
      </div>
      <div className={styles.grid2}>
        <Value label="Width" value={`${num(size.x)}px`} sub={sizing.width !== "Fixed" ? sizing.width : null} copyText={`${num(size.x)}px`} />
        <Value label="Height" value={`${num(size.y)}px`} sub={sizing.height !== "Fixed" ? sizing.height : null} copyText={`${num(size.y)}px`} />
        <Value label="Left" value={`${num(left)}px`} copyText={`${num(left)}px`} />
        <Value label="Top" value={`${num(top)}px`} copyText={`${num(top)}px`} />
        {rot !== 0 && <Value label="Rotation" value={`${num(rot)}°`} copyText={`${num(rot)}deg`} />}
        {corners && <Value label="Radius" value={corners.tl === corners.tr && corners.tr === corners.br && corners.br === corners.bl ? `${num(corners.tl)}px` : `${num(corners.tl)} ${num(corners.tr)} ${num(corners.br)} ${num(corners.bl)}`} copyText={`${num(corners.tl)}px`} />}
        {node.opacity !== undefined && node.opacity < 1 && <Value label="Opacity" value={`${num(node.opacity * 100)}%`} copyText={num(node.opacity)} />}
      </div>
      {auto && (
        <div className={styles.grid2}>
          <Value label="Auto layout" value={node.stackMode === "HORIZONTAL" ? "Horizontal" : "Vertical"} copyText={node.stackMode === "HORIZONTAL" ? "row" : "column"} />
          <Value label="Gap" value={node.stackPrimaryAlignItems === "SPACE_BETWEEN" ? "Auto" : `${num(node.stackSpacing ?? 0)}px`} copyText={`${num(node.stackSpacing ?? 0)}px`} />
        </div>
      )}
    </PanelSection>
  );
}

function CodeSection({ input, language, onLanguage }: { input: NonNullable<ReturnType<ReturnType<typeof useViewer>["doc"]["inspect"]>>; language: Language; onLanguage: (l: Language) => void }) {
  const blocks = useMemo(() => {
    if (language === "swiftui") return [{ title: "SwiftUI", code: swiftUI(input) }];
    if (language === "compose") return [{ title: "Compose", code: compose(input) }];
    const s = cssSnippet(input);
    return [
      { title: "Layout", code: cssLines(s.layout) },
      { title: "Style", code: cssLines(s.style) },
      { title: "Typography", code: s.typography.length ? cssLines(s.typography, s.textStyle) : "" },
    ].filter((b) => b.code);
  }, [input, language]);
  return (
    <PanelSection title="Code" actions={<LanguageSelect language={language} onLanguage={onLanguage} />}>
      <div className={styles.code} data-language={language}>
        {blocks.map((b) => (
          <div key={b.title} className={styles.codeGroup}>
            {blocks.length > 1 && <div className={styles.codeTitle}>{b.title}</div>}
            <CodeBlock code={b.code} label="Copy" />
          </div>
        ))}
      </div>
    </PanelSection>
  );
}

function paintRow(p: Paint, i: number, list: "fillPaints" | "strokePaints", variables: Record<string, VariableUse>, styleName: string | undefined) {
  const v = variables[`${list}[${i}].color`];
  const opacity = (p.opacity ?? 1) * (p.color?.a ?? 1);
  if (p.type === "SOLID" && p.color) {
    const hex = hexOf(p.color);
    const name = v?.name ?? styleName ?? null;
    return (
      <Value
        key={`${list}${i}`}
        lead={<Swatch color={hex} opacity={Math.round(opacity * 100)} />}
        value={name ?? hex}
        sub={name ? `${hex}${opacity < 1 ? ` · ${num(opacity * 100)}%` : ""}${v?.collection ? ` · ${v.collection}${v.mode ? ` / ${v.mode}` : ""}` : ""}` : opacity < 1 ? `${num(opacity * 100)}%` : null}
        copyText={name ?? hex}
      />
    );
  }
  const label = p.type === "IMAGE" ? "Image" : p.type === "GRADIENT_LINEAR" ? "Linear gradient" : p.type === "GRADIENT_RADIAL" ? "Radial gradient" : p.type === "GRADIENT_ANGULAR" ? "Angular gradient" : p.type === "GRADIENT_DIAMOND" ? "Diamond gradient" : String(p.type);
  const stops = (p.stops ?? []).map((s) => `${cssColor(s.color)} ${num(s.position * 100)}%`).join(", ");
  return <Value key={`${list}${i}`} lead={<Icon name={p.type === "IMAGE" ? "16.image" : "16.variable.color"} />} value={styleName ?? label} sub={stops || null} copyText={stops || label} />;
}

function ColorsSection({ node, variables, styles: names }: { node: NodeChange; variables: Record<string, VariableUse>; styles: { fill?: string; stroke?: string } }) {
  const fills = visiblePaints(node.fillPaints);
  const strokes = visiblePaints(node.strokePaints);
  if (!fills.length && !strokes.length) return null;
  return (
    <PanelSection title="Colors">
      {fills.length > 0 && <div className={styles.subTitle}>{node.type === "TEXT" ? "Text" : "Fill"}</div>}
      {fills.map((p) => paintRow(p, (node.fillPaints ?? []).indexOf(p), "fillPaints", variables, names.fill))}
      {strokes.length > 0 && (
        <>
          <div className={styles.subTitle}>
            Stroke · {num(node.strokeWeight ?? 1)}px {(node.strokeAlign ?? "INSIDE").toLowerCase()}
          </div>
          {strokes.map((p) => paintRow(p, (node.strokePaints ?? []).indexOf(p), "strokePaints", variables, names.stroke))}
        </>
      )}
    </PanelSection>
  );
}

function TypographySection({ node, styleName, variables }: { node: NodeChange; styleName?: string; variables: Record<string, VariableUse> }) {
  const t = typographyOf(node);
  const lh = t.lineHeightPx === null ? "Auto" : `${num(t.lineHeightPx)}px`;
  return (
    <PanelSection title="Typography">
      <div className={styles.typePreview}>
        {styleName && <span className={styles.typeStyle}>{styleName}</span>}
        <span>
          {t.family} · {t.style}
        </span>
      </div>
      <div className={styles.grid2}>
        <Value label="Font" value={variables.FONT_FAMILY?.name ?? t.family} copyText={t.family} />
        <Value label="Weight" value={`${t.weight}`} sub={t.style} copyText={String(t.weight)} />
        <Value label="Size" value={variables.FONT_SIZE?.name ?? `${num(t.size)}px`} copyText={`${num(t.size)}px`} />
        <Value label="Line height" value={variables.LINE_HEIGHT?.name ?? lh} sub={t.lineHeightPercent !== null ? `${num(t.lineHeightPercent)}%` : null} copyText={lh === "Auto" ? "normal" : lh} />
        <Value label="Letter spacing" value={variables.LETTER_SPACING?.name ?? `${num(t.letterSpacingPx)}px`} sub={t.letterSpacingPercent !== null ? `${num(t.letterSpacingPercent)}%` : null} copyText={`${num(t.letterSpacingPx)}px`} />
        {t.align !== "LEFT" && <Value label="Align" value={t.align.charAt(0) + t.align.slice(1).toLowerCase()} copyText={t.align.toLowerCase()} />}
      </div>
      {node.textData?.characters && (
        <Value label="Content" value={<span className={styles.content}>{node.textData.characters}</span>} copyText={node.textData.characters} />
      )}
    </PanelSection>
  );
}

const EFFECT_NAMES: Record<string, string> = { DROP_SHADOW: "Drop shadow", INNER_SHADOW: "Inner shadow", FOREGROUND_BLUR: "Layer blur", BACKGROUND_BLUR: "Background blur", NOISE: "Noise", GRAIN: "Texture", GLASS: "Glass" };

function EffectsSection({ effects, styleName }: { effects: Effect[]; styleName?: string }) {
  if (!effects.length) return null;
  return (
    <PanelSection title="Effects">
      {styleName && <div className={styles.subTitle}>{styleName}</div>}
      {effects.map((e, i) => {
        const shadow = e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW";
        const text = shadow
          ? `${num(e.offset?.x ?? 0)}px ${num(e.offset?.y ?? 0)}px ${num(e.radius ?? 0)}px ${num(e.spread ?? 0)}px ${cssColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 })}`
          : `${num(e.radius ?? 0)}px`;
        return <Value key={i} label={EFFECT_NAMES[e.type] ?? e.type} value={text} copyText={text} />;
      })}
    </PanelSection>
  );
}

const SCALES = ["0.5", "0.75", "1", "1.5", "2", "3", "4"];

function ExportSection({ id, node }: { id: Guid; node: NodeChange }) {
  const { engine } = useViewer();
  const [scale, setScale] = useState("2");
  const [format, setFormat] = useState<"PNG" | "JPG">("PNG");
  const [busy, setBusy] = useState(false);
  const name = node.name || typeLabel(node);
  const run = async () => {
    setBusy(true);
    try {
      const size = node.size ?? { x: 1, y: 1 };
      const px = engine.renderNodeThumbnailPixels({ node: id, maxSize: Math.max(1, Math.ceil(Math.max(size.x, size.y) * Number(scale))) });
      if (!px) throw new Error("nothing to export");
      const canvas = document.createElement("canvas");
      canvas.width = px.width;
      canvas.height = px.height;
      const ctx = canvas.getContext("2d")!;
      const image = new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height);
      if (format === "JPG") {
        const tmp = document.createElement("canvas");
        tmp.width = px.width;
        tmp.height = px.height;
        tmp.getContext("2d")!.putImageData(image, 0, 0);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, px.width, px.height);
        ctx.drawImage(tmp, 0, 0);
      } else ctx.putImageData(image, 0, 0);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, format === "PNG" ? "image/png" : "image/jpeg", 0.92));
      if (!blob) throw new Error("the image couldn't be encoded");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name.replace(/[/\\:]/g, "-")}${scale === "1" ? "" : `@${scale}x`}.${format.toLowerCase()}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      showToast({ message: `Couldn't export: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelSection title="Export">
      <div className={styles.exportRow}>
        <Select label="Scale" value={scale} options={SCALES.map((s) => ({ value: s, label: `${s}x` }))} onChange={setScale} width={72} />
        <Select label="Format" value={format} options={[{ value: "PNG", label: "PNG" }, { value: "JPG", label: "JPG" }]} onChange={(v) => setFormat(v as "PNG" | "JPG")} width={80} />
      </div>
      <Button variant="secondary" fullWidth loading={busy} onClick={() => void run()}>
        Export {name}
      </Button>
    </PanelSection>
  );
}
