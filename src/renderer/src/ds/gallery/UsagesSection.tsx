import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import * as DS from "../index";
import { Icon, ICON_NAMES, type IconName } from "../icons/Icon";
import { SearchField } from "../components/SearchField";
import { Button } from "../components/Button";
import type { CustomControl, DsComponentUsage, DsLook, SampleValue, UsageIndex, UsageLoc } from "./usageTypes";
import raw from "./usages.generated.json";
import styles from "./Usages.module.css";

/**
 * The Gallery's Developer page (the Developer tab): a sidebar of the design system's components as the app uses them,
 * and the selected one on the right — its visually distinct looks (usages collapsed by the props that change how it
 * looks), each drawn live with how many places use it and where, then every hand-made control that looks like it, drawn
 * with its own CSS class beside the ds look that would replace it, with the size, padding and radius they differ by.
 * One round of revisions merges the look-alikes. The index comes from `npm run ds:usages` (tools/ds-usages).
 * Labels are Turkish with the English term beside them (the owner's reading), as the request for this page asked.
 */
export const USAGE_INDEX = raw as unknown as UsageIndex;

// ── Groups and words ──────────────────────────────────────────────────────────

/** The ds components used across the app: controls, overlays, feedback (everything else is an internal piece) */
const CORE = new Set(["Button", "IconButton", "ToggleIconButton", "Icon", "TextInput", "NumericInput", "SearchField", "TextArea", "Select", "Checkbox", "Switch", "RadioGroup", "SegmentedControl", "Tabs", "Slider", "MenuButton", "ContextMenu", "Popover", "Dialog", "Banner", "Toast", "Badge", "EmptyState", "Spinner", "Swatch", "ColorInput", "ColorPicker", "Avatar", "PanelSection", "PropertyRow", "PropertyGrid", "ListRow", "SidebarItem", "InlineEdit", "KeyCap", "Toolbar", "ScrollArea"]);

/** One line on what each component is for */
const ABOUT: Record<string, string> = {
  Button: "Yazılı düğme: Kaydet, Paylaş, İptal gibi eylemler.",
  IconButton: "Yalnızca ikonlu kare düğme (24 panelde, 32 araç çubuğunda); adı ipucunda görünür.",
  ToggleIconButton: "Açık / kapalı kalan ikon düğme (ör. kilit, göz).",
  Icon: "Tasarım sisteminin ikonu (16 veya 24'lük ızgarada).",
  TextInput: "Tek satır metin alanı.",
  NumericInput: "Sayı alanı: sürüklenebilir önek, birim, matematik ifadesi.",
  SearchField: "Arama alanı: büyüteç ikonlu, temizleme düğmeli.",
  TextArea: "Çok satırlı metin alanı.",
  Select: "Açılır seçim kutusu (Figma'nın menüsüyle).",
  Checkbox: "Onay kutusu.",
  Switch: "Aç / kapat anahtarı.",
  RadioGroup: "Birden çok seçenekten birini seçtiren düğmeler.",
  SegmentedControl: "Yan yana bölmeli seçim (ör. Light / Dark).",
  Tabs: "Sekmeler.",
  Slider: "Kaydırıcı.",
  MenuButton: "Tıklanınca menü açan düğme.",
  ContextMenu: "Sağ tık menüsü.",
  Popover: "Panelden açılan küçük pencere.",
  Dialog: "Ekranın ortasında açılan pencere.",
  Banner: "Bir alanın üstünde duran bilgi / uyarı şeridi.",
  Toast: "Ekranın altında beliren kısa bildirim.",
  Badge: "Küçük etiket (Yeni, Beta, sayı).",
  EmptyState: "Boş bir listenin yerindeki ikon + başlık + açıklama.",
  Spinner: "Yükleniyor göstergesi.",
  Swatch: "Renk kutucuğu.",
  ColorInput: "Renk kutucuğu + hex + opaklık alanı.",
  ColorPicker: "Renk seçici penceresi.",
  Avatar: "Kişinin fotoğrafı ya da baş harfi.",
  PanelSection: "Sağ paneldeki başlıklı bölüm.",
  PropertyRow: "Paneldeki bir özellik satırı.",
  PropertyGrid: "Panel satırlarını hizalayan ızgara.",
  ListRow: "Liste görünümündeki tablo satırı.",
  SidebarItem: "Home'un kenar çubuğu satırı.",
  InlineEdit: "Çift tıklayınca yerinde düzenlenen ad.",
  KeyCap: "Klavye kısayolu tuşu.",
  Toolbar: "Araç çubuğu.",
  ScrollArea: "Figma'nın kaydırma çubuğuyla kaydırılan alan.",
};

