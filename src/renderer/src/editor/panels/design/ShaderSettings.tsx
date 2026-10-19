/**
 * A shader fill's or effect's settings (round 11): "Shader" — its preset's name, a click opens the browser to pick
 * another — then its parameters in the preset's order (src/shared/shaders/presets.json): a number field (with its
 * unit), a colour (hex and opacity), a dropdown (a choice) or a checkbox (a toggle), in the effect settings' label /
 * field columns. Live has no capture of a shader's settings: the layout follows the other effect popovers
 * (popovers/effect-settings-*.txt), the rest is unverified.
 */
import { ColorInput, Icon, NumericInput, Select, Slider, Switch, cx, type ChangeInfo } from "@/ds";
import type { Color } from "@/engine/codec";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { presetOf, shaderValue, withShaderValue, type ShaderFields, type ShaderParam, type ShaderValue } from "../../model/shaders";
import { t, useT } from "@/i18n";
import styles from "./ShaderSettings.module.css";

const pick: ChangeInfo = { final: true, source: "pick" };

export function ShaderParams<T extends ShaderFields>({
  target,
  onChange,
  onCancel,
  onChoose,
}: {
  target: T;
  onChange: (next: T, info: ChangeInfo) => void;
  onCancel?: () => void;
  /** The preset's button: the browser, to pick another */
  onChoose?: (anchor: HTMLElement) => void;
}) {
  useT();
  const preset = presetOf(target);
  const set = (p: ShaderParam, v: ShaderValue, info: ChangeInfo) => onChange(withShaderValue(target, p, v), info);
  const row = (p: ShaderParam) => {
    const v = shaderValue(target, p);
    // A toggle: its label, then a switch (the owner's capture figma-shader-pixelate-panel: "Knockout").
    if (p.type === "toggle")
      return [
        <span key={`${p.id}-label`} className={styles.label}>
          {p.name}
        </span>,
        <div key={`${p.id}-field`} className={styles.field} data-shader-param={p.name}>
          <Switch label={p.name} checked={v === true} onChange={(on) => set(p, on, pick)} />
        </div>,
      ];
    let control;
    if (p.type === "color") {
      const c = v as Color;
      control = (
        <ColorInput
          label={p.name}
          swatchLabel={t("Solid color hex: {hex}", { hex: colorToHex(c).replace("#", "").toUpperCase() })}
          color={colorToHex(c)}
          opacity={toPercent(c.a ?? 1)}
          onColor={(hex, info, o) => set(p, hexToColor(hex, o !== undefined ? o / 100 : (c.a ?? 1)), info)}
          onOpacity={(o, info) => set(p, { ...c, a: o / 100 }, info)}
        />
      );
    } else if (p.type === "choice") {
      control = <Select label={p.name} value={String(v)} options={(p.options ?? []).map((o, i) => ({ value: String(i), label: o }))} onChange={(i) => set(p, Number(i), pick)} />;
    } else if (p.min !== undefined && p.max !== undefined) {
      // A ranged number: Figma's slider joined to its value (the capture's Size, Stretch, Gap… rows), as Glass's.
      const whole = p.step === 1;
      const write = (n: number, info: ChangeInfo) => set(p, whole ? Math.round(n) : n, info);
      control = (
        <div className={styles.slider}>
          <span className={styles.track}>
            <Slider label={p.name} min={p.min} max={p.max} step={p.step ?? (whole ? 1 : 0.01)} value={v as number} onChange={write} onCancel={onCancel} />
          </span>
          <NumericInput className={styles.value} label={p.name} value={v as number} min={p.min} max={p.max} precision={whole ? 0 : 2} unit={p.unit === "px" ? undefined : p.unit} onChange={write} onCancel={onCancel} />
        </div>
      );
    } else {
      const whole = p.step === 1;
      control = (
        <NumericInput
          scrubHandle="previous"
          label={p.name}
          value={v as number}
          min={p.min}
          max={p.max}
          precision={whole ? 0 : 2}
          unit={p.unit === "px" ? undefined : p.unit}
          onChange={(n, info) => set(p, whole ? Math.round(n) : n, info)}
          onCancel={onCancel}
        />
      );
    }
    return [
      <span key={`${p.id}-label`} className={styles.label}>
        {p.name}
      </span>,
      <div key={`${p.id}-field`} className={styles.field} data-shader-param={p.name}>
        {control}
      </div>,
    ];
  };
  return (
    <div className={styles.grid} data-shader-settings={preset?.key ?? ""}>
      <span className={styles.label}>{t("Shader")}</span>
      <button type="button" className={cx(styles.preset, !onChoose && styles.presetStatic)} aria-label={t("Shader: {name}", { name: preset?.name ?? t("Unknown") })} disabled={!onChoose} onClick={(e) => onChoose?.(e.currentTarget)}>
        <Icon name="24.effect.shader.small" />
        <span className={styles.presetName}>{preset?.name ?? t("Unknown shader")}</span>
        {onChoose && <Icon name="16.chevron.down" className={styles.chevron} />}
      </button>
      {(preset?.params ?? []).map(row)}
    </div>
  );
}
