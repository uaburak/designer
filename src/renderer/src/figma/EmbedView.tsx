import type { ReactNode } from "react";
import { ZoomableFigma } from "@/components/ZoomableFigma";
import { ZoomableIframe } from "@/components/ZoomableIframe";
import { cn } from "@/lib/utils";
import { CodeMedia, ImageMedia, VideoMedia } from "./embeds/Media";
import { CompareSlider, DevicesRow } from "./embeds/Compare";
import { captionIn, type Embed, type LangCode } from "./model";

/**
 * What the site's code draws in a frame's place (see Embed): an image with
 * its badges, a video, a code sample, a Figma file or a page opening in its
 * window, a before / after slider, screens in their devices — with its
 * caption under it. On the site (`site`) it works; in the editor it is only
 * drawn, so a press on it picks its layer.
 */

/** The media's box: 48px over the medium, its caption 24px under it, 36px under both. */
function Media({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 items-center pt-12 pb-9 w-full">
      {children}
      {caption?.trim() && <p className="text-sm font-light leading-5 text-[var(--text-subtitle)] text-center w-full">{caption}</p>}
    </div>
  );
}

export function EmbedView({ embed, site, lang }: { embed: Embed; id: string; site: boolean; lang: LangCode }) {
  const caption = captionIn(embed, lang);
  // The site's own parts have their words (not found, Prototype…) in Turkish and English only.
  const chrome = lang === "en" ? "en" : "tr";
  const editing = !site;
  let content: ReactNode;
  switch (embed.kind) {
    case "image":
      content = <Media caption={caption}><ImageMedia embed={embed} editing={editing} /></Media>;
      break;
    case "video":
      content = <Media caption={caption}><VideoMedia embed={embed} editing={editing} /></Media>;
      break;
    case "code":
      content = <Media caption={caption}><CodeMedia embed={embed} editing={editing} /></Media>;
      break;
    case "compare":
      content = <Media caption={caption}><CompareSlider embed={embed} editing={editing} lang={lang} /></Media>;
      break;
    case "devices":
      content = (
        <Media caption={caption}>
          <div className="w-full rounded-[32px] border border-[var(--border)] bg-[var(--bg-4)] overflow-hidden p-4 sm:p-10">
            <DevicesRow embed={embed} editing={editing} lang={lang} />
          </div>
        </Media>
      );
      break;
    case "figma":
      content = <ZoomableFigma src={embed.src ?? ""} figmaWorkspace={embed.figmaWorkspace} figmaCover={embed.figmaCover} figmaWorkspaceCover={embed.figmaWorkspaceCover} caption={caption} lang={chrome} animate={false} />;
      break;
    case "iframe":
      content = <ZoomableIframe src={embed.src} iframeTabletUrl={embed.iframeTabletUrl} iframeMobileUrl={embed.iframeMobileUrl} iframeViews={embed.iframeViews} iframeCover={embed.iframeCover} caption={caption} lang={chrome} animate={false} />;
      break;
  }
  return (
    <div data-embed={embed.kind} className={cn("w-full min-w-0", editing && "pointer-events-none select-none")}>
      {content}
    </div>
  );
}
