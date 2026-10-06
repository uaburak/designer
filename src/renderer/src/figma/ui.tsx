import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FigmaIcon, fi, type FigmaIconName } from "@/components/admin/figmaIcons";
import type { MenuItem } from "./popover";
import { ContextMenu, type MenuEntry } from "@/components/admin/ContextMenu";

/**
 * Figma's UI3 pieces, at the kit's measures (UI3: Figma's UI Kit): 11px /
 * 16px Inter — 450 for text, 550 for strong — 24px fields and icon buttons
 * in 32px rows, 40px section headers, 16px in from the left and 12px from the
 * right, 5px corners; fields on the secondary background.
 */

/** A section: its 40px header (title, then icons at the right) and its rows; a line under it. */
export function Section({ title, strong = true, muted = false, icons, pb = 8, children }: { title: string; strong?: boolean; muted?: boolean; icons?: ReactNode; pb?: 8 | 12 | 0; children?: ReactNode }) {
  return (
    <section className={cn("flex flex-col border-b border-[var(--f-border)]", pb === 12 ? "pb-3" : pb === 8 ? "pb-2" : "")}>
      <div className="flex items-center gap-1 h-10 pl-4 pr-3">
        <span className={cn("flex-1 min-w-0 truncate text-[11px] leading-4 tracking-[0.055px] select-none", strong ? "font-[550]" : "font-[450]", muted ? "text-[var(--f-text-secondary)]" : "text-[var(--f-text)]")}>{title}</span>
        <span className="f-icons flex items-center gap-1">{icons}</span>
      </div>
      {children}
    </section>
  );
}

/** A property row: 32px, its fields side by side (8px apart), the row's icons at its end. */
export function PropRow({ children, icons, className }: { children: ReactNode; icons?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2 pl-4 pr-3 py-1", className)}>
      <div className="flex flex-1 min-w-0 items-center gap-2">{children}</div>
      {icons && <div className="f-icons flex shrink-0 items-center gap-1">{icons}</div>}
    </div>
  );
}

/** A 24px icon button, as the kit's: the glyph, a 5px corner, the secondary background on hover; pressed, the selected blue. */
export function IconButton({ label, icon, active = false, disabled = false, onClick, className }: { label: string; icon: ReactNode; active?: boolean; disabled?: boolean; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center justify-center w-6 h-6 rounded-[5px] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default",
        active ? "bg-[var(--f-bg-selected)] text-[var(--f-text-brand)]" : "text-[var(--f-icon)] hover:bg-[var(--f-bg-secondary)]",
        className
      )}
    >
      {icon}
    </button>
  );
}

/** A 24px icon of the kit, as a button's glyph. */
export const icon24 = (name: FigmaIconName) => <FigmaIcon name={name} />;
/** A 16px icon of the kit. */
export const icon16 = (name: FigmaIconName) => <FigmaIcon name={name} />;

/** A field's 24px prefix: a letter (W, H, X, Y) in the secondary colour, or an icon. */
export function Prefix({ children }: { children: ReactNode }) {
  return <span className="flex shrink-0 items-center justify-center w-6 h-6 text-[11px] font-[450] text-[var(--f-text-secondary)] select-none">{children}</span>;
}

const FIELD = "group/field flex items-center h-6 min-w-0 rounded-[5px] bg-[var(--f-bg-secondary)] border border-transparent [&:hover:not(:focus-within)]:border-[var(--f-border)] focus-within:border-[var(--f-border-selected)] transition-colors";
/** A dropdown as Figma draws a component's: no fill, a hairline round it. */
export const FIELD_OUTLINED = "group/field flex items-center h-6 min-w-0 rounded-[5px] bg-transparent border border-[var(--f-border)] [&:hover:not(:focus-within)]:border-[var(--f-icon-tertiary)] focus-within:border-[var(--f-border-selected)] transition-colors";

/**
 * As Figma's fields: a click on an unfocused field selects everything in it,
 * so what is typed replaces the value (the browser would otherwise drop the
 * selection on mouseup and leave the caret where the click landed).
 */
export const selectAllOnClick = {
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select(),
  onPointerDown: (e: React.PointerEvent<HTMLInputElement>) => {
    if (document.activeElement !== e.currentTarget) e.currentTarget.dataset.selecting = "";
  },
  onMouseUp: (e: React.MouseEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if ("selecting" in el.dataset) {
      delete el.dataset.selecting;
      e.preventDefault();
      el.select();
    }
  },
};

