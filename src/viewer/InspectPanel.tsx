/**
 * Dev Mode's Inspect panel (help.figma.com "Guide to Dev Mode" A–J, "Guide to inspecting", "Use code snippets in
 * Dev Mode"; docs/research/figma/R9-dev-mode.md), read-only:
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
import { Button, CodeBlock, Dialog, EmptyState, Icon, IconButton, PanelSection, ScrollArea, SegmentedControl, Swatch, showToast } from "@/ds";
import { useCurrentPage, useSelection } from "@/engine/hooks";
import type { Effect, Guid, NodeChange, Paint } from "@/engine/codec";
import { cssLines, cssSnippet } from "./inspect/css";
import { cornersOf, cssColor, hexOf, isAutoLayout, num, paddingOf, rotationOf, sizingOf, typeLabel, typographyOf, visibleEffects, visiblePaints } from "./inspect/model";
import { compose, swiftUI } from "./inspect/native";
import { useViewer } from "./context";
import { layerIcon } from "./LeftPanel";
import type { VariableUse } from "./viewerDoc";
import { AnnotationsSection, AssetsSection, CodeSettings, ExportSection } from "./DevSections";
import { listRows, STATUS_LABEL } from "./inspect/devMode";
import { composeInUnit, cssInUnit, storedUnits, storeUnits, swiftUIInUnit, type Language, type UnitSettings } from "./inspect/units";
import styles from "./Viewer.module.css";

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

/** The code settings every section reads: the language and its units. */
interface CodeChoice {
  language: Language;
  units: UnitSettings;
  onLanguage: (l: Language) => void;
  onUnits: (u: UnitSettings) => void;
}

export function InspectPanel({ onPresent }: { onPresent?: () => void }) {
  const { store, preview } = useViewer();
  const selection = useSelection(store);
  const [language, setLanguage] = useState<Language>(storedLanguage);
  const [units, setUnits] = useState<UnitSettings>(storedUnits);
  const onUnits = (u: UnitSettings) => {
    setUnits(u);
    storeUnits(u);
  };
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
        <span className={styles.grow} />
        {onPresent && <IconButton icon="24.play" label="Present" shortcut="⌥⌘↩" onClick={onPresent} />}
      </div>
      <ScrollArea className={styles.rightBody}>
        {!inspect ? (
          <EmptyState icon="24.info" title="Inspect is off" body="The person who shared this preview turned off Inspect." />
        ) : selection.refs.length === 0 ? (
          <NothingSelected code={{ language, units, onLanguage: choose, onUnits }} />
        ) : selection.refs.length > 1 ? (
          <div className={styles.multi}>{selection.refs.length} layers selected</div>
        ) : (
          <LayerInspect key={selection.refs[0]} id={selection.refs[0]} code={{ language, units, onLanguage: choose, onUnits }} />
        )}
      </ScrollArea>
    </aside>
  );
}

function LanguageSelect({ code }: { code: CodeChoice }) {
  return <CodeSettings language={code.language} units={code.units} onLanguage={code.onLanguage} onUnits={code.onUnits} />;
}

// ---- Nothing selected ------------------------------------------------------------------------------------------

function NothingSelected({ code }: { code: CodeChoice }) {
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
      <PanelSection title="Code" actions={<LanguageSelect code={code} />}>
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

function LayerInspect({ id, code }: { id: Guid; code: CodeChoice }) {
  const { engine, doc, preview } = useViewer();
  const input = useMemo(() => doc.inspect(id), [doc, id]);
  const page = engine.getSelection().pageId;
  const status = useMemo(() => doc.statuses(page).find((s) => s.id === id)?.status ?? null, [doc, page, id]);
  const notes = useMemo(() => doc.annotations(page).find((a) => a.id === id)?.notes ?? [], [doc, page, id]);
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
        {status && (
          <span className={styles.devStatus} data-status={status}>
            {STATUS_LABEL[status]}
          </span>
        )}
      </div>
      <AnnotationsSection notes={notes} />
      <ComponentSection id={id} />
      <LayoutSection node={n} sizing={sizingOf(input)} parentBox={doc.parentOf(id) ? doc.pageBox(doc.parentOf(id)!) : null} box={doc.pageBox(id)} />
      <CodeSection input={input} code={code} />
      <ColorsSection node={n} variables={input.variables} styles={input.styles ?? {}} />
      {n.type === "TEXT" && <TypographySection node={n} styleName={input.styles?.text} variables={input.variables} />}
      <EffectsSection effects={visibleEffects(n.effects)} styleName={input.styles?.effect} />
      {preview.manifest.options.export && <AssetsSection id={id} />}
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

/** "Code" / "List": the snippets, or the properties they set with their values ("Code (default)"). */
const VIEW_KEY = "designer-viewer-code-view";
function storedView(): "code" | "list" {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "code";
  } catch {
    return "code";
  }
}

function CodeSection({ input, code }: { input: NonNullable<ReturnType<ReturnType<typeof useViewer>["doc"]["inspect"]>>; code: CodeChoice }) {
  const { language, units } = code;
  const [view, setView] = useState<"code" | "list">(storedView);
  const choose = (v: "code" | "list") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // this visit only
    }
  };
  const blocks = useMemo(() => {
    if (language === "swiftui") return [{ title: "SwiftUI", code: swiftUIInUnit(swiftUI(input), units) }];
    if (language === "compose") return [{ title: "Compose", code: composeInUnit(compose(input), units) }];
    const s = cssSnippet(input);
    return [
      { title: "Layout", code: cssInUnit(cssLines(s.layout), units) },
      { title: "Style", code: cssInUnit(cssLines(s.style), units) },
      { title: "Typography", code: s.typography.length ? cssInUnit(cssLines(s.typography, s.textStyle), units) : "" },
    ].filter((b) => b.code);
  }, [input, language, units]);
  const rows = useMemo(() => {
    if (view !== "list") return [];
    const s = cssSnippet(input);
    const conv = (v: string) => cssInUnit(v, units);
    return [
      { title: "Layout", rows: listRows(s.layout) },
      { title: "Style", rows: listRows(s.style) },
      { title: "Typography", rows: listRows(s.typography) },
    ]
      .filter((g) => g.rows.length)
      .map((g) => ({ ...g, rows: g.rows.map((r) => ({ ...r, value: conv(r.value) })) }));
  }, [input, view, units]);
  const toggle = (
    <span className={styles.codeActions}>
      <SegmentedControl
        label="Code or list"
        value={view}
        options={[
          { value: "code", label: "Code" },
          { value: "list", label: "List" },
        ]}
        onChange={(v) => choose(v as "code" | "list")}
      />
      <LanguageSelect code={code} />
    </span>
  );
  return (
    <PanelSection title="Code" actions={toggle}>
      {view === "code" ? (
        <div className={styles.code} data-language={language}>
          {blocks.map((b) => (
            <div key={b.title} className={styles.codeGroup}>
              {blocks.length > 1 && <div className={styles.codeTitle}>{b.title}</div>}
              <CodeBlock code={b.code} label="Copy" />
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.list} data-list-view="">
          {rows.map((g) => (
            <div key={g.title}>
              <div className={styles.codeTitle}>{g.title}</div>
              {g.rows.map((r, i) => (
                <Value key={`${r.label}${i}`} label={r.label} value={r.value} copyText={r.value} />
              ))}
            </div>
          ))}
        </div>
      )}
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
