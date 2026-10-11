/**
 * Code Connect (docs/editor.md D-1; D1 `code_connect`, migration 0015): one mapping per (library file, main component
 * or component set node, label). CLI mappings carry the template's JavaScript and are changed only through
 * `/v1/code_connect` (rest.ts, `file_code_connect:write`); Code Connect UI mappings (source + component, no template)
 * through the private routes:
 *
 *   GET    /files/:key/code-connect                       → {mappings: CodeConnectMapping[]}
 *   PUT    /files/:key/code-connect {nodeId, label, language?, source?, component?, imports?, nestable?, instructions?}
 *                                                         → {mapping}   UI mappings only (409 on a CLI one)
 *   DELETE /files/:key/code-connect/:nodeId?label=        → 204         UI mappings only
 *
 * Reading: anyone who can open the file, or anyone who may use it as a library (a consumer file's Inspect shows the
 * library's snippets — docs/data.md §16.4 `canUseLibrary`). Writing: edit access and a Full or Dev seat in orgs.
 */
import type { CodeConnectMapping } from "../../../src/shared/devmode/types";
import type { AccessResult } from "../../../src/shared/org/access";
import type { CodeConnectDoc } from "../../../src/shared/rest/types";
import type { Deps } from "../api";
import type { User } from "../db";
import { Access, type FileRow } from "../org/db";
import { body, HttpError, noContent } from "../org/http";
import { canReadDev, json, line, logDev, nodeId, requireWriteDev } from "./common";

interface Row {
  file_key: string;
  node_id: string;
  label: string;
  language: string;
  origin: "cli" | "ui";
  source: string | null;
  component: string | null;
  template: string | null;
  imports: string;
  nestable: number;
  instructions: string;
  updated_by: string | null;
  updated_at: number;
}

export const MAX_TEMPLATE_BYTES = 256 * 1024;
export const MAX_DOCS = 500;

const toMapping = (r: Row): CodeConnectMapping => {
  let imports: string[] = [];
  try {
    const v = JSON.parse(r.imports) as unknown;
    if (Array.isArray(v)) imports = v.filter((x): x is string => typeof x === "string");
  } catch {
    // none
  }
  return { fileKey: r.file_key, nodeId: r.node_id, label: r.label, language: r.language, origin: r.origin, source: r.source, component: r.component, template: r.template, imports, nestable: r.nestable !== 0, instructions: r.instructions, updatedBy: r.updated_by, updatedAt: r.updated_at };
};

export async function mappingsOf(deps: Deps, key: string, label?: string | null): Promise<CodeConnectMapping[]> {
  const { results } = await deps.db.d1
    .prepare(`SELECT * FROM code_connect WHERE file_key = ?1 AND (?2 IS NULL OR label = ?2) ORDER BY node_id, label`)
    .bind(key, label ?? null)
    .all<Row>();
  return results.map(toMapping);
}

const mappingRow = (deps: Deps, key: string, node: string, label: string) => deps.db.d1.prepare(`SELECT * FROM code_connect WHERE file_key = ?1 AND node_id = ?2 AND label = ?3`).bind(key, node, label).first<Row>();

function cleanLabel(v: unknown): string {
  const l = line(v, 50);
  if (!l) throw new HttpError(400, "label is required (React, SwiftUI, Compose …)");
  return l;
}

function cleanImports(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 100 || !v.every((x) => typeof x === "string" && x.length <= 1000)) throw new HttpError(400, "imports is a list of strings");
  return v as string[];
}

/** The language a label implies, when none is given (Figma's labels and their snippet languages) */
export function languageOf(label: string, given?: unknown): string {
  const g = line(given, 50);
  if (g) return g;
  const l = label.toLowerCase();
  if (l === "react" || l === "storybook") return "tsx";
  if (l === "swiftui" || l === "uikit") return "swift";
  if (l === "compose" || l === "jetpack compose") return "kotlin";
  if (l === "vue") return "vue";
  if (l === "html" || l === "web components" || l === "angular") return "html";
  return "raw";
}

interface UpsertInput {
  node: string;
  label: string;
  language: string;
  origin: "cli" | "ui";
  source: string | null;
  component: string | null;
  template: string | null;
  imports: string[];
  nestable: boolean;
  instructions: string;
}

