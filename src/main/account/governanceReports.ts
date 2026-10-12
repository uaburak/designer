/**
 * Client-reported governance events (docs/governance.md §2.11, §2.12): the MCP tool calls and AI prompts that touch an
 * organization's file, sent to the Worker so Discovery and the developer logs can show them. Electron-free: how a
 * file's org is found and how a request is made are injected (governanceReportsWiring.ts wires the app's).
 *
 * MCP calls are batched in memory per org: one POST (`/orgs/:org/developer-logs/mcp`, ≤ 100 calls) at most every 60 s,
 * at 50 calls, and on quit. An AI prompt goes at once (`/orgs/:org/discovery/ai-prompt`), once per run. Everything is
 * fire-and-forget: nothing here throws or waits for the network, and a failed POST drops its batch. A file that isn't
 * an org's (or nobody signed in) reports nothing and costs one cached lookup.
 */
import type { AiPromptReport, McpLogReport } from "../../shared/org/governance";

export const FLUSH_MS = 60_000;
export const FLUSH_AT = 50;
/** The server takes at most 100 calls per report */
export const MAX_PER_POST = 100;
/** A file's org is looked up again after this long */
export const ORG_FRESH_MS = 60_000;
const MAX_PROMPT_CHARS = 20_000;

export interface ReportDeps {
  /** The org of a file (an org file's linked copy), null for a local file or when signed out */
  orgOf(fileKey: string): Promise<string | null>;
  /** Signed in at all (cheap, synchronous): false skips every lookup */
  signedIn(): boolean;
  /** POST `path` with a JSON body; the session and server are the host's */
  post(path: string, body: unknown): Promise<void>;
  now?(): number;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void };
}

type Call = McpLogReport["calls"][number];

export class GovernanceReports {
  private batches = new Map<string, Call[]>();
  private timer: unknown = null;
  private orgs = new Map<string, { org: string | null; at: number }>();
  private inflight = new Set<Promise<void>>();

  constructor(private readonly deps: ReportDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async orgOf(fileKey: string): Promise<string | null> {
    if (!this.deps.signedIn()) return null;
    const hit = this.orgs.get(fileKey);
    if (hit && this.now() - hit.at < ORG_FRESH_MS) return hit.org;
    let org: string | null = null;
    try {
      org = await this.deps.orgOf(fileKey);
    } catch {
      org = null;
    }
    this.orgs.set(fileKey, { org, at: this.now() });
    return org;
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** A tool call on `fileKey` (never throws, never waits for the caller) */
  mcpCall(fileKey: string | null, tool: string): void {
    if (!fileKey || !this.deps.signedIn()) return;
    const at = this.now();
    this.track(
      this.orgOf(fileKey)
        .then((org) => {
          if (!org) return;
          const list = this.batches.get(org) ?? [];
          list.push({ tool, fileKey, at });
          this.batches.set(org, list);
          if (list.length >= FLUSH_AT) this.track(this.flush());
          else this.arm();
        })
        .catch(() => undefined)
    );
  }

  /** The user's AI prompt for a run in `fileKey` */
  aiPrompt(fileKey: string | null, text: string, feature: string): void {
    if (!fileKey || !text.trim() || !this.deps.signedIn()) return;
    const at = this.now();
    this.track(
      this.orgOf(fileKey)
        .then((org) => {
          if (!org) return;
          const body: AiPromptReport = { fileKey, text: text.slice(0, MAX_PROMPT_CHARS), feature, at };
          return this.deps.post(`/orgs/${encodeURIComponent(org)}/discovery/ai-prompt`, body);
        })
        .catch(() => undefined)
    );
  }

  private arm(): void {
    if (this.timer) return;
    const t = this.deps.timers ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (x: unknown) => clearTimeout(x as ReturnType<typeof setTimeout>) };
    this.timer = t.setTimeout(() => {
      this.timer = null;
      this.track(this.flush());
    }, FLUSH_MS);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  /** Sends every org's batch now (one POST per org, ≤ 100 calls each) */
  async flush(): Promise<void> {
    if (this.timer) {
      (this.deps.timers?.clearTimeout ?? ((x: unknown) => clearTimeout(x as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
    const batches = this.batches;
    this.batches = new Map();
    const posts: Promise<void>[] = [];
    for (const [org, calls] of batches)
      for (let i = 0; i < calls.length; i += MAX_PER_POST) {
        const body: McpLogReport = { calls: calls.slice(i, i + MAX_PER_POST) };
        posts.push(this.deps.post(`/orgs/${encodeURIComponent(org)}/developer-logs/mcp`, body).catch(() => undefined));
      }
    await Promise.all(posts);
  }

  /** On quit: lets pending lookups settle, then flushes */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight]);
    await this.flush();
  }
}

// ── The app's instance: set by the wiring; before that (and in tests of other modules) every report is a no-op ──

let current: GovernanceReports | null = null;
export const setGovernanceReports = (r: GovernanceReports | null) => void (current = r);
export const reportMcpCall = (fileKey: string | null, tool: string) => current?.mcpCall(fileKey, tool);
export const reportAiPrompt = (fileKey: string | null, text: string, feature: string) => current?.aiPrompt(fileKey, text, feature);
export const drainGovernanceReports = (): Promise<void> => current?.drain() ?? Promise.resolve();
