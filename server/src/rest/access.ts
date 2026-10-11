/**
 * Who the REST caller is to a file (docs/multiplayer.md §16.7: "view" and "edit" are `resolveAccess` on the file).
 * Naming a file by its key is opening it by its link, as on the private API; a link password is never passed over
 * REST, so a file that needs one answers 403. Scopes never widen access (§16.1).
 */
import type { AccessGranted } from "../../../src/shared/org/access";
import { type FileRow } from "../org/db";
import { RestError, type RestCtx } from "./http";

export interface FileAccess {
  f: FileRow;
  a: AccessGranted;
}

export async function fileFor(ctx: RestCtx, key: string, need: "view" | "edit" | "comment" = "view"): Promise<FileAccess> {
  if (ctx.caller.kind === "plan") throw new RestError(403, "A plan access token can't read files");
  const f = await ctx.acc.fileRow(key);
  if (!f) throw new RestError(404, "Not found");
  const a = await ctx.acc.file(f, { viaLink: true, passOk: false });
  if (!a.ok) {
    if (a.reason === "password_required") throw new RestError(403, "This file needs a password");
    if (a.reason === "gone") throw new RestError(404, "Not found");
    throw new RestError(404, "Not found");
  }
  // Prototype-only people (docs/editor.md D-6) see the presentation, not the file's content.
  if (a.prototypeOnly) throw new RestError(403, "You only have access to this file's prototype");
  if (need === "edit" && (!a.canEdit || a.trashed)) throw new RestError(403, a.capped === "seat" ? "Your seat can't edit this file" : "You can only view this file");
  if (need === "comment" && !a.canComment) throw new RestError(403, "You can't comment on this file");
  return { f, a };
}

/** Variables need a Full seat in orgs (§16.7; Figma: Enterprise full members) */
export async function requireFullSeat(ctx: RestCtx, f: FileRow): Promise<void> {
  if (!f.org_id) return;
  const m = await ctx.acc.membership(f.org_id);
  if (!m || m.seat !== "full") throw new RestError(403, "Variables need a Full seat in this organization");
}