async function upsert(deps: Deps, key: string, user: User, i: UpsertInput): Promise<CodeConnectMapping> {
  const r = await deps.db.d1
    .prepare(
      `INSERT INTO code_connect (file_key, node_id, label, language, origin, source, component, template, imports, nestable, instructions, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT (file_key, node_id, label) DO UPDATE SET language = ?4, origin = ?5, source = ?6, component = ?7, template = ?8, imports = ?9, nestable = ?10, instructions = ?11, updated_by = ?12, updated_at = ?13
       RETURNING *`,
    )
    .bind(key, i.node, i.label, i.language, i.origin, i.source, i.component, i.template, JSON.stringify(i.imports), i.nestable ? 1 : 0, i.instructions, user.id, deps.now())
    .first<Row>();
  await (await import("../roomBroadcast")).roomBroadcast(deps, key, "code-connect");
  return toMapping(r!);
}

/** May the caller read this file's mappings? Open it (not prototype-only), or use it as a library. */
async function canReadMappings(deps: Deps, user: User, f: FileRow, a: AccessResult): Promise<boolean> {
  if (canReadDev(a)) return true;
  const { libraryRow } = await import("../libraries/db");
  const lib = await libraryRow(deps.db.d1, f.key);
  if (!lib) return false;
  const { canUseLibrary } = await import("../libraries/access");
  return (await canUseLibrary(new Access(deps, user), lib)).length > 0;
}

/** `/files/:key/code-connect…` (parts: ["files", key, "code-connect", nodeId?]) */
export async function codeConnectRoute(req: Request, url: URL, deps: Deps, user: User, parts: string[], f: FileRow, a: AccessResult): Promise<Response> {
  const m = req.method;
  if (parts.length === 3 && m === "GET") {
    if (!(await canReadMappings(deps, user, f, a))) throw new HttpError(404, "no such file");
    return json({ mappings: await mappingsOf(deps, f.key, url.searchParams.get("label")) });
  }
  if (!a.ok) throw new HttpError(404, "no such file");
  if (parts.length === 3 && m === "PUT") {
    requireWriteDev(a);
    const b = await body<Record<string, unknown>>(req);
    const node = nodeId(b.nodeId);
    const label = cleanLabel(b.label);
    const existing = await mappingRow(deps, f.key, node, label);
    if (existing?.origin === "cli") throw new HttpError(409, "this mapping was published from the CLI; edit it in code");
    const mapping = await upsert(deps, f.key, user, {
      node,
      label,
      language: languageOf(label, b.language),
      origin: "ui",
      source: line(b.source, 1000) || null,
      component: line(b.component, 200) || null,
      template: null,
      imports: cleanImports(b.imports),
      nestable: b.nestable !== false,
      instructions: typeof b.instructions === "string" ? b.instructions.slice(0, 5000) : "",
    });
    await logDev(deps, f, user, "code_connect_publish", { node_id: node, label, origin: "ui" }, req);
    return json({ mapping });
  }
  if (parts.length === 4 && m === "DELETE") {
    requireWriteDev(a);
    const node = nodeId(parts[3]);
    const label = cleanLabel(url.searchParams.get("label"));
    const existing = await mappingRow(deps, f.key, node, label);
    if (!existing) throw new HttpError(404, "no such mapping");
    if (existing.origin === "cli") throw new HttpError(409, "this mapping was published from the CLI; unpublish it there");
    await deps.db.d1.prepare(`DELETE FROM code_connect WHERE file_key = ?1 AND node_id = ?2 AND label = ?3`).bind(f.key, node, label).run();
    await (await import("../roomBroadcast")).roomBroadcast(deps, f.key, "code-connect");
    await logDev(deps, f, user, "code_connect_unpublish", { node_id: node, label, origin: "ui" }, req);
    return noContent();
  }
  throw new HttpError(405, "method not allowed");
}

// ---- the CLI's routes (/v1/code_connect, §16.7) -------------------------------------------------------------------

/**
 * A node link: ours (`<server>/f/<key>?node-id=1-2`) or Figma-style (`…/design|file|proto/<key>/<name>?node-id=1-2`),
 * node ids as "1-2", "1:2" or "1%3A2". null: not a node link.
 */
