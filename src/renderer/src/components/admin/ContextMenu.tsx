import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { FigmaIcon } from "@/components/admin/figmaIcons";

/**
 * Figma's context menu (UI3): a right click on a layer — on the canvas or in
 * the layer tree — opens what can be done with it, as Figma's dark menu: its
 * actions in groups (a line between them), each with its keys on the right,
 * some opening a menu of their own beside them (Select layer ›, Variant ›).
 * The mouse or the keys pick one (↑ ↓, → opens a menu beside, ← and Esc go
 * back, Enter picks); a click elsewhere, the wheel or Esc closes it.
 */

export type ContextMenuItem = {
  label: string;
  /** Its keys, as Figma writes them — see `keys` */
  shortcut?: string;
  /** A word after it, greyed (what kind of layer it selects…) */
  hint?: string;
  /** A 16px icon before its label (Figma's sizing menu) */
  icon?: ReactNode;
  /** Ticked (the variant an instance is…) */
  checked?: boolean;
  disabled?: boolean;
  /** Its own menu, beside it */
  items?: MenuEntry[];
  onSelect?: () => void;
};

/** A menu's entries: its items — "-" draws the line between two groups of them. */
export type MenuEntry = ContextMenuItem | "-";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** An action's keys, as Figma writes them — ⇧⌘H on a Mac, Ctrl+Shift+H elsewhere (`mod`: ⌘ / Ctrl). */
export function keys(...parts: ("mod" | "shift" | "alt" | "ctrl" | "backspace" | string)[]) {
  const order = ["ctrl", "shift", "alt", "mod"];
  const sorted = [...parts].sort((a, b) => (order.includes(a) ? order.indexOf(a) : 9) - (order.includes(b) ? order.indexOf(b) : 9));
  const mac: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "^", backspace: "⌫" };
  const other: Record<string, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", backspace: "Del" };
  return IS_MAC ? sorted.map((p) => mac[p] ?? p.toUpperCase()).join("") : sorted.map((p) => other[p] ?? p.toUpperCase()).join("+");
}

/** The entries as drawn: no line first, last or twice in a row. */
function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry === "-" && (out.length === 0 || out[out.length - 1] === "-")) continue;
    out.push(entry);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

const EDGE = 8;

