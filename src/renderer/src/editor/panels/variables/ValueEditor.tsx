/**
 * One variable's value in one mode, edited in place (the Local variables
 * table's cells and the Edit variable modal's Values): a colour's swatch (the
 * colour picker) and hex, a number, a string, a boolean; Motion's easing (its
 * name; a click opens the Easing page's controls — graph, presets, Curve |
 * Spring, Bezier / Bounce — in a floating "Easing" panel, 2026-10-19) and timing (milliseconds; round 8i); an alias shows
 * as the aliased variable's pill (its × makes it a plain value again: the value
 * it resolves to now). "Apply variable" on hover aliases another variable of
 * the same type — never one that would make a cycle.
 */
import { useMemo, useState } from "react";
import { ColorPicker, Icon, NumericInput, Popover, Swatch, Switch, TextInput, cx, tooltipProps } from "@/ds";
import type { Color, Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { aliasMakesCycle, formatLiteral, isEasingLiteral, resolveVariable, valueIn, type Collection, type Literal, type Variable } from "../../model/variables";
import { EasingControls } from "../../motion/easing/EasingPage";
import { isOverridden, resetOverride, setVariableValue } from "../../variables";
import { VariableGlyph, VariablePicker } from "./VariablePicker";
import styles from "./LocalVariables.module.css";
import { t, useT } from "@/i18n";

/** "0D99FF", "#0d99ff", "0D99FF 50%" → a colour (null: not a colour). */
export function parseColorText(text: string, alpha = 1): Color | null {
  const m = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6})\s*(?:(\d{1,3})\s*%)?\s*$/i.exec(text);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return hexToColor(`#${hex}`, m[2] !== undefined ? Math.min(100, Number(m[2])) / 100 : alpha);
}

