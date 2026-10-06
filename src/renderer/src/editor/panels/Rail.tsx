/**
 * The 48px rail at the window's left (UI3, measured on the references):
 * the Figma button (main menu), a line, File, Assets, Insert, Resources, a
 * line, Settings. File and Assets switch the left panel; the main menu holds
 * Back to files, Quick actions and Figma's File / Edit / View / Object /
 * Text / Arrange submenus.
 */
import { useRef, useState } from "react";
import { ContextMenu, Rail as DSRail, RailItem, RailSeparator, showToast, type MenuEntry } from "@/ds";
import { useEditor } from "../controller";
import { runEditorCommand } from "../commands";
import { useUI } from "../hooks";
import { commandItem, mainMenu } from "../menus";

type Open = { owner: "main" | "settings"; at: { x: number; y: number }; entries: MenuEntry[] } | null;

export function Rail() {
  const ed = useEditor();
  const tab = useUI((s) => s.railTab);
  const [menu, setMenu] = useState<Open>(null);
  const figma = useRef<HTMLDivElement>(null);
  const settings = useRef<HTMLDivElement>(null);
  const toggle = (owner: "main" | "settings", wrap: HTMLDivElement | null, entries: () => MenuEntry[]) => {
    if (menu?.owner === owner) return setMenu(null);
    const r = (wrap?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    if (r) setMenu({ owner, at: { x: r.right + 4, y: r.top }, entries: entries() });
  };
  return (
    <>
      <DSRail label="Navigation">
        <div ref={figma} style={{ display: "contents" }}>
          <RailItem icon="24.figma" label="Main menu" active={false} onClick={() => toggle("main", figma.current, () => mainMenu(ed))} />
        </div>
        <RailSeparator />
        <RailItem icon="24.page" label="File" active={tab === "file"} onClick={() => ed.ui.set({ railTab: "file" })} />
        <RailItem icon="24.library" label="Assets" active={tab === "assets"} onClick={() => ed.ui.set({ railTab: "assets" })} />
        <RailItem icon="24.plus" label="Insert" active={false} onClick={() => showToast({ message: "Insert comes with components and libraries" })} />
        <RailItem icon="24.library.shelf" label="Resources" active={false} onClick={() => showToast({ message: "Resources come with plugins and widgets" })} />
        <RailSeparator />
        <div ref={settings} style={{ display: "contents" }}>
          <RailItem
            icon="24.settings.small"
            label="Settings"
            active={false}
            onClick={() => toggle("settings", settings.current, () => [{ header: "Theme" }, commandItem(ed, "theme.light"), commandItem(ed, "theme.dark"), commandItem(ed, "theme.system"), "-", commandItem(ed, "view.rulers"), commandItem(ed, "view.property-labels")])}
          />
        </div>
      </DSRail>
      {menu && (
        <ContextMenu
          at={menu.at}
          entries={menu.entries}
          label={menu.owner === "main" ? "Main menu" : "Settings"}
          ignore={menu.owner === "main" ? figma : settings}
          onSelect={(id) => {
            if (!runEditorCommand(ed, id)) return;
            if (!id.startsWith("view.toggle")) ed.focusCanvas();
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
