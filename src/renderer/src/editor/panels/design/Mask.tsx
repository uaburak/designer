/**
 * The mask type (Figma's mask panel, atlas 07 §12): when every selected layer is a mask, "Mask" with Alpha, Vector
 * (the schema's OUTLINE: the mask's shape, its fills' alpha ignored) or Luminance (the mask's brightness); Mixed —
 * shown, not pickable — when they differ. Stored as `maskType` (schema MaskType); the renderer draws all three.
 * A hovered option is previewed on the canvas after 50 ms, as Figma's. Unverified: where UI3 shows the row, and the
 * options' extended descriptions (`mask_panel.*_extended`, English unattested).
 */
import { PanelSection, Select, isMixed } from "@/ds";
import type { MaskType, NodeFields } from "@/engine/codec";
import { useEditor } from "../../controller";
import { mixed } from "../../model/mixed";
import { previewProps, type PanelNode } from "./shared";
import { t, useT } from "@/i18n";
import styles from "./Design.module.css";

export const MASK_TYPES: { value: MaskType; label: string }[] = [
  { value: "ALPHA", label: "Alpha" },
  { value: "OUTLINE", label: "Vector" },
  { value: "LUMINANCE", label: "Luminance" },
];

/** Every selected layer is a mask: the row shows. */
export const allMasks = (nodes: readonly PanelNode[]) => nodes.length > 0 && nodes.every((n) => n.mask === true);

export function MaskSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  if (!allMasks(nodes)) return null;
  const value = mixed(nodes.map((n) => (n.maskType as MaskType | undefined) ?? "ALPHA"));
  const options = [...(isMixed(value) ? [{ value: "MIXED", label: t("Mixed"), disabled: true }] : []), ...MASK_TYPES.map((o) => ({ ...o, label: t(o.label) }))];
  return (
    <PanelSection title={t("Mask")}>
      <div className={styles.maskRow}>
        <Select
          label={t("Mask")}
          value={isMixed(value) || value === undefined ? "MIXED" : value}
          options={options}
          onChange={(v) => ed.setProps(nodes.map((n) => n.guid), { maskType: v as MaskType }, "Mask type")}
          onPreview={previewProps(ed, nodes.map((n) => n.guid), "Mask type", (v) => ({ maskType: v as MaskType }) as NodeFields)}
        />
      </div>
    </PanelSection>
  );
}
