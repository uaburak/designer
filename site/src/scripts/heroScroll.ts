// The home hero grows with the scroll (docs/site.md §2.2): the editor starts as a framed window under the headline,
// scales up until it fills the viewport, stays pinned full screen while the visitor uses it (the section is a tall
// track with a sticky viewport), then scrolls away. Transform only, written from a rAF scroll handler (one code path
// in every browser; CSS scroll-driven animations can't read the slot's measured box).

export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HeroFrame {
  /** 0 framed … 1 full screen */
  progress: number;
  x: number;
  y: number;
  scale: number;
  /** The window's corner radius in its own (unscaled) px, so it looks 12px framed and 0 at full size */
  radius: number;
  copyOpacity: number;
  copyShift: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * Where the window is drawn for a scroll position. `scrolled`: px the track's top is above the viewport's; `grow`: the
 * scroll distance over which it grows; the window's layout box is the whole viewport (`vw` × `vh`), fitted into `slot`
 * at the start. `snap` (reduced motion): no in-between, framed or full.
 */
export function heroFrame(scrolled: number, grow: number, vw: number, vh: number, slot: Slot, snap = false): HeroFrame {
  let p = clamp01(scrolled / grow);
  if (snap) p = p >= 0.5 ? 1 : 0;
  const s0 = Math.min(slot.w / vw, slot.h / vh, 1);
  const x0 = slot.x + (slot.w - vw * s0) / 2;
  const y0 = slot.y;
  const e = ease(p);
  const scale = s0 + (1 - s0) * e;
  return {
    progress: p,
    x: x0 * (1 - e),
    y: y0 * (1 - e),
    scale,
    radius: (12 * (1 - e)) / scale,
    copyOpacity: clamp01(1 - p * 2.2),
    copyShift: -p * 80,
  };
}

export function initHeroScroll(): void {
  const track = document.querySelector<HTMLElement>(".hero-track");
  const win = document.querySelector<HTMLElement>("[data-hero-window]");
  const slotEl = document.querySelector<HTMLElement>("[data-hero-slot]");
  const copy = document.querySelector<HTMLElement>("[data-hero-copy]");
  if (!track || !win || !slotEl) return;
  const sticky = win.parentElement!;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let slot: Slot = { x: 0, y: 0, w: 0, h: 0 };
  let queued = false;

  const measure = () => {
    const cs = getComputedStyle(slotEl);
    const left = parseFloat(cs.paddingLeft) || 0;
    const right = parseFloat(cs.paddingRight) || 0;
    slot = { x: slotEl.offsetLeft + left, y: slotEl.offsetTop, w: slotEl.offsetWidth - left - right, h: slotEl.offsetHeight };
  };
  const draw = () => {
    queued = false;
    const vw = sticky.clientWidth;
    const vh = sticky.clientHeight;
    const top = track.getBoundingClientRect().top;
    const f = heroFrame(-top, vh * 0.9, vw, vh, slot, reduced.matches);
    win.style.transform = `translate3d(${f.x}px, ${f.y}px, 0) scale(${f.scale})`;
    win.style.setProperty("--hero-radius", `${f.radius}px`);
    if (copy) {
      copy.style.opacity = String(f.copyOpacity);
      copy.style.transform = `translate3d(0, ${f.copyShift}px, 0)`;
      copy.style.visibility = f.copyOpacity === 0 ? "hidden" : "";
    }
    // Full screen and still pinned: the editor is the visitor's, and the site's header steps aside
    const pinned = f.progress >= 1 && top > -(track.offsetHeight - vh) + 1;
    win.toggleAttribute("data-live", f.progress >= 1);
    document.body.toggleAttribute("data-hero-full", pinned);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  };
  const resize = () => {
    measure();
    queue();
  };
  measure();
  draw();
  addEventListener("scroll", queue, { passive: true });
  addEventListener("resize", resize);
  reduced.addEventListener("change", queue);
  new ResizeObserver(resize).observe(slotEl);
}