export function parseNodeLink(link: string): { fileKey: string; nodeId: string } | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const path = /^\/(?:f|file|design|proto)\/([A-Za-z0-9_-]{6,64})(?:\/|$)/.exec(u.pathname);
  const raw = u.searchParams.get("node-id");
  if (!path || !raw) return null;
  const n = /^(I?-?\d+)[-:](-?\d+)$/.exec(raw.trim());
  if (!n) return null;
  return { fileKey: path[1], nodeId: `${n[1]}:${n[2]}` };
}

export const nodeLink = (origin: string, key: string, node: string) => `${origin}/f/${key}?node-id=${node.replace(":", "-")}`;

type Resolved = { ok: true; f: FileRow; a: AccessResult } | { ok: false; error: string };

/** The file a link names and the caller's access to it, once per key */
function fileResolver(deps: Deps, user: User) {
  const acc = new Access(deps, user);
  const cache = new Map<string, Promise<Resolved>>();
  return (key: string): Promise<Resolved> => {
    let p = cache.get(key);
    if (!p) {
      p = (async (): Promise<Resolved> => {
        const f = await acc.fileRow(key);
        if (!f) return { ok: false, error: "File not found" };
        if (await acc.branch(key)) return { ok: false, error: "Code Connect is published to main files, not branches" };
        const a = await acc.file(f, { viaLink: true, passOk: false });
        if (!a.ok) return { ok: false, error: "File not found" };
        return { ok: true, f, a };
      })();
      cache.set(key, p);
    }
    return p;
  };
}

/** POST /v1/code_connect {docs} → {published, errors}: each doc on its own; CLI mappings replace UI ones of the label. */
export async function publishDocs(req: Request, deps: Deps, user: User, input: unknown): Promise<{ published: { nodeId: string; fileKey: string; label: string; url: string }[]; errors: { url: string; label: string; error: string }[] }> {
  const docs = (input as { docs?: unknown } | null)?.docs;
  if (!Array.isArray(docs) || docs.length > MAX_DOCS) throw new HttpError(400, `docs is a list of at most ${MAX_DOCS} Code Connect docs`);
  const origin = new URL(req.url).origin;
  const resolve = fileResolver(deps, user);
  const published: { nodeId: string; fileKey: string; label: string; url: string }[] = [];
  const errors: { url: string; label: string; error: string }[] = [];
  const logged = new Map<string, { f: FileRow; nodes: string[] }>();
  for (const raw of docs as Partial<CodeConnectDoc>[]) {
    const link = typeof raw?.url === "string" ? raw.url : "";
    const label = typeof raw?.label === "string" ? raw.label.trim().slice(0, 50) : "";
    const fail = (error: string) => errors.push({ url: link, label, error });
    if (!label) {
      fail("label is required");
      continue;
    }
    const at = parseNodeLink(link);
    if (!at) {
      fail("url is not a link to a node (…?node-id=1-2)");
      continue;
    }
    const template = raw.template === null || raw.template === undefined ? null : typeof raw.template === "string" ? raw.template : undefined;
    if (template === undefined || (template !== null && new TextEncoder().encode(template).byteLength > MAX_TEMPLATE_BYTES)) {
      fail(`template is the template's JavaScript (≤ ${MAX_TEMPLATE_BYTES / 1024} kB) or null`);
      continue;
    }
    const r = await resolve(at.fileKey);
    if (!r.ok) {
      fail(r.error);
      continue;
    }
    try {
      requireWriteDev(r.a);
    } catch (e) {
      fail(e instanceof HttpError ? e.message : "not allowed");
      continue;
    }
    let imports: string[];
    try {
      imports = cleanImports(raw.imports);
    } catch {
      fail("imports is a list of strings");
      continue;
    }
    await upsert(deps, at.fileKey, user, {
      node: at.nodeId,
      label,
      language: languageOf(label, raw.language),
      // A doc with no template is a UI-style mapping published from the CLI: still the CLI's (edited only there)
      origin: "cli",
      source: line(raw.source, 1000) || null,
      component: line(raw.component, 200) || null,
      template,
      imports,
      nestable: raw.nestable !== false,
      instructions: typeof raw.instructions === "string" ? raw.instructions.slice(0, 5000) : "",
    });
    published.push({ nodeId: at.nodeId, fileKey: at.fileKey, label, url: nodeLink(origin, at.fileKey, at.nodeId) });
    const l = logged.get(at.fileKey) ?? { f: r.f, nodes: [] };
    l.nodes.push(at.nodeId);
    logged.set(at.fileKey, l);
  }
  for (const { f, nodes } of logged.values()) await logDev(deps, f, user, "code_connect_publish", { node_ids: nodes.slice(0, 100), count: nodes.length, origin: "cli" }, req);
  return { published, errors };
}

