import { parseSkillFile } from "../../../shared/ai/skillFile";
import { SKILL_LIMITS } from "../../../shared/ai/types";
import { untrustedResult, wrapUntrusted, isRepoName } from "../../../shared/agents/reach";
import { checkWebUrl, displayUrl, isPublicAddress } from "../../../shared/agents/reachNet";
import type { ToolResult } from "../../../shared/agents/tools";
import type { ReachRunner, RunContext } from "./hub";

/**
 * Skills from the web (docs/research/agent-parity.md §3, [ours]): `find_skills` looks for SKILL.md files (the Agent
 * Skills format — YAML frontmatter `name`, `description`, then the instructions) in public GitHub repositories,
 * `read_skill` reads one, and install_skill (src/main/agents/skills.ts) installs what it read. Under Access › Web's
 * policy (the gate in hub.ts asks, logs and times out): every address goes through reachNet's rules and its host's
 * DNS answers must be public (unless the owner allowed that host), redirects are followed by hand and checked again,
 * answers are cut at a few hundred KB. Only text is read; nothing is run. Electron-free: fetch and DNS are injected.
 */

export interface SkillWebDeps {
  fetch(url: string, init: { headers: Record<string, string>; redirect: "manual"; signal?: AbortSignal }): Promise<Response>;
  /** The host's addresses (the public check) */
  resolve(host: string): Promise<string[]>;
}

/** Where agents look by default: Anthropic's public skills (Apache-2.0 examples and document skills). */
export const DEFAULT_SKILL_SOURCES = ["anthropics/skills"] as const;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MAX_CANDIDATES = 40;

const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export class SkillFetchError extends Error {}

/**
 * A skill's address as a raw file: GitHub's blob / tree pages and a repository's root become
 * raw.githubusercontent.com (a folder: its SKILL.md); other addresses are kept.
 */
export function rawSkillUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new SkillFetchError("url: a full address like https://github.com/owner/repo/tree/main/skills/name");
  }
  if (u.hostname === "github.com" || u.hostname === "www.github.com") {
    const [owner, repo, kind, ref, ...rest] = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repo) throw new SkillFetchError("That GitHub address names no repository.");
    const path = rest.join("/");
    if (!kind) return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/SKILL.md`;
    if ((kind === "blob" || kind === "raw") && ref && path) return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
    if (kind === "tree" && ref) return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path ? `${path}/` : ""}SKILL.md`;
    throw new SkillFetchError("Give a GitHub file (…/blob/…/SKILL.md) or folder (…/tree/…) address.");
  }
  if (u.hostname === "raw.githubusercontent.com" && !/\.md$/i.test(u.pathname)) return `${u.origin}${u.pathname.replace(/\/+$/, "")}/SKILL.md`;
  return u.toString();
}

async function checkedHost(url: string, ctx: Pick<RunContext, "settings">, deps: SkillWebDeps): Promise<URL> {
  const c = checkWebUrl(url, ctx.settings.web.allowedHosts);
  if (!c.ok) throw new SkillFetchError(`${displayUrl(url)}: ${c.reason}`);
  if (c.host && !c.allowedLocal && !c.literal) {
    const list = await deps.resolve(c.host).catch(() => [] as string[]);
    if (!list.length || !list.every((a) => isPublicAddress(a))) throw new SkillFetchError(`${c.hostPort} resolves to a local or private address (allow it in Agent settings › Access › Web if it is yours)`);
  }
  return c.url;
}

