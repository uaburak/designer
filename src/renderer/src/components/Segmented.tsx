import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

/**
 * Size variants — container height:
 *  xs → 28px   inner pill py-[2px]  text-[12px]
 *  sm → 32px   inner pill py-[4px]  text-[13px]
 *  md → 40px   inner pill py-[8px]  text-[14px]   ← default
 *  lg → 48px   inner pill py-[12px] text-[15px]
 */

const containerSizeMap = {
  xs: "h-7  p-[3px]",
  sm: "h-8  p-[3px]",
  md: "h-10 p-[4px]",
  lg: "h-12 p-[4px]",
} as const;

const btnSizeMap = {
  xs: "px-2.5 text-[12px] leading-5",
  sm: "px-3   text-[13px] leading-5",
  md: "px-3   text-[14px] leading-5",
  lg: "px-4   text-[15px] leading-5",
} as const;

interface SegmentedProps {
  options: string[];
  /** Controlled value — if provided, component acts as controlled */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** xs=28px · sm=32px · md=40px · lg=48px */
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}

export function Segmented({
  options,
  value: controlledValue,
  defaultValue,
  onChange,
  size = "md",
  className,
}: SegmentedProps) {
  const isControlled = controlledValue !== undefined;
  const [internalActive, setInternalActive] = useState(
    defaultValue ?? options[0]
  );
  const active = isControlled ? controlledValue : internalActive;

  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 3, width: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLButtonElement>(
      `[data-value="${active}"]`
    );
    if (!activeEl) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = activeEl.getBoundingClientRect();
    setIndicatorStyle({
      left: elRect.left - containerRect.left,
      width: elRect.width,
    });
  }, [active]);

  const handleSelect = (val: string) => {
    if (!isControlled) setInternalActive(val);
    onChange?.(val);
  };

  return (
    <div
      ref={containerRef}
      role="tablist"
      className={cn(
        "relative flex items-center rounded-full border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden",
        containerSizeMap[size],
        className
      )}
    >
      {/* Sliding indicator */}
      <span
        aria-hidden
        className="absolute top-[3px] bottom-[3px] rounded-full bg-[var(--bg-4)] transition-all duration-200 ease-in-out pointer-events-none"
        style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
      />

      {options.map((opt) => (
        <button
          key={opt}
          role="tab"
          data-value={opt}
          aria-selected={active === opt}
          onClick={() => handleSelect(opt)}
          className={cn(
            "relative z-10 flex items-center rounded-full font-[500] whitespace-nowrap cursor-pointer transition-colors duration-200",
            btnSizeMap[size],
            active === opt
              ? "text-[var(--text-p)]"
              : "text-[var(--text-subtitle)]"
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
