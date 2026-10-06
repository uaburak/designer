import { useMemo, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { Segmented } from "@/components/Segmented";
import { IconButton } from "@/components/Button";
import { ZoomableImage } from "@/components/ZoomableImage";
import { CodeHighlight } from "@/components/CodeHighlight";
import { ComponentRenderer } from "@/components/demos/ComponentRegistry";
import { cn } from "@/lib/utils";
import type { Embed } from "../model";
import type { BadgeItem, BadgePosition, SegmentedSecondTab } from "./types";

/**
 * The media the site's code draws in an embed's place: an image (with its
 * badges and second tab), a video, a code sample. `editing`: drawn in the
 * editor — placeholders say what to fill in, nothing plays or opens.
 */

export interface MediaProps {
  embed: Embed;
  editing: boolean;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICON_PATHS: Record<Exclude<BadgeItem["icon"], "segmented">, ReactNode> = {
  link: <path d="M8.5 11.5L11.5 8.5M7 13C5.34 13 4 11.66 4 10C4 8.34 5.34 7 7 7H9M11 13H13C14.66 13 16 11.66 16 10C16 8.34 14.66 7 13 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  search: <><circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.5" /><path d="M13 13L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  gear: <><circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" /><path d="M10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17M4.93 4.93l1.06 1.06M14.01 14.01l1.06 1.06M4.93 15.07l1.06-1.06M14.01 5.99l1.06-1.06" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  play: <path d="M6.5 4.5L15.5 10L6.5 15.5V4.5Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />,
  external: <path d="M11 4H16V9M16 4L10 10M8 5H5C4.45 5 4 5.45 4 6V15C4 15.55 4.45 16 5 16H14C14.55 16 15 15.55 15 15V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
};

function BadgeIcon({ icon }: { icon: BadgeItem["icon"] }) {
  if (icon === "segmented") return null;
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>{ICON_PATHS[icon]}</svg>;
}

// ── Badges ────────────────────────────────────────────────────────────────────

const POSITION_CLASS: Record<BadgePosition, string> = {
  "top-right": "absolute top-[14px] right-[14px]",
  "top-left": "absolute top-[14px] left-[14px]",
  "bottom-right": "absolute bottom-[11px] right-[11px]",
  "bottom-left": "absolute bottom-[11px] left-[11px]",
};

const BADGE_LABELS: Record<string, string> = { link: "Link", search: "Search", play: "Play", external: "External link", gear: "Settings" };

function Badges({ badges, activeTab, onTabChange }: { badges: BadgeItem[]; activeTab: string; onTabChange: (label: string) => void }) {
  const grouped = badges.reduce<Record<BadgePosition, BadgeItem[]>>(
    (acc, b) => ({ ...acc, [b.position]: [...acc[b.position], b] }),
    { "top-right": [], "top-left": [], "bottom-right": [], "bottom-left": [] }
  );
  return (
    <>
      {(Object.entries(grouped) as [BadgePosition, BadgeItem[]][]).map(([pos, items]) =>
        items.length ? (
          <div key={pos} className={`${POSITION_CLASS[pos]} flex items-center gap-2 z-10`}>
            {items.map((badge) => {
              if (badge.icon === "segmented") {
                const t1 = badge.tab1Label ?? "Project";
                const t2 = badge.tab2Label ?? "Code";
                return <Segmented key={badge.id} options={[t1, t2]} value={activeTab || t1} onChange={onTabChange} />;
              }
              const label = BADGE_LABELS[badge.icon] ?? "Badge";
              return badge.href ? (
                <a key={badge.id} href={badge.href} target="_blank" rel="noopener noreferrer" aria-label={label} className="flex items-center justify-center w-10 h-10 rounded-full border border-[var(--border)] bg-[var(--bg-2)] text-[var(--text-title)] transition-all duration-200 cursor-pointer hover:bg-[var(--bg-4)] hover:border-[var(--border-hover)] active:scale-95">
                  <BadgeIcon icon={badge.icon} />
                </a>
              ) : (
                <IconButton key={badge.id} aria-label={label} size="md">
                  <BadgeIcon icon={badge.icon} />
                </IconButton>
              );
            })}
          </div>
        ) : null
      )}
    </>
  );
}

/** A video link as what plays it: YouTube's and Vimeo's players, a file as itself — null when it is neither. */
export function embedUrl(src: string): string | null {
  const yt = src.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vimeo = src.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  if (/\.(mp4|webm)(\?|$)/i.test(src)) return src;
  return null;
}

const isFile = (src: string | undefined) => Boolean(src && /\.(mp4|webm)(\?|$)/i.test(src));

const Placeholder = ({ children }: { children: ReactNode }) => (
  <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[var(--text-subtitle)] text-sm font-light select-none opacity-40">{children}</div>
);

function SecondTab({ tab2 }: { tab2: SegmentedSecondTab }) {
  if (tab2.type === "image") return tab2.src ? <ZoomableImage src={tab2.src} alt="" loading="lazy" className="w-full h-full object-cover" /> : <Placeholder>No image</Placeholder>;
  if (tab2.type === "video") {
    const url = tab2.src ? embedUrl(tab2.src) : null;
    return url ? <iframe src={url} loading="lazy" className="absolute inset-0 w-full h-full" allowFullScreen title="Video" /> : <Placeholder>No video</Placeholder>;
  }
  if (tab2.type === "code") {
    return (
      <div className="w-full h-full bg-[var(--bg-2)]">
        <CodeHighlight code={tab2.content?.trim() || "// no code"} language={tab2.language || "javascript"} />
      </div>
    );
  }
  return (
    <div className="w-full h-full overflow-auto p-5 sm:p-6 bg-[var(--bg-2)]">
      <p className="text-base font-light leading-7 text-[var(--text-p)] whitespace-pre-wrap">{tab2.content?.trim()}</p>
    </div>
  );
}

/** The badges' state: which tab of a segmented badge is shown. */
function useTabs(embed: Embed) {
  const [activeTab, setActiveTab] = useState("");
  const segmented = embed.badges?.find((b) => b.icon === "segmented");
  const second = segmented && activeTab === (segmented.tab2Label ?? "Code") ? segmented.tab2 ?? null : null;
  return { activeTab, setActiveTab, segmented, second };
}

const IMAGE_ASPECT: Record<string, string> = { "16/9": "940 / 518", "4/3": "940 / 705", "1/1": "940 / 940" };

const BOX = "relative w-full rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden";

/** An image at its aspect ratio, its badges over it — opening larger on a click (the site). */
export function ImageMedia({ embed, editing }: MediaProps) {
  const { activeTab, setActiveTab, second } = useTabs(embed);
  return (
    <div className={BOX} style={{ aspectRatio: IMAGE_ASPECT[embed.aspectRatio ?? "16/9"] ?? IMAGE_ASPECT["16/9"] }}>
      {second ? (
        <SecondTab tab2={second} />
      ) : embed.src ? (
        editing ? (
          <img src={embed.src} alt={embed.alt ?? ""} draggable={false} className="w-full h-full object-cover" />
        ) : (
          <ZoomableImage src={embed.src} alt={embed.alt ?? ""} loading="lazy" className="w-full h-full object-cover" badges={embed.badges} activeTab={activeTab} onTabChange={setActiveTab} />
        )
      ) : (
        <Placeholder>{editing ? "Add the image's link in the Embed section" : "Image not found"}</Placeholder>
      )}
      {embed.badges?.length ? <Badges badges={embed.badges} activeTab={activeTab} onTabChange={setActiveTab} /> : null}
    </div>
  );
}

/** A video: YouTube's or Vimeo's player, or a file — played with controls, or looping silently. */
export function VideoMedia({ embed, editing }: MediaProps) {
  const { activeTab, setActiveTab, second } = useTabs(embed);
  const url = embed.src ? embedUrl(embed.src) : null;
  return (
    <div className={cn(BOX, "aspect-video")}>
      {second ? (
        <SecondTab tab2={second} />
      ) : url ? (
        isFile(embed.src) ? (
          embed.videoLoop ? (
            <video src={url} autoPlay={!editing} muted loop playsInline preload="metadata" className="w-full h-full object-cover" />
          ) : (
            <video src={url} controls preload="metadata" className="w-full h-full object-cover" />
          )
        ) : (
          <iframe src={url} loading="lazy" className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title={embed.caption || "Video"} />
        )
      ) : (
        <Placeholder>{editing ? "Add a YouTube, Vimeo or .mp4 link in the Embed section" : "Video not found"}</Placeholder>
      )}
      {embed.badges?.length ? <Badges badges={embed.badges} activeTab={activeTab} onTabChange={setActiveTab} /> : null}
    </div>
  );
}

/**
 * A code sample's HTML preview: sanitized first — scripts, event handlers
 * and anything else that would run on the page are taken out — and only in
 * the browser (it is drawn after a click on Preview, never on the server).
 */
function HtmlPreview({ html }: { html: string }) {
  const clean = useMemo(() => (typeof window === "undefined" ? "" : DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true } })), [html]);
  return <div className="w-full" dangerouslySetInnerHTML={{ __html: clean }} />;
}

