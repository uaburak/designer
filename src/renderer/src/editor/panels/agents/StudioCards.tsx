/**
 * The manager's cards in its answer (docs/studio.md §2.3, §2.4, §4.1, §6.1): one task card per task it started (title,
 * who runs it, its state and time, its credits, Stop, and a disclosure with the worker's words and steps and its prompt,
 * which the owner can edit and run again once the task has ended, §5.2), and the cards it waits on — a choice (the image model card with "Use this for this chat"), the brand and
 * product forms (editor/studio/forms.tsx), and the review (each frame ✓ or its problems, boxes on its thumbnail, "Fix
 * selected" / "Leave as is").
 */
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Icon, IconButton, Spinner, TextArea, cx, tooltipProps } from "@/ds";
import type { ProviderInfo } from "@shared/agents/types";
import type { ImageRouteInfo } from "@shared/ai/types";
import { useImageRoutes } from "./ManagerSettings";
import type { ManagerSettings, ReviewReport, TaskState } from "@shared/studio/types";
import { managerName } from "../../agents/managerName";
import { elapsedLabel, segmentsOf } from "../../agents/activity";
import { modelLabel } from "../../agents/setup";
import { toolLabel, type AgentsService, type ChatTask } from "../../agents/service";
import type { ViewCard } from "../../agents/managerTools";
import { BrandForm, ProductForm } from "../../studio/forms";
import { useUI } from "../../hooks";
import styles from "./Agents.module.css";
import { t, tp, useT } from "@/i18n";

const STATE_LABEL: Record<TaskState, string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" };

/** "claude-sonnet-5-5" → "Sonnet 5.5"; else the agent's own name for it. */
function shortModel(m: string, p?: ProviderInfo): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  return modelLabel(m, p);
}

/** "Claude Code · Sonnet 5.5", "Gemini API · Nano Banana Pro" (an image route's names as main reports them). */
export function routeText(task: Pick<ChatTask, "kind" | "route">, providers: readonly ProviderInfo[], images: readonly ImageRouteInfo[] = [], manager?: Pick<ManagerSettings, "name">): string {
  const p = providers.find((x) => x.id === task.route.providerId);
  if (task.kind === "review") return managerName(manager);
  if (task.kind === "image") {
    const r = images.find((x) => x.providerId === task.route.providerId);
    const model = task.route.model ? (r?.models.find((m) => m.id === task.route.model)?.label ?? task.route.model) : null;
    return [r?.label ?? task.route.providerId, model].filter(Boolean).join(" · ");
  }
  const who = p?.label ?? task.route.providerId;
  return task.route.model ? `${who} · ${shortModel(task.route.model, p)}` : who;
}

/** Ticks once a second while `on` (a running task's time). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function TaskCard({ task, service }: { task: ChatTask; service: AgentsService }) {
  useT();
  const [open, setOpen] = useState(false);
  // The prompt as the owner edits it to run the task again (§5.2); null: not editing
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const images = useImageRoutes();
  const running = task.state === "running";
  const now = useNow(running);
  const time = running ? elapsedLabel(task.startedAt, now + 5000) : "";
  const ended = task.state === "done" || task.state === "failed" || task.state === "stopped";
  const log = task.worker;
  const segs = log ? segmentsOf({ state: log.state === "running" ? "running" : "done", parts: log.parts }) : [];
  // A new task in the same answer, beside this one; this card goes back to its prompt.
  const runAgain = () => {
    if (editing === null) return;
    void service.runTaskAgain(task.id, editing).then((why) => {
      setProblem(why);
      if (!why) setEditing(null);
    });
  };
  return (
    <div className={styles.task} data-task={task.id} data-task-state={task.state} data-task-kind={task.kind}>
      <div className={styles.taskHead}>
        <button type="button" className={styles.taskToggle} aria-expanded={open} onClick={() => setOpen(!open)} data-task-toggle="">
          <span className={cx(styles.taskIcon, styles[`task_${task.state}`])}>
            {running ? <Spinner size={16} /> : task.state === "done" ? <Icon name="16.check" /> : task.state === "queued" ? <Icon name="24.recent" /> : <Icon name="16.warning" />}
          </span>
          <span className={styles.taskText}>
            <span className={styles.taskTitle}>{task.title}</span>
            <span className={styles.taskMeta}>
              {routeText(task, service.get().providers, images, service.managerSettings())} · <span data-task-state-label="">{t(STATE_LABEL[task.state])}</span>
              {time && ` ${time}`}
              {!!task.credits && ` · ${tp(task.credits, "{n} credit", "{n} credits")}`}
            </span>
          </span>
          <span className={cx(styles.groupChevron, open && styles.groupChevronOpen)}>
            <Icon name="16.chevron.down" />
          </span>
        </button>
        {!ended && <IconButton icon="24.close.small" label={t("Stop")} tone="secondary" onClick={() => service.stopTask(task.id)} data-task-stop="" />}
      </div>
      {task.error && <div className={styles.taskError}>{task.error}</div>}
      {open && (
        <div className={styles.taskBody} data-task-body="">
          {task.summary && <p className={styles.taskSummary}>{task.summary}</p>}
          {segs.map((s) =>
            s.kind === "text" ? (
              <p key={s.key} className={styles.taskSummary}>{s.text}</p>
            ) : (
              s.steps.map((step) => (
                <div key={step.id} className={styles.tool} data-tool={step.name} data-tool-state={step.state} {...tooltipProps(step.summary)}>
                  <span className={styles.toolIcon}>{step.state === "running" ? <Spinner size={16} /> : step.state === "error" ? <Icon name="16.warning" /> : <Icon name="16.check" />}</span>
                  <span className={styles.toolLabel}>{toolLabel(step.name)}</span>
                </div>
              ))
            )
          )}
          {log?.error && <div className={styles.taskError}>{log.error}</div>}
          {task.prompt && (
            <details className={styles.taskPrompt} open={editing !== null || undefined}>
              <summary>{t("Prompt")}</summary>
              {editing === null ? <pre className={styles.consentArgs}>{task.prompt}</pre> : <TextArea label={t("Prompt")} value={editing} onChange={setEditing} minRows={4} maxRows={12} data-task-prompt-edit="" />}
              {ended && task.again && (
                <div className={styles.actions}>
                  {editing === null ? (
                    <Button variant="secondary" onClick={() => setEditing(task.prompt!)} data-task-edit="">
                      {t("Edit")}
                    </Button>
                  ) : (
                    <>
                      <Button variant="primary" disabled={!editing.trim()} onClick={runAgain} data-task-again="">
                        {t("Run again")}
                      </Button>
                      <Button variant="secondary" onClick={() => setEditing(null)} data-task-edit-cancel="">
                        {t("Cancel")}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {problem && <div className={styles.taskError} role="alert">{problem}</div>}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** A card the manager waits on. */
