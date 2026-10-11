/**
 * The REST routes' scope and tier table (docs/multiplayer.md §16.3, §16.4): one row per route — the scopes that open it
 * (any of them), its rate-limit tier, whether a plan access token may call it, and whether it needs no token at all
 * (signed URLs).
 */
import type { RestScope, RestTier } from "../../../src/shared/rest/types";

export interface RouteSpec {
  /** Route group, for dispatch */
  group: "me" | "files" | "images" | "comments" | "teams" | "libraries" | "variables" | "dev" | "analytics" | "org" | "webhooks" | "signed";
  scopes: RestScope[];
  tier: RestTier;
  /** A plan access token may call it */
  plan?: boolean;
  /** The file key the route names (rate type and access) */
  fileKey?: string;
}

const KEY = /^[A-Za-z0-9_-]{6,64}$/;

/** The spec of `method parts` (parts after the version), or null: no such route (404). */
export function routeSpec(version: string, method: string, parts: string[]): RouteSpec | null {
  const [a, b, c, d] = parts;
  const n = parts.length;
  const get = method === "GET";
  if (version === "v1") {
    if (a === "me" && n === 1 && get) return { group: "me", scopes: ["current_user:read"], tier: 3 };
    if (a === "blobs" || a === "library-blobs") return get ? { group: "signed", scopes: [], tier: 2 } : null;
    if (a === "images" && n === 2 && get && KEY.test(b)) return { group: "images", scopes: ["file_content:read"], tier: 1, fileKey: b };
    if (a === "files" && n >= 2 && KEY.test(b)) {
      const fileKey = b;
      if (n === 2 && get) return { group: "files", scopes: ["file_content:read"], tier: 1, fileKey };
      if (n === 3 && get && c === "nodes") return { group: "files", scopes: ["file_content:read"], tier: 1, fileKey };
      if (n === 3 && get && c === "images") return { group: "files", scopes: ["file_content:read"], tier: 2, fileKey };
      if (n === 3 && get && c === "meta") return { group: "files", scopes: ["file_metadata:read"], tier: 3, fileKey };
      if (n === 3 && get && c === "versions") return { group: "files", scopes: ["file_versions:read"], tier: 2, fileKey };
      if (n === 3 && get && c === "thumbnail") return { group: "signed", scopes: [], tier: 2, fileKey };
      if (c === "comments") {
        if (n === 3) return get ? { group: "comments", scopes: ["file_comments:read"], tier: 2, fileKey } : method === "POST" ? { group: "comments", scopes: ["file_comments:write"], tier: 2, fileKey } : null;
        if (n === 4 && method === "DELETE") return { group: "comments", scopes: ["file_comments:write"], tier: 2, fileKey };
        if (n === 5 && parts[4] === "reactions") {
          if (get) return { group: "comments", scopes: ["file_comments:read"], tier: 2, fileKey };
          if (method === "POST" || method === "DELETE") return { group: "comments", scopes: ["file_comments:write"], tier: 2, fileKey };
        }
        return null;
      }
      if ((c === "components" || c === "component_sets" || c === "styles") && n === 3 && get) return { group: "libraries", scopes: ["library_content:read"], tier: 3, fileKey };
      if (c === "variables" && n === 4 && get && (d === "local" || d === "published")) return { group: "variables", scopes: ["file_variables:read"], tier: 2, fileKey };
      if (c === "variables" && n === 3 && method === "POST") return { group: "variables", scopes: ["file_variables:write"], tier: 3, fileKey };
      if (c === "dev_resources") {
        if (n === 3 && get) return { group: "dev", scopes: ["file_dev_resources:read"], tier: 2, fileKey };
        if (n === 4 && method === "DELETE") return { group: "dev", scopes: ["file_dev_resources:write"], tier: 2, fileKey };
        return null;
      }
      if (c === "code_connect" && n === 3 && get) return { group: "dev", scopes: ["file_content:read"], tier: 3, fileKey };
      return null;
    }
    if (a === "dev_resources" && n === 1 && (method === "POST" || method === "PUT")) return { group: "dev", scopes: ["file_dev_resources:write"], tier: 2 };
    if (a === "code_connect" && n === 1 && (method === "POST" || method === "DELETE")) return { group: "dev", scopes: ["file_code_connect:write"], tier: 3 };
    if (a === "teams" && n === 3 && get && (c === "components" || c === "component_sets" || c === "styles")) return { group: "libraries", scopes: ["team_library_content:read"], tier: 3 };
    if (a === "teams" && n === 3 && get && c === "projects") return { group: "teams", scopes: ["folders:read"], tier: 2 };
    if (a === "projects" && n === 3 && get && c === "files") return { group: "teams", scopes: ["folders:read"], tier: 2 };
    if (a === "projects" && n === 3 && get && c === "meta") return { group: "teams", scopes: ["folder_metadata:read"], tier: 3 };
    if ((a === "components" || a === "component_sets" || a === "styles") && n === 2 && get) return { group: "libraries", scopes: ["library_assets:read"], tier: 3 };
    if (a === "analytics" && b === "libraries" && n === 5 && get && ["component", "style", "variable"].includes(d) && (parts[4] === "actions" || parts[4] === "usages")) return { group: "analytics", scopes: ["library_analytics:read"], tier: 3, plan: true };
    if (a === "activity_logs" && n === 1 && get) return { group: "org", scopes: ["org:activity_log_read"], tier: 3, plan: true };
    if (a === "ai_usage" && b === "daily" && n === 2 && get) return { group: "org", scopes: ["org:ai_metering_usage_read"], tier: 3, plan: true };
    return null;
  }
  if (version === "v2") {
    if (a === "teams" && n === 3 && get && c === "folders") return { group: "teams", scopes: ["folders:read"], tier: 2 };
    if (a === "folders" && n === 3 && get && (c === "folders" || c === "files")) return { group: "teams", scopes: ["folders:read"], tier: 2 };
    if (a === "folders" && n === 3 && get && c === "meta") return { group: "teams", scopes: ["folder_metadata:read"], tier: 3 };
    if (a === "webhooks") {
      const write = method === "POST" || method === "PUT" || method === "DELETE";
      if (n === 1 && (get || method === "POST")) return { group: "webhooks", scopes: [write ? "webhooks:write" : "webhooks:read"], tier: 2, plan: true };
      if (n === 2 && (get || method === "PUT" || method === "DELETE")) return { group: "webhooks", scopes: [write ? "webhooks:write" : "webhooks:read"], tier: 2, plan: true };
      if (n === 3 && get && c === "requests") return { group: "webhooks", scopes: ["webhooks:read"], tier: 2, plan: true };
    }
    return null;
  }
  return null;
}
