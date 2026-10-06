import { useState } from "react";
import { MIXED } from "../types";
import { keys } from "../util/keys";
import { Button, IconButton, ToggleIconButton, type ButtonVariant } from "../components/Button";
import { TextArea, TextInput } from "../components/TextInput";
import { NumericInput } from "../components/NumericInput";
import { ColorInput } from "../components/ColorInput";
import { Swatch } from "../components/Swatch";
import { SearchField } from "../components/SearchField";
import { ContextMenu, MenuButton, type MenuEntry } from "../components/Menu";
import { Select, type SelectOption } from "../components/Select";
import { Checkbox } from "../components/Checkbox";
import { Switch } from "../components/Switch";
import { RadioGroup } from "../components/Radio";
import { SegmentedControl } from "../components/SegmentedControl";
import { Tabs } from "../components/Tabs";
import { PanelSection } from "../components/PanelSection";
import { PropertyGrid, PropertyRow } from "../components/PropertyGrid";
import { LayerRow, PageRow } from "../components/LayerRow";
import { ResizeHandle } from "../components/ResizeHandle";
import { Dialog } from "../components/Dialog";
import { Popover } from "../components/Popover";
import { showToast, Toast } from "../components/Toast";
import { TabBar } from "../components/TabBar";
import { HelpButton, Toolbar, ToolbarDivider, ToolbarGroup, ToolButton } from "../components/Toolbar";
import { Rail, RailItem, RailSeparator } from "../components/Rail";
import { SidebarHeader, SidebarItem } from "../components/SidebarItem";
import { FileCard, FileRow } from "../components/FileCard";
import { Avatar, Badge, CodeBlock, Divider, EmptyState, Kbd } from "../components/Misc";
import { Spinner } from "../components/Spinner";
import { ScrollArea } from "../components/ScrollArea";
import { VirtualList } from "../components/VirtualList";
import { TooltipBubble } from "../overlay/TooltipManager";
import { formatEdited } from "../util/time";
import { FileKindIcon } from "../components/FileCard";
import { FolderIcon, SidebarDivider } from "../components/SidebarItem";
import { PickerDemos } from "./PickerDemos";
import { Cell, Comp, noop, Row, Section } from "./parts";
import styles from "./Gallery.module.css";

const STATES = ["default", "hover", "pressed", "focus-visible", "disabled"] as const;
const forced = (state: string) => ({
  "data-hover": state === "hover" || undefined,
  "data-pressed": state === "pressed" || undefined,
  "data-focus-visible": state === "focus-visible" || undefined,
  disabled: state === "disabled" || undefined,
});

export const MENU_ENTRIES: MenuEntry[] = [
  { header: "Selection" },
  { id: "copy", label: "Copy", shortcut: keys(["mod", "c"]) },
  { id: "paste", label: "Paste here", shortcut: keys(["mod", "v"]), disabled: true },
  { id: "dup", label: "Duplicate", shortcut: keys(["mod", "d"]) },
  "-",
  { id: "select", label: "Select layer", items: [{ id: "a", label: "Frame 1", hint: "Frame" }, { id: "b", label: "Card", hint: "Component" }] },
  { id: "grid", label: "Show layout guides", checked: true, shortcut: keys(["ctrl", "g"]) },
  { id: "rulers", label: "Rulers", checked: false, shortcut: keys(["shift", "r"]) },
  "-",
  { id: "frame", label: "Frame selection", shortcut: keys(["alt", "mod", "g"]) },
  { id: "delete", label: "Delete", shortcut: "⌫", danger: true },
];

const SELECT_OPTIONS: (SelectOption | "-")[] = [
  { value: "fixed", label: "Fixed width", icon: "24.al.width-hug" },
  { value: "hug", label: "Hug contents", icon: "24.al.width-hug" },
  { value: "fill", label: "Fill container", icon: "24.al.width-fill" },
  "-",
  { value: "min", label: "Add min width…", disabled: true },
];

const FONT_OPTIONS: (SelectOption | "-")[] = [
  { value: "regular", label: "Regular" },
  { value: "medium", label: "Medium" },
  { value: "semibold", label: "Semi Bold" },
  { value: "bold", label: "Bold" },
];

