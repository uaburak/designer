/**
 * Home's Import (and .fig files dropped) while an org is the space shown (docs/multiplayer.md §5.1, §14.6): as Figma,
 * the file lands where the person is — the org's Drafts or the folder shown — not in the local Drafts. The .fig is
 * imported as a local copy with its org `space` set from the start (so it never lists among local Drafts), then
 * registered and uploaded through `shareTo`, the path "Move to" a folder and a new org file take — its snapshot and
 * every image in the upload panel, the destination named. Refused before the upload finished: the copy goes again
 * (nothing stray is left); registered but not all uploaded: the copy stays and its link finishes the upload.
 * Imports nothing from Node or the DOM (both stores run it).
 */
import { StoreError } from "../../shared/store/protocol";
import type { FileKey, FileMeta, FileSpace, OrgImportPlace } from "../../shared/store/types";
import type { MultiplayerService } from "./service";
import { t as tr } from "../../shared/i18n";

export interface OrgImportDeps {
  mp: Pick<MultiplayerService, "newRoomKey" | "shareTo" | "call" | "signedIn">;
  /** The folder's team (an org folder lives in one) */
  teamOf(projectId: string): Promise<string>;
  /** The .fig imported as a local copy with this `space` (hidden from the local Drafts from the start) */
  importLocal(space: FileSpace): Promise<FileMeta>;
  headSnapshot(fileKey: FileKey): Promise<Uint8Array>;
  deleteLocal(fileKey: FileKey): Promise<void>;
  /** The org's list that shows the new file is read again (its `files.changed` event) */
  filesChanged(orgId: string, projectId: string | null): void;
  log(level: "warn", message: string, detail?: unknown): void;
}

/** A share registered on the server whose content didn't finish uploading (MultiplayerService.shareTo's `upload_incomplete`) */
const pendingUpload = (e: unknown): boolean => e instanceof StoreError && (e.detail as { pendingUpload?: unknown } | undefined)?.pendingUpload === true;

/** Checks the place a page names (`files.importFigBytes`'s fourth argument) */
export function cleanOrgPlace(v: unknown): OrgImportPlace | null {
  if (v === undefined || v === null) return null;
  const p = v as Partial<OrgImportPlace>;
  if (typeof p.orgId !== "string" || !p.orgId || (p.projectId !== null && p.projectId !== undefined && typeof p.projectId !== "string")) throw new StoreError("invalid", "bad import place");
  return { orgId: p.orgId, projectId: p.projectId ?? null };
}

export async function importIntoOrg(d: OrgImportDeps, place: OrgImportPlace): Promise<FileMeta> {
  if (!d.mp.signedIn) throw new StoreError("offline", tr("Log in to import into an organization"));
  const { orgId, projectId } = place;
  const teamId = projectId ? await d.teamOf(projectId) : null;
  const key = d.mp.newRoomKey("file");
  const space: FileSpace = { orgId, key, teamId, projectId };
  const meta = await d.importLocal(space);
  try {
    const snapshot = await d.headSnapshot(meta.fileKey);
    await d.mp.shareTo(meta.fileKey, { snapshot, headSeq: 0 }, (k, name) => d.mp.call("POST", "/files", { key: k, name, orgId, ...(projectId ? { projectId } : {}) }), key);
  } catch (e) {
    // On the server already, its content still uploading: the copy is the org file (its link uploads the rest)
    if (pendingUpload(e)) {
      d.filesChanged(orgId, projectId);
      throw e;
    }
    await d.deleteLocal(meta.fileKey).catch((err) => d.log("warn", `import: removing the unregistered copy ${meta.fileKey} failed`, err));
    throw e;
  }
  d.filesChanged(orgId, projectId);
  return meta;
}
