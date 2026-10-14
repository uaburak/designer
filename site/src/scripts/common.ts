// What every page runs: the app's design system stylesheet (Inter, the tokens), the site's own, the header (with the
// theme toggle), the text's reveal and the Download blocks. Pages with scenes mount them on top (scenes/runtime/mount.tsx).
import "@/ds/global.css";
import "../styles/site.css";
import { arrowCursor } from "../scenes/runtime/cursorArt";
import { installMotionTokens } from "../scenes/runtime/easing";
import { initThemeToggle } from "./theme";
import { detectPlatform, formatDate, formatSize, loadReleases, offerFor, type Offer, type Platform } from "./releases";

const NAME: Record<Platform, string> = { mac: "macOS", windows: "Windows" };

export function initHeader(): void {
  // Close the phone menu after a choice or a click outside.
  const menu = document.querySelector<HTMLDetailsElement>(".menu");
  if (menu) {
    document.addEventListener("click", (e) => {
      if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
    });
  }
}

export function offerLine(o: Offer): string {
  return [`Version ${o.version}`, formatSize(o.file.size), formatDate(o.date)].filter(Boolean).join(" · ");
}

function setButton(a: HTMLAnchorElement, offer: Offer | null) {
  const os = a.dataset.os as Platform;
  const label = a.querySelector("span");
  if (offer) {
    a.href = `/download/${os}`;
    a.removeAttribute("aria-disabled");
    a.removeAttribute("tabindex");
    if (label) label.innerHTML = `Download for <span class="os-name">${NAME[os]}</span>`;
  } else {
    a.removeAttribute("href");
    a.setAttribute("aria-disabled", "true");
    a.tabIndex = -1;
    if (label) label.textContent = `${NAME[os]}: coming soon`;
  }
}

/** Fills each `[data-download]` block: this OS first, the other as a link, the release's details. */
export async function initDownloads(): Promise<void> {
  const blocks = [...document.querySelectorAll<HTMLElement>("[data-download]")];
  if (!blocks.length) return;
  const platform = detectPlatform(navigator as Navigator & { userAgentData?: { platform?: string } });
  const releases = await loadReleases();
  const offers: Record<Platform, Offer | null> = {
    mac: releases ? offerFor(releases, "mac") : null,
    windows: releases ? offerFor(releases, "windows") : null,
  };

  for (const block of blocks) {
    const meta = block.querySelector<HTMLElement>("[data-dl-meta]");
    const buttons = [...block.querySelectorAll<HTMLAnchorElement>("a[data-os]")];
    const byOs = (os: Platform) => buttons.find((b) => b.dataset.os === os);
    for (const b of buttons) setButton(b, offers[b.dataset.os as Platform]);

    if (!offers.mac && !offers.windows) {
      block.classList.add("is-soon");
      for (const b of buttons) b.hidden = b !== buttons[0];
      const first = buttons[0];
      if (first) {
        first.querySelector("span")!.textContent = "Coming soon";
        first.classList.replace("btn-primary", "btn-secondary");
      }
      if (meta) meta.textContent = "The first release is on its way, for macOS and Windows.";
      continue;
    }

    if (platform && offers[platform]) {
      // This visitor's OS first, the other one as a quiet link.
      const other: Platform = platform === "mac" ? "windows" : "mac";
      const mine = byOs(platform)!;
      const theirs = byOs(other);
      mine.classList.replace("btn-secondary", "btn-primary");
      mine.parentElement?.prepend(mine);
      if (theirs) theirs.hidden = true;
      if (meta) {
        meta.textContent = offerLine(offers[platform]!);
        if (offers[other]) {
          meta.append(" · Also for ");
          const link = document.createElement("a");
          link.href = `/download/${other}`;
          link.textContent = NAME[other];
          meta.append(link);
        }
      }
    } else {
      // Another OS (or a phone): both, newest version shown.
      const newest = [offers.mac, offers.windows].filter((o): o is Offer => !!o)[0];
      if (meta) meta.textContent = `For macOS and Windows · Version ${newest.version} · ${formatDate(newest.date)}`;
    }
  }
}

/** Containers whose parts reveal one after another (heading, then lede, then the rest). */
const GROUPS = ".head, .hero-side, .card-text, .aside, .band-inner";
/** Stagger between parts entering together, ms. */
const STAGGER = 70;

/**
 * Text marked `data-reveal`, and the tiles, rise and fade in once as they come into view (site.css). Parts that enter
 * together stagger in document order (heading → lede → tile); `will-change` holds only while each one moves.
 * Without script, or under reduced motion, everything is simply there.
 */
export function initReveal(): void {
  const units: HTMLElement[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
    if (el.matches(GROUPS) && el.children.length > 1) {
      el.setAttribute("data-reveal", "group");
      const base = parseFloat(el.style.getPropertyValue("--reveal-delay")) || 0;
      for (const child of el.children) {
        if (!(child instanceof HTMLElement)) continue;
        child.setAttribute("data-reveal-item", "");
        if (base) child.style.setProperty("--reveal-base", `${base}ms`);
        units.push(child);
      }
    } else units.push(el);
  }
  for (const tile of document.querySelectorAll<HTMLElement>(".tile, .platform")) {
    tile.setAttribute("data-reveal-item", "tile");
    units.push(tile);
  }
  const show = (el: HTMLElement) => {
    el.setAttribute("data-shown", "");
    const done = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== "transform") return;
      el.setAttribute("data-done", "");
      el.removeEventListener("transitionend", done);
    };
    el.addEventListener("transitionend", done);
  };
  if (typeof IntersectionObserver !== "function") {
    for (const el of units) el.setAttribute("data-shown", "");
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      const entering = entries
        .filter((e) => e.isIntersecting)
        .map((e) => e.target as HTMLElement)
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      entering.forEach((el, i) => {
        el.style.setProperty("--reveal-delay", `calc(var(--reveal-base, 0ms) + ${Math.min(i, 5) * STAGGER}ms)`);
        show(el);
        io.unobserve(el);
      });
    },
    { rootMargin: "0px 0px -6% 0px" },
  );
  for (const el of units) io.observe(el);
}

/** The page's pointer is Figma UI3's arrow (the UI3 kit's cursor-black: black, white edged, a soft shadow). */
export function initCursor(): void {
  document.documentElement.style.setProperty("--site-cursor", arrowCursor());
}

export function initPage(): void {
  installMotionTokens();
  initCursor();
  initHeader();
  initReveal();
  initThemeToggle();
  void initDownloads();
}
