import React from "react";
import ScrollReveal from "@/components/ScrollReveal";

interface FooterProps {
  children?: React.ReactNode;
  onMouseLeave?: () => void;
  className?: string;
}

export function Footer({ children, onMouseLeave, className = "" }: FooterProps) {
  return (
    <footer
      className={`flex flex-col gap-6 items-start pt-16 w-full ${className}`}
      onMouseLeave={onMouseLeave}
    >
      <ScrollReveal className="w-full">
        <div className="w-full h-px bg-[var(--border)]" />
      </ScrollReveal>
      {children && <div className="relative flex items-center w-full">{children}</div>}
    </footer>
  );
}
