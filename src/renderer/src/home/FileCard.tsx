import { memo, useState } from "react";
import type { ProjectMeta } from "@/types/project";
import { cn } from "@/lib/utils";
import { FileKind, StarIcon } from "@/app/icons";
import { ago, longDate } from "./time";

/**
 * A project in the home's lists: Figma's file card (its cover over its kind,
 * name and when it was edited) or a row of the list view. A click opens it;
 * ⌘ or ⇧ with the click selects; the right click opens its menu.
 */

/** Covers for a project without a picture: a colour of its own (by its slug), its name over it — as the covers of Figma's files. */
const COVERS: [string, string][] = [
  ["#5551ff", "#5551ff"],
  ["#071c2c", "#13a4a0"],
  ["#22c55e", "#16a34a"],
  ["#070712", "#3b0764"],
  ["#4c6fff", "#3b5bfd"],
  ["#0b1220", "#0e7490"],
  ["#ff2e63", "#e11d48"],
  ["#1c1917", "#ea580c"],
];

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function Thumbnail({ project, large = true }: { project: ProjectMeta; large?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (project.coverImage && !broken) {
    return <img src={project.coverImage} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} className="absolute inset-0 w-full h-full object-cover" />;
  }
  const [from, to] = COVERS[hash(project.slug) % COVERS.length];
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-white text-center" style={{ background: from === to ? from : `radial-gradient(120% 120% at 85% 0%, ${to} 0%, ${from} 62%)` }}>
      {large && <span className="text-[8px] font-[700] uppercase tracking-[0.18em] opacity-80">burakkoc.net</span>}
      <span className={cn("max-w-full font-[750] leading-[1.05] tracking-[-0.03em] line-clamp-2", large ? "text-[26px]" : "text-[9px]")}>{project.title || project.slug}</span>
    </div>
  );
}

/** Where it stands on the site: live (as saved, or saved since), or nothing for a draft. */
export function SiteStatus({ project, className }: { project: ProjectMeta; className?: string }) {
  if (!project.published) return null;
  const changed = project.changedSincePublish;
  return (
    <span
      title={changed ? "On the site — saved since it was published: Publish again to update it" : "On the site, as saved"}
      className={cn("inline-flex items-center gap-1 h-5 px-1.5 rounded-[4px] text-[10px] font-[500] leading-none whitespace-nowrap", className)}
      style={{ color: changed ? "var(--home-changed)" : "var(--home-live)", background: `color-mix(in srgb, ${changed ? "var(--home-changed)" : "var(--home-live)"} 14%, transparent)` }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {changed ? "Changed" : "Live"}
    </span>
  );
}

export interface CardProps {
  project: ProjectMeta;
  selected: boolean;
  starred: boolean;
  open: boolean;
  /** "Edited 10 minutes ago", "Deleted 2 days ago" */
  when: "edited" | "trashed";
  draggable: boolean;
  dropSide: "before" | "after" | null;
  onPress: (slug: string, e: React.MouseEvent) => void;
  onMenu: (slug: string, e: React.MouseEvent) => void;
  onDragStart: (slug: string) => void;
  onDragOver: (slug: string, e: React.DragEvent) => void;
  onDrop: (slug: string) => void;
  onDragEnd: () => void;
}

const whenOf = (project: ProjectMeta, when: CardProps["when"]) => (when === "trashed" ? `Deleted ${ago(project.trashedAt)}` : project.updatedAt ? `Edited ${ago(project.updatedAt)}` : "Not saved yet");

export const FileCard = memo(function FileCard({ project, selected, starred, open, when, draggable, dropSide, onPress, onMenu, onDragStart, onDragOver, onDrop, onDragEnd }: CardProps) {
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={project.title || project.slug}
      aria-selected={selected}
      draggable={draggable}
      onClick={(e) => onPress(project.slug, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(project.slug, e);
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", project.slug);
        onDragStart(project.slug);
      }}
      onDragOver={(e) => onDragOver(project.slug, e)}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(project.slug);
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative flex flex-col rounded-[8px] border bg-[var(--f-bg)] transition-[border-color,box-shadow]",
        selected ? "border-[var(--f-border-selected)] shadow-[0_0_0_1px_var(--f-border-selected)]" : "border-[var(--home-card-border)] hover:border-[var(--home-card-border-hover)]"
      )}
    >
      {dropSide && <span aria-hidden className={cn("absolute top-0 bottom-0 w-[3px] rounded-full bg-[var(--f-border-selected)]", dropSide === "before" ? "-left-[18px]" : "-right-[18px]")} />}
      <div className="relative aspect-video overflow-hidden rounded-t-[7px] bg-[var(--home-thumb)]">
        <Thumbnail project={project} />
        {starred && (
          <span title="Starred" className="absolute top-2 right-2 flex items-center justify-center w-6 h-6 rounded-[5px] bg-black/45 text-[#ffc700]">
            <StarIcon size={20} filled />
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 h-[58px] px-4 border-t border-[var(--home-card-border)]">
        <FileKind kind="design" />
        <div className="min-w-0 flex-1 flex flex-col">
          <span className="truncate text-[11px] font-[500] leading-4 text-[var(--f-text)]">{project.title || project.slug}</span>
          <span className="truncate text-[11px] leading-4 text-[var(--f-text-secondary)]" title={longDate(when === "trashed" ? project.trashedAt : project.updatedAt)}>
            {whenOf(project, when)}
            {open && " · Open"}
          </span>
        </div>
        <SiteStatus project={project} />
      </div>
    </div>
  );
});

