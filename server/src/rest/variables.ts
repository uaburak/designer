/**
 * Variables (docs/multiplayer.md §16.7 "Variables", §16.8). Figma restricts them to Enterprise full members; we serve
 * anyone with the file access below (a Full seat in orgs).
 *
 *   GET  /v1/files/:key/variables/local       job `variables_local`: the client's part is the whole answer (gzip)
 *   GET  /v1/files/:key/variables/published   D1 library_assets (VARIABLE, VARIABLE_COLLECTION)
 *   POST /v1/files/:key/variables             shape checked here (validateShape), then job `variables_post` to a client
 *                                             that can edit, which applies it as one actor write → {tempIdToRealId}
 */
import { validateShape, VARIABLES_POST_MAX_BYTES } from "../../../src/shared/rest/variablesPost";
import { fileEntity, logActivity } from "../activity";
import { fileFor, requireFullSeat } from "./access";
import { RestError, iso, restJson, type RestCtx } from "./http";
import { jsonFromPart, partBytes, wantedFor } from "./jobs";
import { backendFor } from "./render";

export async function variablesRestRoute(ctx: RestCtx): Promise<Response> {
  const { parts, m, deps } = ctx;
  const key = parts[1];

  if (m === "GET" && parts[3] === "local") {
    const { f } = await fileFor(ctx, key);
    await requireFullSeat(ctx, f);
    const r = await backendFor(deps, key, { wanted: await wantedFor(deps, key) }).run({ kind: "variables_local" });
    if (!r.ok) throw new RestError(r.status, r.err);
    const part = r.parts.find((p) => p.name === "json");
    const bytes = part ? await partBytes(deps, key, part) : null;
    if (!bytes) throw new RestError(500, "The result is missing");
    return jsonFromPart(ctx.req, bytes, null, ctx.headers ?? {});
  }

  if (m === "GET" && parts[3] === "published") {
    const { f } = await fileFor(ctx, key);
    await requireFullSeat(ctx, f);
    const { results } = await deps.db.d1
      .prepare(
        `SELECT a.key, a.kind, a.name, a.resolved_type, a.collection_key, a.node_id, COALESCE(a.updated_at, l.last_published_at) AS updated, c.node_id AS collection_node
         FROM library_assets a JOIN libraries l ON l.key = a.library_key LEFT JOIN library_assets c ON c.library_key = a.library_key AND c.key = a.collection_key
         WHERE a.library_key = ?1 AND l.status = 'published' AND a.removed_in IS NULL AND a.kind IN ('VARIABLE', 'VARIABLE_COLLECTION')`,
      )
      .bind(key)
      .all<{ key: string; kind: string; name: string; resolved_type: string | null; collection_key: string | null; node_id: string | null; updated: number; collection_node: string | null }>();
    const variables: Record<string, unknown> = {};
    const variableCollections: Record<string, unknown> = {};
    for (const r of results) {
      // `id`: the GUID in the library file (the asset key until 0015's node_id is written); `subscribed_id`: the asset key (ours)
      const id = r.node_id ? `VariableID:${r.node_id}` : r.key;
      if (r.kind === "VARIABLE") {
        variables[id] = { id, subscribed_id: r.key, name: r.name, key: r.key, variableCollectionId: r.collection_node ? `VariableCollectionId:${r.collection_node}` : r.collection_key, resolvedType: r.resolved_type ?? "FLOAT", updatedAt: iso(r.updated) };
      } else {
        const cid = r.node_id ? `VariableCollectionId:${r.node_id}` : r.key;
        variableCollections[cid] = { id: cid, subscribed_id: r.key, name: r.name, key: r.key, updatedAt: iso(r.updated) };
      }
    }
    return restJson({ status: 200, error: false, meta: { variables, variableCollections } });
  }

  if (m === "POST" && parts.length === 3) {
    const { f } = await fileFor(ctx, key, "edit");
    await requireFullSeat(ctx, f);
    if (Number(ctx.req.headers.get("content-length") ?? "0") > VARIABLES_POST_MAX_BYTES) throw new RestError(413, "Request body too large");
    const text = await ctx.req.text();
    if (text.length > VARIABLES_POST_MAX_BYTES) throw new RestError(413, "Request body too large");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new RestError(400, "Invalid request body");
    }
    const shape = validateShape(raw);
    if (!shape.ok) throw new RestError(400, shape.message);
    const r = await backendFor(deps, key, { wanted: await wantedFor(deps, key) }).run({ kind: "variables_post", body: shape.body, actorUserId: ctx.caller.user.id });
    if (!r.ok) throw new RestError(r.status, r.err);
    const part = r.parts.find((p) => p.name === "json");
    const bytes = part ? await partBytes(deps, key, part) : null;
    if (!bytes) throw new RestError(500, "The result is missing");
    if (f.org_id) {
      const counts = Object.fromEntries((["variableCollections", "variableModes", "variables", "variableModeValues"] as const).map((k) => [k, shape.body[k]?.length ?? 0]));
      await logActivity(deps, { orgId: f.org_id, action: "file_variables_update", actor: ctx.caller.user, entity: fileEntity(f), teamId: f.team_id, details: { ...counts, client_name: "REST API" }, req: ctx.req });
    }
    return jsonFromPart(ctx.req, bytes, null, ctx.headers ?? {});
  }
  throw new RestError(404, "Not found");
}
