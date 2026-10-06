import { useContext, useLayoutEffect, useRef, useState } from "react";
import { appColor, canvasChrome, CHROME_COLORS, elevation, figmaColor, motion, radius, size, space, text, z, type TextStyle } from "../tokens";
import { Switch } from "../components/Switch";
import { PanelSection } from "../components/PanelSection";
import { Comp, GalleryContext, Section } from "./parts";
import styles from "./Gallery.module.css";

/** A colour token, its value read back from the CSS (getComputedStyle) — so what is checked is the stylesheet. */
function TokenSwatch({ name, cssVar }: { name: string; cssVar: string }) {
  const chip = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState("");
  useLayoutEffect(() => {
    if (chip.current) setValue(getComputedStyle(chip.current).backgroundColor);
  }, []);
  return (
    <div className={styles.swatchRow} title={`var(${cssVar}) = ${value}`}>
      <span className={styles.chipBox}><span ref={chip} className={styles.chip} style={{ background: `var(${cssVar})` }} /></span>
      <span className={styles.tokenName}>{name}</span>
      <span className={styles.tokenValue}>{toHex(value)}</span>
    </div>
  );
}

/** "rgb(1, 2, 3)" / "rgba(…)" → "#010203" / "#01020380". */
function toHex(css: string): string {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(css);
  if (!m) return css;
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  const a = m[4] === undefined ? "" : h(Number(m[4]) * 255);
  return `#${h(+m[1])}${h(+m[2])}${h(+m[3])}${a === "ff" ? "" : a}`;
}

const GROUPS = ["bg", "text", "icon", "border"] as const;

export function TokensSection() {
  const { theme } = useContext(GalleryContext);
  const [on, setOn] = useState(true);
  const [open, setOpen] = useState(true);
  const names = Object.keys(figmaColor);
  return (
    <Section id="tokens" title="Tokens">
      {GROUPS.map((g) => (
        <Comp key={g} name={`figma-color-${g}*`}>
          <div className={styles.swatches}>
            {names.filter((n) => n === g || n.startsWith(`${g}-`)).map((n) => <TokenSwatch key={n} name={n} cssVar={`--figma-color-${n}`} />)}
          </div>
        </Comp>
      ))}
      <Comp name="ds-color-* (app colours)">
        <div className={styles.swatches}>
          {Object.keys(appColor).map((n) => <TokenSwatch key={n} name={n} cssVar={`--ds-color-${n}`} />)}
        </div>
      </Comp>
      <Comp name="Canvas chrome palette (engine, ABI order)">
        <div className={styles.swatches}>
          {CHROME_COLORS.map((n, i) => {
            const v = canvasChrome[n][theme === "light" ? 0 : 1];
            return (
              <div key={n} className={styles.swatchRow}>
                <span className={styles.chipBox}><span className={styles.chip} style={{ background: v }} /></span>
                <span className={styles.tokenName}>{i} {n}</span>
                <span className={styles.tokenValue}>{v}</span>
              </div>
            );
          })}
        </div>
      </Comp>
      <Comp name="Type">
        <div className={styles.specimen}>
          {(Object.entries(text) as [string, TextStyle][]).map(([k, t]) => (
            <div key={k} style={{ display: "contents" }}>
              <span className={styles.tokenValue}>{k} · {t.size}/{t.line} · {t.weight}</span>
              <span style={{ font: `var(--ds-font-${k})`, letterSpacing: `var(--ds-tracking-${k})` }}>Frame 1 — The quick brown fox jumps over the lazy dog 0123456789</span>
            </div>
          ))}
        </div>
      </Comp>
      <Comp name="Spacing">
        <div className={styles.bars}>
          {Object.entries(space).map(([k, v]) => (
            <div key={k} className={styles.swatchRow}>
              <span className={styles.tokenValue} style={{ width: 120 }}>--ds-space-{k} · {v}</span>
              <span className={styles.bar} style={{ width: v }} />
            </div>
          ))}
        </div>
      </Comp>
      <Comp name="Radii">
        <div className={styles.row}>
          {Object.entries(radius).map(([k, v]) => (
            <div key={k} className={styles.cell}>
              <span className={styles.radiusBox} style={{ borderRadius: `var(--ds-radius-${k})` }} />
              <span className={styles.cellLabel}>{k} · {v}</span>
            </div>
          ))}
        </div>
      </Comp>
      <Comp name="Elevation">
        <div className={styles.row} style={{ gap: 24, padding: 12, background: "var(--ds-color-canvas-default)", borderRadius: 5 }}>
          {Object.keys(elevation).map((k) => (
            <div key={k} className={styles.elevationCard} style={{ boxShadow: `var(--ds-elevation-${k})` }}>{k}</div>
          ))}
        </div>
      </Comp>
      <Comp name="Sizes">
        <table className={styles.table}>
          <tbody>
            {Object.entries(size).map(([k, v]) => (
              <tr key={k}><td>--ds-size-{k}</td><td>{v}px</td></tr>
            ))}
          </tbody>
        </table>
      </Comp>
      <Comp name="Z-index and motion">
        <div className={styles.row} style={{ gap: 48 }}>
          <table className={styles.table}>
            <thead><tr><th>layer</th><th>z</th></tr></thead>
            <tbody>{Object.entries(z).map(([k, v]) => <tr key={k}><td>--ds-z-{k}</td><td>{v}</td></tr>)}</tbody>
          </table>
          <table className={styles.table}>
            <thead><tr><th>motion</th><th>value</th></tr></thead>
            <tbody>{Object.entries(motion).map(([k, v]) => <tr key={k}><td>--ds-{k}</td><td>{v}</td></tr>)}</tbody>
          </table>
          <div className={styles.cell}>
            <Switch label="Motion demo" checked={on} onChange={setOn} showLabel />
            <div className={styles.panelPlain} style={{ border: "1px solid var(--figma-color-border)", borderRadius: 5 }}>
              <PanelSection title="Chevron (fast)" collapsible open={open} onOpenChange={setOpen}>
                <div style={{ padding: "0 16px", color: "var(--figma-color-text-secondary)" }}>Content</div>
              </PanelSection>
            </div>
          </div>
        </div>
      </Comp>
    </Section>
  );
}
