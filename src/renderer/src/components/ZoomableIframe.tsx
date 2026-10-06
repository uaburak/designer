import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ScrollReveal from "@/components/ScrollReveal";
import { Segmented } from "@/components/Segmented";
import { IconButton } from "@/components/Button";

interface ZoomableIframeProps {
  src?: string;
  iframeTabletUrl?: string;
  iframeMobileUrl?: string;
  iframeViews?: ("desktop" | "tablet" | "mobile")[];
  iframeCover?: string;
  caption?: string;
  lang?: "tr" | "en";
  /** Scroll reveal; off in the admin preview, whose panel scrolls independently of the window */
  animate?: boolean;
}

type DeviceMode = "desktop" | "tablet" | "mobile";

// DevTools Inspect Mode Virtual Viewport Dimensions
const getVirtualDimensions = (mode: DeviceMode) => {
  if (mode === "mobile") return { width: 402, height: 756 };
  if (mode === "tablet") return { width: 834, height: 1194 };
  return { width: 1920, height: 1080 }; // Desktop 1920x1080
};

// Scaled iFrame component emulating Chrome DevTools Inspect Mode scaling with ZERO scrollbars
function ScaledIframe({
  src,
  activeMode,
  caption,
  scrollable = false,
}: {
  src?: string;
  activeMode: DeviceMode;
  caption?: string;
  /** true = focus/lightbox mode (scroll works, no scrollbar). false = inline preview (no scroll, no interaction) */
  scrollable?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const virtual = getVirtualDimensions(activeMode);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateScale = () => {
      const currentWidth = el.clientWidth;
      if (currentWidth > 0) {
        const s = currentWidth / virtual.width;
        setScale(s);
      }
    };

    updateScale();
    const ro = new ResizeObserver(updateScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, [virtual.width]);

  // Extra px to push native scrollbar outside the visible overflow:hidden area
  const scrollbarClip = 20;

  return (
    <div ref={containerRef} className="flex-1 w-full h-full bg-[var(--bg-2)] relative overflow-hidden">
      <div
        className="absolute top-0 left-0 border-none overflow-hidden"
        style={{
          width: `${virtual.width + scrollbarClip}px`,
          height: `${scale > 0 ? 100 / scale : 100}%`,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        <iframe
          src={src}
          // Loaded when scrolled near, not with the page (a whole site's page, its scripts and pictures).
          loading="lazy"
          className="w-full h-full border-none"
          scrolling={scrollable ? "yes" : "no"}
          style={{
            pointerEvents: scrollable ? "auto" : "none",
            overflow: scrollable ? "auto" : "hidden",
          }}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          title={caption ?? "iFrame"}
        />
      </div>
    </div>
  );
}

export function ZoomableIframe({
  src,
  iframeTabletUrl,
  iframeMobileUrl,
  iframeViews = ["desktop", "tablet", "mobile"],
  iframeCover,
  caption,
  lang = "tr",
  animate = true,
}: ZoomableIframeProps) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [originalRect, setOriginalRect] = useState<DOMRect | null>(null);
  const [targetRect, setTargetRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  // Available views filtering
  const availableViews: DeviceMode[] = iframeViews.length > 0 ? iframeViews : ["desktop", "tablet", "mobile"];

  // Tab index state
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const activeMode: DeviceMode = availableViews[activeTabIndex] ?? availableViews[0] ?? "desktop";

  const placeholderRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const portalContainer = typeof window !== "undefined" ? document.body : null;

  // Tab labels — always English
  const getTabLabel = (mode: DeviceMode) => {
    if (mode === "desktop") return "Desktop";
    if (mode === "tablet") return "Tablet";
    return "Mobile";
  };

  const options: string[] = availableViews.map(getTabLabel);
  const hasSegmented = availableViews.length > 1;

  // Active URL calculation
  const getActiveUrl = (mode: DeviceMode) => {
    if (mode === "tablet" && iframeTabletUrl) return iframeTabletUrl;
    if (mode === "mobile" && iframeMobileUrl) return iframeMobileUrl;
    return src;
  };

  const currentUrl = getActiveUrl(activeMode);

  const getModeRatio = (mode: DeviceMode) => {
    if (mode === "mobile") return 402 / 756;
    if (mode === "tablet") return 834 / 1194;
    return 1920 / 1080;
  };

  const calculateTargetRect = useCallback((mode: DeviceMode) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobileScreen = vw < 640;
    const aspectRatioValue = getModeRatio(mode);

    const maxW = mode === "mobile" 
      ? (isMobileScreen ? vw - 32 : 402) 
      : mode === "tablet" 
        ? (isMobileScreen ? vw - 24 : 834) 
        : (isMobileScreen ? vw - 16 : vw * 0.88);

    const maxH = isMobileScreen ? vh * 0.82 : vh * 0.85;
    const targetRatio = maxW / maxH;

    let targetWidth = maxW;
    let targetHeight = maxH;

    if (aspectRatioValue > targetRatio) {
      targetWidth = maxW;
      targetHeight = maxW / aspectRatioValue;
    } else {
      targetHeight = maxH;
      targetWidth = maxH * aspectRatioValue;
    }

    return {
      left: (vw - targetWidth) / 2,
      top: (vh - targetHeight) / 2,
      width: targetWidth,
      height: targetHeight,
    };
  }, []);


  const handleZoom = () => {
    if (isZoomed || !currentUrl) return;

    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }

    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const rect = placeholder.getBoundingClientRect();

    setOriginalRect(rect);
    const target = calculateTargetRect(activeMode);
    setTargetRect(target);
    setIsZoomed(true);

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
      document.documentElement.style.setProperty("--scrollbar-width", `${scrollbarWidth}px`);
    }
    document.body.style.overflow = "hidden";
  };

  const handleClose = useCallback(() => {
    if (!isZoomed || !placeholderRef.current) return;

    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
    }

    const currentRect = placeholderRef.current.getBoundingClientRect();
    setOriginalRect(currentRect);
    setIsExpanded(false);

    closeTimeoutRef.current = setTimeout(() => {
      setIsZoomed(false);
      setOriginalRect(null);
      setTargetRect(null);
      setActiveTabIndex(0); // Always return to desktop view
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
      document.documentElement.style.removeProperty("--scrollbar-width");
      closeTimeoutRef.current = null;
    }, 400);
  }, [isZoomed]);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isZoomed && targetRect) {
      const raf = requestAnimationFrame(() => {
        setIsExpanded(true);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [isZoomed, targetRect]);

  useEffect(() => {
    if (!isZoomed) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isZoomed, handleClose]);

  useEffect(() => {
    if (!isZoomed) return;
    const handleResize = () => {
      const target = calculateTargetRect(activeMode);
      setTargetRect(target);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isZoomed, activeMode, calculateTargetRect]);

  if (!currentUrl && !src) {
    return (
      <ScrollReveal disabled={!animate}>
        <div className="flex flex-col gap-6 items-center pt-12 pb-9 w-full">
          <div className="relative w-full rounded-[32px] border border-dashed border-[var(--border)] bg-[var(--bg-2)] aspect-video flex items-center justify-center text-[var(--text-subtitle)] text-sm font-light select-none opacity-40">
            {lang === "en" ? "iFrame URL not found" : "iFrame adresi bulunamadı"}
          </div>
        </div>
      </ScrollReveal>
    );
  }

  // Device frame border-radius based on mode — sizing is handled by the outer FLIP container
  const deviceFrameRadius = activeMode === "mobile" ? "32px" : "24px";

  // Inline container shape based on activeMode (resizes frame on project page without focus mode)
  const inlineContainerStyle = () => {
    if (activeMode === "mobile") {
      return "w-full max-w-[402px] aspect-[402/756] mx-auto rounded-[32px]";
    }
    if (activeMode === "tablet") {
      return "w-full max-w-[640px] aspect-[834/1194] mx-auto rounded-[32px]";
    }
    return "w-full aspect-[1920/1080] rounded-[32px]";
  };

  return (
    <>
      {/* Inline Placeholder View */}
      <ScrollReveal disabled={!animate}>
        <div className="flex flex-col gap-6 items-center pt-12 pb-9 w-full">
          <div
            ref={placeholderRef}
            onClick={handleZoom}
            // A button: reached with Tab, opened with Enter or Space, named for screen readers.
            role="button"
            tabIndex={0}
            aria-label={lang === "en" ? "Open the live page" : "Canlı sayfayı aç"}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              handleZoom();
            }}
            className={`relative border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden flex items-center justify-center cursor-pointer group transition-all duration-300 ease-in-out outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-title)] ${inlineContainerStyle()}`}
            style={{
              visibility: isZoomed ? "hidden" : "visible",
            }}
          >
            {/* Cover Image or Live Scaled Preview */}
            {iframeCover ? (
              <img
                src={iframeCover}
                alt={caption ?? "iFrame Cover"}
                className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none transition-all duration-300"
              />
            ) : (
              <div className="absolute inset-0 w-full h-full pointer-events-none overflow-hidden opacity-90 group-hover:opacity-100 transition-opacity duration-300">
                <ScaledIframe
                  src={currentUrl}
                  activeMode={activeMode}
                  caption={caption}
                />
              </div>
            )}

            {/* Overlay */}
            {iframeCover && (
              <div className="absolute inset-0 bg-black/15 group-hover:bg-black/25 transition-colors duration-300" />
            )}


            {/* Play / Interactive Launch Button */}
            <IconButton
              size="lg"
              className="relative z-10 pointer-events-none"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="ml-0.5 text-[var(--text-title)]">
                <path d="M6.5 4.5L15.5 10L6.5 15.5V4.5Z" fill="currentColor" />
              </svg>
            </IconButton>
          </div>

          {caption && !isZoomed && (
            <p className="text-sm font-light leading-5 text-[var(--text-subtitle)] text-center w-full">
              {caption}
            </p>
          )}
        </div>
      </ScrollReveal>

      {/* Lightbox / Zoom Portal */}
      {isZoomed && portalContainer && originalRect && targetRect &&
        createPortal(
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-[9998] cursor-zoom-out"
              style={{
                backgroundColor: "var(--bg-1)",
                opacity: isExpanded ? 0.85 : 0,
                transition: "opacity 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)",
              }}
              onClick={handleClose}
            />

            {/* Bottom Bar / Segmented Switcher in Lightbox */}
            {hasSegmented && (
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
                  options={options}
                  value={options[activeTabIndex]}
                  onChange={(val) => {
                    const idx = options.indexOf(val);
                    if (idx === -1) return;
                    setActiveTabIndex(idx);
                    // The window takes the device's size as it changes (while open).
                    if (isZoomed) setTargetRect(calculateTargetRect(availableViews[idx] ?? "desktop"));
                  }}
                  size="md"
                />
              </div>
            )}

            {/* Cloned container performing the FLIP zoom animation */}
            <div
              data-lenis-prevent
              className="fixed z-[9999] select-none bg-transparent flex flex-col items-center justify-center p-2"
              style={{
                left: isExpanded ? `${targetRect.left}px` : `${originalRect.left}px`,
                top: isExpanded ? `${targetRect.top}px` : `${originalRect.top}px`,
                width: isExpanded ? `${targetRect.width}px` : `${originalRect.width}px`,
                height: isExpanded ? `${targetRect.height}px` : `${originalRect.height}px`,
                transition: "all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)",
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              {isExpanded ? (
                <div
                  className="w-full h-full overflow-hidden flex flex-col"
                  style={{
                    borderRadius: deviceFrameRadius,
                    border: "1px solid var(--border)",
                    background: "var(--bg-2)",
                  }}
                >
                  {/* DevTools Inspect Mode Scaled iFrame Viewport */}
                  <ScaledIframe
                    src={currentUrl}
                    activeMode={activeMode}
                    caption={caption}
                    scrollable
                  />
                </div>
              ) : (
                /* Static placeholder view shown during collapse transition */
                <div className={`relative w-full h-full flex items-center justify-center bg-[var(--bg-2)] border border-[var(--border)] overflow-hidden transition-all duration-300 ${inlineContainerStyle()}`}>
                  {iframeCover ? (
                    <img
                      src={iframeCover}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-[var(--bg-2)]" />
                  )}
                  {iframeCover && (
                    <div className="absolute inset-0 bg-black/15" />
                  )}
                  <IconButton
                    size="lg"
                    className="relative z-10 bg-[var(--bg-1)]/80 backdrop-blur-sm pointer-events-none"
                  >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="ml-0.5 text-[var(--text-title)]">
                      <path d="M6.5 4.5L15.5 10L6.5 15.5V4.5Z" fill="currentColor" />
                    </svg>
                  </IconButton>
                </div>
              )}
            </div>
          </>,
          portalContainer
        )
      }
    </>
  );
}