export function ValueEditor({ variable, mode, collection, className, disabled }: { variable: Variable; mode: Guid; collection: Collection; className?: string; disabled?: boolean }) {
  useT();
  const ed = useEditor();
  const a = useLocalAssets();
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [color, setColor] = useState<DOMRect | null>(null);
  const [easing, setEasing] = useState<DOMRect | null>(null);
  const value = valueIn(variable, mode, collection);
  const resolved = value.kind === "literal" ? value.value : resolveVariable(value.id, a.lookup);
  // An extended collection: the values it overrides show in blue, with "Reset change" (Figma).
  const overridden = !!collection.parent && isOverridden(collection, variable.id, mode);
  const set = (v: Literal, info?: { final: boolean; source?: string }) => setVariableValue(ed, variable.id, mode, { kind: "literal", value: v }, info);
  const exclude = useMemo(() => new Set(a.variables.filter((v) => v.type === variable.type && (v.id === variable.id || aliasMakesCycle(variable.id, v.id, a.lookup))).map((v) => v.id)), [a, variable]);
  const label = t("{name} in {mode}", { name: variable.name, mode: collection.modes.find((m) => m.id === mode)?.name ?? t("mode") });

  let body;
  if (value.kind === "alias") {
    const target = a.lookup.variable(value.id);
    body = (
      <button type="button" className={styles.alias} aria-label={`${label}: ${target?.name ?? t("Missing variable")}`} {...tooltipProps(target?.name ?? t("Missing variable"))} onClick={(e) => setPicker(e.currentTarget)}>
        <VariableGlyph type={variable.type} value={resolved} />
        <span className={styles.aliasText}>{target?.name ?? t("Missing variable")}</span>
      </button>
    );
  } else {
    switch (variable.type) {
      case "COLOR": {
        const c = value.value as Color;
        body = (
          <>
            <button type="button" className={styles.swatchButton} aria-label={`${label}: ${t("colour")}`} onClick={(e) => setColor(e.currentTarget.getBoundingClientRect())}>
              <Swatch color={colorToHex(c)} opacity={toPercent(c.a ?? 1)} size={16} />
            </button>
            <TextInput
              label={label}
              variant="ghost"
              value={formatLiteral("COLOR", c)}
              onCommit={(text) => {
                const next = parseColorText(text, c.a ?? 1);
                if (next) set(next);
              }}
            />
          </>
        );
        break;
      }
      case "FLOAT":
        body = <NumericInput label={label} variant="ghost" value={Number(value.value)} min={-1e6} max={1e6} onChange={(v, info) => set(v, info)} onCancel={() => ed.cancelEdit()} scrub={false} />;
        break;
      case "STRING":
        body = <TextInput label={label} variant="ghost" value={String(value.value)} placeholder={t("Empty")} onCommit={(v) => set(v)} />;
        break;
      case "BOOLEAN":
        // Live 2026-10-19 (variables.txt): a switch, then "True" / "False"
        body = (
          <span className={styles.boolean}>
            <Switch label={label} checked={value.value === true} onChange={(on) => set(on)} />
            <span aria-hidden>{value.value === true ? t("True") : t("False")}</span>
          </span>
        );
        break;
      case "EASING":
        // Its name (a custom curve's numbers too); the Easing editor edits it.
        body = (
          <button type="button" className={styles.easingValue} aria-label={`${label}: ${formatLiteral("EASING", value.value)}`} data-easing-value onClick={(e) => setEasing(e.currentTarget.getBoundingClientRect())}>
            <Icon name="16.easing" />
            <span className={styles.aliasText}>{formatLiteral("EASING", value.value)}</span>
          </button>
        );
        break;
      case "TIMING":
        body = <NumericInput label={label} variant="ghost" value={Number(value.value)} unit="ms" precision={0} min={0} max={1e6} onChange={(v, info) => set(v, info)} onCancel={() => ed.cancelEdit()} scrub={false} />;
        break;
    }
  }

  if (disabled)
    // A mode past the plan's limit (atlas 11 §3.1): its column is disabled, the value shown, not edited.
    return (
      <div className={cx(styles.cell, styles.value, styles.valueDisabled, className)} aria-disabled="true" data-value-cell={`${variable.name}|${collection.modes.find((m) => m.id === mode)?.name ?? ""}`}>
        <span className={styles.valueText}>{formatLiteral(variable.type, resolved)}</span>
      </div>
    );

  return (
    <div
      className={cx(styles.cell, styles.value, overridden && styles.overridden, className)}
      data-value-cell={`${variable.name}|${collection.modes.find((m) => m.id === mode)?.name ?? ""}`}
      data-value-mode={mode}
      data-overridden={overridden ? "" : undefined}
    >
      {body}
      {overridden && (
        <button type="button" className={styles.cellButton} aria-label={t("Reset change")} {...tooltipProps(t("Reset change"))} onClick={() => resetOverride(ed, collection.id, variable.id, mode)}>
          <Icon name="24.reset.instance.small" />
        </button>
      )}
      {value.kind === "alias" ? (
        <button
          type="button"
          className={styles.cellButton}
          aria-label={t("Detach variable")}
          {...tooltipProps(t("Detach variable"))}
          onClick={() => {
            if (resolved !== null) set(resolved);
          }}
        >
          <Icon name="24.detach.small" />
        </button>
      ) : variable.type === "COLOR" ? (
        // Figma, on hover: the colour's opacity as a field at the cell's right ("Opacity"), Apply variable inside it
        <span className={styles.opacityField} data-opacity-field="" data-open={picker ? "" : undefined} {...tooltipProps(t("Opacity"))}>
          {/* Its glyph scrubs: press and drag left / right (Figma) */}
          <NumericInput
            label={t("Opacity")}
            variant="ghost"
            prefix="24.opacity"
            value={toPercent((value.value as Color).a ?? 1)}
            unit="%"
            precision={0}
            min={0}
            max={100}
            onChange={(v, info) => set({ ...(value.value as Color), a: Math.max(0, Math.min(100, v)) / 100 }, info)}
            onCancel={() => ed.cancelEdit()}
          />
          <button type="button" className={styles.opacityBind} aria-label={t("Apply variable")} aria-expanded={!!picker} {...tooltipProps(t("Apply variable"))} onClick={(e) => setPicker(e.currentTarget)}>
            <Icon name="24.variable.small" />
          </button>
        </span>
      ) : (
        <button type="button" className={styles.cellButton} aria-label={t("Apply variable")} aria-expanded={!!picker} {...tooltipProps(t("Apply variable"))} onClick={(e) => setPicker(e.currentTarget)}>
          <Icon name="24.variable.small" />
        </button>
      )}
      {picker && (
        <VariablePicker
          anchor={picker}
          placement="bottom-start"
          types={[variable.type]}
          exclude={exclude}
          current={value.kind === "alias" ? value.id : null}
          onPick={(v) => setVariableValue(ed, variable.id, mode, { kind: "alias", id: v.id })}
          onClose={() => setPicker(null)}
        />
      )}
      {easing && value.kind === "literal" && isEasingLiteral(value.value) && (
        // The Easing page's own controls (motion/easing/EasingPage.tsx) over the value; a drag is one step (ed.edit).
        <Popover anchor={easing} placement="bottom-start" title={t("Easing")} width={240} label={label} onClose={() => setEasing(null)}>
          <div data-easing-value-editor>
            <EasingControls
              values={[{ easing: value.value }]}
              variables={false}
              onChange={(next, commit) => {
                if ("type" in next) set(next, { final: commit, source: commit ? "pick" : "drag" });
              }}
            />
          </div>
        </Popover>
      )}
      {color && value.kind === "literal" && (
        <ColorPicker
          value={{ type: "SOLID", color: { ...(value.value as Color), a: 1 }, opacity: (value.value as Color).a ?? 1 }}
          paintTypes={["SOLID"]}
          anchor={color}
          placement="bottom-start"
          onChange={(next, info) => set({ ...(next.color ?? (value.value as Color)), a: next.opacity ?? 1 }, info)}
          onCancel={() => ed.cancelEdit()}
          onClose={() => setColor(null)}
        />
      )}
    </div>
  );
}
