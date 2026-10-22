import { Component, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import * as DS from "../index";
import { Icon, ICON_NAMES, type IconName } from "../icons/Icon";
import { Badge } from "../components/Misc";
import { Button } from "../components/Button";
import type { CustomControl, DsComponentUsage, DsVariant, UsageIndex, UsageLoc } from "./usageTypes";
import raw from "./usages.generated.json";
import styles from "./Usages.module.css";

/**
 * The Gallery's "Usages in the app" and "Not from the design system" (the Developer tab): every ds component as the
 * app uses it — each distinct combination of visual props drawn live with the real component, how many places use it
 * and where — and the hand-made controls beside them, drawn with their own CSS module class, so one round of revisions
 * can merge the near-duplicates. The index comes from `npm run ds:usages` (tools/ds-usages).
 */
export const USAGE_INDEX = raw as unknown as UsageIndex;

/** Overlays and plumbing: listed, never drawn inline (they would cover the page or need a host) */
const NOT_INLINE: Record<string, string> = {
  Dialog: "overlay",
  Popover: "overlay",
  ContextMenu: "overlay",
  FloatingPanel: "overlay",
  ColorPicker: "overlay",
  Toast: "overlay",
  ToastHost: "host",
  TooltipManager: "host",
  Portal: "host",
  FocusTrap: "host",
  ReturnFocusProvider: "host",
  ScrollArea: "container",
  VirtualList: "data list",
  CollectionView: "data list",
  ListRow: "data list",
  ListHeader: "data list",
  LayerRow: "layers panel row",
  PageRow: "layers panel row",
  TabBar: "window chrome",
  TabBarUpdate: "window chrome",
  EditorToolbar: "window chrome",
  Rail: "window chrome",
  ResizeHandle: "panel edge",
  PropertyGrid: "container",
  PropertyRow: "needs a PropertyGrid",
  FileCard: "needs file data",
  FolderCard: "needs folder data",
  Breadcrumb: "needs items",
};

const noop = () => {};
const iconNames = new Set<string>(ICON_NAMES);
const textOf = (s: string | undefined) => (s ?? "").replace(/\{(\w+)\}/g, "$1");

/** What a component needs to draw, beside what the usage gave it */
const NEEDS: Record<string, (text: string) => Record<string, unknown>> = {
  Select: (text) => ({ options: [{ value: "a", label: text || "Option" }], value: "a", onChange: noop }),
  TextInput: () => ({ value: "", onChange: noop }),
  TextArea: () => ({ value: "", onChange: noop }),
  SearchField: () => ({ value: "", onChange: noop }),
  NumericInput: () => ({ value: 12, onChange: noop }),
  Checkbox: () => ({ checked: false, onChange: noop }),
  Switch: () => ({ checked: true, onChange: noop }),
  SegmentedControl: () => ({ options: [{ value: "a", label: "One" }, { value: "b", label: "Two" }], value: "a", onChange: noop }),
  RadioGroup: () => ({ options: [{ value: "a", label: "One" }, { value: "b", label: "Two" }], value: "a", onChange: noop }),
  Tabs: () => ({ tabs: [{ value: "a", label: "First" }, { value: "b", label: "Second" }], value: "a", onChange: noop }),
  Slider: () => ({ value: 50, min: 0, max: 100, onChange: noop }),
  ColorInput: () => ({ color: "#0D99FF", opacity: 100, onColor: noop, onOpacity: noop }),
  Swatch: () => ({ color: "#0D99FF" }),
  MenuButton: () => ({ entries: [], onSelect: noop }),
  EmptyState: (text) => ({ title: text || "Nothing here yet" }),
  Avatar: () => ({ name: "Burak Koç" }),
  KeyCap: () => ({ children: "⌘" }),
  CodeBlock: () => ({ code: "npm run ds:usages" }),
  PanelSection: (text) => ({ title: text || "Section", children: null }),
  SidebarItem: (text) => ({ icon: "24.design", label: text || "Drafts" }),
  RailItem: (text) => ({ icon: "24.tools", label: text || "Layers" }),
  ToolButton: (text) => ({ icon: "24.move", label: text || "Move" }),
  ToolTextButton: (text) => ({ label: text || "Tool" }),
  InlineEdit: (text) => ({ value: text || "Name", editing: false, onEditingChange: noop, onCommit: noop }),
  Toolbar: () => ({ children: null }),
  Icon: () => ({ name: "24.design" }),
  FieldPrefix: () => ({ prefix: "X" }),
  AgentLogo: () => ({ id: "claude" }),
  Badge: (text) => ({ children: text || "Badge" }),
  Banner: (text) => ({ children: text || "A banner's message" }),
};

/** The props to draw a variant with: what the component needs, then the usage's own literals and text. */
export function sampleProps(name: string, v: DsVariant): Record<string, unknown> {
  const text = textOf(v.text ?? (typeof v.sample.label === "string" ? v.sample.label : undefined));
  const props: Record<string, unknown> = { ...NEEDS[name]?.(text) };
  for (const [k, val] of Object.entries(v.sample)) {
    if (typeof val === "string" && /icon|prefix/i.test(k) && /^\d+\./.test(val) && !iconNames.has(val)) continue;
    props[k] = typeof val === "string" ? textOf(val) : val;
  }
  if (v.props.children) props.children = text || name;
  if (props.label === undefined && /Input|Select|Field|Checkbox|Switch|Slider|Radio|Segmented|Tabs|IconButton/.test(name)) props.label = text || name;
  if (name === "IconButton" || name === "ToggleIconButton") props.icon = iconNames.has(String(props.icon)) ? props.icon : "24.more";
  if (name === "Icon" && !iconNames.has(String(props.name))) props.name = "24.design";
  return props;
}

class SampleBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <span className={styles.noLive}>No live preview (needs more context)</span> : this.props.children;
  }
}

