import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { NumericInput } from "../components/NumericInput";
import styles from "./Gallery.module.css";

type Settings = { opacity: number; scale: number; x: number; y: number; difference: boolean };
const DEFAULTS: Settings = { opacity: 50, scale: 1 / 1.3228, x: 0, y: 0, difference: false };

function load(screen: string): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(`ds-gallery-ref-${screen}`) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

/**
 * A Figma screenshot over a screen (contract §5.3): open a PNG, drawn at
 * 1/1.3228 (the owner's screenshots) with 50% opacity or Difference; the
 * arrow keys nudge it 1px (⇧ 10). Kept per screen in localStorage.
 */
export function ReferenceOverlay({ screen, children }: { screen: string; children: ReactNode }) {
  const [src, setSrc] = useState<string | null>(null);
  const [s, setS] = useState<Settings>(() => load(screen));
  useEffect(() => {
    try {
      localStorage.setItem(`ds-gallery-ref-${screen}`, JSON.stringify(s));
    } catch {
      /* private mode */
    }
  }, [screen, s]);
  useEffect(() => {
    if (!src) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as Element).closest("input,textarea")) return;
      const by = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }[e.key];
      if (!d) return;
      e.preventDefault();
      setS((p) => ({ ...p, x: p.x + d[0], y: p.y + d[1] }));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [src]);
  return (
    <div>
      <div className={styles.refControls} style={{ marginBottom: 8 }}>
        <label>
          <Button variant="secondary" onClick={(e) => (e.currentTarget.nextElementSibling as HTMLInputElement | null)?.click()}>Reference…</Button>
          <input
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setSrc(URL.createObjectURL(f));
            }}
          />
        </label>
        {src && (
          <>
            <div style={{ width: 88 }}><NumericInput label="Opacity" prefix="24.opacity" value={s.opacity} min={0} max={100} unit="%" onChange={(v) => setS((p) => ({ ...p, opacity: v }))} /></div>
            <div style={{ width: 88 }}><NumericInput label="Scale" prefix="S" value={Math.round(s.scale * 10000) / 10000} precision={4} step={0.01} onChange={(v) => setS((p) => ({ ...p, scale: v }))} /></div>
            <Checkbox label="Difference" checked={s.difference} onChange={(c) => setS((p) => ({ ...p, difference: c }))} />
            <Button variant="ghost" onClick={() => setSrc(null)}>Remove</Button>
          </>
        )}
      </div>
      <div style={{ position: "relative" }}>
        {children}
        {src && <img alt="" src={src} className={styles.refLayer} style={{ opacity: s.opacity / 100, transform: `translate(${s.x}px, ${s.y}px) scale(${s.scale})`, mixBlendMode: s.difference ? "difference" : "normal" }} />}
      </div>
    </div>
  );
}
