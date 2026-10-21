/**
 * The store's `ai` repository (docs/ai.md §2.9, §2.10, §8): the usage ledger, Skills, and the daily org reports.
 *
 * - **Ledger**: one file per calendar month (local time — "AI balance" resets on the 1st), `usage/YYYY-MM.json`:
 *   the month's totals (credits used, per action, runs) and its entries, newest last, the oldest dropped past
 *   `MAX_ENTRIES` (the totals keep counting). `balance(allowance)` is the current month against the allowance;
 *   `history` pages entries newest first, across months unless one is named.
 * - **Skills**: `skills/<id>.md` (frontmatter `name`, `description`, then the instructions — `skillFile.ts`), with
 *   `skills.json` keeping what the file doesn't say: enabled, created, updated. A `.md` dropped in by hand is a skill
 *   too (enabled). Names are unique.
 * - **Reports**: an entry with credits in an org's file adds to that (org, UTC day, editor type)'s total in
 *   `reports.json`; totals that changed since they were last sent go to `POST /me/ai-usage` (absolute, so a repeat is
 *   harmless) a minute after the last record, when the session changes, and at the quit. Rows belong to the account
 *   that recorded them: another account's are dropped, not sent as them. Rows older than 35 days are dropped.
 *
 * No Node or DOM imports: the desktop store (files under `Workspace/spaces/ai/`) and the browser's dev store (keys)
 * both run it through `AiStoreHost`.
 */
import { SKILL_LIMITS, SKILL_NAME_RE, type AiAction, type AiBalance, type AiRepository, type AiSkill, type AiUsageEntry } from "../../shared/ai/types";
import { parseSkillFile, skillFileText, skillProblem } from "../../shared/ai/skillFile";
import { AI_REPORT_KEEP_DAYS, AI_REPORT_MAX_ROWS, type AiUsageReportRow } from "../../shared/ai/usageReport";
import { StoreError } from "../../shared/store/protocol";
import { SerialQueue } from "../../shared/store/queue";
import type { FileMeta } from "../../shared/store/types";
import type { EditorType } from "../../shared/org/types";
import { isOffline, type LibraryServer } from "../libraries/org";
import { t as tr } from "../../shared/i18n";

export interface AiTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AiStoreHost {
  /** A text file under the AI folder ("usage/2026-10.json", "skills/<id>.md", "skills.json", "reports.json"); null: none */
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** The file names directly in a folder ("usage", "skills") */
  list(dir: string): Promise<string[]>;
  server: LibraryServer;
  getMeta(fileKey: string): FileMeta | null;
  newId(): string;
  now(): number;
  timers: AiTimers;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

/** Entries kept per month (the totals count every run) */
export const MAX_ENTRIES = 5000;
/** A report is sent this long after the last record */
export const REPORT_AFTER_MS = 60_000;
const DAY_MS = 86_400_000;

export const AI_ACTION_LIST: readonly AiAction[] = [
  "rename-layers", "rewrite", "translate", "shorten", "replace-content", "add-interactions", "first-draft",
  "make-image", "edit-image", "remove-background", "boost-resolution", "expand-image", "erase-object", "isolate-object", "vectorize",
  "visual-search", "search", "agent",
];

// ---- months ----

const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-10": the local calendar month of `t` */
export const monthOf = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
/** Local midnight of the 1st of the month after `month` */
export const resetOf = (month: string): number => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1).getTime();
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

interface MonthFile {
  v: 1;
  month: string;
  used: number;
  runs: number;
  byAction: Partial<Record<AiAction, number>>;
  /** Oldest first */
  entries: AiUsageEntry[];
}

const emptyMonth = (month: string): MonthFile => ({ v: 1, month, used: 0, runs: 0, byAction: {}, entries: [] });

/** Credits rounded to hundredths (fractions add up without drift) */
const round = (n: number) => Math.round(n * 100) / 100;