const matches = (q: string, ...parts: (string | undefined | null)[]) => !q || parts.some((p) => p && p.toLowerCase().includes(q));
const locText = (l: UsageLoc) => `${l.file.replace(/^src\/renderer\/src\//, "")}:${l.line}`;

function Locations({ locs, count }: { locs: UsageLoc[]; count: number }) {
  const files = new Set(locs.map((l) => l.file)).size;
  return (
    <details className={styles.locs}>
      <summary>
        {count === 1 ? "1 place" : `${count} places`}
        {files > 1 ? ` in ${files} files` : ""}
      </summary>
      <ul className={styles.locList}>
        {locs.map((l, i) => (
          <li key={i} title={`${l.file}:${l.line}`}>
            {locText(l)}
          </li>
        ))}
        {count > locs.length && <li>… {count - locs.length} more</li>}
      </ul>
    </details>
  );
}

function Props({ props }: { props: Record<string, string> }) {
  const entries = Object.entries(props);
  if (!entries.length) return <span className={styles.propNone}>Defaults only</span>;
  return (
    <>
      {entries.map(([k, v]) => (
        <span key={k} className={styles.prop} title={`${k}: ${v}`}>
          {v === "✓" ? (
            <b>{k}</b>
          ) : (
            <>
              {k}=<b>{v}</b>
            </>
          )}
        </span>
      ))}
    </>
  );
}

const SHOWN = 12;

