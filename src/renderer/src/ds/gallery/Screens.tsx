import { useState } from "react";
import { Breadcrumb } from "../components/Breadcrumb";
import { CollectionView } from "../components/CollectionView";
import { MIXED } from "../types";
import { Button, IconButton, ToggleIconButton } from "../components/Button";
import { NumericInput } from "../components/NumericInput";
import { ColorInput } from "../components/ColorInput";
import { Select } from "../components/Select";
import { SegmentedControl } from "../components/SegmentedControl";
import { Tabs } from "../components/Tabs";
import { PanelSection } from "../components/PanelSection";
import { PropertyGrid, PropertyRow } from "../components/PropertyGrid";
import { LayerRow, PageRow } from "../components/LayerRow";
import { TabBar } from "../components/TabBar";
import { HelpButton } from "../components/Toolbar";
import { EditorToolbar, groupOf, type ToolGroupId, type ToolId } from "../components/EditorToolbar";
import { Rail, RailItem, RailSeparator } from "../components/Rail";
import { FolderIcon, SidebarDivider, SidebarHeader, SidebarItem } from "../components/SidebarItem";
import { FileCard, FileKindIcon } from "../components/FileCard";
import { formatEdited } from "../util/time";
import { Avatar } from "../components/Misc";
import { SearchField } from "../components/SearchField";
import { ReferenceOverlay } from "./ReferenceOverlay";
import { Comp, noop, Section } from "./parts";
import styles from "./Gallery.module.css";

