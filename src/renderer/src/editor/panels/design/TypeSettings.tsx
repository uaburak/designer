/**
 * Figma UI3's "Type settings" (help.figma.com "Explore text properties"): tabs Basics, Details, and Variable for a
 * variable font. Basics: alignment, decoration (with the underline's details), letter case, vertical trim, list
 * style, paragraph and list spacing, truncation with max lines, wrap style. Details: indentation (paragraph indent,
 * hanging quotes, hanging lists), letter case features, numbers (style, fractions, position, slashed zero) and the
 * font's OpenType features (letterforms, stylistic sets, character variants, kerning) — those the font lacks are
 * greyed. Variable: a slider and a field per axis.
 *
 * Values come from the engine's range summary (the edited selection's runs, or the whole layers'), so run fields
 * show "Mixed" where runs differ; writes go through setProps, which the engine sends to the selected range while a
 * text is being edited.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fonts } from "@/engine/fonts";
import { Checkbox, IconButton, MIXED, NumericInput, Popover, SegmentedControl, Select, Tabs, cx, tooltipProps, type ChangeInfo } from "@/ds";
import type { CSSProperties } from "react";
import { styleWeight } from "../../fontList";
import { useEditor } from "../../controller";
import { AXIS_LABELS, featureName, withAxis, type TextSummary } from "../../model/text";
import { exitToCanvas } from "./Sections";
import { fields, type ExtraFields, type PanelNode } from "./shared";
import styles from "./Design.module.css";
import type { FontInfo } from "@/engine/codec";

type Tab = "basics" | "details" | "variable";

/** The font the summary's runs use (the first one's when mixed), and what it offers; read again as fonts arrive. */
export function useFontInfo(summary: TextSummary | null): FontInfo | null {
  const ed = useEditor();
  const font = summary?.values.fontName as { family: string; style: string } | undefined;
  const family = font?.family ?? "";
  const style = font?.style ?? "";
  const [arrived, setArrived] = useState(0);
  useEffect(() => fonts.onChange(() => setArrived((n) => n + 1)), []);
  return useMemo(
    () => (family && typeof ed.engine.fontInfo === "function" ? ed.engine.fontInfo(family, style) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ed, family, style, arrived]
  );
}

export function TypeSettings({ nodes, summary, anchor, onClose }: { nodes: PanelNode[]; summary: TextSummary | null; anchor: HTMLElement; onClose: () => void }) {
  const info = useFontInfo(summary);
  const axes = (info?.axes ?? []).filter((a) => !a.hidden);
  const [tab, setTab] = useState<Tab>("basics");
  const shown: Tab = tab === "variable" && !axes.length ? "basics" : tab;
  const tabs = [
    { value: "basics", label: "Basics" },
    { value: "details", label: "Details" },
    ...(axes.length ? [{ value: "variable", label: "Variable" }] : []),
  ];
  return (
    <Popover
      anchor={anchor}
      label="Type settings"
      width={240}
      onClose={onClose}
      header={<Tabs label="Type settings" value={shown} tabs={tabs} onChange={(v) => setTab(v as Tab)} />}
    >
      <TypePreview nodes={nodes} summary={summary} />
      <div className={styles.typeSettingsBody}>
        {shown === "basics" && <Basics nodes={nodes} summary={summary} info={info} />}
        {shown === "details" && <Details nodes={nodes} summary={summary} info={info} />}
        {shown === "variable" && <Variable nodes={nodes} summary={summary} axes={axes} />}
      </div>
    </Popover>
  );
}

/**
 * Live (popovers/type-settings*.txt): every tab opens on a 208 × 120 preview — "Preview" at 16px in the text's font,
 * with its case and decoration (what Figma draws in it beyond the word is not captured).
 */
function TypePreview({ nodes, summary }: { nodes: PanelNode[]; summary: TextSummary | null }) {
  const family = valueOf<string>(summary, "fontFamily", nodes[0]?.fontName?.family ?? "Inter");
  const style = valueOf<string>(summary, "fontStyle", nodes[0]?.fontName?.style ?? "Regular");
  const decoration = valueOf<string>(summary, "textDecoration", "NONE");
  const textCase = valueOf<string>(summary, "textCase", "ORIGINAL");
  const css: CSSProperties = {
    fontFamily: family === MIXED ? undefined : `"${family}", var(--ds-font-family)`,
    fontWeight: style === MIXED ? undefined : styleWeight(style),
    fontStyle: style !== MIXED && /italic|oblique/i.test(style) ? "italic" : undefined,
    textDecoration: decoration === "UNDERLINE" ? "underline" : decoration === "STRIKETHROUGH" ? "line-through" : undefined,
    textTransform: textCase === "UPPER" ? "uppercase" : textCase === "LOWER" ? "lowercase" : textCase === "TITLE" ? "capitalize" : undefined,
    fontVariantCaps: textCase === "SMALL_CAPS" ? "small-caps" : undefined,
  };
  return (
    <div className={styles.typePreview} aria-hidden="true" data-type-preview="">
      <div className={styles.typePreviewBox}>
        <span style={css}>Preview</span>
      </div>
    </div>
  );
}

