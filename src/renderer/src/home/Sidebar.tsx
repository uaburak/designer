import { memo, useRef, type ReactNode } from "react";
import type { User } from "firebase/auth";
import type { ProjectMeta } from "@/types/project";
import { cn } from "@/lib/utils";
import { fi } from "@/components/admin/figmaIcons";
import { ClockIcon, FileIcon, FileKind, GlobeIcon, GridIcon, LibraryIcon, PersonIcon, SearchIcon, TrashIcon } from "@/app/icons";
import { setBrowse, useBrowse } from "./prefs";

/**
 * The home's left side, as Figma's file browser: the account, search, the
 * views (Recents, Published), the site — burakkoc.net, the team — with its
 * drafts, all its projects, its library, its CV and its trash, then the
 * starred files.
 */

export type ViewKind = "recents" | "published" | "drafts" | "all" | "library" | "trash" | "search";

function NavItem({ icon, label, active, onClick, count, onContextMenu }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void; count?: number; onContextMenu?: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      aria-current={active || undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn("flex items-center gap-1 w-full h-8 pl-1 pr-2 rounded-[6px] text-left text-[11px] leading-4 transition-colors", active ? "bg-[var(--home-nav-selected)] text-[var(--f-text)]" : "text-[var(--f-text)] hover:bg-[var(--f-bg-hover)]")}
    >
      <span className="flex items-center justify-center w-6 h-6 shrink-0 text-[var(--f-icon)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && <span className="shrink-0 tabular-nums text-[var(--f-text-tertiary)]">{count}</span>}
    </button>
  );
}

interface Props {
  user: User;
  view: ViewKind;
  query: string;
  onQuery: (query: string) => void;
  onView: (view: ViewKind) => void;
  starred: ProjectMeta[];
  counts: { drafts: number; trash: number };
  onOpen: (slug: string) => void;
  onOpenCv: () => void;
  onAccountMenu: (el: HTMLElement) => void;
  onStarredMenu: (slug: string, e: React.MouseEvent) => void;
}

export const Sidebar = memo(function Sidebar({ user, view, query, onQuery, onView, starred, counts, onOpen, onOpenCv, onAccountMenu, onStarredMenu }: Props) {
  const { starredOpen } = useBrowse();
  const search = useRef<HTMLInputElement>(null);
  const name = user.displayName?.split(" ")[0]?.toLowerCase() ?? user.email?.split("@")[0] ?? "account";
  return (
    <aside className="flex flex-col w-60 shrink-0 h-full border-r border-[var(--f-border)] bg-[var(--f-bg)] select-none">
      {/* The account */}
      <div className="flex items-center h-12 px-3 shrink-0">
        <button type="button" aria-haspopup="menu" onClick={(e) => onAccountMenu(e.currentTarget)} className="flex items-center gap-2 min-w-0 h-8 pl-1 pr-1.5 -ml-1 rounded-[6px] hover:bg-[var(--f-bg-hover)]">
          <span className="flex items-center justify-center w-6 h-6 shrink-0 overflow-hidden rounded-full bg-[var(--f-bg-tertiary)] text-[var(--f-icon-secondary)]">
            {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" /> : <PersonIcon size={20} />}
          </span>
          <span className="min-w-0 truncate text-[13px] font-[600] leading-5 tracking-[-0.0325px]">{name}</span>
          <span className="shrink-0 text-[var(--f-icon-secondary)]">{fi("16.chevron.down")}</span>
        </button>
      </div>

      {/* Search */}
      <div className="px-2 pb-2 shrink-0">
        <label className="flex items-center gap-1 h-8 pl-1 pr-2 rounded-[6px] bg-[var(--home-field)] border border-transparent focus-within:border-[var(--f-border-selected)] text-[var(--f-icon-secondary)]">
          <span className="flex items-center justify-center w-6 h-6 shrink-0"><SearchIcon size={20} /></span>
          <input
            ref={search}
            data-home-search=""
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onQuery("");
                search.current?.blur();
              }
            }}
            placeholder="Search"
            aria-label="Search files"
            spellCheck={false}
            className="min-w-0 flex-1 h-full bg-transparent text-[11px] leading-4 text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)] outline-none"
          />
        </label>
      </div>

      <nav aria-label="Views" className="flex flex-col gap-px px-2 pb-2 shrink-0">
        <NavItem icon={<ClockIcon />} label="Recents" active={view === "recents"} onClick={() => onView("recents")} />
        <NavItem icon={<GlobeIcon />} label="Published" active={view === "published"} onClick={() => onView("published")} />
      </nav>

      <div className="h-px bg-[var(--f-border)] shrink-0" />

      {/* The site, as Figma's team */}
      <nav aria-label="burakkoc.net" className="flex flex-col gap-px px-2 py-2 shrink-0">
        <div className="flex items-center gap-2 h-10 pl-1.5 pr-1">
          <span className="flex items-center justify-center w-5 h-5 shrink-0 rounded-full bg-[#14ae5c] text-[10px] font-[700] text-white">B</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-[600] leading-5 tracking-[-0.0325px]">burakkoc.net</span>
          <span className="shrink-0 h-5 px-1.5 rounded-[4px] bg-[var(--home-badge-bg)] text-[var(--home-badge-text)] text-[11px] leading-5">Admin</span>
        </div>
        <NavItem icon={<FileIcon />} label="Drafts" count={counts.drafts} active={view === "drafts"} onClick={() => onView("drafts")} />
        <NavItem icon={<GridIcon />} label="All projects" active={view === "all"} onClick={() => onView("all")} />
        <NavItem icon={<LibraryIcon />} label="Library" active={view === "library"} onClick={() => onView("library")} />
        <NavItem icon={<PersonIcon />} label="CV" onClick={onOpenCv} />
        <NavItem icon={<TrashIcon />} label="Trash" count={counts.trash} active={view === "trash"} onClick={() => onView("trash")} />
      </nav>

      <div className="h-px bg-[var(--f-border)] shrink-0" />

      {/* Starred */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        <button type="button" onClick={() => setBrowse({ starredOpen: !starredOpen })} className="flex items-center gap-0.5 h-8 pl-0 pr-2 text-[11px] font-[600] leading-4 text-[var(--f-text)]">
          <span className={cn("flex text-[var(--f-icon-secondary)] transition-transform", !starredOpen && "-rotate-90")}>{fi("16.chevron.down")}</span>
          Starred
        </button>
        {starredOpen && (
          <div className="flex flex-col gap-px">
            {starred.length === 0 && <p className="pl-2 pr-2 py-1 text-[11px] leading-4 text-[var(--f-text-tertiary)]">Star a project (right-click it) to keep it here.</p>}
            {starred.map((p) => (
              <NavItem key={p.slug} icon={<FileKind kind="design" size={16} />} label={p.title || p.slug} onClick={() => onOpen(p.slug)} onContextMenu={(e) => { e.preventDefault(); onStarredMenu(p.slug, e); }} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
});
