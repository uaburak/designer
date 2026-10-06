import { useRef, useState, type CSSProperties } from "react";
import { ZoomableImage } from "@/components/ZoomableImage";
import { cn } from "@/lib/utils";
import { BASE_LANGUAGE, type Embed, type LangCode } from "../model";
import type { AspectRatio, DeviceVariant, EmbedEntry } from "./types";

/**
 * The before / after slider and the device frames an embed draws (see
 * Embed). `editing`: drawn in the editor — placeholders say what to fill
 * in, pictures don't open larger.
 */

export interface PicturesProps {
  embed: Embed;
  editing: boolean;
  lang: LangCode;
}

const ASPECT_CSS: Record<AspectRatio, string> = { "16/9": "16 / 9", "4/3": "4 / 3", "1/1": "1 / 1", "3/4": "3 / 4", "9/16": "9 / 16" };
const aspect = (ratio: AspectRatio | undefined, fallback: AspectRatio): CSSProperties => ({ aspectRatio: ASPECT_CSS[ratio ?? fallback] ?? ASPECT_CSS[fallback] });

/** An entry's words in the language shown (Turkish's where it has none in it). */
const labelOf = (entry: EmbedEntry | undefined, lang: LangCode) => (lang !== BASE_LANGUAGE && entry?.labelEn ? entry.labelEn : entry?.label);
const altOf = (entry: EmbedEntry | undefined, lang: LangCode) => (lang !== BASE_LANGUAGE && entry?.altEn ? entry.altEn : entry?.alt) ?? "";

function Placeholder({ label, side }: { label: string; side?: "left" | "right" }) {
  return (
    <div className={cn("absolute inset-y-0 flex items-center justify-center p-5 text-center text-sm font-light leading-5 text-[var(--text-subtitle)] select-none opacity-50", side === "left" ? "left-0 w-1/2" : side === "right" ? "right-0 w-1/2" : "inset-x-0")}>
      {label}
    </div>
  );
}