/** A panel of the menu: the first at the pointer, the others beside the item opening them. */
function MenuPanel({ entries, x, y, flipX, autoFocus, onClose, onBack }: {
  entries: MenuEntry[];
  x: number;
  y: number;
  /** Where it goes when it has no room on the right: its right edge here (a menu beside another opens on its left) */
  flipX?: number;
  autoFocus: boolean;
  /** Picked: the whole menu closes */
  onClose: () => void;
  /** ← / Esc in a menu beside another: back to that one */
  onBack?: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number; focus: boolean } | null>(null);
  const list = tidy(entries);
  const hasChecks = list.some((e) => e !== "-" && e.checked !== undefined);
  const hasIcons = list.some((e) => e !== "-" && e.icon);

  // Kept on the screen: moved left (or to the other side of the item opening it) and up when it would reach past its edges.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${x + width > window.innerWidth - EDGE ? Math.max(EDGE, (flipX ?? x) - width) : x}px`;
    el.style.top = `${y + height > window.innerHeight - EDGE ? Math.max(EDGE, window.innerHeight - EDGE - height) : y}px`;
    el.style.visibility = "visible";
    if (autoFocus) el.focus({ preventScroll: true });
  }, [x, y, flipX, autoFocus]);

  const openSub = (index: number, focus: boolean) => {
    const item = panel.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`);
    if (!item) return;
    const r = item.getBoundingClientRect();
    setSub({ index, x: r.right + 4, y: r.top - 8, flipX: r.left - 4, focus });
  };
  const pick = (index: number) => {
    const entry = list[index];
    if (!entry || entry === "-" || entry.disabled) return;
    if (entry.items) return openSub(index, true);
    entry.onSelect?.();
    onClose();
  };
  const step = (dir: 1 | -1) => {
    const usable = list.map((e, i) => (e !== "-" && !e.disabled ? i : -1)).filter((i) => i >= 0);
    if (!usable.length) return;
    const at = usable.indexOf(active);
    setActive(usable[at < 0 ? (dir === 1 ? 0 : usable.length - 1) : (at + dir + usable.length) % usable.length]);
  };

  return (
    <>
      <div
        ref={panel}
        role="menu"
        data-instant=""
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown" || e.key === "ArrowUp") step(e.key === "ArrowDown" ? 1 : -1);
          else if (e.key === "Enter" || e.key === " ") pick(active);
          else if (e.key === "ArrowRight") {
            const entry = list[active];
            if (entry && entry !== "-" && entry.items && !entry.disabled) openSub(active, true);
          } else if ((e.key === "ArrowLeft" || e.key === "Escape") && onBack) onBack();
          else if (e.key === "Escape") onClose();
          else return;
          e.preventDefault();
        }}
        onContextMenu={(e) => e.preventDefault()}
        style={{ left: x, top: y, visibility: "hidden" }}
        className="fixed z-[70] min-w-[208px] max-w-[320px] max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain p-2 rounded-[13px] bg-[#1e1e1e] text-white shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_5px_17px_rgba(0,0,0,0.25),0_2px_7px_rgba(0,0,0,0.15)] outline-none select-none"
      >
        {list.map((entry, i) =>
          entry === "-" ? (
            <div key={`line-${i}`} role="separator" className="-mx-2 my-2 h-px bg-white/10" />
          ) : (
            <button
              key={`${entry.label}-${i}`}
              type="button"
              role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
              data-menu-index={i}
              aria-haspopup={entry.items ? "menu" : undefined}
              aria-expanded={entry.items ? sub?.index === i : undefined}
              aria-checked={entry.checked}
              disabled={entry.disabled}
              onMouseEnter={() => {
                setActive(i);
                if (entry.items && !entry.disabled) openSub(i, false);
                else setSub(null);
              }}
              onClick={() => pick(i)}
              className={cn(
                "flex items-center gap-2 w-full h-6 px-2 rounded-[5px] text-left text-[12px] leading-4 cursor-default",
                entry.disabled ? "text-white/35" : active === i || sub?.index === i ? "bg-[#0d99ff] text-white" : "text-white"
              )}
            >
              {hasChecks && <span className="flex w-4 shrink-0 -ml-1">{entry.checked && <FigmaIcon name="16.check" />}</span>}
              {hasIcons && <span className="flex w-4 h-4 shrink-0 items-center justify-center overflow-hidden text-white/90">{entry.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.hint && <span className={cn("max-w-[45%] shrink-0 truncate", active === i && !entry.disabled ? "text-white/80" : "text-white/45")}>{entry.hint}</span>}
              {entry.shortcut && <span className={cn("shrink-0 pl-4 tabular-nums", active === i && !entry.disabled ? "text-white/80" : "text-white/45")}>{entry.shortcut}</span>}
              {entry.items && <FigmaIcon name="16.chevron.down" className="-mr-1 shrink-0 -rotate-90" />}
            </button>
          )
        )}
      </div>
      {sub && (() => {
        const entry = list[sub.index];
        if (!entry || entry === "-" || !entry.items) return null;
        return (
          <MenuPanel
            key={sub.index}
            entries={entry.items}
            x={sub.x}
            y={sub.y}
            flipX={sub.flipX}
            autoFocus={sub.focus}
            onClose={onClose}
            onBack={() => {
              setSub(null);
              panel.current?.focus({ preventScroll: true });
            }}
          />
        );
      })()}
    </>
  );
}

/**
 * The menu, at the pointer (`at`, in the screen's pixels) — drawn over
 * everything (in the page's body), closing on a pick, a press outside it,
 * the wheel, Esc or the window losing focus.
 */
export function ContextMenu({ at, entries, onClose }: { at: { x: number; y: number }; entries: MenuEntry[]; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Scrolled by hand (the wheel), not by the editor bringing the new selection into view.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("wheel", outside, { capture: true, passive: true });
    document.addEventListener("keydown", escape, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("wheel", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={root}>
      <MenuPanel entries={entries} x={at.x} y={at.y} autoFocus onClose={onClose} />
    </div>,
    document.body
  );
}