/** Overlays and plumbing: listed, never drawn inline (they would cover the page or need a host) */
const NOT_INLINE: Record<string, string> = {
  Dialog: "üstte açılan pencere",
  Popover: "üstte açılan pencere",
  ContextMenu: "üstte açılan menü",
  FloatingPanel: "üstte açılan pencere",
  ColorPicker: "üstte açılan pencere",
  Toast: "üstte açılan bildirim",
  ToastHost: "görünmez taşıyıcı",
  TooltipManager: "görünmez taşıyıcı",
  Portal: "görünmez taşıyıcı",
  FocusTrap: "görünmez taşıyıcı",
  ReturnFocusProvider: "görünmez taşıyıcı",
  ScrollArea: "kapsayıcı",
  VirtualList: "veri listesi",
  CollectionView: "veri listesi",
  ListRow: "tablo satırı, veri ister",
  ListHeader: "tablo başlığı, veri ister",
  LayerRow: "katman paneli satırı",
  PageRow: "katman paneli satırı",
  TabBar: "pencere çerçevesi",
  TabBarUpdate: "pencere çerçevesi",
  EditorToolbar: "pencere çerçevesi",
  Rail: "pencere çerçevesi",
  ResizeHandle: "panel kenarı",
  PropertyGrid: "kapsayıcı",
  PropertyRow: "PropertyGrid ister",
  FileCard: "dosya verisi ister",
  FolderCard: "klasör verisi ister",
  Breadcrumb: "veri ister",
};

const VARIANT: Record<string, string> = {
  primary: "Birincil (mavi)",
  secondary: "İkincil (çerçeveli)",
  ghost: "Hayalet (çerçevesiz)",
  destructive: "Yıkıcı (kırmızı)",
  "destructive-secondary": "Yıkıcı ikincil",
  tinted: "Renkli dolgu",
  link: "Bağlantı",
  outlined: "Çerçeveli",
  filled: "Dolgulu",
  card: "Kart",
  dynamic: "Stili çalışırken seçilir",
};
const TONE: Record<string, string> = { secondary: "soluk", warning: "uyarı (sarı)", success: "başarılı (yeşil)", danger: "tehlike (kırmızı)", brand: "marka (mavi)", panel: "panel tonu", toolbar: "araç çubuğu tonu", default: "varsayılan ton", dynamic: "tonu çalışırken seçilir" };

/** A look in plain words: "İkincil (çerçeveli), büyük, ikonlu". */
export function captionOf(props: Record<string, string>, name = ""): string {
  const words: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (k === "variant") words.unshift(VARIANT[v] ?? v);
    else if (k === "tone") words.push(TONE[v] ?? `${v} tonu`);
    else if (k === "size") words.push(v === "large" ? "büyük (32)" : v === "small" ? "küçük" : v === "default" ? "normal" : v === "page" ? "sayfa boyu" : /^\d/.test(v) ? `${v}px` : v);
    else if (k === "icon") {
      // An icon button always has one
      if (!/IconButton$/.test(name)) words.push("ikonlu");
    }
    else if (k === "prefix") words.push("önekli");
    else if (k === "suffix") words.push("sonekli");
    else if (k === "unit") words.push("birimli");
    else if (k === "fullWidth") words.push("tam genişlik");
    else if (k === "width") words.push(v === "hug" ? "içeriğe göre genişlik" : v === "fixed" ? "sabit genişlik" : `genişlik ${v}`);
    else if (k === "disabled") words.push("devre dışı");
    else if (k === "shape") words.push(v === "round" ? "yuvarlak" : v === "square" ? "kare" : v);
    else if (k === "hideLabel") words.push("etiketsiz");
    else if (k === "showLabel") words.push("etiketi görünür");
    else if (k === "prefixTone") words.push("önek vurgulu");
    else if (k === "boxLabel") words.push("kutulu etiket");
    else if (k === "floating") words.push("yüzen");
    else if (k === "secondary") words.push("ikincil");
    else if (k === "compact") words.push("sıkı");
    else if (k === "chevron") words.push("oklu");
    else if (k === "collapsible") words.push("daraltılabilir");
    else if (k === "header") words.push(`${v} başlık`);
    else if (k === "pad") words.push(v === "none" ? "kenar boşluksuz" : `boşluk ${v}`);
    else if (k === "axis") words.push(`kaydırma: ${v}`);
    else if (k === "side") words.push(`kenar: ${v}`);
    else words.push(`${k}=${v}`);
  }
  if (!words.length) return "Varsayılan";
  const s = words.join(", ");
  return s[0].toLocaleUpperCase("tr") + s.slice(1);
}