/**
 * DELETE /v1/code_connect {label, nodes?: {fileKey, nodeId}[]} → {removed}: the CLI mappings of that label on those
 * nodes, or — without `nodes` — every CLI mapping of that label the caller published last (Figma's `unpublish
 * --label` without `--node`; ours: limited to the caller's own, since there is no project to scope it by).
 */
export async function unpublishDocs(req: Request, deps: Deps, user: User, input: unknown): Promise<{ removed: { fileKey: string; nodeId: string; label: string }[]; errors: { fileKey: string; nodeId: string; error: string }[] }> {
  const b = (input ?? {}) as { label?: unknown; nodes?: unknown };
  const label = typeof b.label === "string" ? b.label.trim() : "";
  if (!label) throw new HttpError(400, "label is required");
  let targets: { fileKey: string; nodeId: string }[];
  if (b.nodes === undefined || b.nodes === null) {
    const { results } = await deps.db.d1.prepare(`SELECT file_key, node_id FROM code_connect WHERE label = ?1 AND origin = 'cli' AND updated_by = ?2 LIMIT 5000`).bind(label, user.id).all<{ file_key: string; node_id: string }>();
    targets = results.map((r) => ({ fileKey: r.file_key, nodeId: r.node_id }));
  } else {
    if (!Array.isArray(b.nodes) || b.nodes.length > 5000) throw new HttpError(400, "nodes is a list of {fileKey, nodeId}");
    targets = (b.nodes as { fileKey?: unknown; nodeId?: unknown; url?: unknown }[]).map((n) => (typeof n?.url === "string" ? (parseNodeLink(n.url) ?? { fileKey: "", nodeId: "" }) : { fileKey: typeof n?.fileKey === "string" ? n.fileKey : "", nodeId: typeof n?.nodeId === "string" ? n.nodeId : "" }));
  }
  const resolve = fileResolver(deps, user);
  const removed: { fileKey: string; nodeId: string; label: string }[] = [];
  const errors: { fileKey: string; nodeId: string; error: string }[] = [];
  const logged = new Map<string, { f: FileRow; nodes: string[] }>();
  for (const t of targets) {
    const r = t.fileKey ? await resolve(t.fileKey) : ({ ok: false, error: "File not found" } as const);
    if (!r.ok) {
      errors.push({ ...t, error: r.error });
      continue;
    }
    try {
      requireWriteDev(r.a);
    } catch (e) {
      errors.push({ ...t, error: e instanceof HttpError ? e.message : "not allowed" });
      continue;
    }
    const gone = await deps.db.d1.prepare(`DELETE FROM code_connect WHERE file_key = ?1 AND node_id = ?2 AND label = ?3 AND origin = 'cli' RETURNING node_id`).bind(t.fileKey, t.nodeId, label).first();
    if (!gone) continue;
    removed.push({ ...t, label });
    const l = logged.get(t.fileKey) ?? { f: r.f, nodes: [] };
    l.nodes.push(t.nodeId);
    logged.set(t.fileKey, l);
  }
  for (const { f } of logged.values()) await (await import("../roomBroadcast")).roomBroadcast(deps, f.key, "code-connect");
  for (const { f, nodes } of logged.values()) await logDev(deps, f, user, "code_connect_unpublish", { node_ids: nodes.slice(0, 100), count: nodes.length, label, origin: "cli" }, req);
  return { removed, errors };
}

/** GET /v1/files/:key/code_connect?label → {docs}: the file's mappings as the CLI publishes them */
export async function docsOf(req: Request, deps: Deps, key: string, label: string | null): Promise<{ docs: (CodeConnectDoc & { origin: "cli" | "ui" })[] }> {
  const origin = new URL(req.url).origin;
  const ms = await mappingsOf(deps, key, label);
  return {
    docs: ms.map((m) => ({
      url: nodeLink(origin, key, m.nodeId),
      label: m.label,
      language: m.language,
      ...(m.source ? { source: m.source } : {}),
      ...(m.component ? { component: m.component } : {}),
      template: m.template,
      imports: m.imports,
      nestable: m.nestable,
      instructions: m.instructions,
      origin: m.origin,
    })),
  };
}

export { canReadMappings };
