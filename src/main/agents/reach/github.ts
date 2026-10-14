import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REACH_LIMITS, untrustedResult, type ReachView } from "../../../shared/agents/reach";
import type { ToolResult } from "../../../shared/agents/tools";
import type { ReachRunner, RunContext } from "./hub";

/**
 * GitHub (docs/agents-reach.md §6): read-only access to the repositories the owner picked, through GitHub's REST API —
 * no git, nothing cloned, nothing run. The token (a GitHub App's user token from the device flow, or a fine-grained
 * personal access token) is sealed in userData/agents/github.json and only ever sent as an Authorization header to
 * api.github.com — never in a URL, a log, an error or a result. Electron-free: fetch and the sealing are injected.
 */

export type GithubFetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface GithubDeps {
  /** userData/agents/github.json */
  path: string;
  fetch: GithubFetch;
  seal(secret: string): Promise<string>;
  unseal(sealed: string | undefined): Promise<string | null>;
  /** The GitHub App's client id for the device flow ("" when the build has none) */
  clientId: string;
}

interface Stored {
  token?: string;
  login?: string;
  via?: "app" | "token";
}

export interface GithubRepoInfo {
  fullName: string;
  private: boolean;
  description: string;
}

const API = "https://api.github.com";
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A repository path as agents may give it: relative, no `..`, no backslashes, no NUL; "" for the root. */
export function cleanRepoPath(path: unknown): string | null {
  if (path === undefined || path === null) return "";
  if (typeof path !== "string" || path.length > 1000) return null;
  const p = path.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  if (p.split("/").some((s) => s === ".." || s === ".")) return null;
  return p;
}

/** The allowlist's spelling of `repo` (GitHub names are case-insensitive), or null when it isn't on it. */
export const allowedRepo = (repo: unknown, list: readonly string[]): string | null => (typeof repo === "string" ? (list.find((r) => r.toLowerCase() === repo.trim().toLowerCase()) ?? null) : null);

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export class GithubError extends Error {}

export class GithubAccess {
  private cached: string | null | undefined;
  private device: { code: string; interval: number; until: number; next: number } | null = null;

  constructor(private d: GithubDeps) {}

  private read(): Stored {
    try {
      return existsSync(this.d.path) ? (JSON.parse(readFileSync(this.d.path, "utf8")) as Stored) : {};
    } catch {
      return {};
    }
  }