/** The balance of a month's totals against an allowance */
export function balanceOf(m: Pick<MonthFile, "month" | "used" | "byAction">, allowance: number): AiBalance {
  const a = Math.max(0, Number.isFinite(allowance) ? Math.round(allowance) : 0);
  const used = round(m.used);
  return { month: m.month, used, allowance: a, remaining: Math.max(0, round(a - used)), resetsAt: resetOf(m.month), byAction: { ...m.byAction } };
}

// ---- checks ----

const num = (v: unknown, what: string): number => {
  const n = v === undefined || v === null ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new StoreError("invalid", `ai.record: ${what} must be a number ≥ 0`);
  return n;
};
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

function cleanEntry(e: Omit<AiUsageEntry, "id" | "at">): Omit<AiUsageEntry, "id" | "at"> {
  if (!e || typeof e !== "object") throw new StoreError("invalid", "ai.record: expected an entry");
  if (!AI_ACTION_LIST.includes(e.action)) throw new StoreError("invalid", `ai.record: unknown action ${String(e.action)}`);
  const providerId = str(e.providerId, 120);
  if (!providerId) throw new StoreError("invalid", "ai.record: providerId is required");
  const model = str(e.model, 200);
  return {
    action: e.action,
    providerId,
    ...(model ? { model } : {}),
    input: Math.round(num(e.input, "input")),
    output: Math.round(num(e.output, "output")),
    images: Math.round(num(e.images, "images")),
    credits: round(num(e.credits, "credits")),
    fileKey: str(e.fileKey, 64),
    orgId: str(e.orgId, 64),
    local: !!e.local,
    ok: e.ok !== false,
  };
}

// ---- reports ----

interface ReportRow extends AiUsageReportRow {
  uid: string;
  /** The total last sent (or refused for good) */
  sent: number;
}
interface ReportsFile {
  v: 1;
  rows: ReportRow[];
}
const reportKey = (r: Pick<ReportRow, "uid" | "orgId" | "day" | "editorType">) => `${r.uid}\u0000${r.orgId}\u0000${r.day}\u0000${r.editorType}`;

// ---- skills ----

interface SkillMeta {
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
const SKILL_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** skills.json: the index, and the default skills the owner turned off (by name) */
interface SkillIndexFile {
  v: 1;
  skills: Record<string, SkillMeta>;
  defaultsOff: string[];
}

export class AiService {
  private queue = new SerialQueue();
  private reports: Map<string, ReportRow> | null = null;
  private reportTimer: unknown = null;
  private sending: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly host: AiStoreHost) {}

  // ---- the ledger ----

  private async loadMonth(month: string): Promise<MonthFile> {
    const raw = await this.readJson<Partial<MonthFile>>(`usage/${month}.json`);
    const m = raw && raw.v === 1 && Array.isArray(raw.entries) ? { ...emptyMonth(month), ...raw, month, entries: raw.entries.filter((x) => x && typeof x.id === "string") } : emptyMonth(month);
    return m;
  }

  /** Read each time (cheap; the browser's dev store has two pages writing the same keys) */
  private current(now: number): Promise<MonthFile> {
    return this.loadMonth(monthOf(now));
  }

  async record(input: Omit<AiUsageEntry, "id" | "at">): Promise<AiUsageEntry> {
    const clean = cleanEntry(input);
    return this.queue.run(async () => {
      const at = this.host.now();
      const meta = clean.fileKey ? this.host.getMeta(clean.fileKey) : null;
      const orgId = clean.orgId ?? meta?.space?.orgId ?? null;
      const entry: AiUsageEntry = { id: this.host.newId(), at, ...clean, orgId };
      const m = await this.current(at);
      m.used = round(m.used + entry.credits);
      m.runs += 1;
      if (entry.credits) m.byAction[entry.action] = round((m.byAction[entry.action] ?? 0) + entry.credits);
      m.entries.push(entry);
      if (m.entries.length > MAX_ENTRIES) m.entries.splice(0, m.entries.length - MAX_ENTRIES);
      await this.host.write(`usage/${m.month}.json`, JSON.stringify(m));
      if (orgId && entry.credits > 0) await this.addReport(orgId, utcDay(at), meta?.editorType ?? "design", entry.credits);
      return entry;
    });
  }