/**
 * Figma's numeric input: its prefix, then the number — typed (Enter / leaving
 * the field keeps it, Esc drops it), stepped with ↑ ↓ (⇧: by 10), scrubbed by
 * dragging the prefix. `suffix` sits at its end (a unit, a sizing menu).
 */
export function NumericInput({ label, prefix, value, min = -100000, max = 100000, unit, placeholder, fallback, onChange, onClear, suffix, disabled = false, className, onFocusChange }: {
  label: string;
  /** Focused / blurred (the canvas highlights what a padding or gap field edits) */
  onFocusChange?: (focused: boolean) => void;
  prefix: ReactNode;
  value: number | null;
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  fallback?: number;
  onChange: (value: number) => void;
  onClear?: () => void;
  suffix?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const base = value ?? fallback ?? 0;
  const [draft, setDraft] = useState<string | null>(null);
  const typing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // With a unit the number hugs it ("100%", "0°", as Figma writes them): the input is as wide as its digits, the rest of the field still focuses it.
  const shown = draft ?? (value === null ? placeholder ?? "" : String(value));
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n * 100) / 100));
  const finish = (raw?: string) => {
    if (!typing.current) return;
    typing.current = false;
    // A number, or arithmetic on numbers ("100+20", "48/2"), as Figma's fields take.
    const n = raw === undefined ? NaN : evaluate(raw);
    if (raw !== undefined && !raw.trim() && value !== null) onClear?.();
    else if (raw?.trim() && Number.isFinite(n) && clamp(n) !== value) onChange(clamp(n));
    setDraft(null);
  };
  const scrub = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    // Scrubbing the icon edits the value as typing would: the canvas shows what it edits meanwhile.
    onFocusChange?.(true);
    const startX = e.clientX;
    let last = value;
    const move = (ev: PointerEvent) => {
      const next = clamp(base + Math.round((ev.clientX - startX) / 4));
      if (next !== last) { last = next; onChange(next); }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onFocusChange?.(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className={cn(FIELD, "flex-1", disabled && "opacity-50", className)}>
      <span onPointerDown={scrub} className="flex shrink-0 cursor-ew-resize">{typeof prefix === "string" ? <Prefix>{prefix}</Prefix> : prefix}</span>
      <input
        ref={input}
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? (value === null ? "" : String(value))}
        placeholder={placeholder}
        style={unit ? { width: `${Math.max(1, shown.length) + 0.2}ch` } : undefined}
        {...selectAllOnClick}
        onChange={(e) => { typing.current = true; setDraft(e.target.value); }}
        onFocus={(e) => { selectAllOnClick.onFocus(e); onFocusChange?.(true); }}
        onBlur={(e) => { finish(e.currentTarget.value); onFocusChange?.(false); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(e.currentTarget.value);
          if (e.key === "Escape") finish();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const next = clamp(base + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
            if (next !== value) onChange(next);
            typing.current = false;
            setDraft(null);
          }
        }}
        className={cn("min-w-0 h-full bg-transparent text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)] outline-none tabular-nums", !unit && "flex-1")}
      />
      {unit && (
        <>
          <span className="shrink-0 text-[11px] text-[var(--f-text)] select-none">{unit}</span>
          <span className="flex-1 h-full min-w-1 cursor-text" onPointerDown={(e) => { e.preventDefault(); input.current?.focus(); input.current?.select(); }} />
        </>
      )}
      {suffix}
    </div>
  );
}

/**
 * Figma's toggle: a boolean property's value — a 28 × 16 track, an oval
 * knob. On: the brand blue under a white knob at the right. Off: a grey fill
 * and outline under the knob (at the left); the knob, the innermost, always
 * white. Drawn by EDITOR_CSS ([data-switch]), not by classes: the editor's
 * own CSS is always current, a dev server's generated classes can lag.
 */
export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} data-switch="" data-motion="" onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

/**
 * A field's number: plain ("12", "1,5") or arithmetic on numbers — + − × ÷
 * and parentheses ("100+20", "(48-8)/2") — NaN for anything else (it is
 * dropped). Parsed by hand: nothing typed is ever run as code.
 */
