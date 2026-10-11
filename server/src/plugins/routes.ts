/**
 * Private plugins and approval (docs/plugins.md §10), dispatched by api.ts:
 *   /plugins…                    private.ts pluginsRoute
 *   /orgs/:org/plugins           private.ts orgPluginsRoute
 *   /orgs/:org/plugins/approved  approvals.ts (members)
 *   /orgs/:org/plugins/requests  approvals.ts (members)
 *   /orgs/:org/admin/plugins…    approvals.ts (admins)
 */
import { HttpError, type Ctx } from "../org/http";

export async function pluginRoutes(ctx: Ctx): Promise<Response> {
  const { parts } = ctx;
  if (parts[0] === "plugins" && parts.length >= 2) return (await import("./private")).pluginsRoute(ctx);
  if (parts[0] === "orgs" && parts[2] === "plugins") {
    if (parts.length === 3) return (await import("./private")).orgPluginsRoute(ctx, parts[1]);
    return (await import("./approvals")).memberApprovalsRoute(ctx, parts[1]);
  }
  if (parts[0] === "orgs" && parts[2] === "admin" && parts[3] === "plugins") return (await import("./approvals")).adminPluginsRoute(ctx, parts[1]);
  throw new HttpError(404, "not found");
}
