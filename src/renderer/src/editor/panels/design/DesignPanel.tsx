/**
 * The Design tab, by selection (UI3, Figma's live panel): nothing selected →
 * Page (the page's colour, Apply variable mode when the file has modes), the
 * local Styles list, Export — variables live in the left rail since 2026 —;
 * a selection → its header (Header.tsx: "Frame ▾" with presets, the type or
 * "N selected", the kind's actions), Position (with Constraints), Layout /
 * Auto layout (Flow, sizing menus, min / max), Appearance, Typography (text),
 * Fill, Stroke, Selection colors, Effects, Layout guide (frames), Export.
 */
import { useEffect, useState } from "react";
import { ColorInput, PanelSection, ToggleIconButton, useTheme } from "@/ds";
import { useCurrentPage } from "@/engine/hooks";
import type { Color } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useNodes, useUI } from "../../hooks";
import { useStoreSlice } from "../../uiStore";
import { colorToHex, hexToColor, sameColor, toPercent } from "../../model/color";
import { AppearanceSection, PositionSection } from "./Sections";
import { LayoutSection } from "./Layout";
import { PaintPicker, PaintsSection, type PickerTarget } from "./Paints";
import { SelectionColorsSection } from "./SelectionColors";
import { TypographySection } from "./Typography";
import { EffectsSection, LayoutGuideSection } from "./Effects";
import { ExportSection, type ExportTarget } from "./Export";
import { VectorEditPanel } from "./VectorPoints";
import { isFrameNode, isTextNode, usePaintTargets, useSelectedNodes, type PanelNode } from "./shared";
import { TypeHeader } from "./Header";
import { ComponentBlock, InstanceHeader, componentSelection } from "./Component";
import { useMultiEditVariants } from "./multiEdit";
import { ApplyModeButton, ModeRows } from "./Variables";
import { GridPanel } from "./Grid";
import { LocalStylesSection } from "./Styles";
import styles from "./Design.module.css";

/** The engine draws Figma's default page colour (#F5F5F5) as #1E1E1E in the dark theme. */
const DEFAULT_PAGE = hexToColor("#f5f5f5");
const DEFAULT_PAGE_DARK = hexToColor("#1e1e1e");

export function DesignPanel() {
  const { nodes } = useSelectedNodes();
  const paintNodes = usePaintTargets(nodes);
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
  // Live (grid/row-track-selected-panel.txt): tracks selected on the canvas replace the Design panel with "Grid".
  const tracks = useUI((s) => s.gridTracks);
  // Multi-edit variants: one layer picked in a variant takes the same layer in the set's other variants.
  useMultiEditVariants();
  const gridSettings = useUI((s) => s.gridSettings);
  const settingsShown = !!gridSettings && nodes.length === 1 && nodes[0].guid === gridSettings;
  // Another selection closes it (it does not come back when the grid is selected again).
  useEffect(() => {
    if (gridSettings && !settingsShown) ed.ui.set({ gridSettings: null });
  }, [gridSettings, settingsShown, ed]);
  if (tracks && tracks.tracks.length && nodes.length === 1 && nodes[0].guid === tracks.frame) return <GridPanel frame={tracks.frame} />;
  // The grid picker's "Open grid settings" (unverified beyond its label: the same Grid panel, no track selected).
  if (settingsShown) return <GridPanel frame={gridSettings} />;

  return (
    <>
      {nodes.length === 0 ? (
        <>
          <PanelSection title="Page" actions={<ApplyModeButton refs={[page]} />}>
            <div className={`${styles.paintRow} ${styles.pageRow}`}>
              <ColorInput
                className={styles.paintField}
                label="Color"
                swatchLabel={`Solid color hex: ${colorToHex(shownPageColor).slice(1).toUpperCase()}`}
                color={colorToHex(shownPageColor)}
                opacity={toPercent(shownPageColor.a ?? 1)}
                onColor={(hex, info) => ed.edit("Page colour", info, () => void ed.engine.setProps([page], { backgroundColor: hexToColor(hex, pageColor.a ?? 1) }))}
                onOpacity={(o, info) => ed.edit("Page colour", info, () => void ed.engine.setProps([page], { backgroundColor: { ...shownPageColor, a: o / 100 } }))}
                onSwatchClick={(anchor) => open({ kind: "page", page, anchor })}
              />
              <ToggleIconButton
                icon={pageNode?.backgroundEnabled === false ? "24.hidden.small" : "24.eye.small"}
                label="Toggle visibility"
                tone="secondary"
                pressed={false}
                onPressedChange={() => ed.setProps([page], { backgroundEnabled: pageNode?.backgroundEnabled === false }, "Page colour")}
              />
            </div>
            <ModeRows refs={[page]} />
          </PanelSection>
          <LocalStylesSection />
          {pageNode && <ExportSection targets={[pageNode as ExportTarget]} page />}
        </>
      ) : (
        <Selected nodes={nodes} paintNodes={paintNodes} onPick={open} />
      )}
      {picker && <PaintPicker target={picker} nodes={paintNodes} pageColor={pageNode?.backgroundColor ?? null} onClose={() => setPicker(null)} />}
    </>
  );
}

function Selected({ nodes, paintNodes, onPick }: { nodes: PanelNode[]; paintNodes: PanelNode[]; onPick: (t: PickerTarget) => void }) {
  const ed = useEditor();
  const frames = nodes.every(isFrameNode);
  const sections = nodes.some((n) => n.type === "SECTION");
  // Typography shows when any selected layer is a text (Figma's live panel: "4 selected" with a text in it).
  const texts = nodes.filter(isTextNode);
  const vectorRef = useStoreSlice(ed.vector.state, (s) => (s.active ? s.ref : null));
  const editingVector = !!vectorRef && nodes.length === 1 && nodes[0].guid === vectorRef;
  // One component, set, variant or instance: its header and properties come first (UI3).
  const comp = componentSelection(ed, nodes);
  // Vector edit mode (live design/vector-edit-mode.txt): "Vector", its points' block, then Fill and Stroke only.
  if (editingVector)
    return (
      <>
        <VectorEditPanel />
        <PaintsSection title="Fill" field="fillPaints" nodes={paintNodes} onPick={onPick} />
        <PaintsSection title="Stroke" field="strokePaints" nodes={paintNodes} onPick={onPick} />
      </>
    );
  return (
    <>
      {/* An instance: its name, Go to main component and its properties; a component, set or variant: its name and Properties (Current variant) */}
      {comp?.kind === "instance" ? <InstanceHeader instance={comp.node} /> : comp ? <ComponentBlock sel={comp} /> : <TypeHeader nodes={nodes} />}
      <PositionSection nodes={nodes} />
      <LayoutSection nodes={nodes} />
      <AppearanceSection nodes={nodes} />
      {texts.length > 0 && <TypographySection nodes={texts} />}
      <PaintsSection title="Fill" field="fillPaints" nodes={paintNodes} onPick={onPick} />
      <PaintsSection title="Stroke" field="strokePaints" nodes={paintNodes} onPick={onPick} />
      {/* A section has neither effects nor layout guides (Figma's live panel: Fill, Stroke, Export) */}
      {!sections && <EffectsSection nodes={nodes} />}
      <SelectionColorsSection nodes={nodes} onPick={onPick} />
      {frames && !sections && <LayoutGuideSection nodes={nodes} />}
      <ExportSection targets={nodes as ExportTarget[]} page={false} />
    </>
  );
}

