import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REACH_LIMITS, cleanReachSettings, isReachCapability, type AccessLogEntry, type ReachSettings } from "../../../shared/agents/reach";

/**
 * Agents' reach on disk (docs/agents-reach.md §7), main's only: `reach.json` (policies and grants) and
 * `access-log.jsonl` (the last REACH_LIMITS.log calls), both mode 0600 in userData/agents. Electron-free (the folder is
 * given), so the tests use a temp folder.
 */
export class ReachStore {
  private log: AccessLogEntry[] | null = null;
  private lines = 0;

  constructor(private dir: string) {}

  private path(name: string) {
    return join(this.dir, name);
  }

  private writePrivate(path: string, text: string) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }

  settings(): ReachSettings {
    try {
      return cleanReachSettings(JSON.parse(readFileSync(this.path("reach.json"), "utf8")));
    } catch {
      return cleanReachSettings(null);
    }
  }

  saveSettings(s: ReachSettings): ReachSettings {
    const clean = cleanReachSettings(s);
    this.writePrivate(this.path("reach.json"), JSON.stringify(clean, null, 1));
    return clean;
  }

  private loadLog(): AccessLogEntry[] {
    if (this.log) return this.log;
    const out: AccessLogEntry[] = [];
    try {
      const text = existsSync(this.path("access-log.jsonl")) ? readFileSync(this.path("access-log.jsonl"), "utf8") : "";
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.lines++;
        try {
          const e = JSON.parse(line) as AccessLogEntry;
          if (e && typeof e.at === "number" && isReachCapability(e.capability) && typeof e.tool === "string") out.push(e);
        } catch {
          /* a torn line */
        }
      }
    } catch {
      /* none yet */
    }
    this.log = out.slice(-REACH_LIMITS.log);
    return this.log;
  }

  append(e: AccessLogEntry) {
    const log = this.loadLog();
    log.push(e);
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path("access-log.jsonl"), `${JSON.stringify(e)}\n`, { mode: 0o600 });
      this.lines++;
      // Kept short: rewritten with the last entries once it has grown a quarter past the limit.
      if (this.lines > REACH_LIMITS.log * 1.25) {
        this.log = log.slice(-REACH_LIMITS.log);
        this.writePrivate(this.path("access-log.jsonl"), this.log.map((x) => JSON.stringify(x)).join("\n") + "\n");
        this.lines = this.log.length;
      }
    } catch {
      /* the log never fails a call */
    }
    if (log.length > REACH_LIMITS.log) this.log = log.slice(-REACH_LIMITS.log);
  }

  /** Newest first. */
  entries(limit = REACH_LIMITS.log): AccessLogEntry[] {
    return this.loadLog().slice(-limit).reverse();
  }

  clearLog() {
    this.log = [];
    this.lines = 0;
    try {
      this.writePrivate(this.path("access-log.jsonl"), "");
    } catch {
      /* nothing to clear */
    }
  }
}
