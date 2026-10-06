import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ScrollReveal from "@/components/ScrollReveal";
import { Segmented } from "@/components/Segmented";
import { IconButton } from "@/components/Button";

interface ZoomableFigmaProps {
  src: string;
  figmaWorkspace?: string;
  figmaCover?: string;
  figmaWorkspaceCover?: string;
  caption?: string;
  lang?: "tr" | "en";
  /** Scroll reveal; off in the admin preview, whose panel scrolls independently of the window */
  animate?: boolean;
}

function getFigmaEmbedUrl(url: string): string {
  if (!url) return "";
  if (url.includes("embed.figma.com")) return url;
  let cleanUrl = url.replace(/(www\.)?figma\.com/, "embed.figma.com");
  if (!cleanUrl.includes("embed-host=")) {
    const separator = cleanUrl.includes("?") ? "&" : "?";
    cleanUrl = `${cleanUrl}${separator}embed-host=share`;
  }
  return cleanUrl;
}

export function ZoomableFigma({ src, figmaWorkspace, figmaCover, figmaWorkspaceCover, caption, lang = "tr", animate = true }: ZoomableFigmaProps) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [originalRect, setOriginalRect] = useState<DOMRect | null>(null);
  const [targetRect, setTargetRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  // Index based tab state: 0 = Prototype, 1 = Workspace
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  const placeholderRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const portalContainer = typeof window !== "undefined" ? document.body : null;

  const options = lang === "en" ? ["Prototype", "Pages"] : ["Prototip", "Pages"];
  const hasSegmented = Boolean(src && figmaWorkspace);

  const calculateTargetRect = useCallback((aspectRatioValue: number) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < 640;
    const maxW = isMobile ? vw - 16 : vw * 0.85;
    const maxH = isMobile ? vh * 0.85 : vh * 0.85;
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
    const activeUrl = src || figmaWorkspace;
    if (isZoomed || !activeUrl) return;

    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }

    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    const rect = placeholder.getBoundingClientRect();

    setOriginalRect(rect);

    const target = calculateTargetRect(16 / 9);
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
      const target = calculateTargetRect(16 / 9);
      setTargetRect(target);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isZoomed, calculateTargetRect]);

  const activeUrl = hasSegmented && activeTabIndex === 1 ? figmaWorkspace : (src || figmaWorkspace);
  const embedUrl = getFigmaEmbedUrl(activeUrl ?? "");

  const hasAnyLink = Boolean(src || figmaWorkspace);

  const activeCover = activeTabIndex === 1 ? (figmaWorkspaceCover || figmaCover) : figmaCover;

  let playLabel = "";
  if (lang === "en") {
    if (hasSegmented) {
      playLabel = activeTabIndex === 0 ? "Load Interactive Prototype" : "Load Interactive Pages";
    } else if (src) {
      playLabel = "Load Interactive Prototype";
    } else {
      playLabel = "Load Interactive Pages";
    }
  } else {
    if (hasSegmented) {
      playLabel = activeTabIndex === 0 ? "Etkileşimli Prototipi Yükle" : "Etkileşimli Pages Yükle";
    } else if (src) {
      playLabel = "Etkileşimli Prototipi Yükle";
    } else {
      playLabel = "Etkileşimli Pages Yükle";
    }
  }

  if (!hasAnyLink) {
    return (
      <ScrollReveal disabled={!animate}>
        <div className="flex flex-col gap-6 items-center pt-12 pb-9 w-full">
          <div className="relative w-full rounded-[32px] border border-dashed border-[var(--border)] bg-[var(--bg-2)] aspect-video flex items-center justify-center text-[var(--text-subtitle)] text-sm font-light select-none opacity-40">
            {lang === "en" ? "Figma prototype URL not found" : "Figma prototip adresi bulunamadı"}
          </div>
        </div>
      </ScrollReveal>
    );
  }

  return (
    <>
      {/* Inline Placeholder */}
      <ScrollReveal disabled={!animate}>
        <div className="flex flex-col gap-6 items-center pt-12 pb-9 w-full">
          <div
            ref={placeholderRef}
            onClick={handleZoom}
            // A button: reached with Tab, opened with Enter or Space, named for screen readers.
            role="button"
            tabIndex={0}
            aria-label={playLabel}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              handleZoom();
            }}
            className="relative w-full rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden aspect-video flex items-center justify-center cursor-pointer group transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-title)]"
            style={{
              visibility: isZoomed ? "hidden" : "visible",
            }}
          >
            {/* Cover Image Background */}
            {activeCover ? (
              <img
                src={activeCover}
                alt={caption ?? "Figma Cover"}
                className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
              />
            ) : (
              <div className="absolute inset-0 bg-[var(--bg-2)]" />
            )}

            {/* Subtle overlay to guarantee readability of play button */}
            {activeCover && (
              <div className="absolute inset-0 bg-black/10 group-hover:bg-black/20 transition-colors duration-300" />
            )}

            {/* Segmented Control on Placeholder */}
            {hasSegmented && (
              <div
                className="absolute top-[14px] right-[14px] z-10"
                onClick={(e) => e.stopPropagation()}
              >
                <Segmented
                  options={options}
                  value={options[activeTabIndex]}
                  onChange={(val) => {
                    const idx = options.indexOf(val);
                    if (idx !== -1) setActiveTabIndex(idx);
                  }}
                />
              </div>
            )}

            {/* Play Button */}
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
            {/* Backdrop with smooth fade in/out */}
            <div
              className="fixed inset-0 z-[9998] cursor-zoom-out"
              style={{
                backgroundColor: "var(--bg-1)",
                opacity: isExpanded ? 0.75 : 0,
                transition: "opacity 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)",
              }}
              onClick={handleClose}
            />

            {/* Segmented Control at the bottom */}
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
                    if (idx !== -1) setActiveTabIndex(idx);
                  }}
                  size="md"
                />
              </div>
            )}

            {/* Cloned container performing the FLIP zoom animation */}
            <div
              data-lenis-prevent
              className="fixed z-[9999] cursor-zoom-out select-none bg-[var(--bg-2)]"
              style={{
                left: isExpanded ? `${targetRect.left}px` : `${originalRect.left}px`,
                top: isExpanded ? `${targetRect.top}px` : `${originalRect.top}px`,
                width: isExpanded ? `${targetRect.width}px` : `${originalRect.width}px`,
                height: isExpanded ? `${targetRect.height}px` : `${originalRect.height}px`,
                borderRadius: isExpanded ? "32px" : "32px",
                border: "1px solid var(--border)",
                overflow: "hidden",
                transition: "all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)",
              }}
              onClick={(e) => {
                // Prevent close when clicking inside the iframe area
                e.stopPropagation();
              }}
            >
              {isExpanded ? (
                <iframe
                  src={embedUrl}
                  loading="lazy"
                  className="w-full h-full border-none"
                  allowFullScreen
                  title={caption ?? "Figma"}
                />
              ) : (
                /* Static placeholder view shown during collapse transition */
                <div className="relative w-full h-full flex items-center justify-center bg-[var(--bg-2)]">
                  {activeCover ? (
                    <img
                      src={activeCover}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-[var(--bg-2)]" />
                  )}
                  {activeCover && (
                    <div className="absolute inset-0 bg-black/10" />
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
