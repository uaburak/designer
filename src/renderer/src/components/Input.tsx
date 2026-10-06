import { InputHTMLAttributes, ReactNode, forwardRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared Input component with size variants matching Button / Segmented tokens:
 *  xs → 28px  (h-7)   px-3      text-[12px] leading-5
 *  sm → 32px  (h-8)   px-3.5    text-[13px] leading-5
 *  md → 40px  (h-10)  px-4      text-[14px] leading-6   ← default
 *  lg → 48px  (h-12)  px-[18px] text-[16px] leading-6
 */

const sizeMap = {
  xs: "h-7  px-3      text-[12px] leading-5",
  sm: "h-8  px-3.5    text-[13px] leading-5",
  md: "h-10 px-4      text-[14px] leading-6",
  lg: "h-12 px-[18px] text-[16px] leading-6",
} as const;

type SizeVariant = "xs" | "sm" | "md" | "lg";

// Omit native `size` attr (number) to avoid conflict with our string variant
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** xs=28px · sm=32px · md=40px · lg=48px */
  size?: SizeVariant;
  /** "section" (in white section: bg-white, hover bg-#f2f2f2 + border) | "block" (inside #f2f2f2 block: bg-white, hover stays bg-white + adds border) */
  bgContext?: "section" | "block";
  startContent?: ReactNode;
  endContent?: ReactNode;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ size = "md", bgContext = "section", startContent, endContent, wrapperClassName, className, ...props }, ref) => {
    const bgStyle =
      bgContext === "section"
        ? "border border-[var(--border)] bg-[var(--bg-1)] hover:bg-[var(--bg-4)] hover:border-[var(--border-hover)] focus-within:border-[var(--border-hover)]"
        : "border border-transparent bg-[var(--bg-1)] hover:bg-[var(--bg-1)] hover:border-[var(--border-hover)] focus-within:border-[var(--border-hover)]";

    if (startContent || endContent) {
      return (
        <div
          className={cn(
            "w-full rounded-full flex items-center gap-2.5 transition-all duration-150",
            bgStyle,
            sizeMap[size],
            wrapperClassName
          )}
        >
          {startContent && (
            <span className="flex-shrink-0 flex items-center text-[var(--text-subtitle)]">
              {startContent}
            </span>
          )}
          <input
            ref={ref}
            {...props}
            className={cn(
              "flex-1 min-w-0 bg-transparent border-none outline-none text-[var(--text-p)] placeholder:text-[var(--text-subtitle)] focus:outline-none",
              className
            )}
          />
          {endContent && (
            <span className="flex-shrink-0 flex items-center">
              {endContent}
            </span>
          )}
        </div>
      );
    }

    return (
      <input
        ref={ref}
        {...props}
        className={cn(
          "w-full rounded-full text-[var(--text-p)] placeholder:text-[var(--text-subtitle)]",
          "focus:outline-none focus:border-[var(--border-hover)] transition-all duration-150",
          bgStyle,
          sizeMap[size],
          className
        )}
      />
    );
  }
);

Input.displayName = "Input";