/** setProps on the selection (the engine routes run fields to the edited range); a scrub is one undo step. */
function useWrite(nodes: PanelNode[]) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  return (label: string, f: ExtraFields, info?: ChangeInfo) =>
    info ? ed.edit(label, info, () => void ed.engine.setProps(refs, fields(f))) : ed.setProps(refs, fields(f), label);
}

/** A summary field: its value, MIXED, or the default. */
function valueOf<T>(summary: TextSummary | null, key: string, fallback: T): T | typeof MIXED {
  if (summary?.mixed.has(key)) return MIXED;
  const v = summary?.values[key];
  return v === undefined || v === null ? fallback : (v as T);
}

/** A node field over the selected layers (paragraph-level fields Figma keeps on the layer). */
function nodeValue<T>(nodes: PanelNode[], read: (n: PanelNode) => T): T | typeof MIXED {
  const vs = nodes.map(read);
  return vs.every((v) => JSON.stringify(v) === JSON.stringify(vs[0])) ? vs[0] : MIXED;
}

const field = <T,>(v: T | typeof MIXED, mixedAs: T): T => (v === MIXED ? mixedAs : v);

function Basics({ nodes, summary, info }: { nodes: PanelNode[]; summary: TextSummary | null; info: FontInfo | null }) {
  const ed = useEditor();
  const [underlineOpen, setUnderlineOpen] = useState(false);
  const write = useWrite(nodes);
  const refs = nodes.map((n) => n.guid);
  const align = nodeValue(nodes, (n) => n.textAlignHorizontal ?? "LEFT");
  const decoration = valueOf<string>(summary, "textDecoration", "NONE");
  const decoStyle = valueOf<string>(summary, "textDecorationStyle", "SOLID");
  const thickness = valueOf<{ value: number; units: string } | null>(summary, "textDecorationThickness", null);
  const offset = valueOf<{ value: number; units: string } | null>(summary, "textUnderlineOffset", null);
  const skipInk = valueOf(summary, "textDecorationSkipInk", false);
  const textCase = valueOf<string>(summary, "textCase", "ORIGINAL");
  const trim = nodeValue(nodes, (n) => n.leadingTrim ?? "NONE");
  const lineType = valueOf<string>(summary, "lineType", "PLAIN");
  const paragraph = nodeValue(nodes, (n) => n.paragraphSpacing ?? 0);
  const listSpacing = nodeValue(nodes, (n) => n.listSpacing ?? 0);
  const truncate = nodeValue(nodes, (n) => n.textTruncation === "ENDING");
  const maxLines = nodeValue(nodes, (n) => n.maxLines ?? 0);
  const wrap = nodeValue(nodes, (n) => n.textWrapStyle ?? "AUTO");
  const px = (v: { value: number; units: string } | null | typeof MIXED) => (v === MIXED ? MIXED : v && v.units === "PIXELS" ? v.value : null);
  const list = (type: "NONE" | "ORDERED" | "UNORDERED") =>
    ed.batch(type === "NONE" ? "Remove list" : type === "ORDERED" ? "Numbered list" : "Bulleted list", () =>
      refs.forEach((r) => {
        // NONE: the engine's toggle — the type the paragraphs have, applied again, removes it.
        const t = type !== "NONE" ? type : lineType === "ORDERED_LIST" ? "ORDERED" : "UNORDERED";
        ed.engine.setTextList(r, t);
      })
    );
  // Figma's live Basics tab (popovers/type-settings.txt): each control right-aligned at its own width — Alignment
  // (4 × 24), Decoration (3, the underline's details after it), Case (5), Vertical trim (2), List style (3),
  // Paragraph spacing (72), Truncate text (2), Wrap style (96).
  const smallCaps = !info || info.features.some((f) => f.tag === "smcp");
  return (
    <div className={`${styles.settings} ${styles.settingsEnd}`}>
      <span className={styles.settingsLabel}>Alignment</span>
      <SegmentedControl
        className={styles.typeSeg}
        label="Alignment"
        value={field(align, "")}
        options={[
          { value: "LEFT", icon: "24.text.align-left", tooltip: "Text align left" },
          { value: "CENTER", icon: "24.text.align-center", tooltip: "Text align center" },
          { value: "RIGHT", icon: "24.text.align-right", tooltip: "Text align right" },
          { value: "JUSTIFIED", icon: "24.text.align-justified", tooltip: "Text align justified" },
        ]}
        onChange={(v) => write("Text alignment", { textAlignHorizontal: v as ExtraFields["textAlignHorizontal"] })}
      />
      <span className={styles.settingsLabel}>Decoration</span>
      <div className={styles.settingsInline}>
        <SegmentedControl
          className={styles.typeSeg}
          label="Decoration"
          value={field(decoration, "")}
          options={[
            { value: "NONE", icon: "24.minus.small", tooltip: "None" },
            { value: "UNDERLINE", icon: "24.text.underline", tooltip: "Underline" },
            { value: "STRIKETHROUGH", icon: "24.text.strikethrough", tooltip: "Strikethrough" },
          ]}
          onChange={(v) => write("Text decoration", { textDecoration: v as ExtraFields["textDecoration"] })}
        />
        {/* Live (popovers/type-settings.txt): enabled whatever the decoration; opening it on a text without one underlines
            it, so its style, thickness and offset apply (unverified: live's capture did not open it) */}
        <IconButton
          icon="16.chevron.down"
          label="Underline details"
          tone="secondary"
          aria-expanded={underlineOpen && decoration === "UNDERLINE"}
          onClick={() => {
            const opening = !(underlineOpen && decoration === "UNDERLINE");
            if (opening && decoration !== "UNDERLINE") write("Text decoration", { textDecoration: "UNDERLINE" });
            setUnderlineOpen(opening);
          }}
        />
      </div>
      {decoration === "UNDERLINE" && underlineOpen && (
        <>
          <span className={styles.settingsLabel}>Style</span>
          <Select
            label="Underline style"
            value={field(decoStyle, MIXED as unknown as string)}
            options={[
              { value: "SOLID", label: "Solid" },
              { value: "DOTTED", label: "Dotted" },
              { value: "WAVY", label: "Wavy" },
            ]}
            onChange={(v) => write("Underline style", { textDecorationStyle: v as ExtraFields["textDecorationStyle"] })}
          />
          <span className={styles.settingsLabel}>Thickness</span>
          <NumericInput
            scrubHandle="previous"
            label="Underline thickness"
            value={px(thickness)}
            placeholder="Auto"
            min={0}
            onChange={(v, info) => write("Underline thickness", { textDecorationThickness: { value: v, units: "PIXELS" } }, info)}
            onClear={() => write("Underline thickness", { textDecorationThickness: null })}
            onCancel={() => ed.cancelEdit()}
          />
          <span className={styles.settingsLabel}>Offset</span>
          <NumericInput
            scrubHandle="previous"
            label="Underline offset"
            value={px(offset)}
            placeholder="Auto"
            onChange={(v, info) => write("Underline offset", { textUnderlineOffset: { value: v, units: "PIXELS" } }, info)}
            onClear={() => write("Underline offset", { textUnderlineOffset: null })}
            onCancel={() => ed.cancelEdit()}
          />
          <span className={styles.settingsLabel}>Skip ink</span>
          <Checkbox label="Skip ink" hideLabel checked={skipInk === MIXED ? false : !!skipInk} onChange={(on) => write("Skip ink", { textDecorationSkipInk: on })} />
        </>
      )}
      <span className={styles.settingsLabel}>Case</span>
      <SegmentedControl
        className={styles.typeSeg}
        label="Case"
        value={field(textCase, "")}
        options={[
          { value: "ORIGINAL", icon: "24.minus.small", tooltip: "As typed" },
          { value: "UPPER", label: "AG", tooltip: "Uppercase" },
          { value: "LOWER", label: "ag", tooltip: "Lowercase" },
          { value: "TITLE", label: "Ag", tooltip: "Title case" },
          { value: "SMALL_CAPS", label: "ᴀɢ", tooltip: smallCaps ? "Small caps" : "Font doesn't support small caps", disabled: !smallCaps },
        ]}
        onChange={(v) => write("Text case", { textCase: v as ExtraFields["textCase"] })}
      />
      {/* Live: 21 more after Case (the trim / list / spacing group starts at 305, not 284) */}
      <span className={styles.settingsGroupGap} />
      <span className={styles.settingsGroupGap} />
      <span className={styles.settingsLabel}>Vertical trim</span>
      <SegmentedControl
        className={styles.typeSeg}
        label="Vertical trim"
        value={field(trim, "")}
        options={[
          { value: "NONE", icon: "24.text.trim-standard", tooltip: "Standard" },
          { value: "CAP_HEIGHT", icon: "24.text.trim-cap", tooltip: "Cap height to baseline" },
        ]}
        onChange={(v) => write("Vertical trim", { leadingTrim: v as ExtraFields["leadingTrim"] })}
      />
      <span className={styles.settingsLabel}>List style</span>
      <SegmentedControl
        className={styles.typeSeg}
        label="List style"
        value={lineType === MIXED ? "" : lineType === "ORDERED_LIST" ? "ORDERED" : lineType === "UNORDERED_LIST" ? "UNORDERED" : "NONE"}
        options={[
          { value: "NONE", icon: "24.minus.small", tooltip: "No list" },
          { value: "UNORDERED", icon: "24.list-view", tooltip: "Bulleted list" },
          { value: "ORDERED", icon: "24.text.list-numbered", tooltip: "Numbered list" },
        ]}
        onChange={(v) => list(v as "NONE" | "ORDERED" | "UNORDERED")}
      />
      <span className={styles.settingsLabel}>Paragraph spacing</span>
      <NumericInput className={styles.settingsField} scrubHandle="previous" label="Paragraph spacing" value={paragraph} min={0} onChange={(v, info) => write("Paragraph spacing", { paragraphSpacing: v }, info)} onCancel={() => ed.cancelEdit()} onExit={exitToCanvas(ed)} />
      {lineType !== "PLAIN" && (
        <>
          <span className={styles.settingsLabel}>List spacing</span>
          <NumericInput className={styles.settingsField} scrubHandle="previous" label="List spacing" value={listSpacing} min={0} onChange={(v, info) => write("List spacing", { listSpacing: v }, info)} onCancel={() => ed.cancelEdit()} onExit={exitToCanvas(ed)} />
        </>
      )}
      <span className={styles.settingsLabel}>Truncate text</span>
      <SegmentedControl
        className={styles.typeSeg}
        label="Truncate text"
        value={truncate === MIXED ? "" : truncate ? "ENDING" : "DISABLED"}
        options={[
          { value: "DISABLED", icon: "24.text.truncate-off", tooltip: "No truncation" },
          { value: "ENDING", icon: "24.text.truncate-on", tooltip: "Truncation enabled" },
        ]}
        onChange={(v) => write("Truncate text", { textTruncation: v as "ENDING" | "DISABLED" })}
      />
      {truncate === true && (
        <>
          <span className={styles.settingsLabel}>Max lines</span>
          <NumericInput
            className={styles.settingsField}
            scrubHandle="previous"
            label="Max lines"
            value={maxLines === 0 ? null : maxLines}
            placeholder="—"
            min={1}
            precision={0}
            onChange={(v, info) => write("Max lines", { maxLines: v }, info)}
            onClear={() => write("Max lines", { maxLines: 0 })}
            onCancel={() => ed.cancelEdit()}
          />
        </>
      )}
      <span className={styles.settingsLabel}>Wrap style</span>
      <Select
        label="Wrap style"
        width={96}
        value={field(wrap, MIXED as unknown as string)}
        options={[
          { value: "AUTO", label: "Auto" },
          { value: "BALANCE", label: "Balance" },
          { value: "PRETTY", label: "Pretty" },
        ]}
        onChange={(v) => write("Wrap style", { textWrapStyle: v as ExtraFields["textWrapStyle"] })}
      />
    </div>
  );
}

