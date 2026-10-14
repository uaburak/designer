// The app's panels, cut to what a collage shows: the file header and Layers (the left panel's own styles), and the
// Design panel's rows (ds PanelSection, PropertyGrid, NumericInput, ColorInput) with fake values. Watch-only: every
// handler is a no-op.
import type { ReactNode } from "react";
import { IconButton } from "@/ds/components/Button";
import { ColorInput } from "@/ds/components/ColorInput";
import { LayerRow } from "@/ds/components/LayerRow";
import { NumericInput, type NumericInputProps } from "@/ds/components/NumericInput";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Icon, type IconName } from "@/ds/icons/Icon";
import panels from "@/editor/panels/Panels.module.css";
import { useTween } from "../runtime/ticker";
import styles from "./ui.module.css";

export const noop = () => {};

/** A layer row's height (the ds's --ds-size-layer-row). */
const ROW = 32;

/** The left panel's head: the file's name and where it lives. */
export function FileHeader({ name, location = "Drafts" }: { name: string; location?: string }) {
  return (
    <div className={panels.fileHeader}>
      <div className={panels.fileTitle}>
        <span className={panels.fileButton}>
          <span>{name}</span>
          <Icon name="16.chevron.down" />
        </span>
        <span className={panels.fileLocation}>{location}</span>
      </div>
    </div>
  );
}

export interface Row {
  id: string;
  name: string;
  icon: IconName;
  depth?: number;
  expanded?: boolean;
  selected?: boolean;
  strong?: boolean;
  kind?: "default" | "component" | "instance";
  /** Not there yet (the script adds it). */
  hidden?: boolean;
}

/**
 * Layers: rows as the panel draws them, each placed by transform (the list keeps its full height, as the panel does).
 * A row the script adds fades in at its place while the rows under it slide down; a renamed row's new name rises in.
 */
export function Layers({ rows, title = "Layers" }: { rows: Row[]; title?: string }) {
  let shown = 0;
  return (
    <PanelSection title={title} pad="none" className={styles.layers}>
      <div className={styles.rows} style={{ height: rows.length * ROW }}>
        {rows.map((r) => {
          const y = shown * ROW;
          if (!r.hidden) shown++;
          return (
            <div key={r.id} className={styles.row} data-out={r.hidden || undefined} style={{ transform: `translate3d(0, ${y}px, 0)` }}>
              <div key={r.name} className={styles.name}>
                <LayerRow
                  id={r.id}
                  depth={r.depth ?? 0}
                  name={r.name}
                  icon={r.icon}
                  kind={r.kind}
                  tone={r.kind === "component" || r.kind === "instance" ? "component" : "default"}
                  expanded={r.expanded}
                  selected={r.selected}
                  run={r.selected ? "single" : undefined}
                  strong={r.strong}
                />
              </div>
            </div>
          );
        })}
      </div>
    </PanelSection>
  );
}

/** A panel field whose number counts to each new value (over `ms` on `ease`, in step with the canvas). */
export function Num({ label, prefix, value, unit, ms, ease, ...rest }: { label: string; prefix?: string; value: number; unit?: string; ms?: number; ease?: (t: number) => number } & Partial<Pick<NumericInputProps, "modeLabel" | "dimValue">>) {
  const v = useTween(value, ms, ease);
  return <NumericInput label={label} prefix={prefix} prefixTone={prefix === "X" || prefix === "Y" ? "primary" : undefined} value={v} unit={unit} onChange={noop} {...rest} />;
}

/** Position and size, as the Design panel shows them for a frame. */
export function FrameSections({ title = "Frame", x, y, w, h, fill = "#FFFFFF", radius, ms, ease, children }: { title?: string; x: number; y: number; w: number; h: number; fill?: string; radius?: number; ms?: number; ease?: (t: number) => number; children?: ReactNode }) {
  return (
    <>
      <PanelSection title={title} pad="none" />
      <PanelSection title="Position">
        <PropertyGrid>
          <PropertyRow>
            <Num label="X-position" prefix="X" value={x} />
            <Num label="Y-position" prefix="Y" value={y} />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <PanelSection title="Layout">
        <PropertyGrid>
          <PropertyRow>
            <Num label="Width" prefix="W" value={w} ms={ms} ease={ease} />
            <Num label="Height" prefix="H" value={h} ms={ms} ease={ease} />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      {radius !== undefined && (
        <PanelSection title="Appearance">
          <PropertyGrid>
            <PropertyRow>
              <Num label="Opacity" prefix="24.opacity" value={100} unit="%" />
              <Num label="Corner radius" prefix="24.corners" value={radius} />
            </PropertyRow>
          </PropertyGrid>
        </PanelSection>
      )}
      <FillSection hex={fill} />
      {children}
    </>
  );
}

export function FillSection({ hex, title = "Fill", label = "Fill" }: { hex: string; title?: string; label?: string }) {
  return (
    <PanelSection title={title} actions={<IconButton icon="24.plus.small" label="Add fill" tone="secondary" />}>
      <PropertyGrid>
        <PropertyRow span={2} action={<IconButton icon="24.eye.small" label="Hide fill" tone="secondary" />}>
          <ColorInput label={label} color={hex} opacity={100} onColor={noop} onOpacity={noop} />
        </PropertyRow>
      </PropertyGrid>
    </PanelSection>
  );
}

/** A panel column of the app's width (the ds sections inside lay out as in the editor). */
export function PanelColumn({ children, side = "right" }: { children: ReactNode; side?: "left" | "right" }) {
  return (
    <div className={styles.column} data-panel={side}>
      {children}
    </div>
  );
}
