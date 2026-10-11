/**
 * Dev resources and Code Connect over REST (docs/multiplayer.md §16.7): `restRoute` has checked the scope, tier and
 * rate; the routes themselves are 5c's (`server/src/devmode/rest.ts`). A plan token can't reach them.
 */
import type { TokenScope } from "../../../src/shared/account";
import { devModeRestRoute } from "../devmode/rest";
import { RestError, type RestCtx } from "./http";

export async function devResourcesRestRoute(ctx: RestCtx): Promise<Response> {
  if (ctx.caller.kind === "plan") throw new RestError(403, "A plan access token can't do that");
  const caller = { user: ctx.caller.user, sid: null, scopes: ctx.caller.scopes ? (ctx.caller.scopes as TokenScope[]) : null };
  // `parts`: the whole path, version first (["v1", "files", key, "dev_resources", …]).
  const res = await devModeRestRoute(ctx.req, ctx.url, ctx.deps, caller, [ctx.version, ...ctx.parts]);
  if (!res) throw new RestError(404, "Not found");
  return res;
}