export function ComponentMatrix() {
  const [toggle, setToggle] = useState(true);
  const [text, setText] = useState("Frame 1");
  const [w, setW] = useState<number>(1440);
  const [opacity, setOpacity] = useState(100);
  const [color, setColor] = useState("#0c8ce9");
  const [sel, setSel] = useState("hug");
  const [check, setCheck] = useState(true);
  const [sw, setSw] = useState(false);
  const [radio, setRadio] = useState("auto");
  const [seg, setSeg] = useState("left");
  const [tab, setTab] = useState("design");
  const [open, setOpen] = useState(true);
  const [panelW, setPanelW] = useState(240);
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState("move");
  const [mode, setMode] = useState("design");
  const [nav, setNav] = useState("recents");
  const [starredOpen, setStarredOpen] = useState(true);
  const now = Date.UTC(2026, 9, 6, 15, 5);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  return (
    <Section id="components" title="Components">
      <Comp name="Button" note="Variants × sizes × states. Focus is a 1px outline 1px out.">
        {(["primary", "secondary", "destructive", "destructive-secondary", "ghost", "link", "tinted"] as ButtonVariant[]).map((v) => (
          <Row key={v} label={v}>
            {STATES.map((s) => (
              <Cell key={s} id={`Button/${v}/default/${s}`}>
                <Button variant={v} {...forced(s)}>{v === "tinted" ? "Design" : "Share"}</Button>
              </Cell>
            ))}
            <Cell id={`Button/${v}/large/default`}><Button variant={v} size="large">Large</Button></Cell>
            <Cell id={`Button/${v}/default/icon`}><Button variant={v} icon="24.plus.small">New</Button></Cell>
            <Cell id={`Button/${v}/default/loading`}><Button variant={v} loading>Saving</Button></Cell>
          </Row>
        ))}
      </Comp>

      <Comp name="IconButton">
        {(["default", "secondary"] as const).map((tone) => (
          <Row key={tone} label={`tone ${tone}`}>
            {STATES.map((s) => (
              <Cell key={s} id={`IconButton/${tone}/default/${s}`}><IconButton icon="24.plus.small" label="Add fill" tone={tone} {...forced(s)} /></Cell>
            ))}
            <Cell id={`IconButton/${tone}/large/default`}><IconButton icon="24.sidebar.closed" label="Toggle UI" size="large" tone={tone} /></Cell>
          </Row>
        ))}
      </Comp>

      <Comp name="ToggleIconButton">
        <Row>
          <Cell id="ToggleIconButton/off/default/default"><ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" pressed={false} onPressedChange={noop} /></Cell>
          <Cell id="ToggleIconButton/off/default/hover"><ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" pressed={false} onPressedChange={noop} data-hover /></Cell>
          <Cell id="ToggleIconButton/on/default/default"><ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" pressed onPressedChange={noop} /></Cell>
          <Cell id="ToggleIconButton/mixed/default/default"><ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" pressed={MIXED} onPressedChange={noop} /></Cell>
          <Cell id="ToggleIconButton/on/default/disabled"><ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" pressed disabled onPressedChange={noop} /></Cell>
          <Cell id="ToggleIconButton/live/default/default" label="live"><ToggleIconButton icon="24.overflow.clip.small" label="Clip content" pressed={toggle} onPressedChange={setToggle} /></Cell>
        </Row>
      </Comp>

      <Comp name="TextInput" note="Click selects all; Enter commits, Esc reverts.">
        {(["filled", "outlined", "ghost"] as const).map((v) => (
          <Row key={v} label={v}>
            <Cell id={`TextInput/${v}/default/default`} width={184}><TextInput label="Name" value="Frame 1" variant={v} onCommit={noop} /></Cell>
            <Cell id={`TextInput/${v}/default/hover`} width={184}><TextInput label="Name" value="Frame 1" variant={v} onCommit={noop} data-hover /></Cell>
            <Cell id={`TextInput/${v}/default/focus-visible`} width={184}><TextInput label="Name" value="Frame 1" variant={v} onCommit={noop} data-focus-visible /></Cell>
            <Cell id={`TextInput/${v}/default/disabled`} width={184}><TextInput label="Name" value="Frame 1" variant={v} onCommit={noop} disabled /></Cell>
          </Row>
        ))}
        <Row label="more">
          <Cell id="TextInput/filled/default/mixed" width={184}><TextInput label="Name" value={MIXED} onCommit={noop} /></Cell>
          <Cell id="TextInput/filled/default/invalid" width={184}><TextInput label="Name" value="12px?" invalid onCommit={noop} /></Cell>
          <Cell id="TextInput/filled/default/placeholder" width={184}><TextInput label="Name" value="" placeholder="Add a description" onCommit={noop} /></Cell>
          <Cell id="TextInput/filled/default/prefix" width={184}><TextInput label="Link" value="burakkoc.net" prefix="24.public.small" onCommit={noop} /></Cell>
          <Cell id="TextInput/filled/large/default" width={240}><TextInput label="Name" value={text} size="large" onCommit={setText} /></Cell>
          <Cell id="TextArea/filled/default/default" width={240}><TextArea label="Description" value={"A multi-line\nfield"} onCommit={noop} /></Cell>
        </Row>
      </Comp>

      <Comp name="NumericInput" note="Drag a prefix to scrub (1/px, ⇧ ×10, ⌥ ×0.1), ↑↓ step, type 100+20.">
        <Row>
          <Cell id="NumericInput/filled/default/default" width={88}><NumericInput label="Width" prefix="W" value={w} onChange={(v) => setW(v)} /></Cell>
          <Cell id="NumericInput/filled/default/hover" width={88}><NumericInput label="Width" prefix="W" value={1440} onChange={noop} data-hover /></Cell>
          <Cell id="NumericInput/filled/default/focus-visible" width={88}><NumericInput label="Width" prefix="W" value={1440} onChange={noop} data-focus-visible /></Cell>
          <Cell id="NumericInput/filled/default/mixed" width={88}><NumericInput label="Height" prefix="H" value={MIXED} onChange={noop} /></Cell>
          <Cell id="NumericInput/filled/default/disabled" width={88}><NumericInput label="X" prefix="X" value={0} onChange={noop} disabled /></Cell>
          <Cell id="NumericInput/filled/default/empty" width={88}><NumericInput label="Min W" prefix="24.al.width-min" value={null} placeholder="Min W" onChange={noop} /></Cell>
          <Cell id="NumericInput/filled/default/unit" width={88}><NumericInput label="Rotation" prefix="24.rotation" value={45} unit="°" onChange={noop} /></Cell>
          <Cell id="NumericInput/ghost/default/default" width={88}><NumericInput label="Gap" prefix="24.al.spacing-horizontal" value={8} variant="ghost" onChange={noop} /></Cell>
        </Row>
      </Comp>

      <Comp name="ColorInput / Swatch">
        <Row>
          <Cell id="ColorInput/filled/default/default" width={184}><ColorInput label="Fill" color={color} opacity={opacity} onColor={(c) => setColor(c)} onOpacity={(o) => setOpacity(o)} /></Cell>
          <Cell id="ColorInput/filled/default/translucent" width={184}><ColorInput label="Fill" color="#f24822" opacity={50} onColor={noop} onOpacity={noop} /></Cell>
          <Cell id="ColorInput/filled/default/hover" width={184}><ColorInput label="Fill" color="#ffffff" opacity={100} onColor={noop} onOpacity={noop} data-hover /></Cell>
          <Cell id="ColorInput/filled/default/mixed" width={184}><ColorInput label="Fill" color={MIXED} opacity={MIXED} onColor={noop} onOpacity={noop} /></Cell>
          <Cell id="ColorInput/filled/default/disabled" width={184}><ColorInput label="Fill" color="#9747ff" opacity={100} onColor={noop} onOpacity={noop} disabled /></Cell>
        </Row>
        <Row>
          <Cell id="Swatch/square/14/default"><Swatch color="#0c8ce9" /></Cell>
          <Cell id="Swatch/square/14/alpha"><Swatch color="#0c8ce9" opacity={40} /></Cell>
          <Cell id="Swatch/square/14/white"><Swatch color="#ffffff" /></Cell>
          <Cell id="Swatch/round/16/default"><Swatch color="#14ae5c" shape="round" /></Cell>
          <Cell id="Swatch/round/16/alpha"><Swatch color="#14ae5c" shape="round" opacity={30} /></Cell>
          <Cell id="Swatch/square/14/mixed"><Swatch color="#000000" mixed /></Cell>
        </Row>
      </Comp>

      <PickerDemos />

      <Comp name="Select" note="Open, the checked item lies over the trigger.">
        {(["filled", "outlined", "ghost"] as const).map((v) => (
          <Row key={v} label={v}>
            <Cell id={`Select/${v}/default/default`} width={184}><Select label="Font weight" value="regular" options={FONT_OPTIONS} variant={v} onChange={noop} /></Cell>
            <Cell id={`Select/${v}/default/hover`} width={184}><Select label="Font weight" value="regular" options={FONT_OPTIONS} variant={v} onChange={noop} data-hover /></Cell>
            <Cell id={`Select/${v}/default/mixed`} width={184}><Select label="Font weight" value={MIXED} options={FONT_OPTIONS} variant={v} onChange={noop} /></Cell>
            <Cell id={`Select/${v}/default/disabled`} width={184}><Select label="Font weight" value="bold" options={FONT_OPTIONS} variant={v} onChange={noop} disabled /></Cell>
          </Row>
        ))}
        <Row label="live, hug, open">
          <Cell id="Select/filled/default/live" width={184}><Select label="Width sizing" value={sel} options={SELECT_OPTIONS} onChange={setSel} prefix="24.al.width-hug" /></Cell>
          <Cell id="Select/ghost/default/hug"><Select label="Sort" value="viewed" variant="ghost" width="hug" options={[{ value: "viewed", label: "Last viewed" }, { value: "name", label: "Alphabetical" }]} onChange={noop} /></Cell>
          <Cell id="Select/filled/default/open" width={184}>
            <div style={{ position: "relative", height: 150 }}>
              <Select label="Font weight" value="medium" options={FONT_OPTIONS} onChange={noop} static />
            </div>
          </Cell>
        </Row>
      </Comp>

      <Comp name="Menu / ContextMenu" note="Dark in both themes. Right-click the stage for a live one.">
        <Row>
          <Cell id="Menu/context/default/highlighted"><ContextMenu static at={{ x: 0, y: 0 }} entries={MENU_ENTRIES} highlighted={3} onSelect={noop} onClose={noop} /></Cell>
          <Cell id="Menu/submenu/default/open"><ContextMenu static at={{ x: 0, y: 0 }} entries={[{ id: "a", label: "Frame 1", hint: "Frame" }, { id: "b", label: "Card", hint: "Component", icon: "16.component" }, { id: "c", label: "Label", hint: "Text", icon: "16.text" }]} highlighted={1} onSelect={noop} onClose={noop} /></Cell>
          <Cell id="Menu/context/default/live" label="live">
            <div
              className={styles.stage}
              style={{ width: 200, height: 120 }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuAt({ x: e.clientX, y: e.clientY });
              }}
            >
              Right-click here
              <div style={{ marginTop: 12 }}>
                <MenuButton label="More" entries={MENU_ENTRIES} onSelect={(id) => showToast({ message: `Picked ${id}` })}>More…</MenuButton>
              </div>
            </div>
            {menuAt && <ContextMenu at={menuAt} entries={MENU_ENTRIES} onSelect={(id) => showToast({ message: `Picked ${id}` })} onClose={() => setMenuAt(null)} />}
          </Cell>
        </Row>
      </Comp>

      <Comp name="Tooltip" note="Hover any icon button: 500ms, then warm for 300ms.">
        <Row>
          <Cell id="Tooltip/default/default/default"><TooltipBubble label="Add fill" /></Cell>
          <Cell id="Tooltip/shortcut/default/default"><TooltipBubble label="Move" shortcut="V" /></Cell>
          <Cell id="Tooltip/long/default/default" width={260}><TooltipBubble label="Show this layer's properties in the panel when it is selected on the canvas" /></Cell>
        </Row>
      </Comp>

      <Comp name="Checkbox / Switch / RadioGroup">
        <Row label="Checkbox">
          <Cell id="Checkbox/off/default/default"><Checkbox label="Clip content" checked={false} onChange={noop} /></Cell>
          <Cell id="Checkbox/off/default/hover"><Checkbox label="Clip content" checked={false} onChange={noop} data-hover /></Cell>
          <Cell id="Checkbox/on/default/default"><Checkbox label="Clip content" checked onChange={noop} /></Cell>
          <Cell id="Checkbox/mixed/default/default"><Checkbox label="Clip content" checked={MIXED} onChange={noop} /></Cell>
          <Cell id="Checkbox/on/default/focus-visible"><Checkbox label="Clip content" checked onChange={noop} data-focus-visible /></Cell>
          <Cell id="Checkbox/on/default/disabled"><Checkbox label="Clip content" checked disabled onChange={noop} /></Cell>
          <Cell id="Checkbox/off/default/disabled"><Checkbox label="Clip content" checked={false} disabled onChange={noop} /></Cell>
          <Cell id="Checkbox/live/default/default" label="live"><Checkbox label="Live" checked={check} onChange={setCheck} /></Cell>
        </Row>
        <Row label="Switch">
          <Cell id="Switch/off/default/default"><Switch label="Show" checked={false} onChange={noop} /></Cell>
          <Cell id="Switch/off/default/hover"><Switch label="Show" checked={false} onChange={noop} data-hover /></Cell>
          <Cell id="Switch/on/default/default"><Switch label="Show" checked onChange={noop} /></Cell>
          <Cell id="Switch/on/default/focus-visible"><Switch label="Show" checked onChange={noop} data-focus-visible /></Cell>
          <Cell id="Switch/on/default/disabled"><Switch label="Show" checked disabled onChange={noop} /></Cell>
          <Cell id="Switch/live/default/default" label="live"><Switch label="Has icon" checked={sw} onChange={setSw} showLabel /></Cell>
        </Row>
        <Row label="RadioGroup">
          <Cell id="RadioGroup/vertical/default/default"><RadioGroup label="Resizing" value={radio} onChange={setRadio} options={[{ value: "auto", label: "Auto width" }, { value: "height", label: "Auto height" }, { value: "fixed", label: "Fixed size", disabled: true }]} /></Cell>
          <Cell id="RadioGroup/horizontal/default/mixed"><RadioGroup label="Align" value={MIXED} orientation="horizontal" onChange={noop} options={[{ value: "a", label: "Top" }, { value: "b", label: "Bottom" }]} /></Cell>
        </Row>
      </Comp>

      <Comp name="SegmentedControl / Tabs">
        <Row>
          <Cell id="SegmentedControl/text/default/default"><SegmentedControl label="View" value="grid" onChange={noop} options={[{ value: "grid", label: "Grid" }, { value: "list", label: "List" }]} /></Cell>
          <Cell id="SegmentedControl/icons/default/live" label="icons · live"><SegmentedControl label="Text align" value={seg} onChange={setSeg} options={[{ value: "left", icon: "24.text.align-left", tooltip: "Align left" }, { value: "center", icon: "24.text.align-center", tooltip: "Align center" }, { value: "right", icon: "24.text.align-right", tooltip: "Align right" }]} /></Cell>
          <Cell id="SegmentedControl/icons/default/mixed"><SegmentedControl label="Text align" value={MIXED} onChange={noop} options={[{ value: "left", icon: "24.text.align-left" }, { value: "center", icon: "24.text.align-center" }, { value: "right", icon: "24.text.align-right" }]} /></Cell>
          <Cell id="SegmentedControl/icons/default/hover"><SegmentedControl label="Text align" value="left" onChange={noop} options={[{ value: "left", icon: "24.text.align-left" }, { value: "center", icon: "24.text.align-center" }]} data-hover /></Cell>
          <Cell id="SegmentedControl/full/default/default" width={184}><SegmentedControl label="Direction" value="h" fullWidth onChange={noop} options={[{ value: "v", icon: "24.autolayout-vertical" }, { value: "h", icon: "24.autolayout-horizontal" }, { value: "w", icon: "24.autolayout-wrap" }]} /></Cell>
          <Cell id="SegmentedControl/toolbar/default/default"><SegmentedControl label="Mode" tone="toolbar" value="design" onChange={noop} options={[{ value: "design", icon: "24.figma", tooltip: "Design" }, { value: "dev", icon: "24.dev-brackets", tooltip: "Dev Mode" }]} /></Cell>
          <Cell id="SegmentedControl/text/default/disabled"><SegmentedControl label="View" value="grid" disabled onChange={noop} options={[{ value: "grid", label: "Grid" }, { value: "list", label: "List" }]} /></Cell>
        </Row>
        <Row>
          <Cell id="Tabs/default/default/live" label="live"><Tabs label="Panel" value={tab} onChange={setTab} tabs={[{ value: "design", label: "Design" }, { value: "prototype", label: "Prototype" }]} /></Cell>
          <Cell id="Tabs/badge/default/default"><Tabs label="Picker" value="custom" onChange={noop} tabs={[{ value: "custom", label: "Custom" }, { value: "libraries", label: "Libraries", badge: 3 }]} /></Cell>
        </Row>
      </Comp>

      <Comp name="PanelSection / PropertyGrid">
        <Row>
          <Cell id="PanelSection/default/default/default">
            <div className={styles.panel}>
              <PanelSection title="Frame" actions={<IconButton icon="24.styles" label="Apply styles" tone="secondary" />}>
                <PropertyGrid>
                  <PropertyRow><NumericInput label="Width" prefix="W" value={1440} onChange={noop} /><NumericInput label="Height" prefix="H" value={1024} onChange={noop} /></PropertyRow>
                  <PropertyRow action={<ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" pressed={false} onPressedChange={noop} />}>
                    <NumericInput label="X" prefix="X" value={0} onChange={noop} />
                    <NumericInput label="Y" prefix="Y" value={0} onChange={noop} />
                  </PropertyRow>
                  <PropertyRow span={2} action={<IconButton icon="24.minus.small" label="Remove fill" tone="secondary" />}>
                    <ColorInput label="Fill" color="#ffffff" opacity={100} onColor={noop} onOpacity={noop} />
                  </PropertyRow>
                </PropertyGrid>
              </PanelSection>
              <PanelSection title="Stroke" empty actions={<IconButton icon="24.plus.small" label="Add stroke" tone="secondary" />} />
              <PanelSection title="Pages" collapsible open={open} onOpenChange={(o) => setOpen(o)} actions={<IconButton icon="24.plus.small" label="Add page" tone="secondary" />}>
                <PageRow id="p1" name="Cover" current />
                <PageRow id="p2" name="Components" current={false} />
              </PanelSection>
            </div>
          </Cell>
          <Cell id="PropertyGrid/labels/default/default">
            <div className={styles.panel}>
              <PanelSection title="Layout">
                <PropertyGrid labels>
                  <PropertyRow label="Dimensions"><NumericInput label="Width" prefix="W" value={320} onChange={noop} /><NumericInput label="Height" prefix="H" value={MIXED} onChange={noop} /></PropertyRow>
                  <PropertyRow label="Resizing" span={2}><Select label="Width sizing" value="hug" options={SELECT_OPTIONS} onChange={noop} /></PropertyRow>
                </PropertyGrid>
              </PanelSection>
            </div>
          </Cell>
          <Cell id="ResizeHandle/right/default/live" label="ResizeHandle · live (drag the right edge)">
            <div className={styles.panel} style={{ position: "relative", width: panelW, height: 120, overflow: "visible" }}>
              <div style={{ padding: 16, color: "var(--figma-color-text-secondary)" }}>{panelW}px — double click the edge to reset</div>
              <ResizeHandle side="right" value={panelW} onChange={(v) => setPanelW(v)} max={400} />
            </div>
          </Cell>
        </Row>
      </Comp>

      <Comp name="LayerRow / PageRow" note="Pitch 24, highlight inset 8, radius 5; contiguous selection joins.">
        <Row>
          <Cell id="LayerRow/tree/default/states">
            <div className={styles.panelPlain} role="tree" aria-label="Layers">
              <LayerRow id="1" depth={0} name="Home — Desktop" icon="16.frame" expanded strong onToggleExpand={noop} onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="2" depth={1} name="Header" icon="16.autolayout.horizontal" expanded selected run="start" onToggleExpand={noop} onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="3" depth={2} name="Logo" icon="16.component" kind="instance" selectedAncestor run="middle" onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="4" depth={2} name="Navigation" icon="16.text" selected run="end" onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="5" depth={1} name="Button" icon="16.component" kind="component" expanded={false} hovered onToggleExpand={noop} onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="6" depth={1} name="Background" icon="16.rectangle" locked onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="7" depth={1} name="Old hero" icon="16.image" hidden onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="8" depth={1} name="Hidden instance" icon="16.instance" kind="instance" hidden onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="9" depth={1} name="Renaming" icon="16.text" renaming onRename={noop} />
              <LayerRow id="10" depth={1} name="Drop inside" icon="16.frame" drop="inside" expanded={false} />
              <LayerRow id="11" depth={1} name="Drop after" icon="16.ellipse" drop="after" />
              <LayerRow id="12" depth={1} name="Focused" icon="16.section" data-focus-visible />
            </div>
          </Cell>
          <Cell id="PageRow/list/default/states">
            <div className={styles.panelPlain} role="listbox" aria-label="Pages">
              <PageRow id="a" name="Cover" current />
              <PageRow id="b" name="Hovered" current={false} hovered />
              <PageRow id="c" name="Components" current={false} />
              <PageRow id="d" name="---" current={false} divider />
              <PageRow id="e" name="Archive" current={false} renaming onRename={noop} />
            </div>
          </Cell>
        </Row>
      </Comp>

      <Comp name="Dialog / Popover / Toast">
        <Row>
          <Cell id="Dialog/small/default/static">
            <Dialog static open title="Delete page?" onClose={noop} footer={<><Button variant="secondary" size="large">Cancel</Button><Button variant="destructive" size="large">Delete</Button></>}>
              “Archive” and its 12 layers will be deleted. You can undo this.
            </Dialog>
          </Cell>
          <Cell id="Popover/titled/default/static">
            <Popover static anchor={null} title="Drop shadow" onClose={noop}>
              <PropertyGrid>
                <PropertyRow><NumericInput label="X" prefix="X" value={0} onChange={noop} /><NumericInput label="Y" prefix="Y" value={4} onChange={noop} /></PropertyRow>
                <PropertyRow><NumericInput label="Blur" prefix="24.layer.blur.small" value={4} onChange={noop} /><NumericInput label="Spread" prefix="24.spread.small" value={0} onChange={noop} /></PropertyRow>
                <PropertyRow span={2}><ColorInput label="Color" color="#000000" opacity={25} onColor={noop} onOpacity={noop} /></PropertyRow>
              </PropertyGrid>
            </Popover>
          </Cell>
          <Cell id="Overlay/live/default/default" label="live">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Button variant="secondary" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>Open popover</Button>
              <Button variant="secondary" onClick={() => setDialog(true)}>Open dialog</Button>
              <Button variant="secondary" onClick={() => showToast({ message: "Link copied to clipboard", action: { label: "Undo", onAction: noop } })}>Show toast</Button>
              <Button variant="secondary" onClick={() => showToast({ message: "Couldn't save. Check your connection.", kind: "error" })}>Show error toast</Button>
            </div>
            {anchor && (
              <Popover anchor={anchor} placement="right" title="Settings" onClose={() => setAnchor(null)}>
                <div style={{ padding: "0 16px 8px" }}><Checkbox label="Show rulers" checked onChange={noop} /></div>
              </Popover>
            )}
            <Dialog open={dialog} onClose={() => setDialog(false)} title="Rename file" size="small" footer={<><Button variant="secondary" size="large" onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" size="large" onClick={() => setDialog(false)}>Rename</Button></>}>
              <TextInput label="File name" value="Portfolio" size="large" onCommit={noop} />
            </Dialog>
          </Cell>
        </Row>
        <Row>
          <Cell id="Toast/default/default/static"><Toast static message="Copied link to clipboard" onClose={noop} /></Cell>
          <Cell id="Toast/action/default/static"><Toast static message="Page deleted" action={{ label: "Undo", onAction: noop }} onClose={noop} /></Cell>
          <Cell id="Toast/error/default/static"><Toast static kind="error" message="Couldn't save changes" onClose={noop} /></Cell>
          <Cell id="Toast/success/default/static"><Toast static kind="success" message="Published" onClose={noop} /></Cell>
        </Row>
      </Comp>

      <Comp name="TabBar" note="38px incl. line; 80px traffic-light room; separators on both sides of the active tab.">
        <Row>
          <Cell id="TabBar/default/default/states" width={700}>
            <div style={{ width: 700 }}>
              <TabBar tabs={[{ id: "a", title: "Portfolio" }, { id: "b", title: "Case study — Atlas", dirty: true }, { id: "c", title: "Hovered tab" }]} active="a" hoverId="c" onActivate={noop} onClose={noop} onNew={noop} trailing={<IconButton icon="24.sidebar.closed" label="Panels" />} />
            </div>
          </Cell>
          <Cell id="TabBar/home/default/fullscreen" width={700}>
            <div style={{ width: 700 }}>
              <TabBar tabs={[{ id: "a", title: "Portfolio", dirty: true }]} active="home" fullScreen onActivate={noop} onClose={noop} onNew={noop} />
            </div>
          </Cell>
        </Row>
      </Comp>

      <Comp name="Toolbar / ToolButton / Rail">
        <Row>
          <Cell id="Toolbar/default/default/live" label="live">
            <div className={styles.stage}>
              <Toolbar>
                <ToolbarGroup>
                  <ToolButton icon="24.move" label="Move" shortcut="V" active={tool === "move"} onSelect={() => setTool("move")} menu={[{ id: "move", label: "Move", shortcut: "V", icon: "16.cursor" }, { id: "hand", label: "Hand tool", shortcut: "H", icon: "16.hand" }]} onMenuSelect={setTool} />
                  <ToolButton icon="24.frame" label="Frame" shortcut="F" active={tool === "frame"} onSelect={() => setTool("frame")} menu={[{ id: "frame", label: "Frame", shortcut: "F" }, { id: "section", label: "Section", shortcut: keys(["shift", "s"]) }]} onMenuSelect={setTool} />
                  <ToolButton icon="24.rectangle" label="Rectangle" shortcut="R" active={tool === "rect"} onSelect={() => setTool("rect")} menu={[{ id: "rect", label: "Rectangle", shortcut: "R" }, { id: "ellipse", label: "Ellipse", shortcut: "O" }]} onMenuSelect={setTool} />
                  <ToolButton icon="24.pen" label="Pen" shortcut="P" active={tool === "pen"} onSelect={() => setTool("pen")} menu={[{ id: "pen", label: "Pen", shortcut: "P" }, { id: "pencil", label: "Pencil", shortcut: keys(["shift", "p"]) }]} onMenuSelect={setTool} />
                  <ToolButton icon="24.text" label="Text" shortcut="T" active={tool === "text"} onSelect={() => setTool("text")} />
                  <ToolButton icon="24.comment" label="Comment" shortcut="C" active={tool === "comment"} onSelect={() => setTool("comment")} />
                  <ToolButton icon="24.actions" label="Actions" shortcut={keys(["mod", "k"])} active={false} onSelect={noop} />
                </ToolbarGroup>
                <ToolbarDivider />
                <SegmentedControl label="Mode" tone="toolbar" value={mode} onChange={setMode} options={[{ value: "design", icon: "24.figma", tooltip: "Design" }, { value: "dev", icon: "24.dev-brackets", tooltip: "Dev Mode", shortcut: keys(["shift", "d"]) }]} />
              </Toolbar>
            </div>
          </Cell>
          <Cell id="ToolButton/states/default/default">
            <div className={styles.stage} style={{ display: "flex", gap: 8 }}>
              <Toolbar>
                <ToolButton icon="24.move" label="Move" active={false} onSelect={noop} />
                <ToolButton icon="24.move" label="Move" active={false} forceHover onSelect={noop} />
                <ToolButton icon="24.frame" label="Frame" active onSelect={noop} menu={[]} />
                <ToolButton icon="24.pen" label="Pen" active={false} forceOpen onSelect={noop} menu={[]} />
                <ToolButton icon="24.text" label="Text" active={false} disabled onSelect={noop} />
              </Toolbar>
              <HelpButton inline />
            </div>
          </Cell>
          <Cell id="Rail/default/default/states">
            <div style={{ height: 300, border: "1px solid var(--figma-color-border)" }}>
              <Rail>
                <RailItem icon="24.figma" label="Main menu" active={false} />
                <RailSeparator />
                <RailItem icon="24.page" label="File" active onClick={noop} />
                <RailItem icon="24.library" label="Assets" active={false} forceHover />
                <RailItem icon="24.search" label="Find" shortcut={keys(["mod", "f"])} active={false} />
                <RailSeparator />
                <RailItem icon="24.settings.small" label="Settings" active={false} />
              </Rail>
            </div>
          </Cell>
        </Row>
      </Comp>

      <Comp name="SidebarItem / SearchField / FileCard">
        <Row>
          <Cell id="SidebarItem/default/default/states">
            <div className={styles.panelPlain}>
              <SearchField value={search} onChange={setSearch} size="large" style={{ margin: "0 8px 8px" }} />
              <SidebarItem icon="24.recent" label="Recents" selected={nav === "recents"} onClick={() => setNav("recents")} />
              <SidebarDivider />
              <SidebarItem icon="24.file" label="Drafts" count={12} selected={nav === "drafts"} onClick={() => setNav("drafts")} />
              <SidebarItem icon="24.view.grid" label="All folders" selected={nav === "folders"} onClick={() => setNav("folders")} />
              <SidebarItem icon="24.trash.outline" label="Hovered" forceHover />
              <SidebarDivider />
              <SidebarHeader title="Starred" open={starredOpen} onOpenChange={setStarredOpen} action={<IconButton icon="24.plus.small" label="New folder" tone="secondary" />} />
              {starredOpen && (
                <>
                  <SidebarItem icon={<FolderIcon />} label="Drop target" dropTarget />
                  <SidebarItem icon={<FileKindIcon />} label="Portfolio" />
                  <SidebarItem icon={<FolderIcon />} label="Nested folder" indent={1} />
                </>
              )}
            </div>
          </Cell>
          <Cell id="SearchField/states/default/default">
            <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 200 }}>
              <SearchField value="" onChange={noop} />
              <SearchField value="Button" onChange={noop} />
              <SearchField value="" onChange={noop} data-hover />
              <SearchField value="" onChange={noop} size="large" placeholder="Search files" />
            </div>
          </Cell>
          <Cell id="FileCard/default/default/default"><FileCard id="f1" title="Portfolio" subtitle={formatEdited(now - 34 * 60_000, now)} onStar={noop} /></Cell>
          <Cell id="FileCard/default/default/hover"><FileCard id="f2" title="Case study — Atlas" subtitle={formatEdited(now - 86_400_000, now)} forceHover onStar={noop} /></Cell>
          <Cell id="FileCard/default/default/selected"><FileCard id="f3" title="Selected" subtitle={formatEdited(now - 3 * 86_400_000, now)} selected starred onStar={noop} /></Cell>
          <Cell id="FileCard/default/default/renaming"><FileCard id="f4" title="Renaming" subtitle={formatEdited(now - 5_000, now)} renaming onRename={noop} /></Cell>
          <Cell id="FileRow/default/default/default" width={420}>
            <div style={{ width: 420 }}>
              <FileRow id="r1" title="Portfolio" subtitle={formatEdited(now - 2 * 3_600_000, now)} />
              <FileRow id="r2" title="Selected" subtitle={formatEdited(now - 40 * 86_400_000, now)} selected />
            </div>
          </Cell>
        </Row>
      </Comp>

      <Comp name="Badge / Avatar / Spinner / Kbd / Divider">
        <Row>
          {(["default", "brand", "component", "success", "warning", "danger"] as const).map((t) => (
            <Cell key={t} id={`Badge/${t}/default/default`}><Badge tone={t}>{t === "default" ? "Draft" : t}</Badge></Cell>
          ))}
          <Cell id="Badge/count/default/default"><Badge tone="brand" count>12</Badge></Cell>
        </Row>
        <Row>
          <Cell id="Avatar/initials/16/default"><Avatar name="Burak Koç" size={16} /></Cell>
          <Cell id="Avatar/initials/24/default"><Avatar name="Burak Koç" size={24} /></Cell>
          <Cell id="Avatar/initials/32/default"><Avatar name="Burak Koç" size={32} /></Cell>
          <Cell id="Spinner/default/16/default"><Spinner size={16} /></Cell>
          <Cell id="Spinner/default/24/default"><Spinner size={24} /></Cell>
          <Cell id="Spinner/default/32/default"><Spinner size={32} /></Cell>
          <Cell id="Kbd/default/default/default"><Kbd>{keys(["shift", "mod", "p"])}</Kbd></Cell>
          <Cell id="Divider/horizontal/default/default" width={120}><div style={{ width: 120, padding: "8px 0" }}><Divider /></div></Cell>
        </Row>
      </Comp>

      <Comp name="EmptyState / ScrollArea / VirtualList / CodeBlock">
        <Row>
          <Cell id="EmptyState/panel/default/default" width={240}><EmptyState icon="24.search.small" title="No results" body="Try another name or clear the filter." action={{ label: "Clear search", onClick: noop }} /></Cell>
          <Cell id="EmptyState/page/default/default" width={320}><EmptyState size="page" icon="24.file" title="No files yet" body="Create a design file to get started." /></Cell>
          <Cell id="ScrollArea/y/default/default" width={200}>
            <ScrollArea forceVisible style={{ height: 160, width: 200, border: "1px solid var(--figma-color-border)", borderRadius: 5 }}>
              <div style={{ padding: 8 }}>{Array.from({ length: 30 }, (_, i) => <div key={i} style={{ height: 24 }}>Row {i + 1}</div>)}</div>
            </ScrollArea>
          </Cell>
          <Cell id="VirtualList/default/default/default" width={240}>
            <div style={{ height: 200, width: 240, display: "flex", border: "1px solid var(--figma-color-border)", borderRadius: 5 }}>
              <VirtualList count={10000} rowHeight={24} renderRow={(i) => <LayerRow id={String(i)} depth={i % 3} name={`Layer ${i + 1}`} icon={i % 3 ? "16.rectangle" : "16.frame"} selected={i === 2} />} />
            </div>
          </Cell>
          <Cell id="CodeBlock/default/default/default" width={280}><div style={{ width: 280 }}><CodeBlock code={"width: 1440px;\nheight: 1024px;\nbackground: #FFFFFF;"} /></div></Cell>
        </Row>
      </Comp>
    </Section>
  );
}
