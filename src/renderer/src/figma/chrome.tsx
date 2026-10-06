/**
 * The editor's chrome around the canvas and the panels: Figma's colours (its
 * UI kit's tokens), the navigation tabs, the toolbar's tools and views, Save
 * and Publish with what they say, the account, the zoom, and the prototype
 * preview's window.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fi } from "@/components/admin/figmaIcons";
import type { EditSession } from "./session";
import type { useAccount } from "./account";
import { BrandButton } from "./ui";
import { useView } from "./useView";
import type { ViewStore } from "./view";

export { FIGMA_TOKENS } from "./tokens";

/** A tab of the navigation bar: its icon alone — its name the tooltip. */
export function NavTab({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} data-tip={label} aria-pressed={active} onClick={onClick} className="group/nav flex w-12 items-center justify-center py-1 cursor-pointer select-none">
      <span className={cn("flex items-center justify-center w-7 h-7 rounded-[5px] transition-colors", active ? "bg-[var(--f-bg-selected)] text-[var(--f-text-brand)]" : "text-[var(--f-icon)] group-hover/nav:bg-[var(--f-bg-hover)]")}>{icon}</span>
    </button>
  );
}

/** Save, as Figma's Share in its place: what it says — unsaved (a dot), saving, saved, failed (its reason as its tooltip). */
export function SaveButton({ session }: { session: EditSession }) {
  const { saveState, dirty } = session;
  const label = saveState.kind === "saving" ? "Saving…" : saveState.kind === "saved" && !dirty ? "Saved" : saveState.kind === "error" || saveState.kind === "conflict" ? "Not saved" : "Save";
  const tip = saveState.kind === "error" ? saveState.message : saveState.kind === "conflict" ? "Saved elsewhere since it was opened" : saveState.kind === "saved" && saveState.warning ? saveState.warning : dirty ? "Unsaved changes (⌘S)" : "Everything is saved";
  return (
    <BrandButton disabled={saveState.kind === "saving"} onClick={() => void session.save()} className={cn("relative", (saveState.kind === "error" || saveState.kind === "conflict") && "bg-[#f24822]")} title={tip}>
      {label}
      {dirty && saveState.kind !== "saving" && <span aria-label="Unsaved changes" className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#ffc700] ring-2 ring-[var(--f-bg)]" />}
    </BrandButton>
  );
}

/** A save refused (saved elsewhere since) or failed: what happened, and what can be done. */
export function SaveProblem({ session }: { session: EditSession }) {
  const { saveState } = session;
  if (saveState.kind !== "conflict" && saveState.kind !== "error" && !(saveState.kind === "saved" && saveState.warning)) return null;
  const conflict = saveState.kind === "conflict";
  const part = conflict ? { project: "This project", library: "The components", variables: "The variables", textStyles: "The text styles" }[saveState.part] : "";
  return (
    <div role="alert" className="absolute top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 max-w-[560px] min-h-10 py-2 pl-3 pr-2 rounded-[9px] bg-[var(--f-bg-menu)] text-white text-[11px] leading-4 shadow-[0_2px_12px_rgba(0,0,0,0.25)]">
      <span className="min-w-0 flex-1">
        {conflict ? `${part} was saved somewhere else (another tab?) since it was opened. Overwrite it with what is here, or reload to get that version (what isn't saved here is lost).` : saveState.kind === "error" ? `Couldn't save: ${saveState.message}` : saveState.kind === "saved" ? saveState.warning : null}
      </span>
      {conflict && (
        <>
          <button type="button" onClick={() => void session.save(true)} className="shrink-0 h-7 px-2.5 rounded-[5px] bg-[#f24822] hover:brightness-110 cursor-pointer">Overwrite</button>
          <button type="button" onClick={() => window.location.reload()} className="shrink-0 h-7 px-2.5 rounded-[5px] bg-white/10 hover:bg-white/20 cursor-pointer">Reload</button>
        </>
      )}
      {saveState.kind === "error" && <button type="button" onClick={() => void session.save()} className="shrink-0 h-7 px-2.5 rounded-[5px] bg-white/10 hover:bg-white/20 cursor-pointer">Try again</button>}
    </div>
  );
}

/** Publish: the saved project on the site — "Published" once it is there as it is saved, "Update" when it was saved since. */
export function PublishButton({ session }: { session: EditSession }) {
  const { meta, publishState, dirty } = session;
  if (!meta) return null;
  const busy = publishState.kind === "publishing";
  const current = meta.published && !meta.changedSincePublish && !dirty;
  const label = busy ? "Publishing…" : !meta.published ? "Publish" : current ? "Republish" : "Update";
  const tip = publishState.kind === "error" ? publishState.message : !meta.published ? "Draft — not on the site yet. Publish saves and puts it there." : current ? "The site shows this version — publish it again to take in what changed in the components, variables or text styles since" : "The site shows an older version: update it";
  return (
    <button type="button" disabled={busy} title={tip} onClick={() => void session.publish()} className={cn("h-6 px-2 rounded-[5px] text-[11px] font-[550] leading-4 border transition-colors cursor-pointer disabled:cursor-default", current ? "border-transparent text-[var(--f-text-secondary)] hover:text-[var(--f-text)] hover:bg-[var(--f-bg-hover)]" : "border-[var(--f-border)] text-[var(--f-text)] hover:bg-[var(--f-bg-hover)]", publishState.kind === "error" && "border-[#f24822] text-[#f24822]")}>
      {label}
    </button>
  );
}

/** The person at the panel's corner (Figma's avatar with its chevron): their photo, or a plain circle until there is a sign-in (see account.ts). */
export function AccountButton({ account, onClick }: { account: ReturnType<typeof useAccount>; onClick: (el: HTMLElement) => void }) {
  return (
    <button type="button" aria-label="Account" aria-haspopup="menu" onClick={(e) => onClick(e.currentTarget)} className="flex items-center gap-0.5 h-8 pl-1 pr-0.5 rounded-[5px] cursor-pointer hover:bg-[var(--f-bg-hover)] text-[var(--f-icon-secondary)]">
      <span className="flex items-center justify-center w-6 h-6 overflow-hidden rounded-full bg-[var(--f-bg-tertiary)] text-[var(--f-icon-secondary)]">
        {account.photoURL ? <img src={account.photoURL} alt={account.name ?? ""} className="w-full h-full object-cover" /> : <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden><circle cx="8" cy="6" r="2.75" /><path d="M2.75 14c.4-2.6 2.5-4 5.25-4s4.85 1.4 5.25 4z" /></svg>}
      </span>
      {fi("16.chevron.down")}
    </button>
  );
}

/** One of the editor's views at the toolbar's end: a tab as the panels' (Design / Prototype), as tall as the tools. */
export function ModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={cn("h-8 px-2.5 rounded-[5px] text-[11px] leading-4 tracking-[0.055px] whitespace-nowrap cursor-pointer transition-colors", active ? "font-[550] text-[var(--f-text)] bg-[var(--f-bg-secondary)]" : "font-[450] text-[var(--f-text-secondary)] hover:text-[var(--f-text)] hover:bg-[var(--f-bg-hover)]")}>
      {label}
    </button>
  );
}

