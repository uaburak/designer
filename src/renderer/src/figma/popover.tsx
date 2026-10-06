import { useEffect, useRef, useState } from "react";
import type { DesignVariable } from "@/types/design";
import { FigmaIcon } from "@/components/admin/figmaIcons";
import { resolvedValue, splitName, type ThemeMode } from "@/components/project/designVariables";

/** Where a popover sits on the screen: under what opened it (`top`), or over it (`bottom`, from the screen's bottom). */
export type PopoverAt = { left: number } & ({ top: number; bottom?: undefined } | { bottom: number; top?: undefined });

/** A choice in a menu under a field: `divided` puts a line above it. */
export type MenuItem = { label: string; hint?: string; checked?: boolean; disabled?: boolean; divided?: boolean; onSelect: () => void };

/**
 * A popover fixed to the screen under (or over) what opened it — the panel's
 * edges never clip it. It lives inside `box` (with what opens it): a click
 * outside the box, or a scroll outside it, closes it.
 */
export function usePopover(width: number) {
  const [at, setAt] = useState<PopoverAt | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setAt(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [at]);
  /**
   * Opens it under `under` — its right edge with `under`'s, or its left edge
   * with `side` "left"; over it with `place` "above" — or closes it.
   */
  const toggle = (under: Element, side: "left" | "right" = "right", place: "below" | "above" = "below") => {
    const r = under.getBoundingClientRect();
    const left = Math.min(Math.max(8, side === "left" ? r.left : r.right - width), window.innerWidth - width - 8);
    setAt((open) => (open ? null : place === "above" ? { bottom: window.innerHeight - r.top + 6, left } : { top: r.bottom + 6, left }));
  };
  return { at, box, toggle, close: () => setAt(null) };
}

/** A popover's place as styles, never taller than the room it has. */
export function popoverStyle(at: PopoverAt, width: number, max?: number) {
  const room = at.top !== undefined ? `calc(100vh - ${at.top + 8}px)` : `calc(100vh - ${at.bottom + 8}px)`;
  return { top: at.top, bottom: at.bottom, left: at.left, width, maxHeight: max ? `min(${max}px, ${room})` : room };
}

/** A colour's swatch in a field. */
export function Swatch({ color }: { color: string | number | null }) {
  return <span className="block w-3.5 h-3.5 shrink-0 rounded-[3px] border border-[var(--border-hover)]" style={{ backgroundColor: typeof color === "string" ? color : "transparent" }} />;
}

export const PICKER_WIDTH = 240;

/**
 * Figma's variable picker: the variables a value can be bound to, grouped by
 * their names' paths and found by a search — each with its swatch (a colour)
 * or its value; the bound one ticked.
 */
export function VariablePicker({ at, variables, byId, mode, selectedId, onPick }: {
  at: PopoverAt;
  variables: DesignVariable[];
  byId: Map<string, DesignVariable>;
  mode: ThemeMode;
  selectedId?: string;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase("tr");
  // Groups in the order they first appear.
  const groups = new Map<string, DesignVariable[]>();
  for (const v of variables) {
    if (q && !v.name.toLocaleLowerCase("tr").includes(q)) continue;
    const [group] = splitName(v.name);
    groups.set(group, [...(groups.get(group) ?? []), v]);
  }
  return (
    <div
      role="dialog"
      aria-label="Variables"
      style={popoverStyle(at, PICKER_WIDTH, 360)}
      className="fixed z-50 flex flex-col rounded-[8px] border border-[var(--border)] bg-[var(--bg-1)] shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
    >
      <div className="shrink-0 p-2 border-b border-[var(--border)]">
        <input
          autoFocus
          aria-label="Search variables"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full h-6 px-2 rounded-[6px] bg-[var(--bg-4)] text-[11px] text-[var(--text-title)] placeholder:text-[var(--text-subtitle)] outline-none"
        />
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-1">
        {[...groups].map(([group, list]) => (
          <div key={group || "—"}>
            {group && <p className="h-6 flex items-center px-2 text-[11px] font-medium text-[var(--text-subtitle)] select-none">{group}</p>}
            {list.map((v) => {
              const value = resolvedValue(v, mode, byId);
              return (
                <button
                  key={v.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={v.id === selectedId}
                  title={v.name}
                  onClick={() => onPick(v.id)}
                  className="flex items-center gap-2 w-full h-6 px-2 rounded-[6px] text-left hover:bg-[var(--bg-4)] transition-colors cursor-pointer"
                >
                  {v.kind === "color" ? <Swatch color={value} /> : <FigmaIcon name="16.number" className="-m-px shrink-0 text-[var(--text-subtitle)]" />}
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-title)]">{splitName(v.name)[1] || v.name}</span>
                  {v.kind !== "color" && <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-subtitle)]">{value ?? "—"}</span>}
                  <span className="flex w-4 shrink-0 text-[var(--text-title)]">{v.id === selectedId && <FigmaIcon name="16.check" />}</span>
                </button>
              );
            })}
          </div>
        ))}
        {groups.size === 0 && <p className="px-2 py-3 text-[11px] text-[var(--text-subtitle)]">{variables.length ? "No results" : "No variables"}</p>}
      </div>
    </div>
  );
}