export function evaluate(raw: string): number {
  const src = raw.replace(/,/g, ".").replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  if (!src || !/^[0-9.+\-*/()]+$/.test(src)) return NaN;
  let at = 0;
  const peek = () => src[at];
  const number = (): number => {
    if (peek() === "(") {
      at++;
      const v = sum();
      if (peek() !== ")") return NaN;
      at++;
      return v;
    }
    if (peek() === "-") { at++; return -number(); }
    if (peek() === "+") { at++; return number(); }
    const m = /^\d*\.?\d+|^\d+\.?/.exec(src.slice(at));
    if (!m) return NaN;
    at += m[0].length;
    return Number(m[0]);
  };
  const product = (): number => {
    let v = number();
    while (peek() === "*" || peek() === "/") {
      const op = src[at++];
      const r = number();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = src[at++];
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return at === src.length && Number.isFinite(v) ? v : NaN;
}

/** A one-line text field in the kit's box. Enter or leaving it keeps what was typed (if anything was); Esc puts it back. */
export function TextInput({ label, value, placeholder, prefix, onChange, onCommit, className, autoFocus = false }: { label: string; value: string; placeholder?: string; prefix?: ReactNode; onChange?: (value: string) => void; onCommit?: (value: string) => void; className?: string; autoFocus?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <div className={cn(FIELD, "flex-1", className)}>
      {prefix}
      <input
        aria-label={label}
        autoFocus={autoFocus}
        value={draft ?? value}
        placeholder={placeholder}
        {...selectAllOnClick}
        onChange={(e) => { if (onCommit) setDraft(e.target.value); else onChange?.(e.target.value); }}
        onBlur={(e) => {
          const typed = e.currentTarget.value;
          const keep = onCommit && draft !== null && !cancelled.current && typed !== value;
          cancelled.current = false;
          setDraft(null);
          if (keep) onCommit(typed);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") { cancelled.current = true; setDraft(null); (e.currentTarget as HTMLInputElement).blur(); }
        }}
        className={cn("w-0 min-w-0 flex-1 h-full truncate bg-transparent text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)] outline-none", !prefix && "pl-2")}
      />
    </div>
  );
}

/** A dropdown in the kit's box: its value and a chevron, the system's own menu under it. */
export function Select({ label, value, options, onChange, prefix, className, outlined = false }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; prefix?: ReactNode; className?: string; /** A hairline round it, no fill (a component's properties) */ outlined?: boolean }) {
  return (
    <div className={cn(outlined ? FIELD_OUTLINED : FIELD, "relative flex-1", className)}>
      {prefix}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={cn("w-full h-full pr-6 appearance-none bg-transparent text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text)] outline-none cursor-pointer", prefix ? "pl-0" : "pl-2")}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <FigmaIcon name="16.chevron.down" className="pointer-events-none absolute right-1 text-[var(--f-icon-secondary)]" />
    </div>
  );
}

/** A value with a menu under a chevron (a field's sizing, the zoom…). */
/** A chevron menu's entry: as the context menu's, or the old field menu's (`divided` draws a line before it). */
export type ChevronItem = (MenuItem & { icon?: ReactNode; shortcut?: string }) | MenuEntry;

export function ChevronMenu({ label, items, width, children, className, hover = false }: { label: string; items: ChevronItem[]; width?: number; children?: ReactNode; className?: string; /** The chevron only while the field is hovered (Figma's sizing fields) */ hover?: boolean }) {
  void width;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const entries: MenuEntry[] = items.flatMap((item): MenuEntry[] => (item === "-" ? ["-"] : "divided" in item && item.divided ? ["-", item] : [item]));
  return (
    <div className={cn("relative flex shrink-0 items-center", className)}>
      <button type="button" aria-haspopup="menu" aria-expanded={Boolean(at)} aria-label={label} title={label} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.bottom + 4 }); }} className="flex items-center gap-0.5 h-6 pl-1 pr-0.5 rounded-[5px] text-[11px] text-[var(--f-text)] hover:bg-[var(--f-bg-hover)] cursor-pointer">
        {hover ? (
          // Figma's sizing field: "Fill" / "Hug" sits where the chevron goes; hovering the field (or the open menu) swaps in the chevron.
          <span className="relative flex min-w-4 items-center justify-end">
            <span className={cn("pr-[3px]", at ? "opacity-0" : "group-hover/field:opacity-0")}>{children}</span>
            <FigmaIcon name="16.chevron.down" className={cn("absolute right-0 text-[var(--f-icon-secondary)]", !at && "opacity-0 group-hover/field:opacity-100")} />
          </span>
        ) : (
          <>
            {children}
            <FigmaIcon name="16.chevron.down" className="text-[var(--f-icon-secondary)]" />
          </>
        )}
      </button>
      {at && <ContextMenu at={at} entries={entries} onClose={() => setAt(null)} />}
    </div>
  );
}

