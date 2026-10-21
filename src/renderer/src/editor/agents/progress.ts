/**
 * The Agents panel's pinned progress (above the composer): the chat's last answer as a run — who works on it, where it
 * is (its phases), how far it got and, for a manager's answer with two tasks or more, one row per task. Only what is
 * known: the steps an agent took so far (no agent says how many it will take, so a single agent's bar is indeterminate
 * while it runs), and a manager's tasks (their count is the run's total). Pure: the panel renders it, the tests read it.
 */
import type { ConnectorConsent } from "@shared/ai/types";
import type { TaskState } from "@shared/studio/types";
import { THINKING, toolActiveLabel } from "./activity";
import { toolLabel, type Chat, type ChatMessage, type ChatTask, type MessagePart } from "./service";
import { t } from "@/i18n";

/** A single agent's phases, and a manager's (docs/ai.md §2.12). */
export const AGENT_PHASES = ["Started", "Working", "Approval", "Check", "Ready"] as const;
export const MANAGER_PHASES = ["Planned", "Agents working", "Approval", "Reviewing", "Ready"] as const;

export type PhaseState = "done" | "on" | "todo";

export interface ProgressRow {
  taskId: string;
  kind: ChatTask["kind"];
  /** The agent's id (its mark), for an agent task */
  providerId?: string;
  title: string;
  state: TaskState;
  /** Waiting for the owner's approval of one of its steps */
  waiting: boolean;
  /** What it does now, or how it ended */
  step: string;
  /** Its steps so far */
  steps: number;
  startedAt?: number;
  endedAt?: number;
  live: boolean;
}

