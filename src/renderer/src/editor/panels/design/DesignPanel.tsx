/**
 * The Design tab, by selection (UI3): nothing selected → Page (the page's
 * colour), Styles, Export; a selection → its type (Frame ▾ with presets,
 * Rectangle, Ellipse, Group, Vector path, Text…, Mixed), Position (with
 * Constraints), Layout / Auto layout (sizing menus, min / max), Appearance,
 * Typography (text), Fill, Stroke, Selection colors, Effects, Layout guide
 * (frames), Export.
 * Sections whose fields the engine doesn't keep yet show their "+" disabled.
 */
import { useState } from "react";
import { ColorInput, Icon, IconButton, MenuButton, PanelSection, showToast, useTheme } from "@/ds";
import { useCurrentPage } from "@/engine/hooks";
import type { Color } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useNodes } from "../../hooks";
import { colorToHex, hexToColor, sameColor, toPercent } from "../../model/color";
import { AppearanceSection, LayoutSection, PositionSection } from "./Sections";
import { PaintPicker, PaintsSection, type PickerTarget } from "./Paints";
import { SelectionColorsSection } from "./SelectionColors";
import { TypographySection } from "./Typography";
import { isFrameNode, isTextNode, typeLabel, useSelectedNodes, useSupports, type PanelNode } from "./shared";
import styles from "./Design.module.css";

/** Figma's frame presets (the Frame tool's list in the panel, the most used ones). */
const FRAME_PRESETS: { header: string; items: [string, number, number][] }[] = [
  { header: "Phone", items: [["iPhone 16", 393, 852], ["iPhone 16 Pro Max", 440, 956], ["Android Compact", 412, 917]] },
  { header: "Tablet", items: [["iPad mini 8.3", 744, 1133], ["iPad Pro 11\"", 834, 1194], ["Surface Pro 8", 1440, 960]] },
  { header: "Desktop", items: [["MacBook Air", 1280, 832], ["Desktop", 1440, 1024], ["Wireframe", 1440, 1024], ["TV", 1280, 720]] },
];

/** The engine draws Figma's default page colour (#F5F5F5) as #1E1E1E in the dark theme. */
const DEFAULT_PAGE = hexToColor("#f5f5f5");
const DEFAULT_PAGE_DARK = hexToColor("#1e1e1e");

export function DesignPanel() {
  const { nodes } = useSelectedNodes();
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const [pageNode] = useNodes([page]);
  const { resolved } = useTheme();
  const pageColor = pageNode?.backgroundColor ?? DEFAULT_PAGE;
  const shownPageColor: Color = resolved === "dark" && sameColor(pageColor, DEFAULT_PAGE) ? DEFAULT_PAGE_DARK : pageColor;
  // The picker belongs to what it was opened for: a new selection closes it.
  const [pickerKey, setPickerKey] = useState("");
  const key = nodes.map((n) => n.guid).join(",") || page;
  if (picker && pickerKey !== key) {
    setPicker(null);
    setPickerKey(key);
  }
  const open = (t: PickerTarget) => {
    setPickerKey(key);
    setPicker(t);
  };

  return (
    <>
      {nodes.length === 0 ? (
        <>
          <PanelSection title="Page">
            <div className={styles.paintRow}>
              <ColorInput
                className={styles.paintField}
                label="Page colour"
                color={colorToHex(shownPageColor)}
                opacity={toPercent(shownPageColor.a ?? 1)}
                onColor={(hex, info) => ed.edit("Page colour", info, () => void ed.engine.setProps([page], { backgroundColor: hexToColor(hex, pageColor.a ?? 1) }))}
                onOpacity={(o, info) => ed.edit("Page colour", info, () => void ed.engine.setProps([page], { backgroundColor: { ...shownPageColor, a: o / 100 } }))}
                onSwatchClick={(anchor) => open({ kind: "page", page, anchor })}
              />
              <IconButton
                icon={pageNode?.backgroundEnabled === false ? "24.hidden.small" : "24.eye.small"}
                label={pageNode?.backgroundEnabled === false ? "Show page colour in exports" : "Hide page colour in exports"}
                tone="secondary"
                onClick={() => ed.setProps([page], { backgroundEnabled: pageNode?.backgroundEnabled === false }, "Page colour")}
              />
            </div>
          </PanelSection>
          <PanelSection title="Styles" empty actions={<IconButton icon="24.plus.small" label="Create style" tone="secondary" onClick={() => showToast({ message: "Styles come with variables and libraries" })} />} />
          <ExportSection />
        </>
      ) : (
        <Selected nodes={nodes} onPick={open} />
      )}
      {picker && <PaintPicker target={picker} nodes={nodes} pageColor={pageNode?.backgroundColor ?? null} onClose={() => setPicker(null)} />}
    </>
  );
}

function Selected({ nodes, onPick }: { nodes: PanelNode[]; onPick: (t: PickerTarget) => void }) {
  const frames = nodes.every(isFrameNode);
  const text = nodes.every(isTextNode);
  return (
    <>
      <TypeHeader nodes={nodes} />
      <PositionSection nodes={nodes} />
      <LayoutSection nodes={nodes} />
      <AppearanceSection nodes={nodes} />
      {text && <TypographySection nodes={nodes} />}
      <PaintsSection title="Fill" field="fillPaints" nodes={nodes} onPick={onPick} />
      <PaintsSection title="Stroke" field="strokePaints" nodes={nodes} onPick={onPick} />
      <SelectionColorsSection nodes={nodes} onPick={onPick} />
      <LaterSection title="Effects" field="effects" add="Add effect" />
      {frames && <LaterSection title="Layout guide" field="layoutGrids" add="Add layout guide" />}
      <ExportSection />
    </>
  );
}

function TypeHeader({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const label = typeLabel(nodes);
  if (label !== "Frame") {
    return (
      <div className={styles.typeHeader}>
        <span className={styles.typeLabel}>{label}</span>
      </div>
    );
  }
  const entries = FRAME_PRESETS.flatMap((g, gi) => [...(gi ? ["-" as const] : []), { header: g.header }, ...g.items.map(([name, w, h]) => ({ id: `${w}x${h}:${name}`, label: name, hint: `${w}×${h}` }))]);
  return (
    <div className={styles.typeHeader}>
      <MenuButton
        label="Frame presets"
        entries={entries}
        className={styles.typeButton}
        onSelect={(id) => {
          const [w, h] = id.split(":")[0].split("x").map(Number);
          ed.setProps(
            nodes.map((n) => n.guid),
            { size: { x: w, y: h } },
            "Resize frame"
          );
        }}
      >
        <span>Frame</span>
        <Icon name="16.chevron.down" />
      </MenuButton>
    </div>
  );
}

/** A section whose field the engine doesn't keep yet: "+" disabled until it does. */
function LaterSection({ title, field, add }: { title: string; field: string; add: string }) {
  const kept = useSupports(field);
  return <PanelSection title={title} empty actions={<IconButton icon="24.plus.small" label={add} tone="secondary" disabled={!kept} onClick={() => showToast({ message: `${title} come with the renderer's next milestone` })} />} />;
}

function ExportSection() {
  return <LaterSection title="Export" field="exportSettings" add="Add export settings" />;
}
