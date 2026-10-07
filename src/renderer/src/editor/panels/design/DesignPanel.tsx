/**
 * The Design tab, by selection (UI3): nothing selected → Page (the page's
 * colour, Apply variable mode), Local variables (Open variables), the local
 * Styles list, Export; a selection → its type (Frame ▾ with presets,
 * Rectangle, Ellipse, Group, Vector path, Text…, Mixed), Position (with
 * Constraints), Layout / Auto layout (sizing menus, min / max), Appearance,
 * Typography (text), Fill, Stroke, Selection colors, Effects, Layout guide
 * (frames), Export.
 * Sections whose fields the engine doesn't keep yet show their "+" disabled.
 */
import { useState } from "react";
import { ColorInput, Icon, IconButton, keys, MenuButton, PanelSection, showToast, useTheme, type MenuEntry } from "@/ds";
import { useCurrentPage } from "@/engine/hooks";
import type { Color } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { command, isEnabled, runEditorCommand, shortcutOf } from "../../commands";
import { useNodes, useTopics } from "../../hooks";
import { useStoreSlice } from "../../uiStore";
import { colorToHex, hexToColor, sameColor, toPercent } from "../../model/color";
import { AppearanceSection, LayoutSection, PositionSection } from "./Sections";
import { PaintPicker, PaintsSection, type PickerTarget } from "./Paints";
import { SelectionColorsSection } from "./SelectionColors";
import { TypographySection } from "./Typography";
import { EffectsSection, LayoutGuideSection } from "./Effects";
import { VectorPointSection } from "./VectorPoints";
import { fields, isFrameNode, isTextNode, typeLabel, typeOf, useSelectedNodes, useSupports, type PanelNode } from "./shared";
import { ComponentHeader, CurrentVariantSection, InstanceHeader, InstanceProperties, PropertiesSection, componentSelection } from "./Component";
import { ApplyModeButton, ModeRows } from "./Variables";
import { LocalStylesSection, LocalVariablesSection } from "./Styles";
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
          <PanelSection title="Page" actions={<ApplyModeButton refs={[page]} />}>
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
            <ModeRows refs={[page]} />
          </PanelSection>
          <LocalVariablesSection />
          <LocalStylesSection />
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
  const ed = useEditor();
  const frames = nodes.every(isFrameNode);
  const text = nodes.every(isTextNode);
  const vectorRef = useStoreSlice(ed.vector.state, (s) => (s.active ? s.ref : null));
  const editingVector = !!vectorRef && nodes.length === 1 && nodes[0].guid === vectorRef;
  // One component, set, variant or instance: its header and properties come first (UI3).
  const comp = componentSelection(ed, nodes);
  return (
    <>
      {comp?.kind === "instance" ? (
        <InstanceHeader instance={comp.node} />
      ) : comp ? (
        <ComponentHeader sel={comp} />
      ) : (
        <TypeHeader nodes={nodes} />
      )}
      {comp?.kind === "instance" && <InstanceProperties instance={comp.node} />}
      {(comp?.kind === "component" || comp?.kind === "set") && <PropertiesSection owner={comp.node} />}
      {comp?.kind === "variant" && <CurrentVariantSection variant={comp.node} />}
      {editingVector && <VectorPointSection />}
      <PositionSection nodes={nodes} />
      <LayoutSection nodes={nodes} />
      <AppearanceSection nodes={nodes} />
      {text && <TypographySection nodes={nodes} />}
      <PaintsSection title="Fill" field="fillPaints" nodes={nodes} onPick={onPick} />
      <PaintsSection title="Stroke" field="strokePaints" nodes={nodes} onPick={onPick} />
      <SelectionColorsSection nodes={nodes} onPick={onPick} />
      <EffectsSection nodes={nodes} />
      {frames && <LayoutGuideSection nodes={nodes} />}
      <ExportSection />
    </>
  );
}