/** Before / after: the two pictures, the handle between them, their labels. */
export function CompareSlider({ embed, editing, lang }: PicturesProps) {
  const [before, after] = [embed.entries?.[0], embed.entries?.[1]];
  const [pos, setPos] = useState(50);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const en = lang !== BASE_LANGUAGE;
  const beforeLabel = labelOf(before, lang) || (en ? "Before" : "Önce");
  const afterLabel = labelOf(after, lang) || (en ? "After" : "Sonra");

  const moveTo = (clientX: number) => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPos(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") { e.preventDefault(); setPos((p) => Math.max(0, p - step)); }
    if (e.key === "ArrowRight") { e.preventDefault(); setPos((p) => Math.min(100, p + step)); }
    if (e.key === "Home") { e.preventDefault(); setPos(0); }
    if (e.key === "End") { e.preventDefault(); setPos(100); }
  };
  const side = (entry: EmbedEntry | undefined, placeholder: string, half: "left" | "right") =>
    entry?.src ? (
      <img src={entry.src} alt={altOf(entry, lang)} loading="lazy" draggable={false} className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
    ) : (
      <Placeholder label={editing ? placeholder : ""} side={half} />
    );
  const label = (text: string, at: "left" | "right") => (
    <span className={cn("pointer-events-none absolute top-[14px] inline-flex items-center h-8 px-3 rounded-full bg-[var(--bg-1)]/80 backdrop-blur-sm text-[13px] font-medium text-[var(--text-title)]", at === "left" ? "left-[14px]" : "right-[14px]")}>{text}</span>
  );

  return (
    <div
      ref={frame}
      role="slider"
      tabIndex={editing ? -1 : 0}
      aria-label={`${beforeLabel} / ${afterLabel}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pos)}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => { if (dragging.current) moveTo(e.clientX); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
      className="relative w-full rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden select-none cursor-ew-resize outline-none focus-visible:border-[var(--border-hover)]"
      style={{ ...aspect(embed.aspectRatio, "16/9"), touchAction: "pan-y" }}
    >
      {side(after, en ? "After image" : "Sonra görseli", "right")}
      <div className="absolute inset-0 bg-[var(--bg-4)]" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        {side(before, en ? "Before image" : "Önce görseli", "left")}
      </div>
      <div aria-hidden className="absolute top-0 bottom-0 w-px bg-[var(--bg-1)] pointer-events-none" style={{ left: `${pos}%` }}>
        <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-10 h-10 rounded-full border border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-title)] shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 4L2 8l4 4M10 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      {label(beforeLabel, "left")}
      {label(afterLabel, "right")}
    </div>
  );
}

function DeviceFrame({ variant, entry, editing, lang }: { variant: DeviceVariant; entry: EmbedEntry; editing: boolean; lang: LangCode }) {
  const alt = altOf(entry, lang);
  const screen = entry.src ? (
    editing ? (
      <img src={entry.src} alt={alt} draggable={false} className="w-full h-full object-cover object-top" />
    ) : (
      <ZoomableImage src={entry.src} alt={alt} loading="lazy" className="w-full h-full object-cover object-top" />
    )
  ) : (
    <Placeholder label={editing ? "Screen image" : ""} />
  );
  if (variant === "browser") {
    return (
      <div className="w-full rounded-[16px] border border-[var(--border-hover)] bg-[var(--bg-1)] overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-3 h-9 px-3.5 border-b border-[var(--border)]">
          <div className="flex gap-1.5 w-[42px]">
            {[0, 1, 2].map((i) => <span key={i} className="w-2.5 h-2.5 rounded-full bg-[var(--bg-5)]" />)}
          </div>
          <div className="flex-1 flex justify-center min-w-0">
            <span className="max-w-[70%] truncate inline-flex items-center h-6 px-3 rounded-full bg-[var(--bg-4)] text-[12px] leading-4 text-[var(--text-subtitle)]">{labelOf(entry, lang) || "burakkoc.net"}</span>
          </div>
          <div className="w-[42px]" />
        </div>
        <div className="relative w-full bg-[var(--bg-2)]" style={{ aspectRatio: "16 / 10" }}>{screen}</div>
      </div>
    );
  }
  const phone = variant === "phone";
  return (
    // The ring keeps the dark frame's edge visible on the dark theme.
    <div className={cn("relative w-full bg-[#0d0d0d] ring-1 ring-white/10 shadow-[0_16px_40px_rgba(0,0,0,0.18)]", phone ? "rounded-[36px] p-[7px]" : "rounded-[28px] p-[10px]")}>
      <div className={cn("relative w-full overflow-hidden bg-[var(--bg-2)]", phone ? "rounded-[29px]" : "rounded-[18px]")} style={{ aspectRatio: phone ? "9 / 19.5" : "4 / 3" }}>
        {screen}
        {phone && <span aria-hidden className="absolute top-2 left-1/2 -translate-x-1/2 w-[30%] h-[18px] rounded-full bg-[#0d0d0d] z-10 pointer-events-none" />}
      </div>
    </div>
  );
}

/** Screens in their devices: side by side (phones, tablets) or stacked (browsers). */
export function DevicesRow({ embed, editing, lang }: PicturesProps) {
  const entries = embed.entries ?? [];
  const shown = editing ? entries : entries.filter((e) => e.src?.trim());
  const variant: DeviceVariant = embed.variant === "browser" || embed.variant === "tablet" ? embed.variant : "phone";
  return (
    <div className={cn("flex w-full", variant === "browser" ? "flex-col gap-6" : "items-center justify-center gap-3 sm:gap-6 py-4 sm:py-2")}>
      {shown.map((entry) => (
        <div key={entry.id} className={variant === "phone" ? "flex-1 min-w-0 max-w-[220px]" : variant === "tablet" ? "flex-1 min-w-0 max-w-[460px]" : "w-full"}>
          <DeviceFrame variant={variant} entry={entry} editing={editing} lang={lang} />
        </div>
      ))}
    </div>
  );
}
