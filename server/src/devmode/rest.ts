/**
 * Dev Mode's REST routes (docs/multiplayer.md §16.7, docs/editor.md D-1, D-3): `/v1/dev_resources…`,
 * `/v1/files/:key/dev_resources…`, `/v1/code_connect` and `/v1/files/:key/code_connect`. 5a's `restRoute` calls it after
 * the scope, tier and rate checks; null = not one of these routes. `parts` are the path's segments, with or without
 * the leading "v1".
 *
 *   GET    /v1/files/:key/dev_resources?node_ids=1:2,3:4  → {dev_resources: DevResource[]}            view
 *   POST   /v1/dev_resources {dev_resources: DevResourceCreate[]} → {links_created, errors}           edit + seat, per item
 *   PUT    /v1/dev_resources {dev_resources: DevResourceUpdate[]} → {links_updated: id[], errors}     edit + seat, per item
 *   DELETE /v1/files/:key/dev_resources/:id                → 200, empty body; 404 when missing
 *   POST   /v1/code_connect {docs}                         → {published, errors}
 *   DELETE /v1/code_connect {label, nodes?}                → {removed, errors}
 *   GET    /v1/files/:key/code_connect?label               → {docs}
 *
 * Errors are Figma's `{status, err}`. Main file keys only: a branch key is refused (per item in the batch routes).
 */
import type { Caller } from "../account";
import type { Deps } from "../api";
import type { DevResource } from "../../../src/shared/rest/types";
import { Access, type FileRow } from "../org/db";
import { HttpError } from "../org/http";
import type { AccessResult } from "../../../src/shared/org/access";
import { canReadDev, canWriteDev } from "./common";
import { addResource, editResource, listResources, removeResource } from "./devResources";
import { canReadMappings, docsOf, publishDocs, unpublishDocs } from "./codeConnect";

const out = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const err = (status: number, message: string): Response => out({ status, err: message }, status);

const toRest = (r: { id: string; name: string; url: string; fileKey: string; nodeId: string }): DevResource => ({ id: r.id, name: r.name, url: r.url, file_key: r.fileKey, node_id: r.nodeId });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type FileAt = { ok: true; f: FileRow; a: AccessResult } | { ok: false; error: string; status: number };

function files(deps: Deps, caller: Caller) {
  const acc = new Access(deps, caller.user);
  const cache = new Map<string, Promise<FileAt>>();
  return (key: string): Promise<FileAt> => {
    let p = cache.get(key);
    if (!p) {
      p = (async (): Promise<FileAt> => {
        const f = /^[A-Za-z0-9_-]{6,64}$/.test(key) ? await acc.fileRow(key) : null;
        if (!f) return { ok: false, error: "File not found", status: 404 };
        if (await acc.branch(key)) return { ok: false, error: "Dev resources and Code Connect are on main files, not branches", status: 400 };
        const a = await acc.file(f, { viaLink: true, passOk: false });
        if (!a.ok) return { ok: false, error: "File not found", status: 404 };
        return { ok: true, f, a };
      })();
      cache.set(key, p);
    }
    return p;
  };
}