/** A code sample, highlighted — and what it shows (its preview), a tab beside it. */
export function CodeMedia({ embed }: MediaProps) {
  const { activeTab, setActiveTab, segmented, second } = useTabs(embed);
  const [builtInTab, setBuiltInTab] = useState("Code");
  const hasPreview = Boolean(embed.codePreview?.trim() || embed.previewComponent);
  const tab = segmented ? (second ? "second" : "code") : builtInTab === "Preview" ? "preview" : "code";
  return (
    <div className="relative w-full rounded-[32px] border border-[var(--border)] bg-[var(--bg-code)] overflow-hidden">
      {!segmented && hasPreview && (
        <div className="absolute top-[14px] right-[14px] z-10">
          <Segmented options={["Preview", "Code"]} defaultValue="Code" onChange={setBuiltInTab} />
        </div>
      )}
      {tab === "code" && (embed.content?.trim() ? <CodeHighlight code={embed.content} language={embed.language ?? "javascript"} /> : <div className="p-5 sm:p-6 opacity-30 italic font-mono text-xs text-[var(--text-subtitle)]">{"// no code"}</div>)}
      {tab === "preview" && (
        <div className="bg-[var(--bg-3)] p-5 sm:p-6 min-h-[120px] flex items-center justify-center">
          {embed.previewComponent ? <ComponentRenderer componentKey={embed.previewComponent} /> : <HtmlPreview html={embed.codePreview ?? ""} />}
        </div>
      )}
      {tab === "second" && second && (
        <div className="w-full h-full min-h-[180px]">
          <SecondTab tab2={second} />
        </div>
      )}
      {embed.badges?.length ? <Badges badges={embed.badges} activeTab={activeTab} onTabChange={setActiveTab} /> : null}
    </div>
  );
}