/** The JSX a look-alike would become: `<Button variant="ghost" size="large" icon>`. */
export function suggestionOf(name: string, suggest: Record<string, SampleValue> = {}): string {
  const attrs = Object.entries(suggest).map(([k, v]) => (k === "icon" && name !== "IconButton" ? "icon" : typeof v === "string" ? `${k}="${v}"` : v === true ? k : `${k}={${v}}`));
  return `<${[name, ...attrs].join(" ")}>`;
}

// ── Live samples ──────────────────────────────────────────────────────────────

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

type Sampled = Pick<DsLook, "props" | "sample" | "text">;

/** The props to draw a look with: what the component needs, then the usage's own literals and text. */
export function sampleProps(name: string, v: Sampled): Record<string, unknown> {
  const text = textOf(v.text ?? (typeof v.sample.label === "string" ? v.sample.label : undefined));
  const props: Record<string, unknown> = { ...NEEDS[name]?.(text) };
  for (const [k, val] of Object.entries(v.sample)) {
    if (typeof val === "string" && /icon|prefix/i.test(k) && /^\d+\./.test(val) && !iconNames.has(val)) continue;
    props[k] = typeof val === "string" ? textOf(val) : val;
  }
  if (v.props.icon && props.icon === undefined && name === "Button") props.icon = "24.plus";
  if (name === "Button" || v.props.children) props.children = text || name;
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
    return this.state.failed ? <span className={styles.noLive}>Burada çizilemiyor (bağlam ister)</span> : this.props.children;
  }
}

const LIVE = DS as unknown as Record<string, ComponentType<Record<string, unknown>> | undefined>;

function DsSample({ name, look }: { name: string; look: Sampled }) {
  const Comp = NOT_INLINE[name] ? undefined : LIVE[name];
  if (!Comp) return <span className={styles.noLive}>{NOT_INLINE[name] ? `Sayfada çizilmez — ${NOT_INLINE[name]}` : "Tasarım sisteminden dışa aktarılmıyor"}</span>;
  return (
    <SampleBoundary>
      <Comp {...sampleProps(name, look)} />
    </SampleBoundary>
  );
}

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

