
import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Segmented } from "@/components/Segmented";
import type { BadgeItem } from "@/figma/embeds/types";
import { CodeHighlight } from "@/components/CodeHighlight";
import { cn } from "@/lib/utils";

type ZoomableImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  badges?: BadgeItem[];
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  getStartRect?: () => DOMRect | null;
};

function getEmbedUrl(src: string): string | null {
  const ytMatch = src.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;
  const vimeoMatch = src.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  if (src.endsWith(".mp4") || src.endsWith(".webm")) return src;
  return null;
}

function ZoomTabContent({ tab2 }: { tab2: NonNullable<BadgeItem["tab2"]> }) {
  if (tab2.type === "image") {
    return tab2.src ? (
      <img src={tab2.src} alt="" className="w-full h-full object-cover select-none pointer-events-none" />
    ) : (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-subtitle)] opacity-40 select-none">
        Görsel URL girilmedi
      </div>
    );
  }
  if (tab2.type === "video") {
    const url = tab2.src ? getEmbedUrl(tab2.src) : null;
    const isRaw = tab2.src?.endsWith(".mp4") || tab2.src?.endsWith(".webm");
    return url ? (
      isRaw ? (
        <video src={url} controls className="w-full h-full object-cover" />
      ) : (
        <iframe src={url} className="w-full h-full" allowFullScreen title="Video" />
      )
    ) : (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-subtitle)] opacity-40 select-none">
        Video URL girilmedi
      </div>
    );
  }
  if (tab2.type === "code") {
    return (
      <div className="bg-[var(--bg-2)] w-full h-full overflow-auto">
        <CodeHighlight code={tab2.content?.trim() || "// kod girilmedi"} language={tab2.language || "javascript"} />
      </div>
    );
  }
  if (tab2.type === "text") {
    return (
      <div className="p-5 sm:p-6 overflow-auto w-full h-full bg-[var(--bg-2)]">
        <p className="text-base font-light leading-7 text-[var(--text-p)] whitespace-pre-wrap">
          {tab2.content?.trim() || "Metin girilmedi"}
        </p>
      </div>
    );
  }
  return null;
}

