import { memo, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { HOME } from "./tabs";
import { CloseIcon, HomeIcon, PlayIcon, PlusIcon } from "./icons";

/**
 * The window's top: Figma's desktop tab bar — the traffic lights' room,
 * Home, the open files (each its kind's glyph and its name; × on hover, a
 * dot while unsaved), + for a new project. Its free room moves the window;
 * a tab is dragged sideways to its new place, a middle click closes it.
 */

/** The glyph of a design file, as Figma's tabs draw it (16px, the text's colour). */
function DesignGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" aria-hidden>
      <path d="M8 2.5l3.5 5-1.5 4.5H6L4.5 7.5z" />
      <path d="M8 2.5v4" />
      <circle cx="8" cy="7.3" r="0.8" fill="currentColor" stroke="none" />
      <path d="M6 13.5h4" />
    </svg>
  );
}

/** The CV's glyph: a page with its lines. */
function CvGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" aria-hidden>
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M6 7.5h4M6 9.5h4M6 11.5h2.5" />
    </svg>
  );
}

/** A tab as the bar draws it. */
export interface TabBarTab {
  id: string;
  kind: string;
  title: string;
  dirty: boolean;
  status?: string;
}

interface Props {
  tabs: TabBarTab[];
  /** Room at the left for the traffic lights (none in full screen, or in a browser) */
  room: number;
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, to: number) => void;
  onNew: () => void;
  onTabMenu: (id: string, e: React.MouseEvent) => void;
}

export const TabBar = memo(function TabBar({ tabs, room, active, onActivate, onClose, onMove, onNew, onTabMenu }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ id: string; dx: number } | null>(null);

  /** A press on a tab: a click brings it forward; a drag sideways moves it among the others. */
  const press = (id: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    onActivate(id);
    const startX = e.clientX;
    const el = e.currentTarget;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      setDragging({ id, dx });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
      if (!moved || !strip.current) return;
      // Its new place: before the first tab whose middle is past the dragged tab's middle.
      const own = el.getBoundingClientRect();
      const middle = own.left + own.width / 2 + (ev.clientX - startX);
      const others = [...strip.current.querySelectorAll<HTMLElement>("[data-tab-id]")].filter((t) => t.dataset.tabId !== id);
      let to = others.findIndex((t) => {
        const r = t.getBoundingClientRect();
        return middle < r.left + r.width / 2;
      });
      if (to < 0) to = others.length;
      onMove(id, to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const homeActive = active === HOME;
  return (
    <div role="tablist" aria-label="Tabs" className="app-drag relative flex items-stretch h-[var(--tabbar-height)] shrink-0 bg-[var(--tabbar-bg)] select-none text-[11px] leading-4" style={{ paddingLeft: room }}>
      <button
        type="button"
        role="tab"
        aria-selected={homeActive}
        aria-label="Home"
        title="Home (⌘1)"
        onClick={() => onActivate(HOME)}
        className={cn("app-no-drag flex items-center justify-center w-14 shrink-0 transition-colors", homeActive ? "bg-[var(--f-bg)] text-[var(--f-icon)]" : "text-[var(--tabbar-text-secondary)] hover:bg-[var(--tabbar-hover)] hover:text-[var(--tabbar-text)]")}
      >
        <HomeIcon />
      </button>
      <div ref={strip} className="flex items-stretch min-w-0">
        {tabs.map((tab, i) => {
          const isActive = tab.id === active;
          // Lines between two tabs at rest — none beside the one in front.
          const line = !isActive && tabs[i + 1]?.id !== active;
          const drag = dragging?.id === tab.id ? ({ transform: `translateX(${dragging.dx}px)`, zIndex: 2, position: "relative" } satisfies CSSProperties) : undefined;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={isActive}
              title={tab.status === "crashed" ? `${tab.title} — crashed` : tab.status === "unresponsive" ? `${tab.title} — not responding` : tab.title}
              onPointerDown={press(tab.id)}
              onAuxClick={(e) => e.button === 1 && onClose(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onTabMenu(tab.id, e);
              }}
              style={drag}
              className={cn(
                "app-no-drag group/tab relative flex items-center gap-2 min-w-[96px] max-w-[220px] shrink pl-3 pr-1.5 transition-colors",
                isActive ? "bg-[var(--f-bg)] text-[var(--f-text)]" : "text-[var(--tabbar-text-secondary)] hover:bg-[var(--tabbar-hover)] hover:text-[var(--tabbar-text)]",
                dragging?.id === tab.id && "shadow-[0_0_0_1px_var(--tabbar-divider)]"
              )}
            >
              <span className="flex shrink-0">{tab.kind === "preview" ? <PlayIcon /> : tab.kind === "cv" ? <CvGlyph /> : <DesignGlyph />}</span>
              <span className={cn("min-w-0 flex-1 truncate", isActive && "font-[500]")}>{tab.title}</span>
              <span className="relative flex items-center justify-center w-5 h-5 shrink-0">
                {tab.dirty && <span aria-label="Unsaved changes" className={cn("w-2 h-2 rounded-full bg-current opacity-70", "group-hover/tab:hidden")} />}
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  title="Close tab (⌘W)"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                  className={cn("absolute inset-0 items-center justify-center rounded-[4px] hover:bg-black/10 dark:hover:bg-white/10", tab.dirty ? "hidden group-hover/tab:flex" : isActive ? "flex" : "hidden group-hover/tab:flex")}
                >
                  <CloseIcon />
                </button>
              </span>
              {line && <span aria-hidden className="absolute right-0 top-0 bottom-0 w-px bg-[var(--tabbar-divider)]" />}
            </div>
          );
        })}
      </div>
      <button type="button" aria-label="New project" title="New project (⌘N)" onClick={onNew} className="app-no-drag flex items-center justify-center w-10 shrink-0 text-[var(--tabbar-text-secondary)] hover:text-[var(--tabbar-text)] transition-colors">
        <PlusIcon size={20} />
      </button>
      <div className="flex-1 min-w-4" />
    </div>
  );
});