/** A hand-made control drawn with its own CSS module class (and its first text and icon). */
function CustomSample({ c }: { c: CustomControl }) {
  const mod = useModule(c.cssFile);
  if (c.type === "file" || c.type === "hidden") return <span className={styles.noLive}>Gizli dosya girişi (bir düğmenin arkasında)</span>;
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

// ── Measuring the difference ──────────────────────────────────────────────────

interface Box {
  width: number;
  height: number;
  padding: string;
  radius: string;
  font: string;
  background: string;
  color: string;
}

const px = (s: string) => Math.round(parseFloat(s) * 10) / 10;
const shortBox = (top: string, right: string, bottom: string, left: string) => {
  const [t, r, b, l] = [top, right, bottom, left].map((s) => `${px(s) || 0}`);
  return t === b && r === l ? (t === r ? `${t}` : `${t} ${r}`) : `${t} ${r} ${b} ${l}`;
};

function boxOf(el: Element | null | undefined): Box | null {
  if (!el || typeof getComputedStyle !== "function") return null;
  const s = getComputedStyle(el);
  const width = px(s.width), height = px(s.height);
  if (!width || !height) return null;
  return {
    width,
    height,
    padding: shortBox(s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft),
    radius: `${px(s.borderTopLeftRadius) || 0}`,
    font: `${px(s.fontSize)}px ${s.fontWeight}`,
    background: s.backgroundColor,
    color: s.color,
  };
}

/** How a hand-made control's box differs from the ds look's, in words. */
export function diffWords(a: Box, b: Box): string[] {
  const out: string[] = [];
  const dh = Math.round(a.height - b.height), dw = Math.round(a.width - b.width);
  if (Math.abs(dh) >= 1) out.push(`Yükseklik ${Math.round(a.height)} — ds ${Math.round(b.height)} (${Math.abs(dh)}px daha ${dh < 0 ? "alçak" : "yüksek"})`);
  if (Math.abs(dw) >= 1) out.push(`Genişlik ${Math.round(a.width)} — ds ${Math.round(b.width)} (${Math.abs(dw)}px daha ${dw < 0 ? "dar" : "geniş"})`);
  if (a.padding !== b.padding) out.push(`İç boşluk ${a.padding} — ds ${b.padding}`);
  if (a.radius !== b.radius) out.push(`Köşe yarıçapı ${a.radius} — ds ${b.radius}`);
  if (a.font !== b.font) out.push(`Yazı ${a.font} — ds ${b.font}`);
  if (a.background !== b.background) out.push("Arka plan rengi farklı");
  if (a.color !== b.color) out.push("Yazı / ikon rengi farklı");
  return out;
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const locText = (l: UsageLoc) => `${l.file.replace(/^src\/renderer\/src\//, "")}:${l.line}`;

function Places({ locs, count }: { locs: UsageLoc[]; count: number }) {
  const files = new Set(locs.map((l) => l.file)).size;
  return (
    <details className={styles.places}>
      <summary>
        <strong>{count} yerde</strong>
        {files > 1 ? ` · ${files} dosya` : ""}
      </summary>
      <ul className={styles.locList}>
        {locs.map((l, i) => (
          <li key={i} title={`${l.file}:${l.line}`}>
            {locText(l)}
          </li>
        ))}
        {count > locs.length && <li>… {count - locs.length} daha</li>}
      </ul>
    </details>
  );
}

function PropsCode({ props }: { props: Record<string, string> }) {
  const entries = Object.entries(props);
  if (!entries.length) return <code className={styles.code}>varsayılan props</code>;
  return <code className={styles.code}>{entries.map(([k, v]) => (v === "✓" ? k : `${k}=${v}`)).join(" ")}</code>;
}

function LookRow({ name, look }: { name: string; look: DsLook }) {
  return (
    <div className={styles.look} data-usage-look="">
      <div className={styles.stage}>
        <div className={styles.stageInner}>
          <DsSample name={name} look={look} />
        </div>
      </div>
      <div className={styles.lookInfo}>
        <div className={styles.caption}>{captionOf(look.props, name)}</div>
        <PropsCode props={look.props} />
        <Places locs={look.locs} count={look.count} />
      </div>
    </div>
  );
}

const sourceOf = (c: CustomControl) => (c.cssFile ? `${c.cssFile.replace(/^src\/renderer\/src\//, "")} › .${c.className}` : c.className ? (c.className === "(dynamic)" ? "sınıf çalışırken seçilir" : `class "${c.className}"`) : "sınıfsız");

const CONTEXT: Record<string, string> = {
  "position: absolute": "konumu mutlak (bir şeyin üstünde durur)",
  "position: fixed": "konumu sabit",
  "hidden until its parent is hovered or active": "üstüne gelinene kadar gizli",
  "no rule for this class": "bu sınıfın kuralı yok",
  "class chosen at run time": "sınıfı çalışırken seçilir",
};
const contextOf = (s: string) => CONTEXT[s] ?? s.replace(/^styled only inside (.*)$/, "yalnızca $1 içinde biçimleniyor");
/** Where it comes from, and why its sample may not look as in the app */
const originOf = (c: CustomControl) => `${sourceOf(c)}${c.needsContext && c.className !== "(dynamic)" ? ` · ${contextOf(c.needsContext)}` : ""}`;

/** One hand-made look-alike beside the ds look that would replace it. */
function LookAlike({ c, name, looks }: { c: CustomControl; name: string; looks: DsLook[] }) {
  const mine = useRef<HTMLDivElement>(null);
  const theirs = useRef<HTMLDivElement>(null);
  const [diff, setDiff] = useState<string[] | null>(null);
  const suggest = c.suggest ?? {};
  const target: Sampled = { props: Object.fromEntries(Object.entries(suggest).map(([k, v]) => [k, k === "icon" ? "✓" : String(v)])), sample: { ...suggest, ...(c.icon && name === "Button" && suggest.icon ? { icon: c.icon } : {}) }, text: c.text };
  const existing = c.lookIndex !== undefined ? looks[c.lookIndex] : undefined;
  useLayoutEffect(() => {
    // A class chosen at run time draws unstyled here: nothing to compare
    if (c.className === "(dynamic)") return;
    const measure = () => {
      const a = boxOf(mine.current?.firstElementChild), b = boxOf(theirs.current?.firstElementChild);
      setDiff(a && b ? diffWords(a, b) : null);
    };
    measure();
    // The hand-made class's CSS module loads a moment later
    const id = setTimeout(measure, 120);
    return () => clearTimeout(id);
  }, [c]);
  return (
    <div className={styles.alike} data-lookalike="">
      <div className={styles.pair}>
        <figure className={styles.side}>
          <figcaption className={styles.sideLabel}>
            Elle yapılmış
            {c.needsContext && <span className={styles.sideWarn}> · {c.className === "(dynamic)" ? "sınıfı çalışırken seçilir, burada stilsiz" : "bağlamı olmadan tam görünmeyebilir"}</span>}
          </figcaption>
          <div className={styles.stage}>
            <div className={styles.stageInner} ref={mine}>
              <SampleBoundary>
                <CustomSample c={c} />
              </SampleBoundary>
            </div>
          </div>
        </figure>
        <Icon name="24.arrow.right" className={styles.pairArrow} />
        <figure className={styles.side}>
          <figcaption className={styles.sideLabel}>Tasarım sisteminde</figcaption>
          <div className={styles.stage}>
            <div className={styles.stageInner} ref={theirs}>
              <DsSample name={name} look={target} />
            </div>
          </div>
        </figure>
      </div>
      <div className={styles.alikeInfo}>
        <div className={styles.replace}>
          → <code>{suggestionOf(name, suggest)}</code> ile değiştirilebilir
        </div>
        <div className={styles.meta}>
          {captionOf(target.props, name)}
          {existing ? ` · bu görünüm uygulamada zaten ${existing.count} yerde var` : " · bu görünüm henüz uygulamada yok"}
        </div>
        {diff && (
          <ul className={styles.diff}>
            {diff.length ? diff.map((d) => <li key={d}>{d}</li>) : <li>Ölçüler aynı — yalnızca kodu farklı</li>}
          </ul>
        )}
        <div className={styles.source} title={c.cssFile ?? undefined}>
          {originOf(c)}
        </div>
        <Places locs={c.locs} count={c.count} />
      </div>
    </div>
  );
}

/** A hand-made control with nothing like it in the ds. */
function Unmatched({ c }: { c: CustomControl }) {
  const box = c.box ? Object.entries(c.box).filter(([k]) => ["width", "height", "min-height", "padding", "border-radius"].includes(k)) : [];
  return (
    <div className={styles.look} data-custom-control="">
      <div className={styles.stage}>
        <div className={styles.stageInner}>
          <SampleBoundary>
            <CustomSample c={c} />
          </SampleBoundary>
        </div>
      </div>
      <div className={styles.lookInfo}>
        <div className={styles.caption}>{c.className && c.className !== "(dynamic)" ? `.${c.className}` : c.tag}</div>
        <div className={styles.source} title={c.cssFile ?? undefined}>
          {originOf(c)}
        </div>
        {box.length > 0 && <code className={styles.code}>{box.map(([k, v]) => `${k}: ${v}`).join("; ")}</code>}
        <Places locs={c.locs} count={c.count} />
      </div>
    </div>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

interface Entry {
  id: string;
  name: string;
  meta: string;
  group: "core" | "internal" | "handmade";
}

const HANDMADE_KINDS: { id: string; label: string; test: (c: CustomControl) => boolean }[] = [
  { id: "buttons", label: "Düğmeler / Buttons", test: (c) => c.tag === "button" || c.tag.includes("[role=") },
  { id: "links", label: "Bağlantılar / Links", test: (c) => c.tag === "a" },
  { id: "inputs", label: "Giriş alanları / Inputs", test: (c) => c.tag === "input" || c.tag === "select" || c.tag === "textarea" },
];

/** The sidebar's entries: core components, internal pieces and the hand-made controls with no ds match. */
export function entriesOf(index: UsageIndex) {
  const alikes = new Map<string, CustomControl[]>();
  for (const c of index.custom) if (c.similarTo) alikes.set(c.similarTo, [...(alikes.get(c.similarTo) ?? []), c]);
  const comps: DsComponentUsage[] = [...index.ds];
  // A component only hand-made copies of exist (none of its own uses)
  for (const name of alikes.keys()) if (!comps.some((d) => d.name === name)) comps.push({ name, count: 0, files: 0, looks: [] });
  const entries: Entry[] = comps.map((d) => {
    const n = alikes.get(d.name)?.length ?? 0;
    return { id: d.name, name: d.name, meta: `${d.looks.length} görünüm${n ? ` · ${n} benzer` : ""}`, group: CORE.has(d.name) || n > 0 ? "core" : "internal" };
  });
  const unmatched = index.custom.filter((c) => !c.similarTo);
  for (const k of HANDMADE_KINDS) {
    const list = unmatched.filter(k.test);
    if (list.length) entries.push({ id: `handmade:${k.id}`, name: k.label, meta: `${list.length} kontrol · ${list.reduce((s, c) => s + c.count, 0)} yerde`, group: "handmade" });
  }
  return { entries, comps, alikes, unmatched };
}

const GROUPS: { id: Entry["group"]; title: string; open: boolean }[] = [
  { id: "core", title: "Temel bileşenler / Core", open: true },
  { id: "internal", title: "İç parçalar / Internal", open: false },
  { id: "handmade", title: "Elle yapılmış, eşi yok / Hand-made, no match", open: true },
];

function param(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/** The Developer page: the sidebar of components and the selected one's looks and hand-made look-alikes. */
export function UsagesSection({ index = USAGE_INDEX, initial }: { index?: UsageIndex; initial?: string }) {
  const { entries, comps, alikes, unmatched } = useMemo(() => entriesOf(index), [index]);
  const [selected, setSelected] = useState(() => initial ?? param("pick") ?? "Button");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(GROUPS.map((g) => [g.id, g.open || entries.some((e) => e.group === g.id && e.id === selected)])));
  const q = query.trim().toLowerCase();
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => pane.current?.scrollTo?.({ top: 0 }), [selected]);

  const uses = index.ds.reduce((n, c) => n + c.count, 0);
  const looks = index.ds.reduce((n, c) => n + c.looks.length, 0);
  const similar = index.custom.filter((c) => c.similarTo).length;

  const comp = comps.find((d) => d.name === selected);
  const kind = HANDMADE_KINDS.find((k) => `handmade:${k.id}` === selected);
  return (
    <section className={styles.page} data-gallery-section="usages" id="usages">
      <nav className={styles.sidebar} aria-label="Bileşenler">
        <div className={styles.search}>
          <SearchField value={query} onChange={setQuery} placeholder="Bileşen ara" />
        </div>
        <div className={styles.summary}>
          {index.ds.length} bileşen · {looks} görünüm · {uses} kullanım · {similar} elle yapılmış benzer
        </div>
        <div className={styles.list}>
          {GROUPS.map((g) => {
            const rows = entries.filter((e) => e.group === g.id && (!q || e.name.toLowerCase().includes(q)));
            if (!rows.length) return null;
            const isOpen = q ? true : open[g.id];
            return (
              <div key={g.id} className={styles.group} data-usage-group={g.id}>
                <button type="button" className={styles.groupHead} aria-expanded={isOpen} onClick={() => setOpen({ ...open, [g.id]: !open[g.id] })}>
                  <Icon name={isOpen ? "16.chevron.down" : "16.chevron.right"} />
                  <span className={styles.groupTitle}>{g.title}</span>
                  <span className={styles.groupCount}>{rows.length}</span>
                </button>
                {isOpen &&
                  rows.map((e) => (
                    <button key={e.id} type="button" className={styles.item} aria-current={e.id === selected ? "true" : undefined} data-usage-entry={e.id} onClick={() => setSelected(e.id)}>
                      <span className={styles.itemName}>{e.name}</span>
                      <span className={styles.itemMeta}>{e.meta}</span>
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
        <div className={styles.hint}>npm run ds:usages</div>
      </nav>
      <div className={styles.pane} ref={pane} data-usage-component={comp?.name ?? selected}>
        {comp ? (
          <>
            <header className={styles.paneHead}>
              <h2 className={styles.title}>{comp.name}</h2>
              <p className={styles.about}>{ABOUT[comp.name] ?? "Tasarım sisteminin bir parçası; uygulamanın bir ekranında kullanılıyor."}</p>
              <p className={styles.stats}>
                {comp.count} kullanım · {comp.files} dosya · {comp.looks.length} farklı görünüm
                {(alikes.get(comp.name)?.length ?? 0) > 0 && (
                  <>
                    {" · "}
                    <Button variant="link" onClick={() => pane.current?.querySelector("[data-lookalikes]")?.scrollIntoView({ block: "start", behavior: "smooth" })}>
                      {`${alikes.get(comp.name)!.length} elle yapılmış benzer ↓`}
                    </Button>
                  </>
                )}
              </p>
            </header>
            <h3 className={styles.heading}>
              Görünümler <span className={styles.headingEn}>Looks</span>
            </h3>
            <p className={styles.note}>Kullanımlar görünümü değiştiren props'a göre toplandı (variant, tone, size, ikon, devre dışı, genişlik); metin ve davranış yok sayıldı.</p>
            {comp.looks.length ? comp.looks.map((l, i) => <LookRow key={i} name={comp.name} look={l} />) : <div className={styles.empty}>Uygulamada henüz kullanılmıyor — yalnızca elle yapılmış kopyaları var.</div>}
            {(alikes.get(comp.name)?.length ?? 0) > 0 && (
              <>
                <h3 className={styles.heading} data-lookalikes="">
                  Elle yapılmış benzerleri <span className={styles.headingEn}>Hand-made look-alikes</span>
                </h3>
                <p className={styles.note}>Tasarım sistemi yerine kendi CSS sınıfıyla yapılmış ama bu bileşene benzeyen kontroller. Solda bugünkü hali, sağda yerine geçecek {comp.name}.</p>
                {alikes.get(comp.name)!.map((c, i) => (
                  <LookAlike key={i} c={c} name={comp.name} looks={comp.looks} />
                ))}
              </>
            )}
          </>
        ) : kind ? (
          <>
            <header className={styles.paneHead}>
              <h2 className={styles.title}>{kind.label}</h2>
              <p className={styles.about}>Elle yapılmış ve hiçbir tasarım sistemi bileşenine benzemeyen kontroller: kartlar, çipler, özel satırlar. Yeni bir bileşen mi olmalı, yoksa yerinde mi kalmalı, buradan karar verilir.</p>
            </header>
            {unmatched.filter(kind.test).map((c, i) => (
              <Unmatched key={i} c={c} />
            ))}
          </>
        ) : (
          <div className={styles.empty}>Soldan bir bileşen seçin.</div>
        )}
      </div>
    </section>
  );
}