function DsComponent({ usage, q }: { usage: DsComponentUsage; q: string }) {
  const [all, setAll] = useState(false);
  const live = DS as unknown as Record<string, ComponentType<Record<string, unknown>> | undefined>;
  const Comp = NOT_INLINE[usage.name] ? undefined : live[usage.name];
  const nameHit = matches(q, usage.name);
  const variants = nameHit ? usage.variants : usage.variants.filter((v) => matches(q, JSON.stringify(v.props), v.text, ...v.locs.map((l) => l.file)));
  if (!variants.length) return null;
  const shown = all ? variants : variants.slice(0, SHOWN);
  return (
    <div className={styles.component} id={`usage-${usage.name}`} data-usage-component={usage.name}>
      <div className={styles.componentHead}>
        <h3 className={styles.componentName}>{usage.name}</h3>
        <span className={styles.componentMeta}>
          {usage.count} uses · {usage.variants.length} {usage.variants.length === 1 ? "variant" : "variants"} · {usage.files} files
        </span>
        {NOT_INLINE[usage.name] && <Badge>{NOT_INLINE[usage.name]}</Badge>}
      </div>
      <div className={styles.grid}>
        {shown.map((v, i) => (
          <div key={i} className={styles.card} data-usage-variant="">
            <div className={styles.stage}>
              {Comp ? (
                <SampleBoundary>
                  <div className={styles.stageInner}>
                    <Comp {...sampleProps(usage.name, v)} />
                  </div>
                </SampleBoundary>
              ) : (
                <span className={styles.noLive}>{NOT_INLINE[usage.name] ? `Not drawn inline (${NOT_INLINE[usage.name]})` : "Not exported by the design system"}</span>
              )}
            </div>
            <div className={styles.info}>
              <div className={styles.row}>
                <Props props={v.props} />
                <span className={styles.count}>{v.count}×</span>
              </div>
              <Locations locs={v.locs} count={v.count} />
            </div>
          </div>
        ))}
      </div>
      {variants.length > SHOWN && (
        <div className={styles.more}>
          <Button variant="secondary" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${variants.length} variants`}
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Usages in the app": the ds components, most used first. */
export function UsagesSection({ query = "", index = USAGE_INDEX }: { query?: string; index?: UsageIndex }) {
  const q = query.trim().toLowerCase();
  const list = index.ds;
  const uses = list.reduce((n, c) => n + c.count, 0);
  const variants = list.reduce((n, c) => n + c.variants.length, 0);
  return (
    <section className={styles.block} data-gallery-section="usages" id="usages">
      <div className={styles.head}>
        <h2 className={styles.title}>Usages in the app</h2>
        <span className={styles.summary}>
          <strong>{list.length}</strong> components · <strong>{uses}</strong> uses · <strong>{variants}</strong> distinct variants · in {index.files} files
        </span>
        <span className={styles.hint}>npm run ds:usages</span>
      </div>
      <nav className={styles.index}>
        {list
          .filter((c) => matches(q, c.name) || c.variants.some((v) => matches(q, JSON.stringify(v.props), v.text, ...v.locs.map((l) => l.file))))
          .map((c) => (
            <a key={c.name} className={styles.indexLink} href={`#usage-${c.name}`}>
              {c.name} <span className={styles.indexCount}>{c.count}</span>
            </a>
          ))}
      </nav>
      {list.map((c) => (
        <DsComponent key={c.name} usage={c} q={q} />
      ))}
    </section>
  );
}

// ── Hand-made controls ────────────────────────────────────────────────────────

/** Every CSS module of the app, loaded when its sample is drawn */
const CSS_MODULES = import.meta.glob<{ default: Record<string, string> }>("../../**/*.module.css");
const moduleKey = (cssFile: string) => `../../${cssFile.replace(/^src\/renderer\/src\//, "")}`;

function useModule(cssFile: string | null): Record<string, string> | null | undefined {
  const load = cssFile ? CSS_MODULES[moduleKey(cssFile)] : undefined;
  // undefined: loading; null: no module (a literal class, or one the glob doesn't reach)
  const [mod, setMod] = useState<Record<string, string> | null | undefined>(load ? undefined : null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    load().then(
      (m) => live && setMod(m.default ?? {}),
      () => live && setMod(null)
    );
    return () => {
      live = false;
    };
  }, [load]);
  return mod;
}

function CustomSample({ c }: { c: CustomControl }) {
  const mod = useModule(c.cssFile);
  if (c.type === "file" || c.type === "hidden") return <span className={styles.noLive}>Hidden input (a picker behind a button)</span>;
  if (mod === undefined) return null;
  const className = c.cssFile ? (mod?.[c.className ?? ""] ?? "") : c.className && c.className !== "(dynamic)" ? c.className : "";
  const text = textOf(c.text) || (c.hasText ? "Label" : "");
  const icon = c.icon && iconNames.has(c.icon) ? <Icon name={c.icon as IconName} /> : c.hasIcon ? <Icon name="24.more" /> : null;
  const content = (
    <>
      {icon}
      {text}
      {!icon && !text ? "Button" : null}
    </>
  );
  switch (c.tag) {
    case "button":
      return (
        <button type="button" className={className}>
          {content}
        </button>
      );
    case "a":
      return (
        <a href="#" className={className} onClick={(e) => e.preventDefault()}>
          {text || "Link"}
        </a>
      );
    case "input":
      return c.type === "checkbox" || c.type === "radio" ? <input type={c.type} className={className} defaultChecked readOnly /> : <input type={c.type && c.type !== "dynamic" ? c.type : "text"} className={className} placeholder={text || "Value"} readOnly />;
    case "select":
      return (
        <select className={className} defaultValue="a">
          <option value="a">{text || "Option"}</option>
        </select>
      );
    case "textarea":
      return <textarea className={className} placeholder={text || "Text"} readOnly />;
    default:
      return (
        <div role={c.role} className={className}>
          {content}
        </div>
      );
  }
}