/** The kit's checkbox: a 16px box on the secondary background, the check when on. */
export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 h-6 cursor-pointer select-none">
      <span className="relative flex w-4 h-4 shrink-0 items-center justify-center rounded-[5px] bg-[var(--f-bg-secondary)] text-[var(--f-text)]">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="absolute inset-0 opacity-0 cursor-pointer" />
        {checked && fi("16.check")}
      </span>
      <span className="text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text)]">{label}</span>
    </label>
  );
}

/** Figma's tab (Design / Prototype, File / Assets): 24px, strong on the secondary background while shown. */
export function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={cn("h-6 px-2 rounded-[5px] text-[11px] leading-4 tracking-[0.055px] cursor-pointer", active ? "font-[550] text-[var(--f-text)] bg-[var(--f-bg-secondary)]" : "font-[450] text-[var(--f-text-secondary)] hover:text-[var(--f-text)]")}>
      {label}
    </button>
  );
}

/** The 14px colour chit in a colour field, with its translucent border. */
export function Chit({ color, className }: { color: string; className?: string }) {
  return (
    <span className={cn("flex w-6 h-6 shrink-0 items-center justify-center", className)}>
      <span className="w-3.5 h-3.5 rounded-[2px] border border-[var(--f-border-translucent)]" style={{ background: color }} />
    </span>
  );
}

/** A hex colour's 6 digits, upper case, without "#". */
export const hexDigits = (color: string) => color.replace("#", "").slice(0, 8).toUpperCase();

/**
 * Figma's colour input: the chit, the hex, and — parted by a line — the
 * opacity with its "%". The hex is a text field; the chit opens the
 * system's colour picker.
 */
export function ColorInput({ label, color, opacity, onColor, onOpacity, chit, className }: { label: string; color: string; opacity: number; onColor: (hex: string) => void; onOpacity?: (opacity: number) => void; chit?: ReactNode; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  // What was typed, when it is a colour other than the field's (leaving it untouched changes nothing — an alias stays an alias); Esc puts it back.
  const commit = (raw: string) => {
    const typed = draft !== null && !cancelled.current;
    cancelled.current = false;
    setDraft(null);
    if (!typed) return;
    const digits = raw.trim().replace("#", "");
    const hex = /^[0-9a-f]{6}$/i.test(digits) ? `#${digits.toLowerCase()}` : /^[0-9a-f]{3}$/i.test(digits) ? `#${digits.split("").map((c) => c + c).join("").toLowerCase()}` : null;
    if (hex && hex !== color.toLowerCase()) onColor(hex);
  };
  const valid = /^#[0-9a-f]{6}$/i.test(color);
  return (
    <div className={cn(FIELD, "flex-1", className)}>
      {chit ?? (
        <label className="relative cursor-pointer">
          <Chit color={color} />
          <input type="color" aria-label="Pick color" value={valid ? color : "#000000"} onChange={(e) => onColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
        </label>
      )}
      <input
        aria-label={label}
        value={draft ?? hexDigits(color)}
        {...selectAllOnClick}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); if (e.key === "Escape") { cancelled.current = true; setDraft(null); (e.currentTarget as HTMLInputElement).blur(); } }}
        className="w-0 min-w-0 flex-1 h-full bg-transparent text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text)] outline-none uppercase"
      />
      {onOpacity && (
        <span className="flex w-[53px] h-full shrink-0 items-center border-l border-[var(--f-bg)]">
          <NumericInput label="Opacity" prefix={<span className="w-[7px]" />} value={opacity} min={0} max={100} unit="%" onChange={onOpacity} className="bg-transparent border-0 hover:border-0 flex-1 rounded-none" />
        </span>
      )}
    </div>
  );
}

/** Figma's 40px collapsible header (Pages, Layers): its chevron and label, its icons at the right. */
export function CollapseHeader({ label, open, onToggle, icons }: { label: string; open?: boolean; onToggle?: () => void; icons?: ReactNode }) {
  return (
    <div className="flex items-center justify-between h-10 pr-3 py-1">
      <button type="button" onClick={onToggle} className="flex flex-1 min-w-0 items-center pr-2 cursor-pointer">
        <span className={cn("flex w-4 h-4 shrink-0 items-center justify-center text-[var(--f-icon-secondary)] transition-transform", open === false && "-rotate-90")}>{open === undefined ? null : fi("16.chevron.down")}</span>
        <span className={cn("truncate text-[11px] font-[550] leading-4 tracking-[0.055px] text-[var(--f-text)]", open === undefined && "pl-4")}>{label}</span>
      </button>
      {icons && <div className="flex items-center gap-2 h-6">{icons}</div>}
    </div>
  );
}

