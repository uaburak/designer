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
import { Fragment, useEffect, useMemo, useState } from "react";
import { fonts } from "@/engine/fonts";
import { Checkbox, MIXED, NumericInput, Popover, SegmentedControl, Select, Tabs, type ChangeInfo } from "@/ds";
import { useEditor } from "../../controller";
import { AXIS_LABELS, featureName, withAxis, type TextSummary } from "../../model/text";
import { exitToCanvas } from "./Sections";
import { SETTINGS_WIDTH } from "./Layout";
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
      width={SETTINGS_WIDTH}
      onClose={onClose}
      header={<Tabs label="Type settings" value={shown} tabs={tabs} onChange={(v) => setTab(v as Tab)} />}
    >
      <div className={styles.typeSettingsBody}>
        {shown === "basics" && <Basics nodes={nodes} summary={summary} />}
        {shown === "details" && <Details nodes={nodes} summary={summary} info={info} />}
        {shown === "variable" && <Variable nodes={nodes} summary={summary} axes={axes} />}
      </div>
    </Popover>
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

function Basics({ nodes, summary }: { nodes: PanelNode[]; summary: TextSummary | null }) {
  const ed = useEditor();
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
  return (
    <div className={styles.settings}>
      <span className={styles.settingsLabel}>Alignment</span>
      <SegmentedControl
        label="Text align horizontal"
        fullWidth
        value={field(align, "")}
        options={[
          { value: "LEFT", icon: "24.text.align-left", tooltip: "Align left" },
          { value: "CENTER", icon: "24.text.align-center", tooltip: "Align center" },
          { value: "RIGHT", icon: "24.text.align-right", tooltip: "Align right" },
          { value: "JUSTIFIED", icon: "24.text.align-justified", tooltip: "Justify" },
        ]}
        onChange={(v) => write("Text alignment", { textAlignHorizontal: v as ExtraFields["textAlignHorizontal"] })}
      />
      <span className={styles.settingsLabel}>Decoration</span>
      <SegmentedControl
        label="Decoration"
        fullWidth
        value={field(decoration, "")}
        options={[
          { value: "NONE", label: "—", tooltip: "None" },
          { value: "UNDERLINE", icon: "24.text.underline", tooltip: "Underline" },
          { value: "STRIKETHROUGH", icon: "24.text.strikethrough", tooltip: "Strikethrough" },
        ]}
        onChange={(v) => write("Text decoration", { textDecoration: v as ExtraFields["textDecoration"] })}
      />
      {decoration === "UNDERLINE" && (
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
      <span className={styles.settingsLabel}>Letter case</span>
      <Select
        label="Letter case"
        value={field(textCase, MIXED as unknown as string)}
        options={[
          { value: "ORIGINAL", label: "As typed" },
          { value: "UPPER", label: "Uppercase" },
          { value: "LOWER", label: "Lowercase" },
          { value: "TITLE", label: "Capitalize" },
          { value: "SMALL_CAPS", label: "Small caps" },
          { value: "SMALL_CAPS_FORCED", label: "Forced small caps" },
        ]}
        onChange={(v) => write("Text case", { textCase: v as ExtraFields["textCase"] })}
      />
      <span className={styles.settingsLabel}>Vertical trim</span>
      <Select
        label="Vertical trim"
        value={field(trim, MIXED as unknown as string)}
        options={[
          { value: "NONE", label: "Standard" },
          { value: "CAP_HEIGHT", label: "Cap height to baseline" },
        ]}
        onChange={(v) => write("Vertical trim", { leadingTrim: v as ExtraFields["leadingTrim"] })}
      />
      <span className={styles.settingsLabel}>List style</span>
      <SegmentedControl
        label="List style"
        fullWidth
        value={lineType === MIXED ? "" : lineType === "ORDERED_LIST" ? "ORDERED" : lineType === "UNORDERED_LIST" ? "UNORDERED" : "NONE"}
        options={[
          { value: "NONE", label: "—", tooltip: "No list" },
          { value: "UNORDERED", icon: "24.list-view", tooltip: "Bulleted list" },
          { value: "ORDERED", icon: "24.text.list-numbered", tooltip: "Numbered list" },
        ]}
        onChange={(v) => list(v as "NONE" | "ORDERED" | "UNORDERED")}
      />
      <span className={styles.settingsLabel}>Paragraph spacing</span>
      <NumericInput label="Paragraph spacing" value={paragraph} min={0} onChange={(v, info) => write("Paragraph spacing", { paragraphSpacing: v }, info)} onCancel={() => ed.cancelEdit()} onExit={exitToCanvas(ed)} />
      <span className={styles.settingsLabel}>List spacing</span>
      <NumericInput label="List spacing" value={listSpacing} min={0} onChange={(v, info) => write("List spacing", { listSpacing: v }, info)} onCancel={() => ed.cancelEdit()} onExit={exitToCanvas(ed)} />
      <span className={styles.settingsLabel}>Truncate text</span>
      <Checkbox label="Truncate text" hideLabel checked={truncate === true} onChange={(on) => write("Truncate text", { textTruncation: on ? "ENDING" : "DISABLED" })} />
      <span className={styles.settingsLabel}>Max lines</span>
      <NumericInput
        label="Max lines"
        value={maxLines === 0 ? null : maxLines}
        placeholder="—"
        min={1}
        precision={0}
        disabled={truncate !== true}
        onChange={(v, info) => write("Max lines", { maxLines: v }, info)}
        onClear={() => write("Max lines", { maxLines: 0 })}
        onCancel={() => ed.cancelEdit()}
      />
      <span className={styles.settingsLabel}>Wrap style</span>
      <Select
        label="Wrap style"
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

function Details({ nodes, summary, info }: { nodes: PanelNode[]; summary: TextSummary | null; info: FontInfo | null }) {
  const ed = useEditor();
  const write = useWrite(nodes);
  const has = (tag: string) => !info || info.features.some((f) => f.tag === tag);
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
  const check = (label: string, checked: boolean, enabled: boolean, onChange: (v: boolean) => void) => (
    <>
      <span className={styles.settingsLabel}>{label}</span>
      <Checkbox label={label} hideLabel checked={checked} disabled={!enabled} onChange={onChange} />
    </>
  );
  return (
    <div className={styles.settings}>
      <span className={styles.settingsLabel}>Paragraph indent</span>
      <NumericInput label="Paragraph indent" value={indent} min={0} onChange={(v, i) => write("Paragraph indent", { paragraphIndent: v }, i)} onCancel={() => ed.cancelEdit()} />
      {check("Hanging quotes", hanging === true, true, (v) => write("Hanging quotes", { hangingPunctuation: v }))}
      {check("Hanging lists", hangingList === true, true, (v) => write("Hanging lists", { hangingList: v }))}
      {check("Case-sensitive forms", toggled("case", false), has("case"), (v) => toggle("case", v, false, "Case-sensitive forms"))}
      {check("Capital spacing", toggled("cpsp", false), has("cpsp"), (v) => toggle("cpsp", v, false, "Capital spacing"))}
      <span className={styles.settingsLabel}>Numbers</span>
      <Select
        label="Number style"
        value={numberStyle as string}
        options={NUMBER_STYLES.map((s) => ({ value: s.value, label: s.label }))}
        onChange={(v) => {
          const s = NUMBER_STYLES.find((x) => x.value === v) ?? NUMBER_STYLES[0];
          write("Number style", { fontVariantNumericSpacing: s.spacing, fontVariantNumericFigure: s.figure });
        }}
      />
      {check("Fractions", fraction !== MIXED && fraction !== "NORMAL", has("frac"), (v) => write("Fractions", { fontVariantNumericFraction: v ? "DIAGONAL" : "NORMAL" }))}
      <span className={styles.settingsLabel}>Position</span>
      <Select
        label="Position"
        value={field(position, MIXED as unknown as string)}
        options={[
          { value: "NORMAL", label: "None" },
          { value: "SUPER", label: "Superscript" },
          { value: "SUB", label: "Subscript" },
        ]}
        onChange={(v) => write("Position", { fontVariantPosition: v as ExtraFields["fontVariantPosition"] })}
      />
      {check("Slashed zero", variant("fontVariantSlashedZero", false), has("zero"), (v) => write("Slashed zero", { fontVariantSlashedZero: v }))}
      <span className={styles.settingsHeading}>Letterforms</span>
      <span />
      {check("Ligatures", variant("fontVariantCommonLigatures", true), has("liga"), (v) => write("Ligatures", { fontVariantCommonLigatures: v }))}
      {check("Rare ligatures", variant("fontVariantDiscretionaryLigatures", false), has("dlig"), (v) => write("Rare ligatures", { fontVariantDiscretionaryLigatures: v }))}
      {check("Contextual alternates", variant("fontVariantContextualLigatures", true), has("calt"), (v) => write("Contextual alternates", { fontVariantContextualLigatures: v }))}
      {check("Ordinals", variant("fontVariantOrdinal", false), has("ordn"), (v) => write("Ordinals", { fontVariantOrdinal: v }))}
      {sets.length > 0 && (
        <>
          <span className={styles.settingsHeading}>Stylistic sets</span>
          <span />
        </>
      )}
      {sets.map((f) => (
        <Fragment key={f.tag}>{check(f.name || `Stylistic set ${Number(f.tag.slice(2))}`, toggled(f.tag, false), true, (v) => toggle(f.tag, v, false, "Stylistic set"))}</Fragment>
      ))}
      {variants.length > 0 && (
        <>
          <span className={styles.settingsHeading}>Character variants</span>
          <span />
        </>
      )}
      {variants.map((f) => (
        <Fragment key={f.tag}>{check(f.name || `Character variant ${Number(f.tag.slice(2))}`, toggled(f.tag, false), true, (v) => toggle(f.tag, v, false, "Character variant"))}</Fragment>
      ))}
      <span className={styles.settingsHeading}>Horizontal spacing</span>
      <span />
      {check("Kerning", toggled("kern", true), has("kern"), (v) => toggle("kern", v, true, "Kerning"))}
    </div>
  );
}

function Variable({ nodes, summary, axes }: { nodes: PanelNode[]; summary: TextSummary | null; axes: FontInfo["axes"] }) {
  const ed = useEditor();
  const write = useWrite(nodes);
  const axisValue = (tag: string, fallback: number) =>
    summary?.mixed.has(`axis:${tag}`) ? MIXED : ((summary?.values[`axis:${tag}`] as number | undefined) ?? fallback);
  const variations = summary?.values.fontVariations as { axisTag: number; axisName?: string; value: number }[] | null | undefined;
  const set = (tag: string, name: string, value: number, info?: ChangeInfo) =>
    write(name, { fontVariations: withAxis(variations, tag, name, value) }, info);
  return (
    <div className={styles.settings}>
      {axes.map((a) => {
        const name = AXIS_LABELS[a.tag] ?? a.name ?? a.tag;
        const value = axisValue(a.tag, a.default);
        return (
          <Fragment key={a.tag}>
            <span className={styles.settingsLabel}>{name}</span>
            <span className={styles.axisRow}>
              <input
                type="range"
                aria-label={name}
                className={styles.axisSlider}
                min={a.min}
                max={a.max}
                step={a.max - a.min > 10 ? 1 : 0.1}
                value={value === MIXED ? a.default : value}
                onChange={(e) => set(a.tag, name, Number(e.currentTarget.value), { final: false, source: "drag" })}
                onPointerUp={(e) => set(a.tag, name, Number(e.currentTarget.value), { final: true, source: "drag" })}
                onKeyUp={(e) => set(a.tag, name, Number(e.currentTarget.value), { final: true, source: "drag" })}
              />
              <NumericInput
                label={`${name} value`}
                value={value}
                min={a.min}
                max={a.max}
                onChange={(v, info) => set(a.tag, name, v, info)}
                onCancel={() => ed.cancelEdit()}
              />
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