export function ManagerCard({ card, service }: { card: ViewCard; service: AgentsService }) {
  useT();
  const open = service.cardOpen(card.id) && !card.answer;
  if (card.kind === "choice") return <ChoiceCard card={card} open={open} service={service} />;
  if (card.kind === "review") return <ReviewCard card={card} open={open} service={service} />;
  const answered = card.answer ? ("cancelled" in card.answer ? t("Cancelled") : t("Saved")) : open ? null : t("Not answered");
  return (
    <div className={styles.consent} data-card={card.kind} data-card-open={open || undefined}>
      <p className={styles.consentTitle}>{card.kind === "brand-form" ? (card.brandId ? t("Edit brand") : t("New brand")) : card.productId ? t("Edit product") : t("New product")}</p>
      {open && card.kind === "brand-form" && <BrandForm brandId={card.brandId} prefill={card.prefill} onDone={(brandId) => service.answerCard(card.id, { brandId })} onCancel={() => service.answerCard(card.id, { cancelled: true })} />}
      {open && card.kind === "product-form" && <ProductForm brandId={card.brandId} productId={card.productId} prefill={card.prefill} onDone={(productId) => service.answerCard(card.id, { productId })} onCancel={() => service.answerCard(card.id, { cancelled: true })} />}
      {answered && <span className={styles.cardAnswer}>{answered}</span>}
    </div>
  );
}

/**
 * Social's follow-ups (docs/social.md §7.1, ask_choice {suggestions}): at most three chips under the manager's answer,
 * nothing waiting on them; a click is the owner's next message, and the chips are answered.
 */
