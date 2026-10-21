import type { ToolResult } from "../../../shared/agents/tools";
import { REACH_LIMITS, REACH_TOOL_BY_NAME, REACH_TOOLS, effectivePolicy, reachTarget, type AccessConsent, type AccessLogEntry, type ReachCapability, type ReachPolicy, type ReachSettings, type ReachToolDef } from "../../../shared/agents/reach";

/**
 * The one gate of agents' reach (docs/agents-reach.md §3–4): which reach tools a chat sees, and every call's policy —
 * Off (refused), Ask (the chat's consent card; Always allow makes the capability Allow), Allow — an org's switch, the
 * per-turn budget, the time limit, the size of what comes back, and the access log line. The runners (web, GitHub,
 * files, apps) only do the work. Electron-free: settings, the org's policy, the consent card and the log are injected.
 */

export interface ReachCaller {
  turnId: string;
  chatId: string;
  fileKey: string;
  /** The agent's name as the chat shows it ("Claude Code") */
  agent: string;
}

export interface RunContext extends ReachCaller {
  settings: ReachSettings;
  policy: ReachPolicy;
  signal: AbortSignal;
}

export type ReachRunner = (tool: string, args: Record<string, unknown>, ctx: RunContext) => Promise<ToolResult>;

export interface ReachConsentRequest {
  turnId: string;
  chatId: string;
  tool: string;
  args: Record<string, unknown>;
  access: AccessConsent;
}

export interface ReachHubOptions {
  settings(): ReachSettings;
  setPolicy(cap: ReachCapability, policy: ReachPolicy): void;
  /** Capabilities organizations forced off (cached by the caller) */
  forcedOff(): Promise<readonly ReachCapability[]>;
  ask(req: ReachConsentRequest): Promise<{ allow: boolean; remember?: boolean }>;
  log(entry: AccessLogEntry): void;
  runners: Partial<Record<ReachCapability, ReachRunner>>;
  now?(): number;
}

const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** A runner's result kept inside the limits: ≤ 20 blocks, text cut, images too large replaced by a note. */
export function boundResult(r: ToolResult): ToolResult {
  const content = (Array.isArray(r?.content) ? r.content : []).slice(0, 20).map((c): ToolResult["content"][number] => {
    if (c.type === "text") return c.text.length > REACH_LIMITS.text + 2000 ? { type: "text", text: `${c.text.slice(0, REACH_LIMITS.text)}\n[… cut]` } : c;
    if (c.data.length > REACH_LIMITS.imageBase64) return { type: "text", text: "(a picture was left out: it is larger than 4 MB)" };
    return c;
  });
  return { content: content.length ? content : [{ type: "text", text: "(no result)" }], ...(r?.isError ? { isError: true } : {}), ...(r?.touched ? { touched: r.touched } : {}) };
}

export class ReachHub {
  private calls = new Map<string, number>();

  constructor(private o: ReachHubOptions) {}

  /** The reach tools a chat sees: those whose capability is on (not Off, not forced off) and has a runner. */
  async tools(): Promise<ReachToolDef[]> {
    const s = this.o.settings();
    const off = await this.o.forcedOff().catch(() => [] as ReachCapability[]);
    return REACH_TOOLS.filter((t) => this.o.runners[t.capability] && effectivePolicy(s, off, t.capability) !== "off");
  }

  /** Capabilities on now (for the built-in skills and the turn's note). */
  async on(): Promise<ReachCapability[]> {
    return [...new Set((await this.tools()).map((t) => t.capability))];
  }

  has(name: string): boolean {
    return REACH_TOOL_BY_NAME.has(name);
  }

  /** A turn ended: its budget goes. */
  forgetTurn(turnId: string) {
    this.calls.delete(turnId);
  }

  /**
   * A reach call through the gate. `run` replaces the capability's runner for this call (install_skill reads its
   * source through the same policy, consent, budget, time limit and log as read_skill / read_repo_file).
   */
  async call(caller: ReachCaller, name: string, args: Record<string, unknown>, run?: ReachRunner): Promise<ToolResult> {
    const def = REACH_TOOL_BY_NAME.get(name);
    if (!def) return error(`Unknown tool: ${name}`);
    const cap = def.capability;
    const target = reachTarget(name, args ?? {});
    const at = this.o.now?.() ?? Date.now();
    const log = (outcome: AccessLogEntry["outcome"], detail?: string) =>
      this.o.log({ at, capability: cap, tool: name, target, outcome, ...(detail ? { detail: detail.slice(0, 300) } : {}), chatId: caller.chatId, fileKey: caller.fileKey, agent: caller.agent });
    const settings = this.o.settings();
    const off = await this.o.forcedOff().catch(() => [] as ReachCapability[]);
    if (off.includes(cap)) {
      log("refused", "turned off by an organization");
      return error(`${def.title} is turned off by your organization.`);
    }
    const policy = effectivePolicy(settings, off, cap);
    const runner = run ?? this.o.runners[cap];
    if (policy === "off" || !this.o.runners[cap] || !runner) {
      log("refused", "turned off");
      return error(`${def.title} is turned off. The owner can turn it on in Agent settings › Access.`);
    }
    const n = (this.calls.get(caller.turnId) ?? 0) + 1;
    this.calls.set(caller.turnId, n);
    if (n > REACH_LIMITS.callsPerTurn) {
      log("refused", "too many calls this turn");
      return error(`That's ${REACH_LIMITS.callsPerTurn} calls that reach outside this file in one turn: finish with what you have.`);
    }
    // Local apps ask with their own card, the window picker (the owner's pick is the consent): the runner shows it.
    if (policy === "ask" && cap !== "apps") {
      const answer = await this.o.ask({ turnId: caller.turnId, chatId: caller.chatId, tool: name, args, access: { capability: cap, action: def.action, target } }).catch(() => ({ allow: false }));
      if (!answer.allow) {
        log("denied");
        return error(`The owner didn't allow ${name} (${target}). Don't call it again for this request.`);
      }
      if ("remember" in answer && answer.remember) this.o.setPolicy(cap, "allow");
    }
    const ctl = new AbortController();
    const ms = REACH_LIMITS.timeoutMs[cap];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<ToolResult>((resolve) => {
        timer = setTimeout(() => {
          resolve(error(`${def.title} took too long (${Math.round(ms / 1000)} s) and was stopped.`));
          ctl.abort();
        }, ms);
      });
      const r = boundResult(await Promise.race([runner(name, args ?? {}, { ...caller, settings, policy, signal: ctl.signal }), timeout]));
      const why = r.isError ? r.content.find((c) => c.type === "text")?.text : undefined;
      log(r.isError ? (/didn.t (pick|allow)|denied/i.test(why ?? "") ? "denied" : "error") : "ok", why);
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", msg);
      return error(`${def.title}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