/** Figma's number styles: spacing × figures. */
const NUMBER_STYLES: { value: string; label: string; spacing: ExtraFields["fontVariantNumericSpacing"]; figure: ExtraFields["fontVariantNumericFigure"] }[] = [
  { value: "default", label: "Default", spacing: "NORMAL", figure: "NORMAL" },
  { value: "PROPORTIONAL/LINING", label: "Proportional lining", spacing: "PROPORTIONAL", figure: "LINING" },
  { value: "PROPORTIONAL/OLDSTYLE", label: "Proportional old style", spacing: "PROPORTIONAL", figure: "OLDSTYLE" },
  { value: "TABULAR/LINING", label: "Monospace lining", spacing: "TABULAR", figure: "LINING" },
  { value: "TABULAR/OLDSTYLE", label: "Monospace old style", spacing: "TABULAR", figure: "OLDSTYLE" },
];

/**
 * Features Figma's Details tab shows by their own row (Letter case, Numbers, Letterforms, Stylistic sets, Character
 * variants, Kerning) or never shows (the shaping internals); the rest are "More features", by these names (live
 * popovers/type-settings-details.txt: Fraction denominators, Fraction numerators, Scientific inferiors).
 */
const OWN_ROW = new Set(["case", "cpsp", "frac", "zero", "dlig", "calt", "ordn", "salt", "kern", "smcp", "c2sc", "onum", "lnum", "pnum", "tnum", "sups", "subs"]);
const HIDDEN_FEATURES = new Set(["aalt", "ccmp", "locl", "mark", "mkmk", "rvrn", "rlig", "liga", "clig", "curs", "dist", "abvm", "blwm", "init", "medi", "fina", "isol", "nukt", "akhn", "rphf", "pref", "blwf", "half", "pstf", "vatu", "cjct", "pres", "abvs", "blws", "psts", "haln", "ljmo", "vjmo", "tjmo"]);
export const MORE_FEATURE_NAMES: Record<string, string> = {
  dnom: "Fraction denominators",
  numr: "Fraction numerators",
  sinf: "Scientific inferiors",
  swsh: "Swash",
  titl: "Titling alternates",
  hist: "Historical forms",
  hlig: "Historical ligatures",
  ornm: "Ornaments",
  nalt: "Alternate annotation forms",
  unic: "Unicase",
  pcap: "Petite capitals",
  c2pc: "Petite capitals from capitals",
  cswh: "Contextual swash",
};
/** The "More features" rows of a font (tags in its order). */
export function moreFeatures(features: readonly { tag: string; name?: string }[]): { tag: string; label: string }[] {
  return features
    .filter((f) => !OWN_ROW.has(f.tag) && !HIDDEN_FEATURES.has(f.tag) && !/^ss\d\d$/.test(f.tag) && !/^cv\d\d$/.test(f.tag))
    .map((f) => ({ tag: f.tag, label: f.name || MORE_FEATURE_NAMES[f.tag] || f.tag }));
}

