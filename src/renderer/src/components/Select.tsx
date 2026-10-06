import { useState, useRef, useEffect, ReactNode } from "react";
import { cn } from "@/lib/utils";

const sizeMap = {
  xs: "h-7  px-3      text-[12px] leading-5",
  sm: "h-8  px-3.5    text-[13px] leading-5",
  md: "h-10 px-4      text-[14px] leading-6",
  lg: "h-12 px-[18px] text-[16px] leading-6",
} as const;

type SizeVariant = "xs" | "sm" | "md" | "lg";

export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

interface SelectProps {
  options: (string | SelectOption)[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: SizeVariant;
  /** "section" (in white section: bg-white, hover bg-#f2f2f2 + border) | "block" (inside #f2f2f2 block: bg-white, hover stays bg-white + adds border) */
  bgContext?: "section" | "block";
  className?: string;
  disabled?: boolean;
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={cn(
        "flex-shrink-0 text-[var(--text-subtitle)] transition-transform duration-200",
        open && "rotate-180 text-[var(--text-title)]"
      )}
    >
      <path
        d="M2.5 4.5L6 8L9.5 4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M2.5 6L5 8.5L9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Select({
  options,
  value,
  onChange,
  placeholder = "Choose…",
  size = "md",
  bgContext = "section",
  className,
  disabled = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Normalize options to object format
  const normalizedOptions: SelectOption[] = options.map((opt) =>
    typeof opt === "string" ? { value: opt, label: opt } : opt
  );

  const selectedOption = normalizedOptions.find((opt) => opt.value === value);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={containerRef} className={cn("relative inline-block w-full select-none", className)}>
      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "w-full flex items-center justify-between gap-2 rounded-full text-[var(--text-p)] cursor-pointer transition-all duration-150 focus:outline-none",
          bgContext === "section"
            ? "border border-[var(--border)] bg-[var(--bg-1)] hover:bg-[var(--bg-4)] hover:border-[var(--border-hover)]"
            : "border border-transparent bg-[var(--bg-1)] hover:bg-[var(--bg-1)] hover:border-[var(--border-hover)]",
          open && "border-[var(--border-hover)] ring-2 ring-[var(--border)]/20",
          disabled && "opacity-50 cursor-not-allowed",
          sizeMap[size]
        )}
      >
        <span className="truncate flex items-center gap-2">
          {selectedOption?.icon && <span className="flex-shrink-0">{selectedOption.icon}</span>}
          <span className={cn(!selectedOption && "text-[var(--text-subtitle)]")}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </span>
        <ChevronDownIcon open={open} />
      </button>

      {/* Popover Menu (8px gap from select trigger) */}
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 max-h-60 overflow-y-auto rounded-[24px] border border-[var(--border)] bg-[var(--bg-2)] shadow-[0_16px_36px_rgba(0,0,0,0.18)] p-1.5 flex flex-col gap-1 animate-in fade-in zoom-in-95 duration-100">
          {normalizedOptions.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  "w-full h-7 px-3 flex items-center justify-between gap-2 rounded-full text-[12px] leading-5 font-medium transition-all duration-150 cursor-pointer text-left",
                  isSelected
                    ? "border border-[var(--border)] bg-[var(--bg-4)] text-[var(--text-title)] font-semibold"
                    : "border border-transparent bg-transparent text-[var(--text-p)] hover:bg-[var(--bg-4)] hover:text-[var(--text-title)]"
                )}
              >
                <span className="truncate flex items-center gap-2">
                  {opt.icon && <span className="flex-shrink-0">{opt.icon}</span>}
                  <span>{opt.label}</span>
                </span>
                {isSelected && (
                  <span className="text-[var(--text-title)] shrink-0">
                    <CheckIcon />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
