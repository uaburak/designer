/**
 * The manager's settings and tools as main takes them from a view (docs/studio.md §2.1–2.2): every field checked and
 * bounded, anything else dropped. Pure — main's host and its tests use it.
 */
import type { AgentRoute, ManagerSettings } from "../studio/types";
import { DEFAULT_MANAGER_NAME, DEFAULT_MANAGER_SETTINGS, MANAGER_NAME_MAX } from "../studio/types";
import type { AiRoute } from "../ai/types";
import type { ManagerToolDef } from "./types";

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

function route(v: unknown, fallback: AgentRoute): AgentRoute {
  const r = (v ?? {}) as Record<string, unknown>;
  const providerId = str(r.providerId, 100);
  if (!providerId) return { ...fallback };
  const model = str(r.model, 300);
  const effort = str(r.effort, 20);
  return { providerId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function imageRoute(v: unknown): AiRoute | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const providerId = str(r.providerId, 100);
  if (!providerId) return null;
  const model = str(r.model, 300);
  return { providerId, ...(model ? { model } : {}) };
}

/** The manager's name: one line, spaces collapsed, at most MANAGER_NAME_MAX characters; empty or not a string: null. */
export function cleanManagerName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = Array.from(v.replace(/\s+/g, " "))
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    .trim();
  return Array.from(name).slice(0, MANAGER_NAME_MAX).join("").trim() || null;
}

/**
 * A view's ManagerSettings (or what settings.json kept), cleaned; missing fields take DEFAULT_MANAGER_SETTINGS' — a
 * name kept before names existed is the default one.
 */
export function cleanManagerSettings(v: unknown, base: ManagerSettings = DEFAULT_MANAGER_SETTINGS): ManagerSettings {
  const baseName = cleanManagerName(base.name) ?? DEFAULT_MANAGER_NAME;
  if (!v || typeof v !== "object") return { ...base, name: baseName, manager: { ...base.manager }, general: { ...base.general }, allowed: [...base.allowed] };
  const m = v as Record<string, unknown>;
  const parallel = Math.round(Number(m.parallel));
  return {
    enabled: typeof m.enabled === "boolean" ? m.enabled : base.enabled,
    name: cleanManagerName(m.name) ?? baseName,
    manager: m.manager === undefined ? { ...base.manager } : route(m.manager, base.manager),
    general: m.general === undefined ? { ...base.general } : route(m.general, base.general),
    image: m.image === undefined ? base.image : imageRoute(m.image),
    allowed: Array.isArray(m.allowed) ? [...new Set(m.allowed.flatMap((id) => (str(id, 100) ? [id as string] : [])))].slice(0, 50) : [...base.allowed],
    parallel: Number.isFinite(parallel) ? Math.min(4, Math.max(1, parallel)) : base.parallel,
  };
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** A manager turn's tools from the view: names in the MCP shape, small schemas; at most 40. */
export function cleanManagerTools(v: unknown): ManagerToolDef[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: ManagerToolDef[] = [];
  for (const t of v.slice(0, 40)) {
    const name = str(t?.name, 64);
    if (!name || !TOOL_NAME_RE.test(name) || seen.has(name)) continue;
    const schema = t?.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema) ? (t.inputSchema as Record<string, unknown>) : null;
    if (!schema || JSON.stringify(schema).length > 32_000) continue;
    seen.add(name);
    const title = str(t?.title, 100);
    out.push({ name, ...(title ? { title } : {}), description: str(t?.description, 4000) ?? name, inputSchema: schema });
  }
  return out;
}
