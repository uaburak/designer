/**
 * Typography (Figma UI3's text section) on the schema's text fields: font
 * family, style and size; line height ("Auto" = {100, PERCENT}) and letter
 * spacing; horizontal and vertical alignment; "Type settings" with resizing
 * (Auto width / Auto height / Fixed size), truncation and max lines, paragraph
 * spacing and indent, alignment incl. justified, case, decoration, vertical
 * trim, hanging punctuation.
 *
 * The engine keeps text fields with E3; until `supportsField` sees one, its
 * control shows disabled with Figma's defaults (Inter Regular 12, Auto, 0%).
 */
import { useState } from "react";
import { Checkbox, Icon, IconButton, MIXED, MenuButton, NumericInput, PanelSection, Popover, PropertyGrid, PropertyRow, SegmentedControl, Select, isMixed, type ChangeInfo, type MenuEntry } from "@/ds";
import { useEditor } from "../../controller";
import { BindButton } from "./Component";
import { supportsField } from "../../engineCompat";
import { useUI } from "../../hooks";
import { fieldValue, mixed, mixedNumber, sameData } from "../../model/mixed";
import { exitToCanvas } from "./Sections";
import { SETTINGS_WIDTH } from "./Sizing";
import type { FontFamily } from "@/engine/fonts";
import { familyNames, familyStyles, useFontFamilies } from "../../fontList";
import { FontField } from "./FontPicker";
import { fields, useSupports, type ExtraFields, type FontName, type NumberValue, type PanelNode } from "./shared";
import styles from "./Design.module.css";
import { AppliedStyle, StylesButton, sharedStyle } from "./Styles";
import { VariableField } from "./Variables";

/** Figma's text defaults (schema/document.kiwi @default). */
export const TEXT_DEFAULTS = {
  fontName: { family: "Inter", style: "Regular", postscript: "Inter-Regular" } as FontName,
  fontSize: 12,
  lineHeight: { value: 100, units: "PERCENT" } as NumberValue,
  letterSpacing: { value: 0, units: "PERCENT" } as NumberValue,
};

/** Figma's font size menu. */
export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 20, 24, 32, 36, 40, 48, 64, 96, 128];

/** Inter's styles: offered before the font list has arrived (and for Inter in tests without a desktop). */
export const FALLBACK_STYLES = ["Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"];

/** The families the picker lists: every installed (and bundled) family, plus the selection's own when not installed. */
export function fontFamilies(list: readonly FontFamily[] | null, nodes: readonly { fontName?: { family: string } }[]): string[] {
  return familyNames(list, ["Inter", ...nodes.map((n) => n.fontName?.family).filter((f): f is string => !!f)]);
}

/** The styles the Font style menu lists for `family`: its own (variable fonts: their named instances), else the current one. */
export function fontStyles(list: readonly FontFamily[] | null, family: string, style: string | undefined): string[] {
  const styles = familyStyles(list, family, style);
  if (!list && family.toLowerCase() === "inter") return [...new Set([...(style ? [style] : []), ...FALLBACK_STYLES])];
  return styles;
}

