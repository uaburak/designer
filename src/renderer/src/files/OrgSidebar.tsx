/**
 * The sidebar's entries in an organization (1.png, help.figma.com 14381406380183 "Organization and Enterprise"):
 * Drafts, All teams (Browse), the person's teams with their folders nested (opened one level at a time, as Figma's
 * file browser), Resources, Trash, and Admin for the org's admins.
 */
import { Icon, SidebarItem } from "@/ds";
import type * as O from "@shared/org/types";
import type { Location } from "./model";
import { folderKey } from "./useOrgData";
import { FolderGlyph, TeamIcon } from "./parts";
import styles from "./Files.module.css";

export interface OrgSidebarProps {
  info: O.OrgInfo | null;
  teams: O.TeamSummary[];
  folders: Record<string, O.ProjectSummary[]>;
  expanded: ReadonlySet<string>;
  onToggle: (key: string, teamId: string, parentId: string | null) => void;
  location: Location;
  go: (loc: Location) => void;
  onTeamMenu?: (e: React.MouseEvent, team: O.TeamSummary) => void;
  onFolderMenu?: (e: React.MouseEvent, folder: O.ProjectSummary) => void;
}

/** A row's fold: in the indent before a folder's glyph, at the row's end for a team (its icon sits at the left edge). */
function Disclosure({ depth, open, onToggle }: { depth: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={styles.disclosure}
      style={depth === 1 ? { right: "calc(var(--ds-size-row-inset) + var(--ds-space-2))" } : { left: `calc(var(--ds-size-row-inset) + ${depth - 2} * var(--ds-space-4) + var(--ds-space-2))` }}
      aria-label={open ? "Collapse" : "Expand"}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="16.chevron.down" />
    </button>
  );
}

function FolderBranch({ teamId, parentId, depth, props }: { teamId: string; parentId: string | null; depth: number; props: OrgSidebarProps }) {
  const { folders, expanded, onToggle, location, go, onFolderMenu } = props;
  return (
    <>
      {(folders[folderKey(teamId, parentId)] ?? []).map((f) => {
        const k = folderKey(teamId, f.id);
        const open = expanded.has(k);
        return (
          <div key={f.id} role="treeitem" aria-expanded={f.folderCount > 0 ? open : undefined} aria-level={depth}>
            <div className={styles.treeRow}>
              <SidebarItem icon={<FolderGlyph color="none" />} label={f.name} indent={depth - 1} selected={location.kind === "project" && location.projectId === f.id} onClick={() => go({ kind: "project", projectId: f.id })} onContextMenu={onFolderMenu ? (e) => onFolderMenu(e, f) : undefined} />
              {f.folderCount > 0 && <Disclosure depth={depth} open={open} onToggle={() => onToggle(k, teamId, f.id)} />}
            </div>
            {open && (
              <div role="group">
                <FolderBranch teamId={teamId} parentId={f.id} depth={depth + 1} props={props} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function OrgSidebar(props: OrgSidebarProps) {
  const { info, teams, expanded, onToggle, location, go, onTeamMenu } = props;
  const is = (kind: Location["kind"]) => location.kind === kind;
  return (
    <div className={styles.navGroup}>
      <SidebarItem icon="24.file" label="Drafts" selected={is("org-drafts")} onClick={() => go({ kind: "org-drafts" })} />
      <SidebarItem icon="24.view.grid" label="All teams" selected={is("teams")} onClick={() => go({ kind: "teams" })} />
      <div role="tree" aria-label="Teams">
        {teams.map((t) => {
          const k = folderKey(t.id, null);
          const open = expanded.has(k);
          return (
            <div key={t.id} role="treeitem" aria-expanded={t.projectCount > 0 ? open : undefined} aria-level={1}>
              <div className={styles.treeRow}>
                <SidebarItem icon={<TeamIcon name={t.name} src={t.icon} />} label={t.name} indent={0} selected={location.kind === "team" && location.teamId === t.id} onClick={() => go({ kind: "team", teamId: t.id })} onContextMenu={onTeamMenu ? (e) => onTeamMenu(e, t) : undefined} />
                {t.projectCount > 0 && <Disclosure depth={1} open={open} onToggle={() => onToggle(k, t.id, null)} />}
              </div>
              {open && (
                <div role="group">
                  <FolderBranch teamId={t.id} parentId={null} depth={2} props={props} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <SidebarItem icon="24.library" label="Resources" selected={is("resources")} onClick={() => go({ kind: "resources" })} />
      <SidebarItem icon="24.trash.outline" label="Trash" selected={is("org-trash")} onClick={() => go({ kind: "org-trash" })} />
      {(info?.role === "admin" || !!info?.workspaceAdminOf.length || !!info?.billingGroupAdminOf.length) && <SidebarItem icon="24.settings.small" label="Admin" selected={is("admin")} onClick={() => go({ kind: "admin" })} />}
    </div>
  );
}
