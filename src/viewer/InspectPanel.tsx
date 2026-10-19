/**
 * Dev Mode's Inspect panel (help.figma.com "Guide to Dev Mode" A–J, "Guide to inspecting", "Use code snippets in
 * Dev Mode"; docs/research/figma/R9-dev-mode.md), read-only:
 *
 * - nothing selected: the page, the code language (CSS, iOS, Android), the file's variables ("Open variables table");
 * - a layer: its name and type; the component it comes from; the box model (size, position in its parent, padding);
 *   the code in the chosen language (Figma's sections — CSS: Layout / Position / Other / Typography / Style — each
 *   with Copy, its hints and "Show N more"); the colours with their variables (collection and mode) or styles;
 *   typography with its text style; effects; Export (PNG / JPG at 0.5×–4×, rendered here by the engine) when the
 *   preview allows it.
 *
 * Every value is copied with a click.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Button, CodeBlock, Dialog, EmptyState, Icon, IconButton, MenuButton, PanelSection, ScrollArea, SegmentedControl, Swatch, Tabs, showToast, type MenuEntry } from "@/ds";
import { useCurrentPage, useSelection } from "@/engine/hooks";
import type { Effect, Guid, NodeChange, Paint } from "@/engine/codec";
import { cssSnippet, isVectorClass } from "./inspect/css";
import { renderEngineExport } from "@/editor/exportCore";
import { codeSections } from "./inspect/codegen";
import { CodeSections } from "./inspect/CodeSections";
import { cornersOf, cssColor, hexOf, isAutoLayout, isMirrored, isTextLike, num, paddingOf, rotationOf, typeLabel, typographyOf, visibleEffects, visiblePaints } from "./inspect/model";
import { useViewer, type CodegenHost, type CodegenLanguage } from "./context";
import { layerIcon } from "./LeftPanel";
import type { VariableUse } from "./viewerDoc";
import { AnnotationsSection, AssetsSection, CodeSettings, ExportSection, type PluginLanguages } from "./DevSections";
import { CodeConnectSection } from "./inspect/CodeConnectSection";
import { McpSection } from "./inspect/McpSection";
import { DevResourcesSection } from "./inspect/DevResources";
import { DevTimeline, MotionTab, motionOf } from "./inspect/MotionTab";
import { t, useT } from "@/i18n";
import { editedAgo, listRows } from "./inspect/devMode";
import { StatusTag } from "@/editor/devmode/StatusTag";
import { cssValueInUnit, storedUnits, storeUnits, UNITS, type Language, type UnitSettings } from "./inspect/units";
import styles from "./Viewer.module.css";

const LANGUAGE_KEY = "designer-viewer-language";

function storedLanguage(): Language {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return v && v in UNITS ? (v as Language) : "css";
  } catch {
    return "css";
  }
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => showToast({ message: t("Copied to clipboard") }),
    () => showToast({ message: t("Couldn't copy") }),
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
  /** Codegen plugins' languages (the editor's Dev Mode) */
  plugins?: PluginLanguages;
}

const NO_LANGUAGES: CodegenLanguage[] = [];
const NO_SUBSCRIBE = () => () => {};

/** The codegen plugins' languages and the one chosen (none: the built-in code). */
function usePluginLanguages(codegen: CodegenHost | undefined): PluginLanguages | undefined {
  const list = useSyncExternalStore(codegen ? codegen.subscribe : NO_SUBSCRIBE, () => (codegen ? codegen.languages() : NO_LANGUAGES));
  const [current, setCurrent] = useState<CodegenLanguage | null>(null);
  const live = current && list.some((l) => l.pluginId === current.pluginId && l.value === current.value) ? current : null;
  useEffect(() => {
    codegen?.select(live);
  }, [codegen, live]);
  useEffect(() => () => codegen?.select(null), [codegen]);
  if (!codegen) return undefined;
  return { list, current: live, onPick: setCurrent };
}

/** A second tab beside Inspect (the editor's Dev Mode: "Plugins", docs/plugins.md §7). */
export interface ExtraTab {
  label: string;
  render(): ReactNode;
}

