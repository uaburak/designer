/**
 * Dev Mode's private file routes (docs/editor.md D-1, D-3, D-4, D-6), dispatched by one line in api.ts once the file
 * and the caller's access are known (before api.ts refuses a caller it can't let in: a library's users read its Code
 * Connect mappings without opening the file).
 *
 *   /files/:key/dev-resources…      devResources.ts
 *   /files/:key/code-connect…       codeConnect.ts
 *   /files/:key/dev-status…         status.ts
 *   /files/:key/prototype-members…  prototype.ts
 */
import type { AccessResult } from "../../../src/shared/org/access";
import type { FileRow } from "../org/db";
import { HttpError, type Ctx } from "../org/http";

export const DEV_MODE_FILE_ROUTES = new Set(["dev-resources", "code-connect", "dev-status", "prototype-members"]);

export async function fileDevModeRoute(ctx: Ctx, f: FileRow, access: AccessResult): Promise<Response> {
  const { req, url, deps, user, parts } = ctx;
  // Dev resources, statuses and Code Connect live on main files (a branch's nodes are main's: the clients use main's key)
  const isBranch = !!(await ctx.acc.branch(f.key));
  switch (parts[2]) {
    case "dev-resources":
      if (isBranch) throw new HttpError(400, "dev resources live on the main file");
      return (await import("./devResources")).devResourcesRoute(req, url, deps, user, parts, f, access);
    case "code-connect":
      if (isBranch) throw new HttpError(400, "Code Connect lives on the main file");
      return (await import("./codeConnect")).codeConnectRoute(req, url, deps, user, parts, f, access);
    case "dev-status":
      if (!access.ok) throw new HttpError(404, "no such file");
      return (await import("./status")).devStatusRoute(req, deps, user, parts, f, access, isBranch);
    case "prototype-members":
      return (await import("./prototype")).prototypeMembersRoute(req, deps, user, parts, f, access);
  }
  throw new HttpError(404, "not found");
}
