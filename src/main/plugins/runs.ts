import { effectiveDomains } from "./network";

/**
 * The plugin runs main knows of (docs/plugins.md §3.3): registered by the editor view that runs them
 * (`plugins:begin-run`, or `plugins:open-ui` for a run that shows a UI), each with the domains its manifest allows
 * (`devAllowedDomains` added for a development plugin) and, while its UI is shown, its `ui.html`. A run belongs to the
 * view that registered it: another view can't fetch through it or replace its UI. A view that goes away takes its runs.
 */

/** A run id is the host of `plugin://<runId>/` — a standard scheme lower-cases hosts, so ids are lower case. */
export const RUN_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface PluginRun {
  runId: string;
  /** The webContents that registered it */
  owner: number;
  dev: boolean;
  /** The effective allowedDomains entries */
  domains: string[];
  /** The UI document while it is shown */
  html: string | null;
}

export const MAX_UI_HTML_BYTES = 20 * 1024 * 1024;
const MAX_RUNS = 64;

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((d): d is string => typeof d === "string" && d.length <= 2048).slice(0, 500) : []);

export class PluginRuns {
  private readonly runs = new Map<string, PluginRun>();

  get(runId: string): PluginRun | undefined {
    return this.runs.get(runId);
  }

  /** Registers (or updates) a run's network rules; throws when the id is bad or another view holds it. */
  begin(owner: number, input: { runId: unknown; allowedDomains: unknown; devAllowedDomains?: unknown; dev: unknown }): PluginRun {
    const runId = input.runId;
    if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("plugins: a run id is lower-case letters, digits and hyphens");
    const old = this.runs.get(runId);
    if (old && old.owner !== owner) throw new Error("plugins: that run belongs to another view");
    if (!old && this.runs.size >= MAX_RUNS) throw new Error("plugins: too many plugin runs");
    const dev = input.dev === true;
    const run: PluginRun = { runId, owner, dev, domains: effectiveDomains(asList(input.allowedDomains), asList(input.devAllowedDomains), dev), html: old?.html ?? null };
    this.runs.set(runId, run);
    return run;
  }

  /** The run's UI document (`plugin://<runId>/ui.html`). */
  openUi(owner: number, input: { runId: unknown; html: unknown; allowedDomains: unknown; devAllowedDomains?: unknown; dev: unknown }): { url: string } {
    if (typeof input.html !== "string") throw new Error("plugins:open-ui: no html");
    if (Buffer.byteLength(input.html) > MAX_UI_HTML_BYTES) throw new Error("plugins:open-ui: the UI is larger than 20 MB");
    const run = this.begin(owner, input);
    run.html = input.html;
    return { url: `plugin://${run.runId}/ui.html` };
  }

  closeUi(owner: number, runId: unknown) {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined;
    if (run && run.owner === owner) run.html = null;
  }

  end(owner: number, runId: unknown) {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined;
    if (run && run.owner === owner) this.runs.delete(run.runId);
  }

  /** A view went away (closed, reloaded): its runs end. */
  endAll(owner: number) {
    for (const [id, run] of this.runs) if (run.owner === owner) this.runs.delete(id);
  }

  /** The run `owner` may use (fetch), or a refusal. */
  ownedBy(owner: number, runId: unknown): PluginRun {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined;
    if (!run || run.owner !== owner) throw new Error("plugins: this plugin run isn't registered (plugins:begin-run)");
    return run;
  }

  /** Every run of a view (frame navigation checks) */
  of(owner: number): PluginRun[] {
    return [...this.runs.values()].filter((r) => r.owner === owner);
  }
}

export const pluginRuns = new PluginRuns();
