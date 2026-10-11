/**
 * Who someone is to a branch (docs/data.md §15.1, §15.7): "anyone with access to main can open its branches" — the
 * branch resolves through its main file (`resolveAccess(main)`, org/db.ts `Access.file`), then:
 * - the branch's creator edits it (Figma: a viewer of main who may copy can branch, and works in their branch), but
 *   shares and manages only as main allows;
 * - an archived or merged branch is read-only (§15.5).
 * Pure; no imports but types, so org/db.ts can use it without a cycle.
 */
import type { AccessResult } from "../../src/shared/org/access";

/** A row of `branches` (migration 0011) */
export interface BranchRow {
  key: string;
  main_key: string;
  name: string;
  status: "active" | "archived" | "merged";
  created_by: string;
  created_at: number;
  base_seq: number;
  main_seen_seq: number;
  session_base: number;
  archived_at: number | null;
  archived_by: string | null;
  merged_at: number | null;
  merged_by: string | null;
  merge_version: string | null;
}

export function branchAccess(main: AccessResult, b: Pick<BranchRow, "created_by" | "status">, userId: string): AccessResult {
  if (!main.ok) return main;
  let r = main;
  if (b.created_by === userId && r.capped !== "seat" && !r.trashed && !r.canEdit) {
    r = { ...r, role: "editor", roomRole: r.roomRole === "owner" ? "owner" : "editor", canEdit: true, canComment: true, canExport: true, via: r.via.includes("file") ? r.via : [...r.via, "file"] };
  }
  if (b.status !== "active" && (r.canEdit || r.roomRole !== "viewer")) r = { ...r, canEdit: false, roomRole: "viewer" };
  return r;
}