/** The families the document names, lower case (the font picker's "In this file"). */
export function documentFamilies(engine: { documentFonts?: () => { family: string }[] }): Set<string> {
  try {
    return new Set((engine.documentFonts?.() ?? []).map((f) => f.family.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** Line height as the field shows it: "Auto" ({100, PERCENT}), px, or a percent (the UI's "140%" = {1.4, RAW}, docs/schema.md). */
export function lineHeightView(lh: NumberValue | undefined): { value: number | null; label?: string; unit?: string } {
  const v = lh ?? TEXT_DEFAULTS.lineHeight;
  if (v.units === "PERCENT" && Math.abs(v.value - 100) < 1e-6) return { value: null, label: "Auto" };
  if (v.units === "PIXELS") return { value: v.value };
  if (v.units === "RAW") return { value: Math.round(v.value * 10000) / 100, unit: "%" };
  return { value: v.value, unit: "%" };
}

export function TypographySection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const kept = useSupports("fontSize");
  const fontKept = useSupports("fontName");
  const lhKept = useSupports("lineHeight");
  const lsKept = useSupports("letterSpacing");
  const alignKept = useSupports("textAlignHorizontal");
  const valignKept = useSupports("textAlignVertical");
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const [sizePicker, setSizePicker] = useState<HTMLElement | null>(null);
  const styled = sharedStyle(nodes, "text");
  const hasStyle = !!styled && styled !== "mixed";
  const refs = nodes.map((n) => n.guid);
  const write = (label: string, f: ExtraFields, info?: ChangeInfo) => (info ? ed.edit(label, info, () => void ed.engine.setProps(refs, fields(f))) : ed.setProps(refs, fields(f), label));

  const font = mixed(nodes.map((n) => n.fontName ?? TEXT_DEFAULTS.fontName), sameData);
  const family = font === undefined ? TEXT_DEFAULTS.fontName.family : isMixed(font) ? MIXED : font.family;
  const style = font === undefined ? TEXT_DEFAULTS.fontName.style : isMixed(font) ? MIXED : font.style;
  const size = mixedNumber(nodes.map((n) => n.fontSize ?? TEXT_DEFAULTS.fontSize));
  const lh = mixed(nodes.map((n) => n.lineHeight ?? TEXT_DEFAULTS.lineHeight), sameData);
  const lhView = lh === undefined || isMixed(lh) ? null : lineHeightView(lh);
  const ls = mixed(nodes.map((n) => n.letterSpacing ?? TEXT_DEFAULTS.letterSpacing), sameData);
  const lsValue = ls === undefined ? 0 : isMixed(ls) ? MIXED : ls.value;
  const lsUnit = ls && !isMixed(ls) && ls.units === "PIXELS" ? undefined : "%";
  const align = mixed(nodes.map((n) => n.textAlignHorizontal ?? "LEFT"));
  const valign = mixed(nodes.map((n) => n.textAlignVertical ?? "TOP"));
  const fontList = useFontFamilies();
  const styleOptions = isMixed(family) ? (isMixed(style) ? [] : [style]) : fontStyles(fontList, family, isMixed(style) ? undefined : style);
  const sizeEntries: MenuEntry[] = [...FONT_SIZES.map((s) => ({ id: String(s), label: String(s), checked: size === s })), "-", { id: "apply-variable", label: "Apply variable…" }];

  return (
    <PanelSection
      title="Typography"
      actions={
        <>
          {nodes.length === 1 && <BindButton layer={nodes[0]} field="TEXT_DATA" type="TEXT" />}
          <StylesButton nodes={nodes} slot="text" />
        </>
      }
    >
      {hasStyle && <AppliedStyle nodes={nodes} slot="text" />}
      <PropertyGrid labels={labels}>
        {!hasStyle && (
          <>
        <PropertyRow span={2} label="Font family">
          <FontField
            family={family}
            style={style}
            list={fontList}
            fileFamilies={() => documentFamilies(ed.engine)}
            disabled={!fontKept}
            onPreview={(f) => (f ? ed.edit("Font", { final: false, source: "pick" }, () => void ed.engine.setProps(refs, fields({ fontName: { ...f, postscript: "" } }))) : ed.cancelEdit())}
            onPick={(f) => ed.edit("Font", { final: true, source: "pick" }, () => void ed.engine.setProps(refs, fields({ fontName: { ...f, postscript: "" } })))}
          />
        </PropertyRow>
        <PropertyRow label="Font style and size">
          <Select
            label="Font style"
            value={style}
            disabled={!fontKept}
            options={styleOptions.map((s) => ({ value: s, label: s }))}
            onChange={(s) => write("Font style", { fontName: { family: isMixed(family) ? "Inter" : family, style: s, postscript: "" } })}
          />
          <span data-font-size="" style={{ display: "contents" }}>
          <VariableField nodes={nodes} fields={["FONT_SIZE"]} prefix="24.text.font-size" button={false} open={sizePicker} onOpenChange={setSizePicker}>
          <NumericInput
            label="Font size"
            value={fieldValue(size)}
            min={1}
            max={1000}
            disabled={!kept}
            onChange={(v, info) => write("Font size", { fontSize: v }, info)}
            onCancel={() => ed.cancelEdit()}
            onStep={(d) => ed.batch("Font size", () => nodes.forEach((n) => ed.engine.setProps([n.guid], fields({ fontSize: Math.max(1, (n.fontSize ?? 12) + d) }))))}
            onExit={exitToCanvas(ed)}
            suffix={
              kept ? (
                <MenuButton
                  label="Font sizes"
                  entries={sizeEntries}
                  onSelect={(id) => (id === "apply-variable" ? setSizePicker(document.querySelector<HTMLElement>('[data-font-size] [data-bind-field]')) : write("Font size", { fontSize: Number(id) }))}
                  className={styles.sizeMenu}
                >
                  <Icon name="16.chevron.down" />
                </MenuButton>
              ) : undefined
            }
          />
          </VariableField>
          </span>
        </PropertyRow>
        <PropertyRow label="Line height and letter spacing">
          <VariableField nodes={nodes} fields={["LINE_HEIGHT"]} prefix="24.text.line-height" disabled={!lhKept}>
          <NumericInput
            label="Line height"
            prefix="24.text.line-height"
            value={lh === undefined ? null : isMixed(lh) ? MIXED : lhView!.value}
            valueLabel={lhView?.label}
            unit={lhView?.unit}
            placeholder="Auto"
            min={0}
            disabled={!lhKept}
            onChange={(v, info) => write("Line height", { lineHeight: lhView?.unit === "%" ? { value: v / 100, units: "RAW" } : { value: v, units: "PIXELS" } }, info)}
            onClear={() => write("Line height", { lineHeight: TEXT_DEFAULTS.lineHeight })}
            onCancel={() => ed.cancelEdit()}
            onExit={exitToCanvas(ed)}
          />
          </VariableField>
          <VariableField nodes={nodes} fields={["LETTER_SPACING"]} prefix="24.text.letter-spacing" disabled={!lsKept}>
          <NumericInput
            label="Letter spacing"
            prefix="24.text.letter-spacing"
            value={lsValue}
            unit={lsUnit}
            disabled={!lsKept}
            onChange={(v, info) => write("Letter spacing", { letterSpacing: { value: v, units: lsUnit ? "PERCENT" : "PIXELS" } }, info)}
            onCancel={() => ed.cancelEdit()}
            onExit={exitToCanvas(ed)}
          />
          </VariableField>
        </PropertyRow>
          </>
        )}
        <PropertyRow
          label="Alignment"
          action={<IconButton icon="24.adjust.small" label="Type settings" tone="secondary" aria-expanded={!!details} onClick={(e) => setDetails(details ? null : e.currentTarget)} />}
        >
          <SegmentedControl
            label="Text align horizontal"
            fullWidth
            disabled={!alignKept}
            value={align === undefined ? "LEFT" : align}
            options={[
              { value: "LEFT", icon: "24.text.align-left", tooltip: "Align left" },
              { value: "CENTER", icon: "24.text.align-center", tooltip: "Align center" },
              { value: "RIGHT", icon: "24.text.align-right", tooltip: "Align right" },
            ]}
            onChange={(v) => write("Text alignment", { textAlignHorizontal: v as ExtraFields["textAlignHorizontal"] })}
          />
          <SegmentedControl
            label="Text align vertical"
            fullWidth
            disabled={!valignKept}
            value={valign === undefined ? "TOP" : valign}
            options={[
              { value: "TOP", icon: "24.text.align-top", tooltip: "Align top" },
              { value: "CENTER", icon: "24.text.align-middle", tooltip: "Align middle" },
              { value: "BOTTOM", icon: "24.text.align-bottom", tooltip: "Align bottom" },
            ]}
            onChange={(v) => write("Text alignment", { textAlignVertical: v as ExtraFields["textAlignVertical"] })}
          />
        </PropertyRow>
      </PropertyGrid>
      {details && <TypeSettings nodes={nodes} anchor={details} onClose={() => setDetails(null)} />}
    </PanelSection>
  );
}

/** "Type settings": the details Figma keeps out of the section. */
function TypeSettings({ nodes, anchor, onClose }: { nodes: PanelNode[]; anchor: HTMLElement; onClose: () => void }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const kept = (f: string) => supportsField(ed.engine, f);
  const write = (label: string, f: ExtraFields, info?: ChangeInfo) => (info ? ed.edit(label, info, () => void ed.engine.setProps(refs, fields(f))) : ed.setProps(refs, fields(f), label));
  const resize = mixed(nodes.map((n) => n.textAutoResize ?? "NONE"));
  const truncate = mixed(nodes.map((n) => n.textTruncation === "ENDING"));
  const maxLines = mixedNumber(nodes.map((n) => n.maxLines ?? 0));
  const paragraph = mixedNumber(nodes.map((n) => n.paragraphSpacing ?? 0));
  const indent = mixedNumber(nodes.map((n) => n.paragraphIndent ?? 0));
  const align = mixed(nodes.map((n) => n.textAlignHorizontal ?? "LEFT"));
  const textCase = mixed(nodes.map((n) => n.textCase ?? "ORIGINAL"));
  const decoration = mixed(nodes.map((n) => n.textDecoration ?? "NONE"));
  const trim = mixed(nodes.map((n) => n.leadingTrim ?? "NONE"));
  const hanging = mixed(nodes.map((n) => n.hangingPunctuation === true));
  return (
    <Popover anchor={anchor} title="Type settings" width={SETTINGS_WIDTH} onClose={onClose} label="Type settings">
      <div className={styles.settings}>
        <span className={styles.settingsLabel}>Resizing</span>
        <SegmentedControl
          label="Resizing"
          fullWidth
          disabled={!kept("textAutoResize")}
          value={resize ?? "NONE"}
          options={[
            { value: "WIDTH_AND_HEIGHT", icon: "24.text.resize-width", tooltip: "Auto width" },
            { value: "HEIGHT", icon: "24.text.resize-height", tooltip: "Auto height" },
            { value: "NONE", icon: "24.text.resize-fixed", tooltip: "Fixed size" },
          ]}
          onChange={(v) => write("Text resizing", { textAutoResize: v as ExtraFields["textAutoResize"] })}
        />
        <span className={styles.settingsLabel}>Alignment</span>
        <SegmentedControl
          label="Text align horizontal"
          fullWidth
          disabled={!kept("textAlignHorizontal")}
          value={align ?? "LEFT"}
          options={[
            { value: "LEFT", icon: "24.text.align-left", tooltip: "Align left" },
            { value: "CENTER", icon: "24.text.align-center", tooltip: "Align center" },
            { value: "RIGHT", icon: "24.text.align-right", tooltip: "Align right" },
            { value: "JUSTIFIED", icon: "24.text.align-justified", tooltip: "Justified" },
          ]}
          onChange={(v) => write("Text alignment", { textAlignHorizontal: v as ExtraFields["textAlignHorizontal"] })}
        />
        <span className={styles.settingsLabel}>Paragraph spacing</span>
        <NumericInput label="Paragraph spacing" value={fieldValue(paragraph)} min={0} disabled={!kept("paragraphSpacing")} onChange={(v, info) => write("Paragraph spacing", { paragraphSpacing: v }, info)} onCancel={() => ed.cancelEdit()} />
        <span className={styles.settingsLabel}>Paragraph indent</span>
        <NumericInput label="Paragraph indent" value={fieldValue(indent)} min={0} disabled={!kept("paragraphIndent")} onChange={(v, info) => write("Paragraph indent", { paragraphIndent: v }, info)} onCancel={() => ed.cancelEdit()} />
        <span className={styles.settingsLabel}>Truncate text</span>
        <Checkbox label="Truncate text" hideLabel checked={truncate ?? false} disabled={!kept("textTruncation")} onChange={(on) => write("Truncate text", { textTruncation: on ? "ENDING" : "DISABLED" })} />
        <span className={styles.settingsLabel}>Max lines</span>
        <NumericInput label="Max lines" value={maxLines === 0 ? null : fieldValue(maxLines)} placeholder="—" min={1} precision={0} disabled={!kept("maxLines") || truncate !== true} onChange={(v, info) => write("Max lines", { maxLines: v }, info)} onClear={() => write("Max lines", { maxLines: 0 })} onCancel={() => ed.cancelEdit()} />
        <span className={styles.settingsLabel}>Case</span>
        <Select
          label="Case"
          value={textCase ?? "ORIGINAL"}
          disabled={!kept("textCase")}
          options={[
            { value: "ORIGINAL", label: "As typed" },
            { value: "UPPER", label: "Uppercase" },
            { value: "LOWER", label: "Lowercase" },
            { value: "TITLE", label: "Title case" },
            { value: "SMALL_CAPS", label: "Small caps" },
            { value: "SMALL_CAPS_FORCED", label: "Forced small caps" },
          ]}
          onChange={(v) => write("Text case", { textCase: v as ExtraFields["textCase"] })}
        />
        <span className={styles.settingsLabel}>Decoration</span>
        <Select
          label="Decoration"
          value={decoration ?? "NONE"}
          disabled={!kept("textDecoration")}
          options={[
            { value: "NONE", label: "None" },
            { value: "UNDERLINE", label: "Underline" },
            { value: "STRIKETHROUGH", label: "Strikethrough" },
          ]}
          onChange={(v) => write("Text decoration", { textDecoration: v as ExtraFields["textDecoration"] })}
        />
        <span className={styles.settingsLabel}>Vertical trim</span>
        <Select
          label="Vertical trim"
          value={trim ?? "NONE"}
          disabled={!kept("leadingTrim")}
          options={[
            { value: "NONE", label: "Standard" },
            { value: "CAP_HEIGHT", label: "Cap height to baseline" },
          ]}
          onChange={(v) => write("Vertical trim", { leadingTrim: v as ExtraFields["leadingTrim"] })}
        />
        <span className={styles.settingsLabel}>Hanging punctuation</span>
        <Checkbox label="Hanging punctuation" hideLabel checked={hanging ?? false} disabled={!kept("hangingPunctuation")} onChange={(on) => write("Hanging punctuation", { hangingPunctuation: on })} />
      </div>
    </Popover>
  );
}