function FollowUps({ card, service }: { card: Extract<ViewCard, { kind: "choice" }>; service: AgentsService }) {
  useT();
  const picked = card.answer && "optionId" in card.answer ? card.answer.optionId : null;
  const chat = service.currentChat();
  const busy = !!chat && !!service.get().running[chat.id];
  return (
    <div className={styles.followUps} role="group" aria-label={card.question} data-card="follow-ups">
      {card.options.map((o) => (
        <button key={o.id} type="button" className={cx(styles.followUp, picked === o.id && styles.choiceOn)} disabled={!!picked || busy} {...(o.detail ? tooltipProps(o.detail) : {})} onClick={() => service.pickSuggestion(card.id, o.id)} data-follow-up={o.id}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ChoiceCard({ card, open, service }: { card: Extract<ViewCard, { kind: "choice" }>; open: boolean; service: AgentsService }) {
  useT();
  const [remember, setRemember] = useState(!!card.remember);
  const picked = card.answer && "optionId" in card.answer ? card.answer.optionId : null;
  if (card.suggestions) return <FollowUps card={card} service={service} />;
  return (
    <div className={styles.consent} role="group" aria-label={card.question} data-card="choice" data-card-open={open || undefined}>
      <p className={styles.consentTitle}>{card.question}</p>
      <div className={styles.choices}>
        {card.options.map((o) => {
          const off = !!card.disabled?.includes(o.id);
          return (
            <button key={o.id} type="button" className={cx(styles.choice, picked === o.id && styles.choiceOn)} disabled={!open || off} onClick={() => service.answerCard(card.id, { optionId: o.id, remember })} data-choice={o.id}>
              <span className={styles.choiceLabel}>{o.label}</span>
              {o.detail && <span className={styles.choiceDetail}>{o.detail}</span>}
            </button>
          );
        })}
      </div>
      {card.remember && open && <Checkbox label={t("Use this for this chat")} checked={remember} onChange={setRemember} data-choice-remember="" />}
      {!open && !picked && <span className={styles.cardAnswer}>{t("Not answered")}</span>}
    </div>
  );
}

/** A frame's thumbnail with its problems' boxes over it. */
function Thumb({ nodeId, size, boxes, service }: { nodeId: string; size: { width: number; height: number } | null; boxes: { id: string; x: number; y: number; width: number; height: number }[]; service: AgentsService }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void service.thumbnail(nodeId).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [nodeId, service]);
  if (!url) return <span className={styles.reviewThumb} />;
  return (
    <span className={styles.reviewThumb}>
      <img src={url} alt="" draggable={false} />
      {size &&
        boxes.map((b) => (
          <span key={b.id} className={styles.reviewBox} style={{ left: `${(b.x / size.width) * 100}%`, top: `${(b.y / size.height) * 100}%`, width: `${(b.width / size.width) * 100}%`, height: `${(b.height / size.height) * 100}%` }} />
        ))}
    </span>
  );
}

const KIND_LABEL: Record<string, string> = { "sharp-text": "Label text", "soft-text": "Small print", shape: "Shape", extra: "Extra", missing: "Missing", layout: "Layout", brand: "Brand", "safe-area": "Safe area", caption: "Caption", contrast: "Contrast", logo: "Logo", video: "Video" };

function ReviewCard({ card, open, service }: { card: Extract<ViewCard, { kind: "review" }>; open: boolean; service: AgentsService }) {
  useT();
  const report: ReviewReport = card.report;
  const all = report.items.flatMap((i) => i.problems.map((p) => p.id));
  const [checked, setChecked] = useState<string[]>(all);
  const answer = card.answer;
  // A review pin on the canvas picked one of this card's problems (docs/social.md §6.4): marked and scrolled into view.
  const pinned = useUI((s) => s.socialProblem ?? null);
  const mine = pinned && report.items.some((i) => i.nodeId === pinned.post && i.problems.some((p) => p.id === pinned.problem)) ? pinned.problem : null;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mine) return;
    root.current?.querySelector(`[data-review-problem="${CSS.escape(mine)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [mine]);
  return (
    <div ref={root} className={styles.consent} data-card="review" data-card-open={open || undefined}>
      <p className={styles.consentTitle}>{t("Review")}</p>
      {report.items.map((it) => {
        const size = service.frameSize(it.nodeId);
        return (
          <div key={it.nodeId} className={styles.reviewItem} data-review-item={it.nodeId} data-review-ok={it.ok || undefined}>
            <Thumb nodeId={it.nodeId} size={size} boxes={it.problems.flatMap((p) => (p.box ? [{ id: p.id, ...p.box }] : []))} service={service} />
            <div className={styles.reviewText}>
              <span className={styles.taskTitle}>
                {it.ok && <Icon name="16.check" />} {it.name}
              </span>
              {it.problems.map((p) => (
                <div key={p.id} className={cx(mine === p.id && styles.reviewProblemOn)} data-review-problem={p.id} data-pinned={mine === p.id || undefined}>
                  {open ? (
                    <Checkbox label={`${t(KIND_LABEL[p.kind] ?? p.kind)}: ${p.detail}`} checked={checked.includes(p.id)} onChange={(on) => setChecked(on ? [...checked, p.id] : checked.filter((x) => x !== p.id))} data-problem={p.id} />
                  ) : (
                    <span className={styles.taskMeta}>{`${t(KIND_LABEL[p.kind] ?? p.kind)}: ${p.detail}`}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {open && all.length > 0 && (
        <div className={styles.actions}>
          <Button variant="primary" disabled={!checked.length} onClick={() => service.answerCard(card.id, { fix: checked })} data-review-fix="">
            {t("Fix selected")}
          </Button>
          <Button variant="secondary" onClick={() => service.answerCard(card.id, { cancelled: true })} data-review-leave="">
            {t("Leave as is")}
          </Button>
        </div>
      )}
      {answer && <span className={styles.cardAnswer}>{"fix" in answer ? tp(answer.fix.length, "Fixing {n} problem", "Fixing {n} problems") : t("Left as is")}</span>}
    </div>
  );
}
