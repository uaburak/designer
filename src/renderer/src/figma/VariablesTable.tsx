import { useEffect, useMemo, useState } from "react";
import type { DesignVariable, VariableKind } from "@/types/design";
import { cn } from "@/lib/utils";
import { FigmaIcon, fi } from "@/components/admin/figmaIcons";
import { byGroup, resolvedValue, splitName } from "@/components/project/designVariables";
import type { DesignSystem } from "./designSystem";
import { ColorInput, IconButton, NumericInput, TextInput } from "./ui";

/**
 * Figma's Variables window: the collections and groups at the left, the
 * table at the right — a row per variable: its name, its value in each mode
 * (a colour's Light and Dark) — and "Create variable" under it.
 */
export function VariablesTable({ system, onClose }: { system: DesignSystem; onClose: () => void }) {
  const { variables } = system;
  const [group, setGroup] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindMenu, setKindMenu] = useState(false);
  // Figma's collections: a variable's `collection` (the default one when unset); "+" makes a new one.
  const DEFAULT = "Collection 1";
  const collections = useMemo(() => [DEFAULT, ...new Set(variables.map((v) => v.collection).filter((c): c is string => Boolean(c) && c !== DEFAULT))], [variables]);
  const [collection, setCollection] = useState(DEFAULT);
  const [renaming, setRenaming] = useState<string | null>(null);
    const addCollection = () => {
    let n = collections.length + 1;
    while (collections.includes(`Collection ${n}`)) n++;
    const name = `Collection ${n}`;
    // A collection exists through its variables: the first one is made with it.
    system.addVariable("color", name);
    setCollection(name);
    setGroup(null);
  };
  const renameCollection = (from: string, to: string) => {
    const name = to.trim();
    if (!name || name === from) return;
    variables.filter((v) => (v.collection ?? DEFAULT) === from).forEach((v) => system.setVariable({ ...v, collection: name === DEFAULT ? undefined : name }));
    setCollection(name);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const byId = useMemo(() => new Map(variables.map((v) => [v.id, v])), [variables]);
  const mine = useMemo(() => variables.filter((v) => (v.collection ?? DEFAULT) === collection), [variables, collection]);
  const groups = useMemo(() => [...byGroup(mine).keys()].filter(Boolean), [mine]);
  const q = query.trim().toLocaleLowerCase("tr");
  const shown = mine.filter((v) => (group === null || splitName(v.name)[0] === group) && (!q || v.name.toLocaleLowerCase("tr").includes(q)));
  const chit = (v: DesignVariable, mode: "light" | "dark") => String(resolvedValue(v, mode, byId) ?? "#000000");

  return (
    <div role="dialog" aria-label="Variables" className="fixed inset-0 z-50 flex items-center justify-center bg-black/10" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex w-[1040px] max-w-[calc(100vw-48px)] h-[780px] max-h-[calc(100vh-48px)] rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_10px_24px_rgba(0,0,0,0.25)] overflow-hidden text-[11px] leading-4 text-[var(--f-text)]">
        {/* Collections and groups */}
        <div className="flex w-[300px] shrink-0 flex-col border-r border-[var(--f-border)]">
          <div className="flex items-center justify-between h-12 pl-4 pr-2">
            <span className="text-[13px] font-[550] leading-[22px] tracking-[-0.0325px]">Variables</span>
            <IconButton label="Toggle sidebar" icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" /><path d="M6 3.5v9" stroke="currentColor" /></svg>} />
          </div>
          <div className="flex items-center justify-between h-10 pl-4 pr-2">
            <span className="font-[550]">Collections</span>
            <IconButton label="Create collection" icon={fi("plus.small")} onClick={addCollection} />
          </div>
          <div className="flex flex-col px-2">
            {collections.map((c) => (
              <div key={c} onDoubleClick={() => setRenaming(c)} className={cn("flex items-center justify-between h-8 px-2 rounded-[5px] cursor-pointer", c === collection ? "bg-[var(--f-bg-selected)]" : "hover:bg-[var(--f-bg-hover)]")} onClick={() => { setCollection(c); setGroup(null); }}>
                {renaming === c ? (
                  <input autoFocus defaultValue={c} aria-label="Collection name" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { renameCollection(c, e.currentTarget.value); setRenaming(null); } if (e.key === "Escape") setRenaming(null); }} onBlur={(e) => { renameCollection(c, e.currentTarget.value); setRenaming(null); }} className="min-w-0 flex-1 h-6 px-1 rounded-[3px] bg-[var(--f-bg)] border border-[var(--f-border-selected)] outline-none" />
                ) : (
                  <span className="truncate">{c}</span>
                )}
                <span className="text-[var(--f-text-secondary)] tabular-nums">{variables.filter((v) => (v.collection ?? DEFAULT) === c).length}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center h-10 pl-4 pr-2 mt-4">
            <span className="font-[550]">Groups</span>
          </div>
          <div className="flex flex-col px-2 overflow-y-auto">
            <button type="button" onClick={() => setGroup(null)} className={cn("flex items-center justify-between h-8 px-2 rounded-[5px] text-left cursor-pointer", group === null ? "bg-[var(--f-bg-selected)]" : "hover:bg-[var(--f-bg-hover)]")}>
              <span>All variables</span>
              <span className="text-[var(--f-text-secondary)] tabular-nums">{mine.length}</span>
            </button>
            {groups.map((g) => (
              <button key={g} type="button" onClick={() => setGroup(g)} className={cn("flex items-center justify-between h-8 px-2 rounded-[5px] text-left cursor-pointer", group === g ? "bg-[var(--f-bg-selected)]" : "hover:bg-[var(--f-bg-hover)]")}>
                <span className="truncate">{g}</span>
                <span className="text-[var(--f-text-secondary)] tabular-nums">{mine.filter((v) => splitName(v.name)[0] === g).length}</span>
              </button>
            ))}
          </div>
        </div>
        {/* The table */}
        <div className="flex flex-1 min-w-0 flex-col">
          <div className="flex items-center justify-end gap-2 h-12 px-3 border-b border-[var(--f-border)]">
            <div className="flex items-center w-[260px] h-7 px-2 gap-2 rounded-[5px] bg-[var(--f-bg-secondary)]">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-[var(--f-icon-secondary)]"><circle cx="7" cy="7" r="4" stroke="currentColor" /><path d="M10 10l3.5 3.5" stroke="currentColor" strokeLinecap="round" /></svg>
              <input aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Search" className="min-w-0 flex-1 bg-transparent outline-none text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)]" />
            </div>
            <IconButton label="Close" icon={fi("close.small")} onClick={onClose} />
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-[var(--f-bg)]">
                <tr className="h-10 text-left font-[550]">
                  <th className="w-[260px] pl-5 border-b border-r border-[var(--f-border)]">Name</th>
                  <th className="w-[240px] pl-5 border-b border-r border-[var(--f-border)]">Light</th>
                  <th className="w-[240px] pl-5 border-b border-r border-[var(--f-border)]">Dark</th>
                  <th className="border-b border-[var(--f-border)]" />
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => (
                  <tr key={v.id} className="group/var h-[54px] hover:bg-[var(--f-bg-hover)]">
                    <td className="pl-3 pr-2 border-b border-r border-[var(--f-border)]">
                      <div className="flex items-center gap-2">
                        <span className="flex w-6 shrink-0 justify-center text-[var(--f-icon-secondary)]">{v.kind === "color" ? <FigmaIcon name="16.variable" /> : <FigmaIcon name="16.number" />}</span>
                        <TextInput label="Name" value={v.name} onCommit={(name) => name.trim() && system.setVariable({ ...v, name: name.trim() })} className="bg-transparent border-transparent" />
                      </div>
                    </td>
                    <td className="pl-3 pr-2 border-b border-r border-[var(--f-border)]">
                      {v.kind === "color" ? (
                        <ColorInput label="Light value" color={chit(v, "light")} opacity={100} onColor={(hex) => system.setVariable({ ...v, light: { value: hex } })} className="bg-transparent border-transparent" />
                      ) : (
                        <NumericInput label="Value" prefix={<span className="w-2" />} value={Number(resolvedValue(v, "light", byId) ?? 0)} onChange={(n) => system.setVariable({ ...v, light: { value: n } })} className="bg-transparent border-transparent" />
                      )}
                    </td>
                    <td className="pl-3 pr-2 border-b border-r border-[var(--f-border)]">
                      {v.kind === "color" ? (
                        <ColorInput label="Dark value" color={chit(v, "dark")} opacity={100} onColor={(hex) => system.setVariable({ ...v, dark: { value: hex } })} className="bg-transparent border-transparent" />
                      ) : (
                        <span className="text-[var(--f-text-secondary)]">—</span>
                      )}
                    </td>
                    <td className="pr-2 border-b border-[var(--f-border)] text-right">
                      {!system.isStartingVariable(v.id) && <IconButton label="Delete variable" icon={fi("minus.small")} onClick={() => system.removeVariable(v.id)} className="opacity-0 group-hover/var:opacity-100" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="relative flex items-center h-12 px-3 border-t border-[var(--f-border)]">
            <button type="button" onClick={() => setKindMenu((m) => !m)} className="flex items-center gap-2 h-8 px-2 rounded-[5px] hover:bg-[var(--f-bg-hover)] cursor-pointer">
              {fi("plus.small")}
              <span>Create variable</span>
            </button>
            {kindMenu && (
              <div role="menu" className="absolute left-3 bottom-12 w-[172px] p-2 rounded-[8px] bg-[var(--f-bg-menu)] text-white shadow-[0_5px_17px_rgba(0,0,0,0.35)]">
                {([["color", "Color", <FigmaIcon key="c" name="16.variable" />], ["number", "Number", <FigmaIcon key="n" name="16.number" />], ["weight", "Weight", <span key="w" className="text-[10px] font-[550]">B</span>]] as [VariableKind, string, React.ReactNode][]).map(([kind, label, icon]) => (
                  <button key={kind} type="button" onClick={() => { system.addVariable(kind, collection === DEFAULT ? undefined : collection); setKindMenu(false); }} className="flex items-center gap-2 w-full h-8 px-2 rounded-[5px] text-left hover:bg-[#0d99ff] cursor-pointer">
                    <span className="flex w-4 justify-center text-white/80">{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
