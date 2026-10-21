/**
 * The run pinned above the composer (agents/progress.ts): who works and what they do now, without opening anything —
 * the header ("Claude Code is working", "3 agents working · 1 waiting for approval"), the phase line, the steps (or a
 * manager's tasks) done with a thin bar, and for a manager's answer with two tasks or more one row per task (its agent's
 * mark, its title, the agent and its current step, its time, a spinner / ⚠ / ✓, Stop on hover; a click shows its card).
 * Once the run is over it folds to its header line ("Claude Code finished · 48s"); a click opens it again.
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { Icon, IconButton, Spinner, cx } from "@/ds";
import { durationLabel, runProgress, type ProgressRow, type RunProgress } from "../../agents/progress";
import type { AgentsService, Chat, ChatTask } from "../../agents/service";
import { managerName } from "../../agents/managerName";
import { routeText } from "./StudioCards";
import { AgentMark, providerIdOf } from "./AgentMark";
import styles from "./Agents.module.css";
import { t, tp, useT } from "@/i18n";

/** Ticks once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function RunDock({ service, chat, running, onReveal }: { service: AgentsService; chat: Chat | null; running: boolean; onReveal: (taskId: string) => void }) {
  useT();
  const state = service.get();
  const p = runProgress(chat, { running, consents: state.consents, cardOpen: (id) => service.cardOpen(id) });
  // Open while the run goes, folded after; the owner's own toggle holds until the next run (or its end).
  const [toggled, setToggled] = useState<{ key: string; open: boolean } | null>(null);
  const now = useNow(!!p?.live);
  if (!p) return null;
  const key = `${p.messageId}:${p.live}`;
  const open = toggled?.key === key ? toggled.open : p.live;
  const name = (p.manager ? managerName(service.managerSettings()) : p.label) ?? t("Agent");
  const providerId = p.providerId ?? providerIdOf(p.label, state.providers);
  const tasks = new Map((chat?.tasks ?? []).map((x) => [x.id, x]));
  const agentOf = (task: ChatTask | undefined) => (!task ? "" : task.kind === "agent" ? (state.providers.find((x) => x.id === task.route.providerId)?.label ?? task.route.providerId) : routeText(task, state.providers, [], service.managerSettings()));
  const head = headLine(p, name, p.rows.length ? agentOf(tasks.get(p.rows.find((r) => r.live)?.taskId ?? "")) : "", now);
  const marks = p.manager ? [...new Set(p.rows.map((r) => r.providerId ?? (r.kind === "image" ? "image" : "manager")))] : [providerId ?? ""];
  return (
    <div className={styles.dock} data-run-dock={p.manager ? "manager" : "agent"} data-run-state={p.outcome} data-dock-open={open || undefined}>
      <button type="button" className={styles.dockHead} aria-expanded={open} onClick={() => setToggled({ key, open: !open })} data-dock-toggle="">
        <span className={styles.dockMarks}>
          {(marks.length ? marks : ["manager"]).slice(0, 4).map((m) => (m === "image" ? <span key={m} className={styles.mark}><Icon name="16.image" /></span> : <AgentMark key={m} manager={m === "manager"} providerId={m === "manager" ? undefined : m} />))}
        </span>
        <span className={styles.dockTitle} data-dock-title="">
          <strong>{head.title}</strong>
          {head.rest && <span>{` · ${head.rest}`}</span>}
        </span>
        <span className={cx(styles.groupChevron, open && styles.groupChevronOpen)}>
          <Icon name="16.chevron.down" />
        </span>
      </button>
      {open && (
        <>
          <div className={styles.phases} data-dock-phases="">
            {p.phases.map((ph) => (
              <span key={ph.label} className={styles.phase} data-phase-state={ph.state}>
                {ph.state === "done" && <Icon name="16.check" size={12} />}
                {ph.label}
              </span>
            ))}
          </div>
          <div className={styles.progress} data-dock-progress="">
            <span data-dock-count="">{p.unit === "tasks" && p.total ? t("{done}/{total} tasks", { done: p.done, total: p.total }) : tp(p.done, "{n} step", "{n} steps")}</span>
            <span className={styles.progressBar} data-indeterminate={p.pct === null || undefined}>
              <i style={p.pct === null ? undefined : { width: `${p.pct}%` }} />
            </span>
            {p.pct !== null && <span data-dock-pct={p.pct}>{t("{pct}%", { pct: p.pct })}</span>}
          </div>
          {p.rows.map((r) => (
            <DockRow key={r.taskId} r={r} agent={agentOf(tasks.get(r.taskId))} now={now} onStop={() => service.stopTask(r.taskId)} onReveal={() => onReveal(r.taskId)} />
          ))}
        </>
      )}
    </div>
  );
}

function headLine(p: RunProgress, name: string, oneAgent: string, now: number): { title: string; rest?: string } {
  const waiting = p.waiting ? tp(p.waiting, "{n} waiting for approval", "{n} waiting for approval") : undefined;
  if (p.live) {
    if (!p.manager || p.working === 0) return { title: t("{name} is working", { name }), rest: waiting };
    if (p.working === 1) return { title: t("{name} is working", { name: oneAgent || name }), rest: waiting };
    return { title: tp(p.working, "{n} agent working", "{n} agents working"), rest: waiting };
  }
  const time = p.startedAt && (p.endedAt ?? 0) >= p.startedAt ? durationLabel((p.endedAt ?? now) - p.startedAt) : undefined;
  if (p.outcome === "stopped" && !p.rows.length) return { title: t("Stopped"), rest: time };
  if (p.outcome === "error" && !p.rows.length) return { title: t("Failed"), rest: time };
  if (!p.manager || !p.rows.length) return { title: t("{name} finished", { name }), rest: time };
  const ok = p.rows.filter((r) => r.state === "done").length;
  const off = p.rows.length - ok;
  return { title: `${tp(ok, "{n} agent finished", "{n} agents finished")}${off ? `, ${tp(off, "{n} stopped", "{n} stopped")}` : ""}`, rest: time };
}

function DockRow({ r, agent, now, onStop, onReveal }: { r: ProgressRow; agent: string; now: number; onStop: () => void; onReveal: () => void }) {
  useT();
  const time = r.startedAt ? durationLabel((r.live ? now : (r.endedAt ?? now)) - r.startedAt) : "";
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onReveal();
    }
  };
  return (
    <div role="button" tabIndex={0} className={styles.dockRow} onClick={onReveal} onKeyDown={onKey} data-dock-row={r.taskId} data-task-state={r.waiting ? "waiting" : r.state}>
      {r.kind === "image" ? <span className={styles.mark}><Icon name="16.image" /></span> : <AgentMark providerId={r.providerId} manager={r.kind === "review"} />}
      <span className={styles.dockTask}>{r.title}</span>
      <span className={styles.dockTime}>{r.live && r.state === "running" ? time : !r.live ? time : ""}</span>
      <span className={cx(styles.dockState, r.live && styles.dockStateLive)} data-dock-state="">
        {r.waiting ? <Icon name="16.warning" /> : r.live ? <Spinner size={16} /> : r.state === "done" ? <Icon name="16.check" /> : r.state === "failed" ? <Icon name="16.warning" /> : <Icon name="16.close" />}
      </span>
      {r.live && (
        <IconButton
          icon="24.close.small"
          label={t("Stop")}
          tone="secondary"
          className={styles.dockStop}
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
          data-dock-stop=""
        />
      )}
      <span className={styles.dockSub}>
        <span className={styles.dockName}>{agent} ·</span>
        <span className={cx(styles.dockStep, r.waiting && styles.dockStepAsk)}>{r.step}</span>
        <span className={styles.dockCount}>{tp(r.steps, "{n} step", "{n} steps")}</span>
      </span>
    </div>
  );
}
