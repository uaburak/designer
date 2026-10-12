/**
 * Client-reported Governance+ events (docs/governance.md §2.11, §2.12, §4 "Org (members)"), from main's AI path and
 * its local MCP server. Members and guests of the org, sessions only (a personal access token can't reach them).
 *
 *   POST /orgs/:org/discovery/ai-prompt  AiPromptReport {fileKey, text, feature, at}     → 204
 *        a `user_ai_prompts` event (`feature_entrypoint` = feature), when the org has Discovery on; stamped now (an
 *        hour already served never changes). `fileKey`: one of the org's files, else the event names no file.
 *   POST /orgs/:org/developer-logs/mcp   McpLogReport {calls: [{tool, fileKey, at}]}      → 204
 *        one developer log row per call (`event_source: "mcp_server"`, `token_type: "session"`), when the org has
 *        Governance+; at most 100 calls a report, each `at` within the last day (else now). Files outside the org are
 *        dropped.
 *
 * Off is cheap: the org lists are cached (record.ts `governanceOrgs`) and nothing else is read or written.
 */
import type { AiPromptReport, McpLogReport } from "../../../src/shared/org/governance";
import { body, HttpError, noContent, type Ctx } from "../org/http";
import { logDeveloperCalls, type DeveloperLogEntry } from "../rest/devlog";
import { afterAnswer, governanceOrgs, MAX_TEXT, recordDiscovery, fileTextEvents, type DiscoveryRecord } from "./record";

const MAX_CALLS = 100;
const DAY_MS = 86_400_000;

export async function memberReportRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, deps, acc, user, req } = ctx;
  const orgId = parts[1];
  if (m !== "POST" || parts.length !== 4) throw new HttpError(405, "method not allowed");
  await acc.requireMember(orgId, { guests: true });
  const orgs = await governanceOrgs(deps.db.d1, deps.now());
  const orgFiles = async (keys: string[]) => {
    if (!keys.length) return new Map<string, string>();
    const { results } = await deps.db.d1.prepare(`SELECT key, name FROM files WHERE org_id = ?1 AND key IN (SELECT value FROM json_each(?2))`).bind(orgId, JSON.stringify([...new Set(keys)])).all<{ key: string; name: string }>();
    return new Map(results.map((r) => [r.key, r.name]));
  };

  if (parts[2] === "discovery" && parts[3] === "ai-prompt") {
    const b = await body<Partial<AiPromptReport>>(req);
    if (typeof b.text !== "string" || !b.text.trim()) throw new HttpError(400, "text");
    if (typeof b.feature !== "string" || !b.feature || b.feature.length > 100) throw new HttpError(400, "feature");
    const fileKey = typeof b.fileKey === "string" ? b.fileKey : null;
    if (!orgs.discovery.has(orgId)) return noContent();
    const text = b.text.slice(0, MAX_TEXT);
    const feature = b.feature;
    await afterAnswer(deps, async () => {
      const inOrg = fileKey ? (await orgFiles([fileKey])).has(fileKey) : false;
      let events: DiscoveryRecord[];
      if (inOrg) events = await fileTextEvents(deps, fileKey!, [{ text, action: "transient", textType: "user_ai_prompts", featureEntrypoint: feature, userId: user.id }], orgId);
      else {
        const mem = await deps.db.d1.prepare(`SELECT billing_group_id FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, user.id).first<{ billing_group_id: string | null }>();
        events = [
          {
            org_id: orgId,
            file_key: "",
            text,
            timestamp: Math.floor(deps.now() / 1000),
            action_type: "transient",
            file_name: "",
            file_workspace_id: null,
            node_id: null,
            text_type: "user_ai_prompts",
            resource_id: null,
            parent_comment_id: null,
            user_id: user.id,
            user_email: user.email,
            user_billing_group_id: mem?.billing_group_id ?? null,
            feature_entrypoint: feature,
            moderation_failure_flags: null,
          },
        ];
      }
      await recordDiscovery(deps, events);
    });
    return noContent();
  }

  if (parts[2] === "developer-logs" && parts[3] === "mcp") {
    const b = await body<Partial<McpLogReport>>(req);
    if (!Array.isArray(b.calls) || b.calls.length > MAX_CALLS) throw new HttpError(400, `calls: a list of at most ${MAX_CALLS}`);
    const calls = b.calls.filter((c): c is McpLogReport["calls"][number] => !!c && typeof c.tool === "string" && !!c.tool && c.tool.length <= 200 && (c.fileKey === null || typeof c.fileKey === "string"));
    if (!orgs.gplus.has(orgId) || !calls.length) return noContent();
    const now = deps.now();
    const cf = (req as { cf?: { city?: string; region?: string; country?: string } }).cf;
    await afterAnswer(deps, async () => {
      const files = await orgFiles(calls.map((c) => c.fileKey).filter((k): k is string => !!k));
      const entries: DeveloperLogEntry[] = calls
        .filter((c) => !c.fileKey || files.has(c.fileKey))
        .map((c) => ({
          orgId,
          eventName: c.tool,
          eventSource: "mcp_server",
          userId: user.id,
          tokenId: null,
          tokenName: null,
          tokenType: "session",
          resource: c.fileKey ? { type: "file", id: c.fileKey, name: files.get(c.fileKey) ?? null } : { type: "org", id: orgId, name: null },
          ip: req.headers.get("cf-connecting-ip") ?? "",
          city: cf?.city ?? null,
          countryRegion: cf?.region ?? null,
          country: cf?.country ?? null,
          at: Number.isFinite(c.at) && c.at <= now && c.at >= now - DAY_MS ? c.at : now,
        }));
      await logDeveloperCalls(deps, entries);
    });
    return noContent();
  }
  throw new HttpError(404, "not found");
}
