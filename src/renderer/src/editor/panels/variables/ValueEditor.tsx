/**
 * One variable's value in one mode, edited in place (the Local variables
 * table's cells and the Edit variable modal's Values): a colour's swatch (the
 * colour picker) and hex, a number, a string, a boolean; an alias shows as the
 * aliased variable's pill (its × makes it a plain value again: the value it
 * resolves to now). "Apply variable" on hover aliases another variable of the
 * same type — never one that would make a cycle.
 */
import { useMemo, useState } from "react";
import { Checkbox, ColorPicker, Icon, NumericInput, Swatch, TextInput, cx, tooltipProps } from "@/ds";
import type { Color, Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { aliasMakesCycle, formatLiteral, resolveVariable, valueIn, type Collection, type Literal, type Variable } from "../../model/variables";
import { isOverridden, resetOverride, setVariableValue } from "../../variables";
import { VariableGlyph, VariablePicker } from "./VariablePicker";
import styles from "./LocalVariables.module.css";

/** "0D99FF", "#0d99ff", "0D99FF 50%" → a colour (null: not a colour). */
export function parseColorText(text: string, alpha = 1): Color | null {
  const m = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6})\s*(?:(\d{1,3})\s*%)?\s*$/i.exec(text);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return hexToColor(`#${hex}`, m[2] !== undefined ? Math.min(100, Number(m[2])) / 100 : alpha);
}

export function ValueEditor({ variable, mode, collection, className }: { variable: Variable; mode: Guid; collection: Collection; className?: string }) {
  const ed = useEditor();
  const a = useLocalAssets();
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [color, setColor] = useState<DOMRect | null>(null);
  const value = valueIn(variable, mode, collection);
  const resolved = value.kind === "literal" ? value.value : resolveVariable(value.id, a.lookup);
  // An extended collection: the values it overrides show in blue, with "Reset change" (Figma).
  const overridden = !!collection.parent && isOverridden(collection, variable.id, mode);
  const set = (v: Literal, info?: { final: boolean; source?: string }) => setVariableValue(ed, variable.id, mode, { kind: "literal", value: v }, info);
  const exclude = useMemo(() => new Set(a.variables.filter((v) => v.type === variable.type && (v.id === variable.id || aliasMakesCycle(variable.id, v.id, a.lookup))).map((v) => v.id)), [a, variable]);
  const label = `${variable.name} in ${collection.modes.find((m) => m.id === mode)?.name ?? "mode"}`;

  let body;
  if (value.kind === "alias") {
    const target = a.lookup.variable(value.id);
    body = (
      <button type="button" className={styles.alias} aria-label={`${label}: ${target?.name ?? "Missing variable"}`} {...tooltipProps(target?.name ?? "Missing variable")} onClick={(e) => setPicker(e.currentTarget)}>
        <VariableGlyph type={variable.type} value={resolved} />
        <span className={styles.aliasText}>{target?.name ?? "Missing variable"}</span>
      </button>
    );
  } else {
    switch (variable.type) {
      case "COLOR": {
        const c = value.value as Color;
        body = (
          <>
            <button type="button" className={styles.swatchButton} aria-label={`${label}: colour`} onClick={(e) => setColor(e.currentTarget.getBoundingClientRect())}>
              <Swatch color={colorToHex(c)} opacity={toPercent(c.a ?? 1)} size={14} />
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
        body = <TextInput label={label} variant="ghost" value={String(value.value)} placeholder="Empty" onCommit={(v) => set(v)} />;
        break;
      case "BOOLEAN":
        body = <Checkbox label={value.value === true ? "true" : "false"} checked={value.value === true} onChange={(on) => set(on)} aria-label={label} />;
        break;
    }
  }

  return (
    <div
      className={cx(styles.cell, styles.value, overridden && styles.overridden, className)}
      data-value-cell={`${variable.name}|${collection.modes.find((m) => m.id === mode)?.name ?? ""}`}
      data-overridden={overridden ? "" : undefined}
    >
      {body}
      {overridden && (
        <button type="button" className={styles.cellButton} aria-label="Reset change" {...tooltipProps("Reset change")} onClick={() => resetOverride(ed, collection.id, variable.id, mode)}>
          <Icon name="24.reset.instance.small" />
        </button>
      )}
      {value.kind === "alias" ? (
        <button
          type="button"
          className={styles.cellButton}
          aria-label="Detach variable"
          {...tooltipProps("Detach variable")}
          onClick={() => {
            if (resolved !== null) set(resolved);
          }}
        >
          <Icon name="24.detach.small" />
        </button>
      ) : (
        <button type="button" className={styles.cellButton} aria-label="Apply variable" aria-expanded={!!picker} {...tooltipProps("Apply variable")} onClick={(e) => setPicker(e.currentTarget)}>
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