  private write(s: Stored) {
    mkdirSync(dirname(this.d.path), { recursive: true });
    const tmp = `${this.d.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, this.d.path);
    chmodSync(this.d.path, 0o600);
  }

  private async token(): Promise<string | null> {
    if (this.cached === undefined) this.cached = await this.d.unseal(this.read().token);
    return this.cached;
  }

  async status(): Promise<ReachView["github"]> {
    const s = this.read();
    return { connected: !!s.token, login: s.login ?? null, via: s.token ? (s.via ?? "token") : null, deviceFlow: !!this.d.clientId };
  }

  /** A request to the API: the token as a header only; errors say what GitHub said, never the token. */
  private async api(path: string, o: { accept?: string; signal?: AbortSignal; auth?: string | null } = {}): Promise<Response> {
    const token = o.auth === undefined ? await this.token() : o.auth;
    const res = await this.d.fetch(`${API}${path}`, {
      headers: { Accept: o.accept ?? "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Wecra", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: o.signal,
    });
    if (res.ok) return res;
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      throw new GithubError(`GitHub's rate limit is used up${token ? "" : " (60 reads an hour without a connection — connect GitHub in Agent settings › Access for more)"}; try again ${Number.isFinite(reset) && reset > 0 ? `after ${new Date(reset).toISOString().slice(11, 16)} UTC` : "later"}.`);
    }
    if (res.status === 401) throw new GithubError("GitHub didn't take the connection (the token is wrong, expired or revoked): connect again in Agent settings › Access › GitHub.");
    if (res.status === 404) throw new GithubError("Not found on GitHub (or the connection can't see it: a private repository needs a token with access to it).");
    let msg = "";
    try {
      msg = String(((await res.json()) as { message?: unknown }).message ?? "").slice(0, 200);
    } catch {
      /* no body */
    }
    throw new GithubError(`GitHub answered ${res.status}${msg ? `: ${msg}` : ""}.`);
  }

  private async json<T>(path: string, o: { signal?: AbortSignal; accept?: string } = {}): Promise<T> {
    return (await (await this.api(path, o)).json()) as T;
  }

  /** "Use a token": checked with GET /user, kept sealed only when GitHub takes it. */
  async connectToken(token: string): Promise<ReachView["github"]> {
    const clean = String(token ?? "").trim();
    if (!/^(github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]{20,}$/.test(clean)) throw new GithubError("That doesn't look like a GitHub token (they start with github_pat_).");
    const res = await this.api("/user", { auth: clean });
    const user = (await res.json()) as { login?: string };
    this.write({ token: await this.d.seal(clean), login: String(user.login ?? ""), via: "token" });
    this.cached = clean;
    return this.status();
  }

  /** "Connect with GitHub": the device flow's code for the owner to enter on github.com/login/device. */
  async deviceStart(): Promise<{ userCode: string; verificationUri: string; expiresIn: number }> {
    if (!this.d.clientId) throw new GithubError("This build has no GitHub App for signing in: use a token.");
    const res = await this.d.fetch("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Wecra" }, body: JSON.stringify({ client_id: this.d.clientId }) });
    const r = (await res.json()) as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number };
    if (!res.ok || !r.device_code || !r.user_code) throw new GithubError("GitHub didn't start the sign-in. Try again, or use a token.");
    const interval = Math.max(5, Number(r.interval) || 5) * 1000;
    this.device = { code: r.device_code, interval, until: Date.now() + (Number(r.expires_in) || 900) * 1000, next: Date.now() + interval };
    return { userCode: r.user_code, verificationUri: r.verification_uri ?? "https://github.com/login/device", expiresIn: Number(r.expires_in) || 900 };
  }

  /** One poll of the device flow (the page calls it every few seconds). */
  async devicePoll(): Promise<{ state: "pending" | "connected" | "expired" | "denied" }> {
    const dev = this.device;
    if (!dev || Date.now() > dev.until) {
      this.device = null;
      return { state: "expired" };
    }
    if (Date.now() < dev.next) return { state: "pending" };
    dev.next = Date.now() + dev.interval;
    const res = await this.d.fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Wecra" }, body: JSON.stringify({ client_id: this.d.clientId, device_code: dev.code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) });
    const r = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; interval?: number };
    if (r.access_token) {
      this.device = null;
      const user = (await (await this.api("/user", { auth: r.access_token })).json()) as { login?: string };
      this.write({ token: await this.d.seal(r.access_token), login: String(user.login ?? ""), via: "app" });
      this.cached = r.access_token;
      return { state: "connected" };
    }
    if (r.error === "slow_down") dev.interval += 5000;
    if (r.error === "expired_token") return (this.device = null), { state: "expired" };
    if (r.error === "access_denied") return (this.device = null), { state: "denied" };
    return { state: "pending" };
  }

  disconnect(): Promise<ReachView["github"]> {
    this.write({});
    this.cached = null;
    this.device = null;
    return this.status();
  }

  /** The connected account's repositories (the Access page's checkboxes), most recently pushed first. */
  async accountRepos(): Promise<GithubRepoInfo[]> {
    if (!(await this.token())) return [];
    const out: GithubRepoInfo[] = [];
    for (let page = 1; page <= 3; page++) {
      const list = await this.json<{ full_name: string; private: boolean; description: string | null }[]>(`/user/repos?per_page=100&sort=pushed&page=${page}`);
      out.push(...list.map((r) => ({ fullName: r.full_name, private: r.private, description: (r.description ?? "").slice(0, 200) })));
      if (list.length < 100) break;
    }
    return out;
  }

  // ── The tools ──

  runner(): ReachRunner {
    return async (tool, args, ctx) => {
      try {
        if (tool === "list_repos") return await this.listRepos(ctx);
        const repo = allowedRepo(args.repo, ctx.settings.github.repos);
        if (!repo) return error(`${String(args.repo ?? "(no repo)")} isn't one of the repositories the owner lets you read. list_repos lists them.`);
        const ref = typeof args.ref === "string" && /^[\w./-]{1,200}$/.test(args.ref) && !args.ref.includes("..") ? args.ref : null;
        if (tool === "repo_tree") return await this.tree(repo, ref, args.path, ctx);
        if (tool === "read_repo_file") return await this.readFile(repo, ref, args.path, args.lines === true, ctx);
        if (tool === "search_repo") return await this.search(repo, ref, String(args.query ?? ""), ctx);
        return error(`Unknown tool: ${tool}`);
      } catch (err) {
        return error(err instanceof GithubError ? err.message : `GitHub: ${err instanceof Error ? err.message.slice(0, 200) : "the request failed"}`);
      }
    };
  }

  private async listRepos(ctx: RunContext): Promise<ToolResult> {
    const repos = ctx.settings.github.repos;
    if (!repos.length) return error("The owner hasn't picked any repository yet (Agent settings › Access › GitHub).");
    const lines = await Promise.all(
      repos.slice(0, 50).map(async (r) => {
        try {
          const x = await this.json<{ full_name: string; default_branch: string; description: string | null; private: boolean }>(`/repos/${r}`, { signal: ctx.signal });
          return `- ${x.full_name} (${x.private ? "private" : "public"}, default branch ${x.default_branch})${x.description ? `: ${x.description.slice(0, 200)}` : ""}`;
        } catch (err) {
          return `- ${r}: ${err instanceof Error ? err.message : "can't be read"}`;
        }
      })
    );
    return untrustedResult("github:repositories", lines.join("\n"));
  }

  private async defaultBranch(repo: string, ctx: RunContext): Promise<string> {
    return (await this.json<{ default_branch: string }>(`/repos/${repo}`, { signal: ctx.signal })).default_branch;
  }

  private async treeEntries(repo: string, ref: string | null, ctx: RunContext) {
    const at = ref ?? (await this.defaultBranch(repo, ctx));
    const t = await this.json<{ tree: { path: string; type: string; size?: number }[]; truncated?: boolean }>(`/repos/${repo}/git/trees/${encodeURIComponent(at)}?recursive=1`, { signal: ctx.signal });
    return { at, tree: t.tree ?? [], truncated: !!t.truncated };
  }

  private async tree(repo: string, ref: string | null, path: unknown, ctx: RunContext): Promise<ToolResult> {
    const p = cleanRepoPath(path);
    if (p === null) return error("path: a path inside the repository (no .., no leading /).");
    const { at, tree, truncated } = await this.treeEntries(repo, ref, ctx);
    const under = tree.filter((e) => !p || e.path === p || e.path.startsWith(`${p}/`));
    const max = REACH_LIMITS.github.treeEntries;
    const lines = under.slice(0, max).map((e) => (e.type === "tree" ? `${e.path}/` : `${e.path}  ${e.size ?? 0} B`));
    const notes = [under.length > max ? `[${under.length - max} more entries: ask for a sub-path]` : "", truncated ? "[GitHub cut the tree: ask for a sub-path]" : ""].filter(Boolean);
    return untrustedResult(`github:${repo}@${at}/${p}`, [`${repo} @ ${at}${p ? ` › ${p}` : ""} — ${under.length} entries`, ...lines, ...notes].join("\n"));
  }

  private async readFile(repo: string, ref: string | null, path: unknown, numbered: boolean, ctx: RunContext): Promise<ToolResult> {
    const p = cleanRepoPath(path);
    if (!p) return error("path: a file's path inside the repository (no .., no leading /).");
    const res = await this.api(`/repos/${repo}/contents/${encodePath(p)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, { accept: "application/vnd.github.raw", signal: ctx.signal });
    if ((res.headers.get("content-type") ?? "").includes("application/json") && !/\.json$/i.test(p)) {
      const body = (await res.json()) as unknown;
      if (Array.isArray(body)) return error(`${p} is a folder: use repo_tree with path "${p}".`);
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > REACH_LIMITS.files.fileBytes) return error(`${p} is ${Math.round(len / 1024 / 1024)} MB: too large to read.`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > REACH_LIMITS.files.fileBytes) return error(`${p} is too large to read.`);
    const ext = /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase() ?? "";
    if (IMAGE_TYPES[ext]) {
      if (bytes.length > 4 * 1024 * 1024) return error(`${p} is a picture larger than 4 MB.`);
      return { content: [{ type: "text", text: `${repo} › ${p} (${bytes.length} B)` }, { type: "image", data: bytes.toString("base64"), mimeType: IMAGE_TYPES[ext] }] };
    }
    if (bytes.subarray(0, 8000).includes(0)) return error(`${p} is a binary file (${bytes.length} B): it can't be read as text.`);
    let text = bytes.toString("utf8");
    if (numbered) text = text.split("\n").map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
    return untrustedResult(`github:${repo}/${p}`, text);
  }

  private async search(repo: string, ref: string | null, query: string, ctx: RunContext): Promise<ToolResult> {
    const q = query.trim().slice(0, 200);
    if (!q) return error("query: the text to look for.");
    const { at, tree } = await this.treeEntries(repo, ref, ctx);
    const max = REACH_LIMITS.github.searchMatches;
    const paths = tree.filter((e) => e.path.toLowerCase().includes(q.toLowerCase())).slice(0, max).map((e) => (e.type === "tree" ? `${e.path}/` : e.path));
    const out = [`Paths containing “${q}” (${at}):`, ...(paths.length ? paths : ["(none)"])];
    if (await this.token()) {
      try {
        const r = await this.json<{ total_count: number; items: { path: string; text_matches?: { fragment: string }[] }[] }>(`/search/code?q=${encodeURIComponent(`${q} repo:${repo}`)}&per_page=50`, { accept: "application/vnd.github.text-match+json", signal: ctx.signal });
        out.push("", `Code containing it (GitHub code search, the default branch; ${r.total_count} files):`);
        for (const it of r.items.slice(0, 50)) out.push(`- ${it.path}`, ...(it.text_matches ?? []).slice(0, 3).map((m) => `    ${m.fragment.replace(/\s*\n\s*/g, " ⏎ ").slice(0, 300)}`));
      } catch (err) {
        out.push("", `(Code search didn't answer: ${err instanceof Error ? err.message : "error"})`);
      }
    } else out.push("", "(Code search needs GitHub connected: only paths were searched.)");
    return untrustedResult(`github:${repo} search`, out.join("\n"));
  }
}