export async function devModeRestRoute(req: Request, url: URL, deps: Deps, caller: Caller, parts: string[]): Promise<Response | null> {
  const p = parts[0] === "v1" ? parts.slice(1) : parts;
  const m = req.method;
  const user = caller.user;
  try {
    // /v1/files/:key/dev_resources[/:id] · /v1/files/:key/code_connect
    if (p[0] === "files" && p.length >= 3 && (p[2] === "dev_resources" || p[2] === "code_connect")) {
      const at = await files(deps, caller)(p[1]);
      if (!at.ok) return err(at.status, at.error);
      if (p[2] === "code_connect") {
        if (p.length !== 3 || m !== "GET") return err(405, "Method not allowed");
        if (!(await canReadMappings(deps, user, at.f, at.a))) return err(404, "File not found");
        return out(await docsOf(req, deps, at.f.key, url.searchParams.get("label")));
      }
      if (p.length === 3 && m === "GET") {
        if (!canReadDev(at.a)) return err(403, "Prototype viewers can't read dev resources");
        const q = url.searchParams.get("node_ids");
        const ids = q === null ? null : q.split(",").map((s) => s.trim()).filter(Boolean);
        return out({ dev_resources: (await listResources(deps, at.f.key, ids)).map(toRest) });
      }
      if (p.length === 4 && m === "DELETE") {
        if (!canWriteDev(at.a)) return err(403, "You can't change dev resources in this file");
        const { resourceRow } = await import("./devResources");
        const row = await resourceRow(deps, at.f.key, p[3]);
        if (!row) return err(404, "Dev resource not found");
        await removeResource(deps, at.f, user, row, req);
        return new Response(null, { status: 200 });
      }
      return err(405, "Method not allowed");
    }
    // /v1/dev_resources (POST, PUT)
    if (p[0] === "dev_resources" && p.length === 1) {
      const b = await readBody(req);
      const list = b?.dev_resources;
      if (!Array.isArray(list) || list.length > 1000) return err(400, "dev_resources is a list (at most 1000)");
      const at = files(deps, caller);
      if (m === "POST") {
        const links_created: DevResource[] = [];
        const errors: { file_key: string | null; node_id: string | null; error: string }[] = [];
        for (const raw of list as Record<string, unknown>[]) {
          const file_key = typeof raw?.file_key === "string" ? raw.file_key : null;
          const node_id = typeof raw?.node_id === "string" ? raw.node_id : null;
          const r = file_key ? await at(file_key) : ({ ok: false, error: "file_key is required", status: 400 } as const);
          if (!r.ok) {
            errors.push({ file_key, node_id, error: r.error });
            continue;
          }
          if (!canWriteDev(r.a)) {
            errors.push({ file_key, node_id, error: "You can't add dev resources to this file" });
            continue;
          }
          try {
            links_created.push(toRest(await addResource(deps, r.f, user, { nodeId: node_id, name: raw.name, url: raw.url }, req)));
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            errors.push({ file_key, node_id, error: e.message });
          }
        }
        return out({ links_created, errors });
      }
      if (m === "PUT") {
        const links_updated: string[] = [];
        const errors: { id: string | null; error: string }[] = [];
        for (const raw of list as Record<string, unknown>[]) {
          const id = typeof raw?.id === "string" ? raw.id : null;
          const row = id ? await deps.db.d1.prepare(`SELECT * FROM dev_resources WHERE id = ?1`).bind(id).first<Parameters<typeof editResource>[1]>() : null;
          const r = row ? await at(row.file_key) : null;
          if (!row || !r?.ok) {
            errors.push({ id, error: "Dev resource not found" });
            continue;
          }
          if (!canWriteDev(r.a)) {
            errors.push({ id, error: "You can't change dev resources in this file" });
            continue;
          }
          try {
            await editResource(deps, row, { ...(raw.name !== undefined ? { name: raw.name } : {}), ...(raw.url !== undefined ? { url: raw.url } : {}) });
            links_updated.push(row.id);
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            errors.push({ id, error: e.message });
          }
        }
        return out({ links_updated, errors });
      }
      return err(405, "Method not allowed");
    }
    // /v1/code_connect (POST, DELETE)
    if (p[0] === "code_connect" && p.length === 1) {
      const b = await readBody(req);
      if (!b) return err(400, "Expected a JSON object");
      if (m === "POST") return out(await publishDocs(req, deps, user, b));
      if (m === "DELETE") return out(await unpublishDocs(req, deps, user, b));
      return err(405, "Method not allowed");
    }
  } catch (e) {
    if (e instanceof HttpError) return err(e.status, e.message);
    throw e;
  }
  return null;
}
