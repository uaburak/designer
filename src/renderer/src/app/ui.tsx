import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CloseIcon } from "./icons";

/**
 * The shell's controls — the home's and the tab bar's — in Figma's desktop
 * look (UI3): 13px text, 32px buttons, the blue for what goes ahead, dark
 * menus (ContextMenu), modals on the page's own background.
 */

/** A button: `primary` the blue one, `secondary` outlined, `danger` red, `ghost` bare. */
export function Button({ children, kind = "secondary", size = "large", disabled, onClick, className, title, type = "button", autoFocus }: {
  children: ReactNode;
  kind?: "primary" | "secondary" | "danger" | "ghost";
  size?: "large" | "small";
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  title?: string;
  type?: "button" | "submit";
  autoFocus?: boolean;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 shrink-0 rounded-[6px] font-[500] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--f-border-selected)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--f-bg)] disabled:opacity-40 disabled:pointer-events-none",
        size === "large" ? "h-8 px-3 text-[13px] leading-5" : "h-6 px-2 text-[11px] leading-4",
        kind === "primary" && "bg-[var(--f-bg-brand)] text-white hover:brightness-110",
        kind === "secondary" && "border border-[var(--f-border)] text-[var(--f-text)] hover:bg-[var(--f-bg-hover)]",
        kind === "danger" && "bg-[#f24822] text-white hover:brightness-110",
        kind === "ghost" && "text-[var(--f-text)] hover:bg-[var(--f-bg-hover)]",
        className
      )}
    >
      {children}
    </button>
  );
}

/** A square button holding an icon, its name the tooltip. */
export function IconButton({ label, children, onClick, disabled, active, className }: { label: string; children: ReactNode; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; active?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn("flex items-center justify-center w-8 h-8 shrink-0 rounded-[6px] text-[var(--f-icon)] transition-colors hover:bg-[var(--f-bg-hover)] disabled:opacity-30 disabled:pointer-events-none", active && "bg-[var(--f-bg-secondary)]", className)}
    >
      {children}
    </button>
  );
}

/** A text field, as the home's: 32px, the field's grey, the blue ring when focused (`invalid`: red). */
export function TextField({ label, value, onChange, placeholder, invalid, mono, autoFocus, onEnter, hint }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  mono?: boolean;
  autoFocus?: boolean;
  onEnter?: () => void;
  hint?: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.select();
  }, [autoFocus]);
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="text-[11px] font-[500] leading-4 text-[var(--f-text-secondary)]">{label}</span>
      <input
        ref={ref}
        id={id}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
        className={cn(
          "h-8 px-2.5 rounded-[6px] bg-[var(--home-field)] border border-transparent text-[13px] leading-5 text-[var(--f-text)] placeholder:text-[var(--f-text-tertiary)] outline-none focus:border-[var(--f-border-selected)]",
          mono && "font-mono text-[12px]",
          invalid && "border-[#f24822] focus:border-[#f24822]"
        )}
      />
      {hint && <span className={cn("text-[11px] leading-4", invalid ? "text-[#f24822]" : "text-[var(--f-text-secondary)]")}>{hint}</span>}
    </label>
  );
}

/** A modal over the whole window (the tabs too): a title with ×, what it says, its buttons at the bottom right. Esc and the × close it. */
export function Modal({ title, children, footer, onClose, width = 400 }: { title: string; children?: ReactNode; footer?: ReactNode; onClose: () => void; width?: number }) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 select-none" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex flex-col max-h-[calc(100vh-80px)] rounded-[13px] bg-[var(--f-bg)] text-[var(--f-text)] shadow-[0_0_0.5px_rgba(0,0,0,0.15),0_5px_12px_rgba(0,0,0,0.13),0_1px_3px_rgba(0,0,0,0.1),0_20px_60px_rgba(0,0,0,0.25)]" style={{ width }}>
        <div className="flex items-center justify-between h-12 pl-4 pr-2 border-b border-[var(--f-border)] shrink-0">
          <h2 className="text-[13px] font-[600] leading-5 tracking-[-0.0325px]">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        {children && <div className="flex flex-col gap-4 p-4 text-[13px] leading-5 overflow-auto select-text">{children}</div>}
        {footer && <div className="flex items-center justify-end gap-2 px-4 pb-4 pt-0 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

/** Figma's spinner: a ring with a turning arc. */
export function Spinner({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Loading" className={cn("animate-spin text-[var(--f-icon-secondary)]", className)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