/** The editor at the owner's reference size (1512 × 945 CSS px), built only from DS components. */
export function EditorScreen() {
  const [tool, setTool] = useState<ToolId>("move");
  const [groups, setGroups] = useState<Partial<Record<ToolGroupId, ToolId>>>({});
  return (
    <div className={styles.screen} data-gallery-id="screen/editor">
      <TabBar tabs={[{ id: "a", title: "Portfolio" }, { id: "b", title: "Case study — Atlas", dirty: true }]} active="a" onActivate={noop} onClose={noop} onNew={noop} trailing={<IconButton icon="24.sidebar.closed" label="Panels" />} />
      <div className={styles.editorBody}>
        <Rail>
          <RailItem icon="24.figma" label="Main menu" active={false} />
          <RailSeparator />
          <RailItem icon="24.page" label="File" active />
          <RailItem icon="24.library" label="Assets" active={false} />
          <RailItem icon="24.search" label="Find" active={false} />
          <RailSeparator />
          <RailItem icon="24.settings.small" label="Settings" active={false} />
        </Rail>
        <div className={styles.leftPanel}>
          <div className={styles.fileHeader}>
            <span className={styles.fileName}>Portfolio</span>
            <span className={styles.fileMeta}>Drafts</span>
          </div>
          <PanelSection title="Pages" collapsible open onOpenChange={noop} actions={<IconButton icon="24.plus.small" label="Add page" tone="secondary" />}>
            <PageRow id="p1" name="Cover" current />
            <PageRow id="p2" name="Components" current={false} />
            <PageRow id="p3" name="Archive" current={false} />
          </PanelSection>
          <PanelSection title="Layers" pad="none">
            <div role="tree" aria-label="Layers">
              <LayerRow id="1" depth={0} name="Home — Desktop" icon="16.frame" expanded strong onToggleExpand={noop} />
              <LayerRow id="2" depth={1} name="Header" icon="16.autolayout.horizontal" expanded selected run="start" onToggleExpand={noop} onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="3" depth={2} name="Logo" icon="16.instance" kind="instance" selectedAncestor run="middle" onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="4" depth={2} name="Navigation" icon="16.autolayout.horizontal" selected run="end" onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="5" depth={1} name="Hero" icon="16.frame" expanded={false} onToggleExpand={noop} onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="6" depth={1} name="Background" icon="16.rectangle" locked onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="7" depth={1} name="Old hero" icon="16.image" hidden onToggleLock={noop} onToggleVisible={noop} />
              <LayerRow id="8" depth={0} name="Button" icon="16.component" kind="component" strong expanded={false} onToggleExpand={noop} />
            </div>
          </PanelSection>
        </div>
        <div className={styles.canvas}>
          <span className={styles.frameTitle} style={{ left: 120, top: 84 }}>Home — Desktop</span>
          <div className={styles.frame} style={{ left: 120, top: 104, width: 640, height: 420, background: "#ffffff" }} />
          <EditorToolbar floating tool={tool} groupTools={groups} mode="design" onMode={noop} onTool={(t) => { setTool(t); setGroups((g) => ({ ...g, [groupOf(t)]: t })); }} />
          <HelpButton />
        </div>
        <div className={styles.rightPanel} data-panel="right">
          <div className={styles.rightHeader}>
            <Avatar name="Burak Koç" />
            <span className={styles.grow} />
            <IconButton icon="24.play" label="Present" />
            <Button variant="primary" size="large">Share</Button>
          </div>
          <div className={styles.rightTabs}>
            <Tabs label="Panel" value="design" onChange={noop} tabs={[{ value: "design", label: "Design" }, { value: "prototype", label: "Prototype" }]} />
            <Select label="Zoom" variant="ghost" width="hug" value="100" options={[{ value: "100", label: "100%" }, { value: "200", label: "200%" }]} onChange={noop} />
          </div>
          <PanelSection title="Frame" actions={<IconButton icon="24.styles" label="Apply styles" tone="secondary" />}>
            <PropertyGrid>
              <PropertyRow><NumericInput label="X" prefix="X" value={0} onChange={noop} /><NumericInput label="Y" prefix="Y" value={0} onChange={noop} /></PropertyRow>
              <PropertyRow action={<ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" pressed={false} onPressedChange={noop} />}>
                <NumericInput label="Width" prefix="W" value={1440} onChange={noop} />
                <NumericInput label="Height" prefix="H" value={MIXED} onChange={noop} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
          <PanelSection title="Auto layout" actions={<IconButton icon="24.plus.small" label="Add auto layout" tone="secondary" />}>
            <PropertyGrid>
              <PropertyRow span={2}><SegmentedControl label="Direction" value="h" fullWidth onChange={noop} options={[{ value: "v", icon: "24.autolayout-vertical" }, { value: "h", icon: "24.autolayout-horizontal" }, { value: "w", icon: "24.autolayout-wrap" }]} /></PropertyRow>
              <PropertyRow><NumericInput label="Gap" prefix="24.al.spacing-horizontal" value={24} onChange={noop} /><NumericInput label="Padding" prefix="24.al.padding-horizontal" value={32} onChange={noop} /></PropertyRow>
            </PropertyGrid>
          </PanelSection>
          <PanelSection title="Fill" actions={<><IconButton icon="24.styles" label="Apply styles" tone="secondary" /><IconButton icon="24.plus.small" label="Add fill" tone="secondary" /></>}>
            <PropertyGrid>
              <PropertyRow span={2} action={<IconButton icon="24.minus.small" label="Remove fill" tone="secondary" />}><ColorInput label="Fill" color="#ffffff" opacity={100} onColor={noop} onOpacity={noop} /></PropertyRow>
              <PropertyRow span={2} action={<IconButton icon="24.minus.small" label="Remove fill" tone="secondary" />}><ColorInput label="Fill" color="#0c8ce9" opacity={20} onColor={noop} onOpacity={noop} /></PropertyRow>
            </PropertyGrid>
          </PanelSection>
          <PanelSection title="Stroke" empty actions={<IconButton icon="24.plus.small" label="Add stroke" tone="secondary" />} />
          <PanelSection title="Effects" empty actions={<IconButton icon="24.plus.small" label="Add effect" tone="secondary" />} />
          <PanelSection title="Export" empty actions={<IconButton icon="24.plus.small" label="Add export" tone="secondary" />} />
        </div>
      </div>
    </div>
  );
}

/** Home at the reference size, as Figma's 2026 file browser (folders, not projects). */
export function HomeScreen() {
  const now = Date.UTC(2026, 9, 6, 15, 5);
  const files: [string, number][] = [["Portfolio", 34 * 60_000], ["Case study — Atlas", 3 * 86_400_000], ["Icons", 3 * 86_400_000], ["Landing page", 4 * 86_400_000], ["Mobile app", 5 * 86_400_000], ["Untitled", 5 * 86_400_000], ["Brand", 31 * 86_400_000], ["Wireframes", 62 * 86_400_000]];
  return (
    <div className={styles.screen} data-gallery-id="screen/home">
      <TabBar tabs={[{ id: "a", title: "Portfolio" }]} active="home" onActivate={noop} onClose={noop} onNew={noop} />
      <div style={{ position: "absolute", top: 38, left: 0, right: 0, bottom: 0 }}>
        <div className={styles.homeSide}>
          <div className={styles.homeAccount}>
            <Avatar name="Burak Koç" />
            <span style={{ flex: 1, font: "var(--ds-font-body-large-strong)" }}>burak.koc</span>
            <IconButton icon="24.bell" label="Notifications" />
          </div>
          <div style={{ padding: "0 8px" }}><SearchField value="" onChange={noop} size="large" /></div>
          <div>
            <SidebarItem icon="24.recent" label="Recents" />
          </div>
          <SidebarDivider />
          <div className={styles.homeWorkspace}>
            <Avatar name="burakkoc.net" size={16} />
            <span>burakkoc.net</span>
          </div>
          <div>
            <SidebarItem icon="24.file" label="Drafts" selected />
            <SidebarItem icon="24.view.grid" label="All folders" />
            <SidebarItem icon="24.library.shelf" label="Resources" />
            <SidebarItem icon="24.trash.outline" label="Trash" />
          </div>
          <SidebarDivider />
          <SidebarHeader title="Starred" open onOpenChange={noop} />
          <div>
            <SidebarItem icon={<FolderIcon />} label="Clients" />
            <SidebarItem icon={<FileKindIcon />} label="Portfolio" />
          </div>
        </div>
        <div className={styles.homeTop}>
          <IconButton icon="24.arrow.left" label="Back" tone="secondary" />
          <IconButton icon="24.arrow.right" label="Forward" tone="secondary" />
          <Breadcrumb items={[{ id: "drafts", label: "Drafts" }]} onNavigate={noop} style={{ marginLeft: 4 }} />
          <span className={styles.grow} />
          <Button variant="tinted" icon="24.figma">Design</Button>
          <Button variant="tinted" icon="24.plus.small">Import</Button>
        </div>
        <div className={styles.homeMain}>
          <div className={styles.pills}>
            <span className={styles.grow} />
            <Select label="Files shown" variant="ghost" width="hug" value="all" options={[{ value: "all", label: "All files" }, { value: "design", label: "Design files" }]} onChange={noop} />
            <Select label="Sort" variant="ghost" width="hug" value="modified" options={[{ value: "viewed", label: "Last viewed" }, { value: "modified", label: "Last modified" }, { value: "name", label: "Alphabetical" }, { value: "created", label: "Date created" }]} onChange={noop} />
            <SegmentedControl label="View" value="grid" onChange={noop} options={[{ value: "grid", icon: "24.view.grid", tooltip: "Grid view" }, { value: "list", icon: "24.view.list", tooltip: "List view" }]} />
          </div>
          <CollectionView label="Files" className={styles.cards}>
            {files.map(([t, ago], i) => (
              <FileCard key={`${t}-${i}`} id={`${t}-${i}`} title={t} subtitle={formatEdited(now - ago, now)} selected={i === 1} />
            ))}
          </CollectionView>
        </div>
      </div>
    </div>
  );
}

export function ScreensSection() {
  return (
    <Section id="screens" title="Screens (1512 × 945)">
      <Comp name="Editor">
        <ReferenceOverlay screen="editor"><EditorScreen /></ReferenceOverlay>
      </Comp>
      <Comp name="Home">
        <ReferenceOverlay screen="home"><HomeScreen /></ReferenceOverlay>
      </Comp>
    </Section>
  );
}
