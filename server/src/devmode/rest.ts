/**
 * Dev Mode's REST routes (docs/multiplayer.md §16.7, docs/editor.md D-1, D-3): `/v1/dev_resources…`,
 * `/v1/files/:key/dev_resources…`, `/v1/code_connect` and `/v1/files/:key/code_connect`. 5a's `restRoute` calls it after
 * the scope, tier and rate checks; null = not one of these routes. A stub before round 5: 5c fills it.
 */
import type { Caller } from "../account";
import type { Deps } from "../api";

export async function devModeRestRoute(req: Request, url: URL, deps: Deps, caller: Caller, parts: string[]): Promise<Response | null> {
  void req;
  void url;
  void deps;
  void caller;
  void parts;
  return null;
}