const sourceOf = (c: CustomControl) => (c.cssFile ? `${c.cssFile.replace(/^src\/renderer\/src\//, "")} › .${c.className}` : c.className ? (c.className === "(dynamic)" ? "class chosen at run time" : `class "${c.className}"`) : "no class");

/** "Not from the design system": hand-made controls, most used first, with what they look like in the ds. */
export function CustomSection({ query = "", index = USAGE_INDEX }: { query?: string; index?: UsageIndex }) {
  const q = query.trim().toLowerCase();
  const [onlySimilar, setOnlySimilar] = useState(false);
  const list = useMemo(
    () => index.custom.filter((c) => (!onlySimilar || c.similarTo) && matches(q, c.tag, c.type, c.cssFile, c.className, c.similarTo, c.text, ...c.locs.map((l) => l.file))),
    [index, q, onlySimilar]
  );
  const uses = index.custom.reduce((n, c) => n + c.count, 0);
  const similar = index.custom.filter((c) => c.similarTo);
  return (
    <section className={styles.block} data-gallery-section="custom" id="custom">
      <div className={styles.head}>
        <h2 className={styles.title}>Not from the design system</h2>
        <span className={styles.summary}>
          <strong>{index.custom.length}</strong> hand-made controls · <strong>{uses}</strong> uses · <strong>{similar.length}</strong> look like a ds component ({similar.reduce((n, c) => n + c.count, 0)} uses)
        </span>
        <Button variant={onlySimilar ? "primary" : "secondary"} onClick={() => setOnlySimilar(!onlySimilar)}>
          {onlySimilar ? "Showing near-duplicates" : "Only near-duplicates"}
        </Button>
      </div>
      {list.length === 0 ? (
        <div className={styles.empty}>Nothing matches.</div>
      ) : (
        <div className={styles.grid}>
          {list.map((c) => (
            <div key={`${c.tag}|${c.type ?? ""}|${c.cssFile ?? ""}|${c.className ?? ""}`} className={styles.card} data-custom-control="">
              <div className={styles.stage}>
                <SampleBoundary>
                  <div className={styles.stageInner}>
                    <CustomSample c={c} />
                  </div>
                </SampleBoundary>
              </div>
              <div className={styles.info}>
                <div className={styles.row}>
                  <span className={styles.prop}>
                    <b>{c.tag}</b>
                    {c.type && c.tag === "input" ? ` type=${c.type}` : ""}
                  </span>
                  {c.similarTo && (
                    <Badge tone="brand" title={c.similarWhy}>
                      similar to: {c.similarTo}
                    </Badge>
                  )}
                  {c.needsContext && (
                    <Badge tone="warning" title={c.needsContext}>
                      needs context
                    </Badge>
                  )}
                  <span className={styles.count}>{c.count}×</span>
                </div>
                <div className={styles.source} title={c.cssFile ?? undefined}>
                  {sourceOf(c)}
                  {c.extraClasses.length ? ` + ${c.extraClasses.map((k) => `.${k}`).join(" ")}` : ""}
                </div>
                {(c.similarWhy || c.needsContext) && (
                  <div className={styles.why}>
                    {[c.similarWhy, c.needsContext].filter(Boolean).join(" · ")}
                  </div>
                )}
                {c.box && (
                  <div className={styles.row}>
                    {Object.entries(c.box)
                      .filter(([k]) => k !== "font" && k !== "background" && k !== "border")
                      .map(([k, v]) => (
                        <span key={k} className={styles.prop} title={`${k}: ${v}`}>
                          {k}: <b>{v}</b>
                        </span>
                      ))}
                  </div>
                )}
                <Locations locs={c.locs} count={c.count} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