/**
 * A Details row's name (live popovers/type-settings-details.txt): it wraps at 144 in 16 high lines; two lines stay
 * centred on the row's control (4 above it) and push the next row 8 lower ("r curves into round neighbors" at 940 over
 * its control at 944, the next row's at 984).
 */
function FeatureLabel({ label, applicable, why }: { label: string; applicable: boolean; why: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    if (ref.current) setWrapped(ref.current.offsetHeight > 20);
  }, [label]);
  return (
    <span
      ref={ref}
      data-wrapped={wrapped || undefined}
      className={cx(styles.settingsLabel, styles.featureLabel, !applicable && styles.settingsLabelDisabled, !applicable && why && styles.featureNotApplicable)}
      {...(!applicable && why ? tooltipProps("Not applicable for selected text") : {})}
    >
      {label}
    </span>
  );
}

/**
 * Features that act by their context (live: Contextual alternates, Fractions and Ordinals read applicable on a text
 * they leave as it is): applicable whenever the font has them.
 */
const CONTEXTUAL = new Set(["calt", "frac", "ordn"]);
/** Punctuation that hangs outside the text's box (help "Hanging punctuation": quotes, hyphens and dashes, stops). */
const HANGING = /[\u2018\u2019\u201C\u201D"'\u00AB\u00BB\u2039\u203A\-\u2010-\u2014.,:;!?\u2026()[\]]/;

/**
 * Is each Details row applicable to the selected text? A feature when shaping the text with it on and off differs
 * (engine fontFeaturesIn; contextual ones whenever the font has them); Number style when the text has a digit; Hanging
 * punctuation when it has punctuation that hangs; Hanging lists when a paragraph is a list. Live (popovers/type-settings-
 * details.txt, "Hello Figma text"): the others' labels read tertiary — a feature's with "Not applicable for selected
 * text" — their controls still enabled. (The digit, punctuation and list rules are unverified.)
 */
export function detailsApplicable(text: string, fontHas: (tag: string) => boolean, acting: readonly string[] | null, list: boolean) {
  return {
    feature: (tag: string) => fontHas(tag) && (acting === null || CONTEXTUAL.has(tag) || acting.includes(tag)),
    numbers: /\p{Nd}/u.test(text),
    hanging: HANGING.test(text),
    hangingList: list,
  };
}

function Details({ nodes, summary, info }: { nodes: PanelNode[]; summary: TextSummary | null; info: FontInfo | null }) {
  const ed = useEditor();
  const write = useWrite(nodes);
  const has = (tag: string) => !info || info.features.some((f) => f.tag === tag);
  const font = summary?.values.fontName as { family: string; style: string } | undefined;
  const text = nodes.map((n) => n.textData?.characters ?? "").join("\n");
  const acting = useMemo(
    () => (font?.family && typeof ed.engine.fontFeaturesIn === "function" ? ed.engine.fontFeaturesIn(font.family, font.style, text) : null),
    // `info` arrives with the font: read again then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ed, font?.family, font?.style, text, info]
  );
  const lineType = valueOf<string>(summary, "lineType", "PLAIN");
  const applies = detailsApplicable(text, has, acting, lineType !== "PLAIN" && lineType !== "NONE");
  const on = (valueOf<string[] | null>(summary, "toggledOnOTFeatures", []) as string[] | typeof MIXED) ?? [];
  const off = (valueOf<string[] | null>(summary, "toggledOffOTFeatures", []) as string[] | typeof MIXED) ?? [];
  const onList = on === MIXED ? [] : (on ?? []);
  const offList = off === MIXED ? [] : (off ?? []);
  const toggled = (tag: string, byDefault: boolean) => (onList.includes(featureName(tag)) ? true : offList.includes(featureName(tag)) ? false : byDefault);
  const toggle = (tag: string, value: boolean, byDefault: boolean, label: string) => {
    const name = featureName(tag);
    const nextOn = onList.filter((t) => t !== name);
    const nextOff = offList.filter((t) => t !== name);
    if (value !== byDefault) (value ? nextOn : nextOff).push(name);
    write(label, { toggledOnOTFeatures: nextOn.length ? nextOn : null, toggledOffOTFeatures: nextOff.length ? nextOff : null });
  };
  const variant = (key: string, byDefault: boolean) => {
    const v = valueOf<boolean | null>(summary, key, null);
    return v === MIXED ? false : v === null ? byDefault : !!v;
  };
  const indent = nodeValue(nodes, (n) => n.paragraphIndent ?? 0);
  const hanging = nodeValue(nodes, (n) => n.hangingPunctuation === true);
  const hangingList = nodeValue(nodes, (n) => n.hangingList === true);
  const spacing = valueOf(summary, "fontVariantNumericSpacing", "NORMAL");
  const figure = valueOf(summary, "fontVariantNumericFigure", "NORMAL");
  const numberStyle = spacing === MIXED || figure === MIXED ? MIXED : NUMBER_STYLES.find((s) => s.spacing === spacing && s.figure === figure)?.value ?? "default";
  const fraction = valueOf<string>(summary, "fontVariantNumericFraction", "NORMAL");
  const position = valueOf<string>(summary, "fontVariantPosition", "NORMAL");
  const sets = (info?.features ?? []).filter((f) => /^ss\d\d$/.test(f.tag));
  const variants = (info?.features ?? []).filter((f) => /^cv\d\d$/.test(f.tag));
  // Live (popovers/type-settings-details.txt): each feature a Disabled / Enabled pair (48 at 176); what the font lacks
  // reads tertiary, "Not applicable for selected text".
  // Live: a label wraps at 144 (two lines make the row 32 high); one not applicable reads tertiary — a feature's in a
  // 144 wide "Not applicable for selected text" box —, its control enabled all the same.
  const toggle2 = (label: string, checked: boolean, applicable: boolean, onChange: (v: boolean) => void, why = true) => (
    <>
      <FeatureLabel label={label} applicable={applicable} why={why} />
      <SegmentedControl
        className={styles.typeSeg}
        label={label}
        value={checked ? "ON" : "OFF"}
        options={[
          { value: "OFF", icon: "24.minus.small", tooltip: "Disabled" },
          { value: "ON", icon: "24.check", tooltip: "Enabled" },
        ]}
        onChange={(v) => onChange(v === "ON")}
      />
    </>
  );
  const heading = (title: string, first = false) => (
    <>
      {!first && (
        <>
          <span className={styles.settingsGroupGap} />
          <span className={styles.settingsGroupGap} />
        </>
      )}
      <span className={styles.settingsHeading}>{title}</span>
      <span />
    </>
  );
  const textCase = valueOf<string>(summary, "textCase", "ORIGINAL");
  const smallCaps = has("smcp");
  const oldstyle = has("onum");
  const numberOptions = [
    { value: "default", icon: "24.minus.small" as const, tooltip: "Font default" },
    { value: "PROPORTIONAL/LINING", label: "P", tooltip: "Proportional uppercase/lining" },
    ...(oldstyle ? [{ value: "PROPORTIONAL/OLDSTYLE", label: "p", tooltip: "Proportional lowercase/oldstyle" }] : []),
    { value: "TABULAR/LINING", label: "M", tooltip: "Monospace uppercase/lining" },
    ...(oldstyle ? [{ value: "TABULAR/OLDSTYLE", label: "m", tooltip: "Monospace lowercase/oldstyle" }] : []),
  ];
  const more = moreFeatures(info?.features ?? []);
  return (
    <div className={`${styles.settings} ${styles.settingsEnd}`}>
      {heading("Indentation", true)}
      {toggle2("Hanging punctuation", hanging === true, applies.hanging, (v) => write("Hanging punctuation", { hangingPunctuation: v }), false)}
      {toggle2("Hanging lists", hangingList === true, applies.hangingList, (v) => write("Hanging lists", { hangingList: v }), false)}
      <span className={styles.settingsLabel}>Paragraph indent</span>
      <NumericInput className={styles.settingsField} scrubHandle="previous" label="Paragraph indent" value={indent} min={0} onChange={(v, i) => write("Paragraph indent", { paragraphIndent: v }, i)} onCancel={() => ed.cancelEdit()} />
      {heading("Letter case")}
      <span className={styles.settingsLabel}>Case</span>
      <SegmentedControl
        className={styles.typeSeg}
        label="Case"
        value={field(textCase, "")}
        options={[
          { value: "ORIGINAL", icon: "24.minus.small", tooltip: "As typed" },
          { value: "UPPER", label: "AG", tooltip: "Uppercase" },
          { value: "LOWER", label: "ag", tooltip: "Lowercase" },
          { value: "TITLE", label: "Ag", tooltip: "Title case" },
          { value: "SMALL_CAPS", label: "ᴀɢ", tooltip: smallCaps ? "Small caps" : "Font doesn't support small caps", disabled: !smallCaps },
        ]}
        onChange={(v) => write("Text case", { textCase: v as ExtraFields["textCase"] })}
      />
      {toggle2("Case-sensitive forms", toggled("case", false), applies.feature("case"), (v) => toggle("case", v, false, "Case-sensitive forms"))}
      {toggle2("Capital spacing", toggled("cpsp", false), applies.feature("cpsp"), (v) => toggle("cpsp", v, false, "Capital spacing"))}
      {heading("Numbers")}
      {/* Live: "Style" not applicable without digits, in its "Not applicable for selected text" box (64 wide) */}
      <span
        className={cx(styles.settingsLabel, !(applies.numbers && (has("lnum") || has("tnum") || has("pnum"))) && styles.settingsLabelDisabled)}
        {...(!(applies.numbers && (has("lnum") || has("tnum") || has("pnum"))) ? tooltipProps("Not applicable for selected text") : {})}
      >
        Style
      </span>
      <SegmentedControl
        className={styles.typeSeg}
        label="Number style"
        value={numberStyle as string}
        options={numberOptions}
        onChange={(v) => {
          const st = NUMBER_STYLES.find((x) => x.value === v) ?? NUMBER_STYLES[0];
          write("Number style", { fontVariantNumericSpacing: st.spacing, fontVariantNumericFigure: st.figure });
        }}
      />
      <span className={styles.settingsLabel}>Position</span>
      <SegmentedControl
        className={styles.typeSeg}
        label="Position"
        value={field(position, "")}
        options={[
          { value: "SUB", label: "x₂", tooltip: "Subscript" },
          { value: "NORMAL", icon: "24.minus.small", tooltip: "Normal" },
          { value: "SUPER", label: "x²", tooltip: "Superscript" },
        ]}
        onChange={(v) => write("Position", { fontVariantPosition: v as ExtraFields["fontVariantPosition"] })}
      />
      {toggle2("Fractions", fraction !== MIXED && fraction !== "NORMAL", applies.feature("frac"), (v) => write("Fractions", { fontVariantNumericFraction: v ? "DIAGONAL" : "NORMAL" }))}
      {toggle2("Slashed zero", variant("fontVariantSlashedZero", false), applies.feature("zero"), (v) => write("Slashed zero", { fontVariantSlashedZero: v }))}
      {heading("Letterforms")}
      {toggle2("Rare ligatures", variant("fontVariantDiscretionaryLigatures", false), applies.feature("dlig"), (v) => write("Rare ligatures", { fontVariantDiscretionaryLigatures: v }))}
      {toggle2("Contextual alternates", variant("fontVariantContextualLigatures", true), applies.feature("calt"), (v) => write("Contextual alternates", { fontVariantContextualLigatures: v }))}
      {toggle2("Ordinals", variant("fontVariantOrdinal", false), applies.feature("ordn"), (v) => write("Ordinals", { fontVariantOrdinal: v }))}
      {heading("Stylistic sets")}
      {toggle2("Stylistic alternates", toggled("salt", false), applies.feature("salt"), (v) => toggle("salt", v, false, "Stylistic alternates"))}
      {sets.map((f) => (
        <Fragment key={f.tag}>{toggle2(f.name || `Stylistic set ${Number(f.tag.slice(2))}`, toggled(f.tag, false), applies.feature(f.tag), (v) => toggle(f.tag, v, false, "Stylistic set"))}</Fragment>
      ))}
      {variants.length > 0 && heading("Character variants")}
      {variants.map((f) => (
        <Fragment key={f.tag}>{toggle2(f.name || `Character variant ${Number(f.tag.slice(2))}`, toggled(f.tag, false), applies.feature(f.tag), (v) => toggle(f.tag, v, false, "Character variant"))}</Fragment>
      ))}
      {heading("Horizontal spacing")}
      {toggle2("Kerning pairs", toggled("kern", true), applies.feature("kern"), (v) => toggle("kern", v, true, "Kerning pairs"))}
      {more.length > 0 && heading("More features")}
      {more.map((f) => (
        <Fragment key={f.tag}>{toggle2(f.label, toggled(f.tag, false), applies.feature(f.tag), (v) => toggle(f.tag, v, false, f.label))}</Fragment>
      ))}
    </div>
  );
}

/**
 * An axis's marks on its slider (live popovers/type-settings-variable.txt: Weight's nine at 100…900, Slant's one at its
 * default). Live's marks are likely the font's named instances; the engine gives none, so weight marks every 100 and the
 * rest their default (unverified).
 */
export function axisStops(a: Pick<FontInfo["axes"][number], "tag" | "min" | "max" | "default">): number[] {
  if (a.tag !== "wght") return [a.default];
  const out: number[] = [];
  for (let v = Math.ceil(a.min / 100) * 100; v <= a.max; v += 100) out.push(v);
  return out;
}

/** Live's order: the axes by name (Slant before Weight), whatever the font's own order (unverified rule). */
export function axisOrder<T extends { tag: string; name: string }>(axes: readonly T[]): T[] {
  const label = (a: T) => AXIS_LABELS[a.tag] ?? a.name ?? a.tag;
  return [...axes].sort((x, y) => label(x).localeCompare(label(y)));
}

function Variable({ nodes, summary, axes }: { nodes: PanelNode[]; summary: TextSummary | null; axes: FontInfo["axes"] }) {
  const ed = useEditor();
  const write = useWrite(nodes);
  const axisValue = (tag: string, fallback: number) =>
    summary?.mixed.has(`axis:${tag}`) ? MIXED : ((summary?.values[`axis:${tag}`] as number | undefined) ?? fallback);
  const variations = summary?.values.fontVariations as { axisTag: number; axisName?: string; value: number }[] | null | undefined;
  const set = (tag: string, name: string, value: number, info?: ChangeInfo) =>
    write(name, { fontVariations: withAxis(variations, tag, name, value) }, info);
  // Live: per axis the name and its field (81 × 24 at 143, the number 72 at 151), the slider under them (its marks 4 × 4
  // from 18 to 218, the thumb 16), 65 apart.
  return (
    <div className={styles.axes}>
      {axisOrder(axes).map((a) => {
        const name = AXIS_LABELS[a.tag] ?? a.name ?? a.tag;
        const value = axisValue(a.tag, a.default);
        const at = value === MIXED ? a.default : value;
        const span = a.max - a.min || 1;
        return (
          <div key={a.tag} className={styles.axis}>
            <span className={styles.settingsLabel}>{name}</span>
            <NumericInput
              className={styles.axisField}
              label={`${name} value`}
              value={value}
              min={a.min}
              max={a.max}
              onChange={(v, info) => set(a.tag, name, v, info)}
              onCancel={() => ed.cancelEdit()}
            />
            <span className={styles.axisTrack}>
              {axisStops(a).map((v) => (
                <span key={v} className={styles.axisStop} data-on={v === at || undefined} style={{ left: `calc(${((v - a.min) / span) * 100}% - 2px)` }} />
              ))}
              <input
                type="range"
                aria-label={name}
                className={styles.axisSlider}
                min={a.min}
                max={a.max}
                step={a.max - a.min > 10 ? 1 : 0.1}
                value={at}
                onChange={(e) => set(a.tag, name, Number(e.currentTarget.value), { final: false, source: "drag" })}
                onPointerUp={(e) => set(a.tag, name, Number(e.currentTarget.value), { final: true, source: "drag" })}
                onKeyUp={(e) => set(a.tag, name, Number(e.currentTarget.value), { final: true, source: "drag" })}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}