export const FileRow = memo(function FileRow({ project, selected, starred, open, when, draggable, dropSide, onPress, onMenu, onDragStart, onDragOver, onDrop, onDragEnd }: CardProps) {
  return (
    <div
      role="row"
      aria-selected={selected}
      draggable={draggable}
      onClick={(e) => onPress(project.slug, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(project.slug, e);
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", project.slug);
        onDragStart(project.slug);
      }}
      onDragOver={(e) => onDragOver(project.slug, e)}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(project.slug);
      }}
      onDragEnd={onDragEnd}
      className={cn("relative grid grid-cols-[minmax(0,1fr)_96px_150px_150px] items-center gap-4 h-12 px-2 rounded-[6px] text-[11px] leading-4", selected ? "bg-[var(--home-nav-selected)]" : "hover:bg-[var(--f-bg-hover)]")}
    >
      {dropSide && <span aria-hidden className={cn("absolute left-2 right-2 h-[2px] rounded-full bg-[var(--f-border-selected)]", dropSide === "before" ? "-top-px" : "-bottom-px")} />}
      <div className="flex items-center gap-3 min-w-0">
        <span className="relative w-14 h-8 shrink-0 overflow-hidden rounded-[4px] border border-[var(--home-card-border)] bg-[var(--home-thumb)]">
          <Thumbnail project={project} large={false} />
        </span>
        <span className="min-w-0 flex flex-col">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate font-[500] text-[var(--f-text)]">{project.title || project.slug}</span>
            {starred && <StarIcon size={16} filled className="shrink-0 text-[#ffc700]" />}
          </span>
          <span className="truncate text-[var(--f-text-secondary)]">
            {[project.category, project.year].filter(Boolean).join(" · ") || project.slug}
            {open && " · Open"}
          </span>
        </span>
      </div>
      <div>{project.published ? <SiteStatus project={project} /> : <span className="text-[var(--f-text-tertiary)]">Draft</span>}</div>
      <div className="truncate text-[var(--f-text-secondary)]" title={longDate(when === "trashed" ? project.trashedAt : project.updatedAt)}>{when === "trashed" ? ago(project.trashedAt) : ago(project.updatedAt) || "—"}</div>
      <div className="truncate text-[var(--f-text-secondary)]">{longDate(project.createdAt)}</div>
    </div>
  );
});