export interface InspectPanelProps {
  onPresent?: () => void;
  extraTab?: ExtraTab;
  /** Above the tabs (the editor's Dev Mode: the account, Present and Share) */
  header?: ReactNode;
  /** At the tabs row's right (the editor's Dev Mode: the zoom menu) */
  tabsEnd?: ReactNode;
  /** The tab when the host keeps it (the editor's Dev Mode: ⌥8 / ⌥9 and the rail's Plugins) */
  tab?: "inspect" | "extra";
  onTab?: (tab: "inspect" | "extra") => void;
  /** The panel's width; `children`: its resize handle */
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * The panel (the owner's capture owner-2026-10-18/figma-devmode-inspect; live devmode-inspect-right.txt): the host's
 * header, the tabs row (Inspect, Motion for an animated layer, the host's Plugins; the zoom at its right), then the tab.
 */
export function InspectPanel({ onPresent, extraTab, header, tabsEnd, tab: hostTab, onTab, style, children }: InspectPanelProps) {
  useT();
  const { engine, store, preview, host } = useViewer();
  const [ownTab, setOwnTab] = useState<"inspect" | "extra" | "motion">("inspect");
  // The host's choice between Inspect and its own tab wins; Motion stays this panel's own.
  const tab = hostTab === "extra" ? "extra" : ownTab === "extra" && hostTab ? "inspect" : ownTab;
  const setTab = (next: "inspect" | "extra" | "motion") => {
    setOwnTab(next);
    if (onTab) onTab(next === "extra" ? "extra" : "inspect");
  };
  const [aside, setAside] = useState<HTMLElement | null>(null);
  const [timeline, setTimeline] = useState<string | null>(null);
  const plugins = usePluginLanguages(host?.dev?.codegen);
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
  // The Motion tab: one layer selected that is, or holds, an animated layer (docs/motion.md §8.2).
  const one = selection.refs.length === 1 ? selection.refs[0] : null;
  const motion = useMemo(() => (inspect && one ? motionOf(engine, one) : null), [engine, inspect, one]);
  const shown = tab === "motion" && !motion ? "inspect" : tab;
  // The timeline view stays open while the selection is in its root.
  const timelineRoot = motion && timeline === motion.root ? timeline : null;
  return (
    <aside ref={setAside} className={styles.right} style={style} aria-label={t("Inspect panel")} data-panel="inspect">
      {header}
      <div className={styles.rightTabs}>
        <Tabs
          label={t("Inspect panel")}
          idBase="inspect"
          value={shown}
          tabs={[
            { value: "inspect", label: t("Inspect") },
            ...(motion ? [{ value: "motion", label: t("Motion") }] : []),
            ...(extraTab ? [{ value: "extra", label: extraTab.label }] : []),
          ]}
          onChange={(v) => setTab(v as "inspect" | "extra" | "motion")}
        />
        <span className={styles.grow} />
        {onPresent && <IconButton icon="24.play" label={t("Present")} shortcut="⌥⌘↩" onClick={onPresent} />}
        {tabsEnd}
      </div>
      <ScrollArea className={styles.rightBody} role="tabpanel" id={`inspect-panel-${shown}`} aria-labelledby={`inspect-tab-${shown}`}>
        {extraTab && shown === "extra" ? (
          extraTab.render()
        ) : motion && one && shown === "motion" ? (
          <MotionTab key={one} engine={engine} id={one} units={units} onTimeline={(open) => setTimeline(open ? motion.root : null)} />
        ) : !inspect ? (
          <EmptyState icon="24.info" title="Inspect is off" body="The person who shared this preview turned off Inspect." />
        ) : selection.refs.length === 0 ? (
          <NothingSelected code={{ language, units, onLanguage: choose, onUnits, plugins }} />
        ) : selection.refs.length > 1 ? (
          <div className={styles.multi}>{selection.refs.length} layers selected</div>
        ) : (
          <LayerInspect key={selection.refs[0]} id={selection.refs[0]} code={{ language, units, onLanguage: choose, onUnits, plugins }} />
        )}
      </ScrollArea>
      {timelineRoot && <DevTimeline engine={engine} root={timelineRoot} panel={aside} onClose={() => setTimeline(null)} />}
      {children}
    </aside>
  );
}

function LanguageSelect({ code }: { code: CodeChoice }) {
  return <CodeSettings language={code.language} units={code.units} onLanguage={code.onLanguage} onUnits={code.onUnits} plugins={code.plugins} />;
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

/**
 * One layer, in Figma's order (the owner's capture owner-2026-10-18/figma-devmode-inspect): the selection header —
 * its name with Copy link, the `</>` (its status menu) and ⋯, its type under it —, MCP, Code Connect, its notes, the
 * component it comes from, dev resources, Layer properties (the box model, List | Code and the language, the code),
 * then Colors, Typography, Effects, Assets and Export.
 */
function LayerInspect({ id, code }: { id: Guid; code: CodeChoice }) {
  useT();
  const { engine, doc, preview, host } = useViewer();
  const input = useMemo(() => doc.inspect(id), [doc, id]);
  const page = engine.getSelection().pageId;
  const status = useMemo(() => doc.statuses(page).find((s) => s.id === id) ?? null, [doc, page, id]);
  const notes = useMemo(() => doc.annotations(page).find((a) => a.id === id)?.notes ?? [], [doc, page, id]);
  const info = useMemo(() => {
    try {
      return engine.componentInfo(id);
    } catch {
      return null;
    }
  }, [engine, id]);
  const [addingLink, setAddingLink] = useState(false);
  const dev = host?.dev;
  if (!input) return <EmptyState icon="24.info" title="This layer can't be inspected" />;
  const n = input.node;
  const tree = doc.tree(engine.getSelection().pageId);
  const row = tree.nodes.get(id);
  // A design: a top-level frame, component or section (its status, Compare changes).
  const design = doc.parentOf(id) === null && (n.type === "FRAME" || n.type === "SYMBOL" || n.type === "SECTION");
  const edited = editedAgo((n as { editInfo?: { lastEditedAt?: number } }).editInfo?.lastEditedAt);
  const more: MenuEntry[] = [
    ...(edited ? [{ header: edited }, "-" as const] : []),
    { id: "copy-name", label: t("Copy layer name") },
    ...(host?.onCompare && design ? [{ id: "compare", label: t("Compare changes") }] : []),
    ...(dev?.canEdit && dev.addDevResource ? [{ id: "add-link", label: t("Add a dev resource link") }] : []),
  ];
  return (
    <>
      <div className={styles.selection} data-selection-header="">
        <div className={styles.selectionTop}>
          <span className={styles.layerName} title={n.name || typeLabel(n)}>
            {n.name || typeLabel(n)}
          </span>
          {host?.onCopyLink && <IconButton icon="24.link" label={t("Copy link")} onClick={() => host.onCopyLink!(id)} />}
          {host?.onStatus && design && <IconButton icon="24.dev-brackets" label={t("Set status")} onClick={(e) => host.onStatus!(id, e.currentTarget.getBoundingClientRect())} data-status-button="" />}
          <MenuButton
            label={t("More options")}
            entries={more}
            onSelect={(a) => {
              if (a === "copy-name") copy(n.name ?? "");
              else if (a === "compare") host?.onCompare?.(id);
              else if (a === "add-link") setAddingLink(true);
            }}
            className={styles.selectionMore}
          >
            <Icon name="24.more" />
          </MenuButton>
        </div>
        <div className={styles.selectionType}>
          <Icon name={row ? layerIcon(row) : "16.frame"} />
          <span className={styles.layerType}>{typeLabel(n)}</span>
          {status && (
            <span className={styles.devStatus} data-dev-status={status.workflow}>
              <StatusTag
                workflow={status.workflow}
                dev={status.status}
                variant="chip"
                onClick={host?.onStatus ? (e) => host.onStatus!(id, e.currentTarget.getBoundingClientRect()) : undefined}
              />
            </span>
          )}
        </div>
      </div>
      {host?.mcp && <McpSection id={id} mcp={host.mcp} />}
      <CodeConnectSection id={id} info={info} />
      <AnnotationsSection notes={notes} />
      <ComponentSection id={id} />
      <DevResourcesSection id={id} adding={addingLink} onAdding={setAddingLink} />
      <LayerProperties input={input} code={code} box={doc.pageBox(id)} parentBox={doc.parentOf(id) ? doc.pageBox(doc.parentOf(id)!) : null} />
      <ColorsSection node={n} variables={input.variables} styles={input.styles ?? {}} />
      {isTextLike(n) && <TypographySection node={n} styleName={input.styles?.text} variables={input.variables} />}
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

type Box = { x: number; y: number; width: number; height: number };

/**
 * The box model (live devmode-inspect-right.txt; the owner's capture): the border box — "Border", each side's stroke
 * and each corner's radius —, the padding box — "Padding", each side's —, and the size; around it the distances to the
 * parent, on ticks with a pill each; "border-box" under it. "-" where there is none; a value is copied with a click.
 */
function BoxModel({ node, box, parentBox }: { node: NodeChange; box: Box | null; parentBox: Box | null }) {
  useT();
  const size = node.size ?? { x: 0, y: 0 };
  const p = isAutoLayout(node) ? paddingOf(node) : null;
  const stroke = visiblePaints(node.strokePaints).length ? (node.strokeWeight ?? 1) : 0;
  const corners = cornersOf(node);
  const cell = (value: number, className: string, what: string) =>
    value ? (
      <button type="button" className={className} onClick={() => copy(`${num(value)}px`)} title={what}>
        {num(value)}
      </button>
    ) : (
      <span className={className}>-</span>
    );
  const distances =
    box && parentBox
      ? { top: box.y - parentBox.y, right: parentBox.x + parentBox.width - box.x - box.width, bottom: parentBox.y + parentBox.height - box.y - box.height, left: box.x - parentBox.x }
      : null;
  const padded = !!p && (p.top > 0 || p.right > 0 || p.bottom > 0 || p.left > 0);
  return (
    <div className={styles.boxModel} aria-label={t("Box model")} data-box-model="">
      {distances &&
        (["top", "right", "bottom", "left"] as const).map((side) => (
          <span key={side} className={styles.bmTick} data-side={side}>
            <button type="button" className={styles.bmPill} onClick={() => copy(`${num(distances[side])}px`)}>
              {num(distances[side])}
            </button>
          </span>
        ))}
      <div className={styles.bmBorder}>
        <span className={styles.bmLabel}>{t("Border")}</span>
        {cell(corners?.tl ?? 0, styles.bmTopLeft, t("Radius"))}
        {cell(stroke, styles.bmTop, t("Border"))}
        {cell(corners?.tr ?? 0, styles.bmTopRight, t("Radius"))}
        {cell(stroke, styles.bmLeft, t("Border"))}
        {cell(stroke, styles.bmRight, t("Border"))}
        {cell(corners?.bl ?? 0, styles.bmBottomLeft, t("Radius"))}
        {cell(stroke, styles.bmBottom, t("Border"))}
        {cell(corners?.br ?? 0, styles.bmBottomRight, t("Radius"))}
        <div className={styles.bmPadding} data-padded={padded || undefined}>
          <span className={styles.bmLabel}>{t("Padding")}</span>
          {cell(p?.top ?? 0, styles.bmTop, t("Padding"))}
          {cell(p?.left ?? 0, styles.bmLeft, t("Padding"))}
          {cell(p?.right ?? 0, styles.bmRight, t("Padding"))}
          {cell(p?.bottom ?? 0, styles.bmBottom, t("Padding"))}
          <button type="button" className={styles.bmSize} onClick={() => copy(`width: ${num(size.x)}px;\nheight: ${num(size.y)}px;`)}>
            {num(size.x)} × {num(size.y)}
          </button>
        </div>
      </div>
      <span className={styles.bmCaption}>border-box</span>
    </div>
  );
}

/** "Code" / "List": the snippets, or the properties they set with their values (Figma's default: Code). */
const VIEW_KEY = "designer-viewer-code-view";
function storedView(): "code" | "list" {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "code";
  } catch {
    return "code";
  }
}

/**
 * Layer properties (the owner's capture; live devmode-inspect-right.txt), folded with its chevron: the box model, then
 * List | Code with the language select at the right, then the code sections or the list.
 */
function LayerProperties({ input, code, box, parentBox }: { input: NonNullable<ReturnType<ReturnType<typeof useViewer>["doc"]["inspect"]>>; code: CodeChoice; box: Box | null; parentBox: Box | null }) {
  useT();
  const { language, units } = code;
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<"code" | "list">(storedView);
  const choose = (v: "code" | "list") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // this visit only
    }
  };
  const svg = useVectorSvg(input.node, language === "css");
  const sections = useMemo(() => codeSections(svg ? { ...input, svg } : input, language, units), [input, svg, language, units]);
  const rows = useMemo(() => {
    if (view !== "list") return [];
    const s = cssSnippet(input);
    return [
      { title: "Layout", decls: s.layout },
      { title: "Position", decls: s.position },
      { title: "Other", decls: s.other },
      { title: "Typography", decls: s.typography },
      { title: "Style", decls: s.style },
    ]
      .filter((g) => g.decls.length)
      .map((g) => ({ title: g.title, rows: listRows(g.decls).map((r, i) => ({ ...r, value: cssValueInUnit(g.decls[i].property, r.value, units) })) }));
  }, [input, view, units]);
  const plugin = code.plugins?.current ?? null;
  return (
    <PanelSection title={t("Layer properties")} collapsible open={open} onOpenChange={setOpen} data-layer-properties="">
      {open && (
        <>
          <BoxModel node={input.node} box={box} parentBox={parentBox} />
          <div className={styles.codeBar}>
            {!plugin && (
              <SegmentedControl
                label={t("List or code")}
                value={view}
                options={[
                  { value: "list", label: t("List") },
                  { value: "code", label: t("Code") },
                ]}
                onChange={(v) => choose(v as "code" | "list")}
              />
            )}
            <span className={styles.grow} />
            <LanguageSelect code={code} />
          </div>
          {plugin ? (
            <CodegenBlocks id={input.node.guid} lang={plugin} />
          ) : view === "code" ? (
            <div className={styles.code} data-language={language}>
              <CodeSections sections={sections} />
            </div>
          ) : (
            <div className={styles.list} data-list-view="">
              {rows.map((g) => (
                <div key={g.title}>
                  <div className={styles.codeTitle}>{t(g.title)}</div>
                  {g.rows.map((r, i) => (
                    <Value key={`${r.label}${i}`} label={r.label} value={r.value} copyText={r.value} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </PanelSection>
  );
}

/**
 * A vector's SVG for CSS's SVG section (atlas 14 §5.3): the engine's SVG export of the layer, as Copy as SVG writes it,
 * and whether the layer or a parent is rotated or mirrored (hint 20). None when the file blocks exports.
 */
function useVectorSvg(node: NodeChange, css: boolean): { markup: string; transformed: boolean } | null {
  const { engine, preview, doc } = useViewer();
  const [svg, setSvg] = useState<{ id: Guid; markup: string; transformed: boolean } | null>(null);
  const id = node.guid;
  const wanted = css && !!id && isVectorClass(node) && !!preview.manifest.options.export;
  useEffect(() => {
    if (!wanted || !id) return;
    let live = true;
    void renderEngineExport(engine, (h) => preview.image(h), [id], { imageType: "SVG", constraint: { type: "CONTENT_SCALE", value: 1 }, contentsOnly: true, svgOutlineText: true }).then((r) => {
      if (!live || "error" in r) return;
      let transformed = false;
      for (let at: Guid | null = id; at && !transformed; at = doc.parentOf(at)) {
        const n = engine.readNode(at, { fields: ["transform"] });
        transformed = !!n && (rotationOf(n) !== 0 || isMirrored(n));
      }
      setSvg({ id, markup: new TextDecoder().decode(r.bytes), transformed });
    });
    return () => {
      live = false;
    };
  }, [engine, preview, doc, id, wanted, node]);
  return wanted && svg?.id === id ? { markup: svg.markup, transformed: svg.transformed } : null;
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
      {fills.length > 0 && <div className={styles.subTitle}>{isTextLike(node) ? "Text" : "Fill"}</div>}
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

const EFFECT_NAMES: Record<string, string> = { DROP_SHADOW: "Drop shadow", INNER_SHADOW: "Inner shadow", FOREGROUND_BLUR: "Layer blur", BACKGROUND_BLUR: "Background blur", NOISE: "Noise", GRAIN: "Texture", GLASS: "Glass", CUSTOM: "Shader" };

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

/** A codegen plugin's answer for the layer: its titled code blocks, or Figma's error block (docs/plugins.md §7). */
function CodegenBlocks({ id, lang }: { id: Guid; lang: CodegenLanguage }) {
  const { host } = useViewer();
  const codegen = host?.dev?.codegen;
  const [out, setOut] = useState<{ key: string; blocks: { title: string; code: string; language: string }[]; error: string | null } | null>(null);
  const key = `${id}|${lang.pluginId}|${lang.value}`;
  useEffect(() => {
    if (!codegen) return;
    let live = true;
    codegen.generate(lang, id).then(
      (r) => live && setOut({ key, ...r }),
      (e: unknown) => live && setOut({ key, blocks: [], error: e instanceof Error ? e.message : String(e) })
    );
    return () => {
      live = false;
    };
  }, [codegen, lang, id, key]);
  if (!out || out.key !== key) return <div className={styles.hint}>Generating code…</div>;
  if (out.error)
    return (
      <div className={styles.connectError} data-codegen-error="">
        <div className={styles.connectErrorName}>{lang.pluginName}</div>
        <div>{out.error}</div>
      </div>
    );
  if (!out.blocks.length) return <div className={styles.hint}>No code for this layer.</div>;
  return (
    <div className={styles.code} data-codegen={lang.value}>
      {out.blocks.map((b, i) => (
        <div key={i} className={styles.codeGroup}>
          <div className={styles.codeTitle}>{b.title}</div>
          <CodeBlock code={b.code} label="Copy" />
        </div>
      ))}
    </div>
  );
}