/** A text file from the web (redirects followed and checked again), at most `max` bytes. */
export async function fetchText(url: string, ctx: Pick<RunContext, "settings" | "signal">, deps: SkillWebDeps, o: { max?: number; headers?: Record<string, string> } = {}): Promise<{ text: string; finalUrl: string; type: string }> {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await checkedHost(at, ctx, deps);
    const res = await deps.fetch(u.toString(), { headers: { "User-Agent": "Wecra", Accept: "text/plain, text/markdown, application/vnd.github+json, */*;q=0.5", ...(o.headers ?? {}) }, redirect: "manual", signal: ctx.signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      at = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    if (!res.ok && res.status !== 206) throw new SkillFetchError(`${displayUrl(at)} answered ${res.status}${res.status === 404 ? " (not found: is it the SKILL.md's address?)" : ""}.`);
    const max = o.max ?? MAX_BYTES;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > max && res.status !== 206) throw new SkillFetchError(`${displayUrl(at)} is ${Math.round(len / 1024)} KB: too large for a skill.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > max && res.status !== 206) throw new SkillFetchError(`${displayUrl(at)} is too large for a skill.`);
    if (bytes.subarray(0, 8000).includes(0)) throw new SkillFetchError(`${displayUrl(at)} is a binary file, not a SKILL.md.`);
    return { text: new TextDecoder().decode(bytes.subarray(0, max)), finalUrl: at, type: res.headers.get("content-type") ?? "" };
  }
  throw new SkillFetchError("Too many redirects.");
}

/** A SKILL.md from the web: its skill, or why it isn't one. */
export async function fetchSkill(url: string, ctx: Pick<RunContext, "settings" | "signal">, deps: SkillWebDeps): Promise<{ text: string; source: string }> {
  const raw = rawSkillUrl(url);
  const r = await fetchText(raw, ctx, deps);
  if (/text\/html/i.test(r.type) || /^\s*<(!doctype|html)/i.test(r.text)) throw new SkillFetchError(`${displayUrl(r.finalUrl)} is a web page, not a SKILL.md: give the file's address (on GitHub, the …/blob/…/SKILL.md or the skill's folder).`);
  if (r.text.length > SKILL_LIMITS.instructions + 4096) throw new SkillFetchError("That skill's instructions are longer than 64 KB: Wecra's skills hold up to 64 KB.");
  return { text: r.text, source: displayUrl(r.finalUrl) };
}

/** A frontmatter's name and description, even from a cut file (find_skills reads only the start). */
export function skillHeader(text: string, fallbackName: string): { name: string; description: string } {
  const parsed = parseSkillFile(text, fallbackName);
  if (!("error" in parsed)) return { name: parsed.name, description: parsed.description };
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)(\r?\n---|$)/.exec(text)?.[1] ?? "";
  const field = (k: string) => (new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  return { name: field("name") || fallbackName, description: field("description") };
}

/** Words a person uses for design skills, so "a UX skill" finds frontend-design, canvas-design … */
const SYNONYMS: Record<string, string[]> = {
  ux: ["ux", "user experience", "usability", "design", "interface", "ui", "frontend", "accessibility", "interaction"],
  ui: ["ui", "interface", "design", "frontend", "component", "visual"],
  design: ["design", "visual", "brand", "layout", "typography", "ui", "art"],
  brand: ["brand", "identity", "guidelines", "style"],
  accessibility: ["accessibility", "a11y", "wcag", "contrast"],
  writing: ["writing", "copy", "content", "communication", "docs"],
  motion: ["motion", "animation", "gif", "video"],
};

export function scoreSkill(query: string, s: { name: string; description: string; path: string }): number {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !["a", "an", "the", "skill", "skills", "for", "find", "me", "some"].includes(w));
  if (!terms.length) return 1;
  const hay = `${s.name} ${s.description} ${s.path}`.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (s.name.toLowerCase().includes(t)) score += 5;
    if (hay.includes(t)) score += 3;
    for (const syn of SYNONYMS[t] ?? []) if (hay.includes(syn)) score += 1;
  }
  return score;
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

async function findSkills(args: Record<string, unknown>, ctx: RunContext, deps: SkillWebDeps): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
  const repos = typeof args.repo === "string" && args.repo.trim() ? [args.repo.trim()] : [...DEFAULT_SKILL_SOURCES];
  for (const r of repos) if (!isRepoName(r)) return error(`repo: a public GitHub repository as "owner/name" (got ${JSON.stringify(r)}).`);
  const found: { repo: string; branch: string; path: string; name: string; description: string; url: string; score: number }[] = [];
  const notes: string[] = [];
  for (const repo of repos) {
    try {
      const info = JSON.parse((await fetchText(`https://api.github.com/repos/${repo}`, ctx, deps)).text) as { default_branch?: string };
      const branch = String(info.default_branch ?? "main");
      const tree = JSON.parse((await fetchText(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, ctx, deps, { max: 8 * 1024 * 1024 })).text) as { tree?: { path: string; type: string }[] };
      const files = (tree.tree ?? []).filter((e) => e.type === "blob" && /(^|\/)SKILL\.md$/i.test(e.path)).slice(0, MAX_CANDIDATES);
      if (!files.length) notes.push(`${repo}: no SKILL.md files.`);
      const heads = await inBatches(files, 8, async (f) => {
        const dir = f.path.replace(/\/?SKILL\.md$/i, "");
        const fallback = dir.split("/").pop() || repo.split("/")[1];
        try {
          const head = await fetchText(`https://raw.githubusercontent.com/${repo}/${branch}/${f.path}`, ctx, deps, { max: 4096, headers: { Range: "bytes=0-4095" } });
          return { ...skillHeader(head.text, fallback), dir };
        } catch {
          return { name: fallback, description: "", dir };
        }
      });
      for (const h of heads) {
        const url = `https://github.com/${repo}/tree/${branch}/${h.dir}`;
        found.push({ repo, branch, path: h.dir, name: h.name, description: h.description.slice(0, 400), url, score: scoreSkill(query, { name: h.name, description: h.description, path: h.dir }) });
      }
    } catch (err) {
      notes.push(`${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const ranked = found.filter((f) => f.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 15);
  const lines = ranked.map((f) => `- ${f.name} — ${f.description || "(no description)"}\n  install_skill {url: "${f.url}"}`);
  const text = [`Skills${query ? ` for “${query}”` : ""} in ${repos.join(", ")} (${ranked.length} of ${found.length}):`, ...(lines.length ? lines : ["(none matched: try other words, or another repository with `repo`)"]), ...notes].join("\n");
  return untrustedResult(`skills:${repos.join(",")}`, text);
}

/** find_skills and read_skill (capability Web): the gate in hub.ts has already allowed the call. */
export function skillWebRunner(deps: SkillWebDeps): ReachRunner {
  return async (tool, args, ctx) => {
    try {
      if (tool === "find_skills") return await findSkills(args, ctx, deps);
      if (tool === "read_skill") {
        const r = await fetchSkill(String(args.url ?? ""), ctx, deps);
        const parsed = parseSkillFile(r.text);
        const head = "error" in parsed ? `Not a skill Wecra can install: ${parsed.error}` : `Skill “${parsed.name}”: ${parsed.description}\n(${parsed.instructions.length} characters of instructions; install_skill {url} adds it after the owner confirms)`;
        return { content: [{ type: "text", text: `${head}\n\n${wrapUntrusted(`skill:${r.source}`, r.text)}` }] };
      }
      return error(`Unknown tool: ${tool}`);
    } catch (err) {
      return error(err instanceof SkillFetchError ? err.message : `Skills: ${err instanceof Error ? err.message.slice(0, 200) : "the request failed"}`);
    }
  };
}

export const SKILL_WEB_TOOLS: ReadonlySet<string> = new Set(["find_skills", "read_skill"]);