  balance(allowance: number, now?: number): Promise<AiBalance> {
    const t = typeof now === "number" && Number.isFinite(now) ? now : this.host.now();
    return this.queue.run(async () => balanceOf(await this.loadMonth(monthOf(t)), Number(allowance)));
  }

  async history(q: { month?: string; limit?: number; cursor?: string } = {}): Promise<{ entries: AiUsageEntry[]; cursor: string | null }> {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(q?.limit) || 50)));
    if (q?.month !== undefined && !MONTH.test(String(q.month))) throw new StoreError("invalid", "ai.history: month is YYYY-MM");
    return this.queue.run(async () => {
      // Months newest first: the one asked for, or every month with a file (and the current one).
      let months: string[];
      if (q?.month) months = [q.month];
      else {
        const files = (await this.host.list("usage").catch(() => [] as string[])).map((n) => n.replace(/\.json$/, "")).filter((n) => MONTH.test(n));
        months = [...new Set([...files, monthOf(this.host.now())])].sort().reverse();
      }
      let start = 0;
      if (q?.cursor) {
        const c = /^(\d{4}-\d{2}):(\d+)$/.exec(String(q.cursor));
        if (!c) throw new StoreError("invalid", "ai.history: bad cursor");
        const i = months.indexOf(c[1]);
        if (i < 0) return { entries: [], cursor: null };
        months = months.slice(i);
        start = Number(c[2]);
      }
      const out: AiUsageEntry[] = [];
      for (let mi = 0; mi < months.length; mi++) {
        const m = await this.loadMonth(months[mi]);
        const newest = [...m.entries].reverse();
        const from = mi === 0 ? start : 0;
        const take = newest.slice(from, from + (limit - out.length));
        out.push(...take);
        if (out.length >= limit) {
          const next = from + take.length;
          if (next < newest.length) return { entries: out, cursor: `${months[mi]}:${next}` };
          return { entries: out, cursor: mi + 1 < months.length ? `${months[mi + 1]}:0` : null };
        }
      }
      return { entries: out, cursor: null };
    });
  }

  // ---- skills ----

  private async skillFile(): Promise<SkillIndexFile> {
    const raw = await this.readJson<Partial<SkillIndexFile>>("skills.json");
    const skills = raw?.v === 1 && raw.skills && typeof raw.skills === "object" ? raw.skills : {};
    const defaultsOff = raw?.v === 1 && Array.isArray(raw.defaultsOff) ? raw.defaultsOff.filter((n): n is string => typeof n === "string" && SKILL_NAME_RE.test(n)) : [];
    return { v: 1, skills, defaultsOff };
  }

  private async skillIndex(): Promise<Record<string, SkillMeta>> {
    return (await this.skillFile()).skills;
  }

  /** skills.json with a changed index, the defaults turned off kept. */
  private async writeSkillIndex(skills: Record<string, SkillMeta>, defaultsOff?: string[]): Promise<void> {
    const file = await this.skillFile();
    const off = defaultsOff ?? file.defaultsOff;
    await this.host.write("skills.json", JSON.stringify({ v: 1, skills, ...(off.length ? { defaultsOff: off } : {}) }));
  }

  private async allSkills(): Promise<AiSkill[]> {
    const index = await this.skillIndex();
    const names = (await this.host.list("skills").catch(() => [] as string[])).filter((n) => n.endsWith(".md"));
    const out: AiSkill[] = [];
    for (const file of names) {
      const id = file.slice(0, -3);
      if (!SKILL_ID.test(id)) continue;
      const text = await this.host.read(`skills/${file}`);
      if (text === null) continue;
      const parsed = parseSkillFile(text, file);
      if ("error" in parsed) {
        this.host.log("warn", `ai: skills/${file} isn't a skill (${parsed.error})`);
        continue;
      }
      const meta = index[id];
      out.push({ id, ...parsed, enabled: meta ? meta.enabled !== false : true, createdAt: meta?.createdAt ?? 0, updatedAt: meta?.updatedAt ?? 0 });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  skills(): Promise<AiSkill[]> {
    return this.queue.run(() => this.allSkills());
  }

  async saveSkill(s: { id?: string; name: string; description: string; instructions: string; enabled?: boolean }): Promise<AiSkill> {
    if (!s || typeof s !== "object") throw new StoreError("invalid", "ai.saveSkill: expected a skill");
    const draft = { name: String(s.name ?? "").trim(), description: String(s.description ?? "").trim(), instructions: String(s.instructions ?? "").trim() };
    const problem = skillProblem(draft);
    if (problem) throw new StoreError("invalid", problem);
    if (s.id !== undefined && !SKILL_ID.test(String(s.id))) throw new StoreError("invalid", "ai.saveSkill: bad id");
    return this.queue.run(async () => {
      const all = await this.allSkills();
      const existing = s.id ? all.find((x) => x.id === s.id) : undefined;
      if (s.id && !existing) throw new StoreError("not-found", tr("That skill was deleted."));
      if (all.some((x) => x.name === draft.name && x.id !== s.id)) throw new StoreError("conflict", `A skill named “${draft.name}” already exists.`);
      const now = this.host.now();
      const id = existing?.id ?? this.host.newId();
      const skill: AiSkill = { id, ...draft, enabled: s.enabled ?? existing?.enabled ?? true, createdAt: existing?.createdAt || now, updatedAt: now };
      await this.host.write(`skills/${id}.md`, skillFileText(skill));
      const index = await this.skillIndex();
      index[id] = { enabled: skill.enabled, createdAt: skill.createdAt, updatedAt: skill.updatedAt };
      await this.writeSkillIndex(index);
      return skill;
    });
  }

  async removeSkill(id: string): Promise<void> {
    if (!SKILL_ID.test(String(id))) throw new StoreError("invalid", "ai.removeSkill: bad id");
    return this.queue.run(async () => {
      await this.host.remove(`skills/${id}.md`);
      const index = await this.skillIndex();
      if (index[id]) {
        delete index[id];
        await this.writeSkillIndex(index);
      }
    });
  }

  /** The default skills turned off (docs/ai.md §8.6), kept in skills.json beside the index. */
  defaultSkillsOff(): Promise<string[]> {
    return this.queue.run(async () => (await this.skillFile()).defaultsOff);
  }

  async setDefaultSkillOn(name: string, on: boolean): Promise<string[]> {
    if (typeof name !== "string" || !SKILL_NAME_RE.test(name) || name.length > SKILL_LIMITS.name) throw new StoreError("invalid", "ai.setDefaultSkillOn: bad name");
    return this.queue.run(async () => {
      const file = await this.skillFile();
      const off = on ? file.defaultsOff.filter((n) => n !== name) : [...new Set([...file.defaultsOff, name])].sort();
      await this.writeSkillIndex(file.skills, off);
      return off;
    });
  }

  // ---- reports ----

  private async loadReports(): Promise<Map<string, ReportRow>> {
    if (this.reports) return this.reports;
    const raw = await this.readJson<Partial<ReportsFile>>("reports.json");
    const rows = new Map<string, ReportRow>();
    if (raw?.v === 1 && Array.isArray(raw.rows))
      for (const r of raw.rows) if (r && typeof r.uid === "string" && typeof r.orgId === "string" && typeof r.day === "string" && typeof r.credits === "number") rows.set(reportKey(r), { ...r, sent: Number(r.sent) || 0 });
    this.reports = rows;
    return rows;
  }

  private async saveReports(): Promise<void> {
    const rows = await this.loadReports();
    await this.host.write("reports.json", JSON.stringify({ v: 1, rows: [...rows.values()] } satisfies ReportsFile)).catch((e) => this.host.log("warn", "ai: couldn't save the usage reports", e));
  }

  private async addReport(orgId: string, day: string, editorType: EditorType, credits: number): Promise<void> {
    const uid = this.host.server.userId;
    if (!uid) return;
    const rows = await this.loadReports();
    const k = reportKey({ uid, orgId, day, editorType });
    const had = rows.get(k);
    rows.set(k, { uid, orgId, day, editorType, credits: round((had?.credits ?? 0) + credits), sent: had?.sent ?? 0 });
    await this.saveReports();
    this.scheduleReport();
  }

  private scheduleReport(): void {
    if (this.closed) return;
    if (this.reportTimer) this.host.timers.clearTimeout(this.reportTimer);
    this.reportTimer = this.host.timers.setTimeout(() => {
      this.reportTimer = null;
      void this.flush();
    }, REPORT_AFTER_MS);
  }

  /** Rows waiting to be sent (tests) */
  async pendingReports(): Promise<AiUsageReportRow[]> {
    const rows = await this.queue.run(() => this.loadReports());
    const uid = this.host.server.userId;
    return [...rows.values()].filter((r) => r.uid === uid && r.credits !== r.sent).map(({ orgId, day, editorType, credits }) => ({ orgId, day, editorType, credits }));
  }

  /** Sends the totals that changed (one send at a time) */
  flush(): Promise<void> {
    if (!this.sending)
      this.sending = this.queue
        .run(() => this.send())
        .catch((e) => this.host.log("warn", "ai: sending usage failed", e))
        .finally(() => {
          this.sending = null;
        });
    return this.sending;
  }

  private async send(): Promise<void> {
    const rows = await this.loadReports();
    const uid = this.host.server.userId;
    const oldest = utcDay(this.host.now() - AI_REPORT_KEEP_DAYS * DAY_MS);
    let changed = false;
    for (const [k, r] of rows)
      if (r.day < oldest || (uid !== null && r.uid !== uid)) {
        if (r.uid !== uid && r.credits !== r.sent) this.host.log("info", "ai: dropped usage recorded by another account");
        rows.delete(k);
        changed = true;
      }
    if (!this.host.server.signedIn || !uid) {
      if (changed) await this.saveReports();
      return;
    }
    const due = [...rows.values()].filter((r) => r.credits !== r.sent);
    for (let i = 0; i < due.length; i += AI_REPORT_MAX_ROWS) {
      const chunk = due.slice(i, i + AI_REPORT_MAX_ROWS);
      let status: number;
      try {
        status = (await this.host.server.request("POST", "/me/ai-usage", { rows: chunk.map(({ orgId, day, editorType, credits }) => ({ orgId, day, editorType, credits })) })).status;
      } catch (e) {
        if (!isOffline(e)) this.host.log("warn", "ai: sending usage failed", e);
        break;
      }
      if (status >= 500 || status === 429) break;
      if (status >= 400) this.host.log("warn", `ai: the server refused ${chunk.length} usage rows (${status})`);
      for (const r of chunk) {
        const now = rows.get(reportKey(r));
        if (now) now.sent = r.credits;
      }
      changed = true;
    }
    if (changed) await this.saveReports();
  }

  /** The quit: what changed is sent within `ms` at most */
  async close(ms = 2000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reportTimer) this.host.timers.clearTimeout(this.reportTimer);
    this.reportTimer = null;
    if (!this.reports || !this.host.server.signedIn) return;
    let timer: unknown = null;
    await Promise.race([this.flush(), new Promise<void>((r) => (timer = this.host.timers.setTimeout(r, ms)))]);
    if (timer) this.host.timers.clearTimeout(timer);
  }

  // ---- the repository ----

  repository(): AiRepository {
    return {
      record: (e) => this.record(e),
      balance: (allowance, now) => this.balance(allowance, now),
      history: (q) => this.history(q ?? {}),
      skills: () => this.skills(),
      saveSkill: (s) => this.saveSkill(s),
      removeSkill: (id) => this.removeSkill(id),
      defaultSkillsOff: () => this.defaultSkillsOff(),
      setDefaultSkillOn: (name, on) => this.setDefaultSkillOn(name, on),
    };
  }

  private async readJson<T>(name: string): Promise<T | null> {
    const text = await this.host.read(name).catch(() => null);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      this.host.log("warn", `ai: ${name} is unreadable; starting it again`);
      return null;
    }
  }
}