/** Figma's boolean group menu: the four operations, then Flatten. */
const BOOLEAN_ITEMS: { id: string; op: "UNION" | "SUBTRACT" | "INTERSECT" | "XOR"; icon: "16.boolean.union" | "16.boolean.subtract" | "16.boolean.intersect" | "16.boolean.exclude" }[] = [
  { id: "vector.union", op: "UNION", icon: "16.boolean.union" },
  { id: "vector.subtract", op: "SUBTRACT", icon: "16.boolean.subtract" },
  { id: "vector.intersect", op: "INTERSECT", icon: "16.boolean.intersect" },
  { id: "vector.exclude", op: "XOR", icon: "16.boolean.exclude" },
];

/** Layers vector edit mode opens (the engine turns shapes into a vector at their first edit). */
const EDITABLE = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "BOOLEAN_OPERATION"]);

/** The selection header's actions (UI3): Edit object, Create component, Use as mask, the boolean groups menu. */
function HeaderActions({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  // Command states change with the selection and the document.
  useTopics(ed.store, ["selection", "undo", "structure"]);
  const booleans = nodes.length > 0 && nodes.every((n) => typeOf(n) === "BOOLEAN_OPERATION");
  const current = booleans && nodes.every((n) => n.booleanOperation === nodes[0].booleanOperation) ? (nodes[0].booleanOperation ?? "UNION") : null;
  const opKept = booleans;
  const entries: MenuEntry[] = [
    ...BOOLEAN_ITEMS.map((b) => {
      const c = command(b.id);
      return { id: b.id, label: c.label, icon: b.icon, shortcut: shortcutOf(c), checked: current === b.op, disabled: !(opKept || isEnabled(ed, c)) };
    }),
    "-",
    { id: "vector.flatten", label: command("vector.flatten").label, shortcut: shortcutOf(command("vector.flatten")), disabled: !isEnabled(ed, command("vector.flatten")) },
  ];
  const anyBoolean = entries.some((e) => typeof e === "object" && "id" in e && !e.disabled);
  const mask = command("object.use-as-mask");
  const editable = nodes.length === 1 && EDITABLE.has(typeOf(nodes[0])) && ed.vector.available;
  return (
    <div className={styles.headerActions}>
      {editable && <IconButton icon="24.pen" label="Edit object" shortcut={keys(["enter"])} tone="secondary" onClick={() => ed.vector.start(nodes[0].guid)} />}
      <IconButton
        icon="24.component.small"
        label={command("object.create-component").label}
        shortcut={shortcutOf(command("object.create-component"))}
        tone="secondary"
        disabled={!isEnabled(ed, command("object.create-component"))}
        onClick={() => runEditorCommand(ed, "object.create-component")}
      />
      {/* Pressed when every selected layer is a mask: read from the panel's nodes (the command's own check re-reads the selection from the engine on every render). */}
      <IconButton icon="24.mask" label={mask.label} shortcut={shortcutOf(mask)} tone="secondary" disabled={!isEnabled(ed, mask)} aria-pressed={nodes.some((n) => (n as { mask?: boolean }).mask === true)} onClick={() => runEditorCommand(ed, mask.id)} />
      {anyBoolean ? (
        <MenuButton label="Boolean groups" entries={entries} className={styles.iconMenu} onSelect={(id) => pickBoolean(ed, nodes, id, booleans)}>
          <Icon name="24.boolean.small" />
          <Icon name="16.chevron.down" />
        </MenuButton>
      ) : (
        <IconButton icon="24.boolean.small" label="Boolean groups" tone="secondary" disabled />
      )}
    </div>
  );
}

/** A boolean group selected: the menu changes its operation; otherwise it runs the command on the selection. */
function pickBoolean(ed: EditorController, nodes: PanelNode[], id: string, booleans: boolean) {
  const op = BOOLEAN_ITEMS.find((b) => b.id === id)?.op;
  if (booleans && op) {
    ed.setProps(
      nodes.map((n) => n.guid),
      fields({ booleanOperation: op }),
      command(id).label.replace(" selection", "")
    );
    return;
  }
  runEditorCommand(ed, id);
}

function TypeHeader({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const label = typeLabel(nodes);
  if (label !== "Frame") {
    return (
      <div className={styles.typeHeader}>
        <span className={styles.typeLabel}>{label}</span>
        <HeaderActions nodes={nodes} />
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
      <HeaderActions nodes={nodes} />
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