/** Figma's blue button (Share → Save): 32px, 12px in, 5px corners. */
export function BrandButton({ children, disabled, onClick, className, title }: { children: ReactNode; disabled?: boolean; onClick?: () => void; className?: string; title?: string }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} title={title} className={cn("flex items-center h-8 px-3 rounded-[5px] bg-[var(--f-bg-brand)] text-[11px] font-[450] leading-4 tracking-[0.055px] text-white hover:brightness-105 cursor-pointer disabled:opacity-70 disabled:cursor-default", className)}>
      {children}
    </button>
  );
}

/**
 * The editor's own CSS, rendered once by it: Figma's tooltips — a button's
 * label under it after a beat (`data-tip`); in an icon column (`.f-icons`)
 * they hang from the right edge — and a grid frame's cells, shown while it
 * is selected.
 */
export const EDITOR_CSS = `
/* The Page Editor's scrollbar: in sight only while the pointer is over the canvas (or it is dragged), gone the moment it leaves — no fade. */
[data-page-scrollbar] { opacity: 0; }
[data-figma-canvas]:hover [data-page-scrollbar], [data-page-scrollbar][data-dragging] { opacity: 0.5; }
[data-figma-canvas] [data-page-scrollbar]:hover, [data-page-scrollbar][data-dragging] { opacity: 1; }
[data-grid-cells] { opacity: 0; }
[data-layer-selected] > [data-grid-cells] { opacity: 1; }
[data-tip] { position: relative; }
[data-tip]::after {
  content: attr(data-tip); white-space: nowrap;
  position: absolute; left: 50%; top: calc(100% + 6px); transform: translateX(-50%);
  padding: 4px 8px; border-radius: 5px; background: #1e1e1e; color: #fff;
  font-size: 11px; line-height: 16px; font-weight: 400; letter-spacing: 0.055px;
  pointer-events: none; display: none; z-index: 60;
}
/* Shown only while hovered (a hidden tooltip past the panel's edge would still make it scroll sideways); it fades in after a beat. */
[data-tip]:hover::after { display: block; animation: f-tip 0s 0.5s both; }
@keyframes f-tip { from { opacity: 0; } to { opacity: 1; } }
[data-tip-key]::after { content: attr(data-tip) "   " attr(data-tip-key); white-space: pre; }
.f-icons [data-tip]::after { left: auto; right: 0; transform: none; }
/* The toggle (see Switch): its track, its knob, hovered, on. */
[data-switch] { position: relative; flex-shrink: 0; width: 28px; height: 16px; box-sizing: border-box; padding: 0; border-radius: 9999px; border: 1px solid var(--f-icon-tertiary); background: var(--f-bg-tertiary); cursor: pointer; }
[data-switch]:hover { background: var(--f-bg-toggle-hover); }
[data-switch] > span { position: absolute; top: 50%; left: 2px; width: 14px; height: 10px; box-sizing: border-box; transform: translateY(-50%); border-radius: 9999px; border: 1px solid var(--f-icon-tertiary); background: #fff; }
[data-switch][aria-checked="true"], [data-switch][aria-checked="true"]:hover { background: var(--f-bg-brand); border-color: var(--f-bg-brand); }
[data-switch][aria-checked="true"] > span { left: 10px; border-color: #fff; }
/* The one thing in them that moves: a toggle's knob slides and its colours fade (150ms). */
[data-instant] [data-motion], [data-instant] [data-motion] * { transition: background-color 150ms ease, border-color 150ms ease, left 150ms ease !important; }
/* At the sidebar's left edge: from the button's left, not centred (it would go under the navigation bar). */
.f-tip-start [data-tip]::after { left: 0; transform: none; }
/* The editor's panels (navigation, sidebars, toolbar, menus, windows): hovers, toggles and selections change at once — no transitions, as Figma's. */
[data-instant], [data-instant] * { transition: none !important; }
/* The navigation bar's tabs (icons only): their names to the right of them, as Figma's. */
.f-nav [data-tip]::after { left: calc(100% + 2px); top: 50%; transform: translateY(-50%); }
`;
