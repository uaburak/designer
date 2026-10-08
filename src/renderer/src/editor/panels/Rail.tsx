/**
 * The navigation bar at the window's left (Figma 2026, help "Navigate the left sidebar", measured on the live app):
 * the Figma menu, a line, the File, Agents, Assets and Tools tabs, a line, Variables (the variables view, formerly
 * the right sidebar's Local variables), and at the bottom the file's notifications — missing fonts, library updates
 * — only while there is one. Tabs carry their names under the icons (View › Additional labels). The Figma menu holds
 * Back to files, Actions and Figma's File / Edit / View / Object / Text / Arrange / Vector submenus, Plugins,
 * Widgets, Preferences, Libraries and Help.
 */
import { useRef, useState } from "react";
import { ContextMenu, Rail as DSRail, RailItem, RailSeparator, RailSpacer, type MenuEntry } from "@/ds";
import { useEditor } from "../controller";
import { command, shortcutOf } from "../commands";
import { useLibraries, useUI } from "../hooks";
import { mainMenu, runMenuItem } from "../menus";
import type { RailTab } from "../uiStore";
import { MissingFontsButton } from "./MissingFonts";

type Open = { at: { x: number; y: number }; entries: MenuEntry[] } | null;

const TABS: { tab: RailTab; icon: "24.page" | "24.agents" | "24.assets" | "24.tools"; label: string; command: string }[] = [
  { tab: "file", icon: "24.page", label: "File", command: "view.layers" },
  { tab: "agents", icon: "24.agents", label: "Agents", command: "view.agents" },
  { tab: "assets", icon: "24.assets", label: "Assets", command: "view.assets" },
  { tab: "tools", icon: "24.tools", label: "Tools", command: "view.tools" },
];

export function Rail() {
  const ed = useEditor();
  const tab = useUI((s) => s.railTab);
  const labels = useUI((s) => s.railLabels !== false);
  const variables = useUI((s) => s.variablesOpen);
  const libs = useLibraries();
  const pending = libs.on ? ed.libraries.pendingCount() : 0;
  const [menu, setMenu] = useState<Open>(null);
  const figma = useRef<HTMLDivElement>(null);
  const openMain = () => {
    if (menu) return setMenu(null);
    const r = (figma.current?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    if (r) setMenu({ at: { x: r.left, y: r.bottom + 4 }, entries: mainMenu(ed) });
  };
  return (
    <>
      <DSRail label="Navigation" labels={labels}>
        <div ref={figma} style={{ display: "contents" }}>
          <RailItem compact icon="24.figma" label="Main menu" active={!!menu} onClick={openMain} />
        </div>
        <RailSeparator />
        {TABS.map((t) => (
          <RailItem
            key={t.tab}
            icon={t.icon}
            label={t.label}
            shortcut={shortcutOf(command(t.command))}
            active={tab === t.tab}
            data-rail-tab={t.tab}
            onClick={() => ed.ui.set({ railTab: t.tab, find: t.tab === "file" ? ed.ui.get().find : null })}
          />
        ))}
        <RailSeparator />
        <RailItem icon="24.variables" label="Variables" active={variables} data-rail-tab="variables" onClick={() => ed.ui.set((s) => ({ variablesOpen: !s.variablesOpen }))} />
        <RailSpacer />
        <MissingFontsButton />
        {pending > 0 && (
          <RailItem
            compact
            badge
            icon="24.library"
            label="Review library updates"
            active={false}
            data-library-updates={pending}
            onClick={() => ed.ui.set({ librariesDialog: { tab: "updates" } })}
          />
        )}
      </DSRail>
      {menu && (
        <ContextMenu
          at={menu.at}
          entries={menu.entries}
          label="Main menu"
          ignore={figma}
          onSelect={(id) => {
            if (!runMenuItem(ed, id)) return;
            if (!id.startsWith("view.toggle")) ed.focusCanvas();
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