export function ZoomableImage({ src, alt, className, style, badges, activeTab, onTabChange, getStartRect, ...props }: ZoomableImageProps) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [originalRect, setOriginalRect] = useState<DOMRect | null>(null);
  const [targetRect, setTargetRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [originalBorderRadius, setOriginalBorderRadius] = useState<string>("0px");
  const [localActiveTab, setLocalActiveTab] = useState(activeTab || "");
  const [prevActiveTab, setPrevActiveTab] = useState(activeTab || "");

  const normalizedActiveTab = activeTab || "";
  if (normalizedActiveTab !== prevActiveTab) {
    setPrevActiveTab(normalizedActiveTab);
    setLocalActiveTab(normalizedActiveTab);
  }

  const originalImgRef = useRef<HTMLImageElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Directly check window to avoid setting state in useEffect on mount (prevents linter errors)
  const portalContainer = typeof window !== "undefined" ? document.body : null;

  // Segmented badge configurations
  const segBadge = badges?.find((b) => b.icon === "segmented");
  const tab1Label = segBadge?.tab1Label ?? "Project";
  const tab2Label = segBadge?.tab2Label ?? "Code";
  const tab2 = segBadge?.tab2;
  const isTab2 = segBadge && localActiveTab === tab2Label;

  // Calculate coordinates to center and fit the image within the viewport (limited to 85%)
  const calculateTargetRect = useCallback((naturalW: number, naturalH: number) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < 640;
    const maxW = isMobile ? vw - 16 : vw * 0.80;
    const maxH = isMobile ? vh * 0.85 : vh * 0.80;
    const imageRatio = naturalW / naturalH;
    const targetRatio = maxW / maxH;

    let targetWidth = maxW;
    let targetHeight = maxH;

    if (imageRatio > targetRatio) {
      // Image is wider than viewport ratio limit
      targetWidth = maxW;
      targetHeight = maxW / imageRatio;
    } else {
      // Image is taller than viewport ratio limit
      targetHeight = maxH;
      targetWidth = maxH * imageRatio;
    }

    return {
      left: (vw - targetWidth) / 2,
      top: (vh - targetHeight) / 2,
      width: targetWidth,
      height: targetHeight,
    };
  }, []);

  const handleZoom = (e: React.MouseEvent<HTMLImageElement> | React.KeyboardEvent<HTMLImageElement>) => {
    if (isZoomed) return;

    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }

    const img = e.currentTarget;
    const customRect = getStartRect?.();
    const rect = (customRect && customRect.width > 0 && customRect.height > 0)
      ? customRect
      : img.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(img);
    const parentStyle = img.parentElement ? window.getComputedStyle(img.parentElement) : null;

    // Detect if parent container has overflow: hidden and has border-radius
    const borderRadius = customRect
      ? "16px"
      : (parentStyle?.overflow === "hidden" ? parentStyle.borderRadius : computedStyle.borderRadius);

    setOriginalRect(rect);
    setOriginalBorderRadius(borderRadius || "0px");
    setLocalActiveTab(activeTab || tab1Label);

    const target = calculateTargetRect(img.naturalWidth || rect.width, img.naturalHeight || rect.height);
    setTargetRect(target);
    setIsZoomed(true);
  };

  const handleClose = useCallback(() => {
    if (!isZoomed || !originalImgRef.current) return;

    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
    }

    // Recalculate original position in case it shifted slightly (e.g. dynamic layout shifts)
    const currentRect = originalImgRef.current.getBoundingClientRect();
    setOriginalRect(currentRect);

    setIsExpanded(false);

    // Unmount portal after the 400ms transition completes
    closeTimeoutRef.current = setTimeout(() => {
      setIsZoomed(false);
      setOriginalRect(null);
      setTargetRect(null);
      onTabChange?.(localActiveTab);
      closeTimeoutRef.current = null;
      // The focus back where it was: on the picture opened.
      originalImgRef.current?.focus({ preventScroll: true });
    }, 400);
  }, [isZoomed, localActiveTab, onTabChange]);

  // Lock background scrolling while zoomed without modifying body layout/padding
  useEffect(() => {
    if (!isZoomed) return;

    // Pause Lenis smooth scroll so background page cannot scroll at all
    const lenis = window.__lenis;
    if (lenis && typeof lenis.stop === "function") {
      lenis.stop();
    }

    const preventScroll = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-lenis-prevent]")) {
        return; // Allow wheel/touchpad scrolling inside zoomed container!
      }
      e.preventDefault();
    };

    window.addEventListener("wheel", preventScroll, { passive: false });
    window.addEventListener("touchmove", preventScroll, { passive: false });

    return () => {
      if (lenis && typeof lenis.start === "function") {
        lenis.start();
      }
      window.removeEventListener("wheel", preventScroll);
      window.removeEventListener("touchmove", preventScroll);
    };
  }, [isZoomed]);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  // Trigger smooth expansion once portal mounts
  useEffect(() => {
    if (isZoomed && targetRect) {
      const raf = requestAnimationFrame(() => {
        setIsExpanded(true);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [isZoomed, targetRect]);

  // Close on Escape key press
  useEffect(() => {
    if (!isZoomed) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isZoomed, handleClose]);

  // Handle browser resize during zoom
  useEffect(() => {
    if (!isZoomed || !originalImgRef.current) return;

    const handleResize = () => {
      const img = originalImgRef.current;
      if (img) {
        const target = calculateTargetRect(img.naturalWidth || img.clientWidth, img.naturalHeight || img.clientHeight);
        setTargetRect(target);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isZoomed, calculateTargetRect]);

  return (
    <>
      {/* Original Image (Layout placeholder) */}
      <img
        ref={originalImgRef}
        src={src}
        alt={alt}
        className={`${className || ""} cursor-zoom-in`}
        style={{
          ...style,
          visibility: isZoomed ? "hidden" : "visible",
        }}
        onClick={handleZoom}
        // Opened from the keyboard too (Enter, Space), as a button is.
        tabIndex={0}
        role="button"
        aria-label={alt ? `${alt} — büyüt` : "Görseli büyüt"}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          handleZoom(e);
        }}
        {...props}
      />

      {/* Zoom Portal */}
      {isZoomed && portalContainer && originalRect && targetRect &&
        createPortal(
          <div role="dialog" aria-modal="true" aria-label={alt || "Görsel"}>
            {/* Backdrop with smooth fade in/out (white in light mode, black in dark mode) */}
            <div
              className="fixed inset-0 z-[9998] cursor-zoom-out"
              style={{
                backgroundColor: "var(--bg-1)",
                opacity: isExpanded ? 0.75 : 0,
                transition: "opacity 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)",
              }}
              onClick={handleClose}
            />

            {segBadge && (
              <div
                className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999]"
                style={{
                  opacity: isExpanded ? 1 : 0,
                  transition: "opacity 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)",
                  pointerEvents: isExpanded ? "auto" : "none",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <Segmented
                  options={[tab1Label, tab2Label]}
                  value={localActiveTab}
                  onChange={setLocalActiveTab}
                  size="md"
                />
              </div>
            )}

            {/* Cloned container and image performing the FLIP zoom animation */}
            <div
              data-lenis-prevent
              className={cn("fixed z-[9999] select-text overscroll-contain", isTab2 ? "cursor-default" : "cursor-zoom-out")}
              style={{
                left: isExpanded ? `${targetRect.left}px` : `${originalRect.left}px`,
                top: isExpanded ? `${targetRect.top}px` : `${originalRect.top}px`,
                width: isExpanded ? `${targetRect.width}px` : `${originalRect.width}px`,
                height: isExpanded ? `${targetRect.height}px` : `${originalRect.height}px`,
                borderRadius: isExpanded ? "32px" : originalBorderRadius,
                border: "1px solid var(--border)",
                overflow: "hidden",
                transition: "all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)",
              }}
              onClick={isTab2 ? (e) => e.stopPropagation() : handleClose}
            >
              {isTab2 && tab2 ? (
                <div className="w-full h-full bg-[var(--bg-2)] overflow-auto" onClick={(e) => e.stopPropagation()}>
                  <ZoomTabContent tab2={tab2} />
                </div>
              ) : (
                <img
                  src={src}
                  alt={alt}
                  className="w-full h-full object-cover select-none pointer-events-none"
                />
              )}
            </div>
            <button type="button" autoFocus onClick={handleClose} className="sr-only focus:not-sr-only fixed top-4 right-4 z-[10000] h-9 px-3 rounded-full bg-[var(--bg-1)] text-sm text-[var(--text-title)] border border-[var(--border)]">
              Kapat (Esc)
            </button>
          </div>,
          portalContainer
        )
      }
    </>
  );
}