export interface RunProgress {
  messageId: string;
  manager: boolean;
  /** The run is going */
  live: boolean;
  outcome: "running" | "done" | "stopped" | "error";
  /** The agent's id (a single agent's answer) and its name (the manager's, for a manager's answer) */
  providerId?: string;
  label?: string;
  phases: { label: string; state: PhaseState }[];
  /** Steps (a single agent) or tasks (a manager) ended so far */
  done: number;
  /** The known total: a manager's tasks; null while a single agent runs (unknown) */
  total: number | null;
  unit: "steps" | "tasks";
  /** 0–100, or null (indeterminate) */
  pct: number | null;
  rows: ProgressRow[];
  /** Tasks (or the agent) working now, and approvals waiting */
  working: number;
  waiting: number;
  startedAt?: number;
  endedAt?: number;
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>;
const tools = (parts: readonly MessagePart[] | undefined) => (parts ?? []).filter((p): p is ToolPart => p.kind === "tool");
const ended = (p: ToolPart) => p.state !== "running";

/** Looks at the file: one after a write is the agent checking its work. READS: the steps that change nothing. */
const LOOKS = new Set(["get_screenshot", "get_motion_frames", "get_design_context", "get_metadata"]);
const READS = new Set(["get_selection", "get_metadata", "get_design_context", "get_screenshot", "get_variable_defs", "view_file", "Read", "list_skills", "read_skill", "get_comments", "list_versions", "get_libraries", "list_files", "get_motion_frames", "score_motion", "get_sound_mix"]);

/** Where a single agent's running turn is: 0 started, 1 working, 3 checking (a look after a write, or its last words). */
function agentPhase(parts: readonly MessagePart[]): number {
  const steps = tools(parts);
  if (!steps.length) return 0;
  const last = parts[parts.length - 1];
  if (last?.kind === "text" && last.text.trim()) return 3;
  const running = [...steps].reverse().find((p) => p.state === "running");
  const wrote = steps.some((p) => p !== running && !READS.has(p.name));
  if (running && wrote && LOOKS.has(running.name)) return 3;
  return 1;
}

const phaseList = (labels: readonly string[], at: number, outcome: RunProgress["outcome"]) =>
  labels.map((label, i) => ({ label: t(label), state: (outcome === "done" ? "done" : i < at ? "done" : i === at && outcome === "running" ? "on" : "todo") as PhaseState }));

/** A task's line under its title: what it does now, or how it ended. */
function taskStep(task: ChatTask, waiting: boolean): string {
  if (waiting) return t("Waiting for approval");
  const steps = tools(task.worker?.parts);
  if (task.state === "queued") return t("Queued");
  if (task.state === "running") {
    const now = [...steps].reverse().find((p) => p.state === "running");
    return now ? toolActiveLabel(now.name) : t(THINKING);
  }
  if (task.state === "failed") return t("Failed");
  if (task.state === "stopped") return t("Stopped");
  const last = steps[steps.length - 1];
  return last ? toolLabel(last.name) : t("Done");
}

/**
 * The chat's last answer as a run, or null when there is none to show (no answer, or one with neither steps nor tasks
 * that isn't running). `running`: its turn is the chat's running one; `consents`: the cards waiting for the owner;
 * `cardOpen`: whether one of the manager's own cards waits on him.
 */
export function runProgress(chat: Chat | null, o: { running: boolean; consents: readonly ConnectorConsent[]; cardOpen?: (id: string) => boolean }): RunProgress | null {
  const m: ChatMessage | undefined = chat ? [...chat.messages].reverse().find((x) => x.role === "assistant") : undefined;
  if (!chat || !m) return null;
  const live = o.running && m.state === "running";
  const outcome: RunProgress["outcome"] = live ? "running" : m.state === "stopped" ? "stopped" : m.state === "error" ? "error" : "done";
  const tasks = m.manager ? (chat.tasks ?? []).filter((x) => x.messageId === m.id) : [];
  const steps = tools(m.parts);
  if (!live && !steps.length && !tasks.length) return null;
  const mine = o.consents.filter((c) => (c.chatId ? c.chatId === chat.id : c.turnId === m.turnId) || tasks.some((x) => x.worker?.turnId && x.worker.turnId === c.turnId));
  const waitingOn = (turnId: string | undefined) => !!turnId && mine.some((c) => c.turnId === turnId);
  if (!m.manager) {
    const waiting = live ? mine.length : 0;
    const at = !live ? (outcome === "done" ? AGENT_PHASES.length - 1 : agentPhase(m.parts ?? [])) : waiting ? 2 : agentPhase(m.parts ?? []);
    const done = steps.filter(ended).length;
    return {
      messageId: m.id,
      manager: false,
      live,
      outcome,
      providerId: m.providerId,
      label: m.provider,
      phases: phaseList(AGENT_PHASES, at, outcome),
      done,
      total: live ? null : done,
      unit: "steps",
      pct: live ? null : 100,
      rows: [],
      working: live ? 1 : 0,
      waiting,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
    };
  }
  const rows: ProgressRow[] = tasks.map((task) => {
    const waiting = live && waitingOn(task.worker?.turnId);
    const isLive = task.state === "running" || task.state === "queued";
    return {
      taskId: task.id,
      kind: task.kind,
      ...(task.kind === "agent" ? { providerId: task.route.providerId } : {}),
      title: task.title,
      state: task.state,
      waiting,
      step: taskStep(task, waiting),
      steps: tools(task.worker?.parts).filter(ended).length,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      live: isLive,
    };
  });
  const working = rows.filter((r) => r.live).length;
  const cardWaiting = live && !!o.cardOpen && (m.cards ?? []).some((c) => o.cardOpen!(c.id));
  const waiting = live ? mine.length + (cardWaiting ? 1 : 0) : 0;
  const at = !live ? (outcome === "done" ? MANAGER_PHASES.length - 1 : tasks.length ? (working ? 1 : 3) : 0) : waiting ? 2 : !tasks.length ? 0 : working ? 1 : 3;
  const done = rows.filter((r) => !r.live).length;
  const total = tasks.length || null;
  const ends = tasks.map((x) => x.endedAt ?? 0);
  return {
    messageId: m.id,
    manager: true,
    label: m.provider,
    live,
    outcome,
    phases: phaseList(MANAGER_PHASES, at, outcome),
    done,
    total,
    unit: "tasks",
    pct: !live ? 100 : total ? Math.round((done / total) * 100) : null,
    rows: rows.length >= 2 ? rows : [],
    working,
    waiting,
    startedAt: m.startedAt,
    endedAt: m.endedAt ?? (ends.length && !live ? Math.max(...ends) || undefined : undefined),
  };
}

/** "12s", "1m 05s" — a run's or a task's time (unlike elapsedLabel, from the first second). */
export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