/** A toolbar tool, as the kit's: a 24px icon in a 32px box, blue while in use; a 16px chevron opens its menu. */
export function Tool({ icon, label, shortcut, active = false, onClick, menu, menuLabel }: { icon: ReactNode; label: string; shortcut?: string; active?: boolean; onClick: () => void; menu?: (el: HTMLElement) => void; menuLabel?: string }) {
  return (
    <div className="relative group/tool flex items-center gap-px">
      <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={cn("flex items-center justify-center w-8 h-8 rounded-[5px] transition-colors cursor-pointer", active ? "bg-[var(--f-bg-brand)] text-white" : "text-[var(--f-icon)] hover:bg-[var(--f-bg-hover)]")}>
        {icon}
      </button>
      {menu && (
        <button type="button" aria-label={menuLabel ?? `${label} menu`} onClick={(e) => menu(e.currentTarget)} className="flex items-center justify-center w-4 h-8 rounded-[5px] text-[var(--f-icon-secondary)] hover:bg-[var(--f-bg-hover)] cursor-pointer">
          {fi("16.chevron.down")}
        </button>
      )}
      <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 z-50 hidden group-hover/tool:inline-flex items-center gap-2 h-7 px-2.5 rounded-[6px] bg-[var(--f-bg-menu)] text-[11px] font-medium text-white whitespace-nowrap">
        {label}
        {shortcut && <span className="text-white/50">{shortcut}</span>}
      </span>
    </div>
  );
}

/** The zoom as the chrome shows it ("50%"), following the view. */
export function ZoomPercent({ store }: { store: ViewStore }) {
  return <>{Math.round(useView(store).zoom * 100)}%</>;
}
