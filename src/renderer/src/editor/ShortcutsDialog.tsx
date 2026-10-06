/**
 * Keyboard shortcuts (⌃⇧?, Help ▸ Keyboard shortcuts): every command with
 * a key from the registry, by Figma's groups, plus the keys the engine
 * handles itself on the canvas (selection, nudging, panning).
 */
import { Dialog, Kbd, Tabs, keys } from "@/ds";
import { useState } from "react";
import { useEditor } from "./controller";
import { COMMANDS, shortcutOf } from "./commands";
import { useUI } from "./hooks";
import styles from "./ShortcutsDialog.module.css";

const GROUPS: { value: string; label: string; prefixes: string[] }[] = [
  { value: "tools", label: "Tools", prefixes: ["tool."] },
  { value: "edit", label: "Edit", prefixes: ["edit."] },
  { value: "view", label: "View", prefixes: ["view.", "help."] },
  { value: "object", label: "Object", prefixes: ["object.", "arrange."] },
  { value: "text", label: "Text", prefixes: ["text."] },
  { value: "selection", label: "Selection", prefixes: [] },
];

/** Keys the engine handles on the canvas (docs/engine.md §8.4), as Figma lists them. */
const ENGINE_KEYS: [string, string][] = [
  ["Select children", keys(["enter"])],
  ["Select parent", keys(["shift", "enter"])],
  ["Select next sibling", keys(["tab"])],
  ["Select previous sibling", keys(["shift", "tab"])],
  ["Select parent, then deselect", keys(["escape"])],
  ["Nudge", "← ↑ → ↓"],
  ["Nudge by 10", `${keys(["shift"])} ← ↑ → ↓`],
  ["Pan", keys(["space"]) + " drag"],
  ["Select deep", `${keys(["mod"])} click`],
];

export function ShortcutsDialog() {
  const ed = useEditor();
  const open = useUI((s) => s.shortcutsOpen);
  const [tab, setTab] = useState("tools");
  const close = () => {
    ed.ui.set({ shortcutsOpen: false });
    ed.focusCanvas();
  };
  const group = GROUPS.find((g) => g.value === tab) ?? GROUPS[0];
  const rows: [string, string][] =
    group.value === "selection"
      ? ENGINE_KEYS
      : COMMANDS.filter((c) => c.keys?.length && group.prefixes.some((p) => c.id.startsWith(p))).map((c) => [c.label, shortcutOf(c) ?? ""]);
  return (
    <Dialog title="Keyboard shortcuts" size="large" open={open} onClose={close}>
      <Tabs label="Shortcut groups" value={tab} tabs={GROUPS.map(({ value, label }) => ({ value, label }))} onChange={setTab} />
      <dl className={styles.list}>
        {rows.map(([label, shortcut]) => (
          <div key={label} className={styles.row}>
            <dt>{label}</dt>
            <dd>
              <Kbd>{shortcut}</Kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
