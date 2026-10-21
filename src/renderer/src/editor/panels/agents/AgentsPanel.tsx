/**
 * The Agents tab (left rail; docs/research/figma/R12-agents-mcp.md §3): Figma's agent chat, driven here by the AI
 * tools on this computer. Its views: the file's chats (by recency, "New chat") and a chat (the prompts with the
 * selection they were about, the agent's answer streamed with its steps — open, each a quiet line —, the turn's changes
 * with Undo / Apply, the run pinned above the message box, Stop while it runs, a message typed meanwhile queued, the
 * agent and model under the message box). The gear opens "This chat" (ChatSettings.tsx); All settings is a modal over
 * the panel (AgentSettingsModal.tsx).
 */
import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { NO_FILTER, filterChats, matchSnippet, splitMatches, type ChatFilter, type ChatSort } from "../../agents/chatList";
import { Button, Dialog, EmptyState, Icon, IconButton, MenuButton, Portal, SearchField, Select, Spinner, cx, place, timeAgo, tooltipProps, useDismiss, type IconName } from "@/ds";
import { MAX_ATTACHMENTS, isImageMime, type Attachment, type AttachResult } from "@shared/agents/attachments";
import type { ProviderInfo } from "@shared/agents/types";
import { creditsFor, type ConnectorConsent } from "@shared/ai/types";
import { slashQuery } from "@shared/ai/skillFile";
import { useConnectors, useSkills } from "./aiData";
import { useEditor } from "../../controller";
import { useTopics } from "../../hooks";
import { agentsOf, type AgentsService, type Chat, type ChatMessage, type ImagePart, type MessagePart } from "../../agents/service";
import { MODEL_SEP, modelMenu, pickModel } from "../../agents/models";
import { formatTokens, relevantWindows, resetLabel, ringOf, usedLabel } from "../../agents/usage";
import { elapsedLabel, segmentsOf, type Segment } from "../../agents/activity";
import { REVEAL_MS } from "../../agents/imagePlaceholder";
import { managerName } from "../../agents/managerName";
import { TabHeader } from "../TabHeader";
import { AgentSettingsModal } from "./AgentSettingsModal";
import { ChatSettings } from "./ChatSettings";
import { ModelPicker } from "./ModelPicker";
import { RunDock } from "./RunDock";
import { AgentMark, providerIdOf } from "./AgentMark";
import { ToolRow } from "./StepRow";
import { ManagerCard, TaskCard, REVEAL_TASK } from "./StudioCards";
import styles from "./Agents.module.css";
import { intlLocale, t, tp, useT } from "@/i18n";

function useAgents(): [AgentsService, ReturnType<AgentsService["get"]>] {
  const ed = useEditor();
  const service = agentsOf(ed);
  const state = useSyncExternalStore(service.subscribe, service.get);
  return [service, state];
}

/** The selection as the message's context, re-read when it changes. */
function useSelectionContext(service: AgentsService) {
  const ed = useEditor();
  const version = useTopics(ed.store, ["selection", "structure"]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => service.selectionContext() ?? [], [service, version]);
}

/** Text put in the composer from outside the panel (Social's Ask agent…, docs/social.md §6.3), and its taking. */
type ComposerDraft = { draft: { id: number; text: string } | null; taken: () => void };
const DraftContext = createContext<ComposerDraft>({ draft: null, taken: () => {} });

/**
 * `placement`: the left panel's Agents tab (Design), or Social's right panel (docs/social.md §6.3) — one instance mounts
 * at a time. `draft` / `onDraftTaken`: text the composer takes once, with the focus.
 */
export function AgentsPanel({ placement = "left", draft = null, onDraftTaken }: { placement?: "left" | "right"; draft?: { id: number; text: string } | null; onDraftTaken?: () => void } = {}) {
  useT();
  const [service, state] = useAgents();
  const composerDraft = useMemo<ComposerDraft>(() => ({ draft, taken: () => onDraftTaken?.() }), [draft, onDraftTaken]);
  useEffect(() => {
    if (state.available && !state.providers.length && !state.providersLoading) void service.refreshProviders();
    // Once per panel: providers are refreshed from settings after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);
  // The gear's "This chat" popover, anchored to the gear (a press on it toggles).
  const [gear, setGear] = useState<HTMLSpanElement | null>(null);
  const [quick, setQuick] = useState(false);
  const actions = (
    <>
      <span ref={setGear} className={styles.plus}>
        <IconButton icon="24.settings.small" label={t("Agent settings")} tone="secondary" disabled={!state.available} aria-expanded={quick} aria-haspopup="dialog" onClick={() => setQuick(!quick)} data-agents-settings="" />
      </span>
      <IconButton icon="24.plus.small" label={t("New chat")} tone="secondary" disabled={!state.available} onClick={() => service.newChat()} />
    </>
  );
  return (
    <DraftContext.Provider value={composerDraft}>
      <div className={styles.panel} data-agents="" data-view={state.view} data-settings-open={state.settingsOpen || undefined} data-placement={placement}>
        <TabHeader title={t("Agents")} actions={actions} />
        {!state.available ? (
          <EmptyState icon="24.agents" title={t("Agents run in the desktop app")} body={t("Open this file in Wecra to chat with the AI tools on your computer.")} />
        ) : state.view === "list" && state.chats.length ? (
          <ChatList service={service} chats={state.chats} />
        ) : (
          <ChatView service={service} chat={service.currentChat()} />
        )}
        {quick && state.available && <ChatSettings service={service} anchor={gear} onClose={() => setQuick(false)} />}
        {state.settingsOpen && state.available && <AgentSettingsModal service={service} />}
      </div>
    </DraftContext.Provider>
  );
}

// ---- The chats ------------------------------------------------------------------------------------------------------

/**
 * The chats: a top bar (search by title and message text, the filter menu, "•••"), the list, and — sticky at the
 * bottom, the list fading into the panel under it — the composer: a message sent here starts a new chat and opens it.
 */
function ChatList({ service, chats }: { service: AgentsService; chats: Chat[] }) {
  useT();
  const state = service.get();
  const [filter, setFilter] = useState<ChatFilter>(NO_FILTER);
  const [confirmAll, setConfirmAll] = useState(false);
  const shown = useMemo(() => filterChats(chats, filter), [chats, filter]);
  const agents = useMemo(() => {
    const ids = [...new Set(chats.map((c) => c.providerId).filter((x): x is string => !!x))];
    return ids.map((id) => ({ id, label: state.providers.find((p) => p.id === id)?.label ?? id }));
  }, [chats, state.providers]);
  const searching = !!filter.query.trim();
  return (
    <div className={styles.chats} data-chats="">
      <div className={styles.listBar} data-chats-bar="">
        <SearchField className={styles.listSearch} value={filter.query} onChange={(query) => setFilter({ ...filter, query })} placeholder={t("Search chats")} label={t("Search chats")} data-chats-search="" />
        <MenuButton
          label={t("Filter chats")}
          tooltip
          className={cx(styles.barButton, (filter.agent || filter.sort !== "recent") && styles.barButtonOn)}
          align="end"
          entries={[
            { header: t("Agent") },
            { id: "agent:", label: t("All agents"), checked: !filter.agent },
            ...agents.map((a) => ({ id: `agent:${a.id}`, label: a.label, checked: filter.agent === a.id })),
            "-",
            { header: t("Sort by") },
            { id: "sort:recent", label: t("Recent"), checked: filter.sort === "recent" },
            { id: "sort:oldest", label: t("Oldest"), checked: filter.sort === "oldest" },
          ]}
          onSelect={(id) => (id.startsWith("agent:") ? setFilter({ ...filter, agent: id.slice(6) || null }) : setFilter({ ...filter, sort: id.slice(5) as ChatSort }))}
        >
          <Icon name="24.filter" />
        </MenuButton>
        <MenuButton
          label={t("More")}
          tooltip
          className={styles.barButton}
          align="end"
          entries={[{ id: "new", label: t("New chat") }, { id: "settings", label: t("Agent settings") }, "-", { id: "delete-all", label: t("Delete all chats…") }]}
          onSelect={(id) => (id === "new" ? service.newChat() : id === "settings" ? service.setView("settings") : setConfirmAll(true))}
        >
          <Icon name="24.more" />
        </MenuButton>
      </div>
      <div className={styles.scroll} role="list" aria-label={t("Chats")} data-chats-list="">
        {shown.map((c) => {
          const last = [...c.messages].reverse().find((m) => m.role === "assistant");
          const found = searching && splitMatches(c.title, filter.query).length < 2 ? matchSnippet(c, filter.query) : null;
          const preview = found ?? (last ? partsText(last).slice(0, 120) || last.error || "" : "");
          return (
            <div key={c.id} role="listitem" className={styles.chatRow} data-chat={c.id}>
              <button type="button" className={styles.chatOpen} onClick={() => service.openChat(c.id)}>
                <span className={styles.chatTitle}><Highlighted text={c.title} query={filter.query} /></span>
                <span className={styles.chatPreview}><Highlighted text={preview} query={filter.query} /></span>
                <span className={styles.chatTime}>{timeAgo(c.updatedAt)}</span>
              </button>
              <IconButton icon="24.trash.outline" label={t("Delete chat")} tone="secondary" className={styles.chatDelete} onClick={() => service.deleteChat(c.id)} />
            </div>
          );
        })}
        {!shown.length && <p className={styles.noChats} data-no-chats="">{t("No chats found")}</p>}
      </div>
      <div className={styles.listFoot} data-chats-foot="">
        <Composer service={service} chat={null} running={false} />
      </div>
      <Dialog
        title={t("Delete all chats?")}
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        footer={
          <>
            <Button variant="secondary" size="large" onClick={() => setConfirmAll(false)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              size="large"
              onClick={() => {
                setConfirmAll(false);
                service.deleteAllChats();
              }}
              data-delete-all=""
            >
              {t("Delete all")}
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>{tp(chats.length, "The chat in this file will be deleted. This can’t be undone.", "The {n} chats in this file will be deleted. This can’t be undone.")}</p>
      </Dialog>
    </div>
  );
}

/** `text` with the query's matches marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const parts = splitMatches(text, query);
  if (parts.length < 2) return <>{text}</>;
  return <>{parts.map((t, i) => (i % 2 ? <mark key={i} className={styles.match}>{t}</mark> : t))}</>;
}

const partsText = (m: ChatMessage) => (m.parts ?? []).filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("");

const SUGGESTIONS_WITH_SELECTION = ["Make the mobile version of this", "Make this responsive with auto layout", "Rename these layers"];
const SUGGESTIONS = ["Design a login screen for a mobile app", "What's on this page?"];
/** How long a task's card is marked after the pinned progress showed it. */
const FLASH_MS = 900;

function ChatView({ service, chat }: { service: AgentsService; chat: Chat | null }) {
  useT();
  const state = service.get();
  const running = chat ? !!state.running[chat.id] : false;
  const scroller = useRef<HTMLDivElement>(null);
  const last = chat?.messages[chat.messages.length - 1];
  const lastLength = last ? (last.text?.length ?? 0) + partsText(last).length + (last.parts?.length ?? 0) : 0;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat?.messages.length, lastLength]);
  const selection = useSelectionContext(service);
  // The approvals answered in this view, kept as quiet lines under the answer they were asked in.
  const [answered, setAnswered] = useState<Answered[]>([]);
  const lastAnswer = chat ? [...chat.messages].reverse().find((m) => m.role === "assistant") : undefined;
  // A task row of the pinned progress shows its card: scrolled to, opened, flashed.
  const reveal = (taskId: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(taskId)}"]`);
    if (!el) return;
    el.dispatchEvent(new CustomEvent(REVEAL_TASK));
    el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    el.setAttribute("data-flash", "");
    setTimeout(() => el.removeAttribute("data-flash"), FLASH_MS);
  };
  return (
    <div className={styles.chat}>
      {state.chats.length > 0 && (
        <div className={styles.chatBar}>
          <IconButton icon="24.arrow.left" label={t("Back")} tone="secondary" onClick={() => service.setView("list")} />
          <span className={styles.chatBarTitle}>{chat?.title ?? t("New chat")}</span>
        </div>
      )}
      <div ref={scroller} className={styles.scroll} data-messages="">
        {!chat || !chat.messages.length ? (
          <div className={styles.intro}>
            <span className={styles.introIcon}><Icon name="24.agents" /></span>
            <p className={styles.introTitle}>{t("What should we design?")}</p>
            <p className={styles.introBody}>{t("Agents on this computer read and edit this file. Select a frame and ask — every reply’s changes are one undo step.")}</p>
            <div className={styles.suggestions}>
              {(selection?.length ? SUGGESTIONS_WITH_SELECTION : SUGGESTIONS).map((s) => (
                <button key={s} type="button" className={styles.suggestion} onClick={() => void service.send(t(s))} data-suggestion="">
                  {t(s)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          chat.messages.map((m) => (m.role === "user" ? <UserMessage key={m.id} m={m} /> : <AgentMessage key={m.id} m={m} service={service} />))
        )}
        {chat && answered.filter((a) => a.chatId === chat.id && a.messageId === lastAnswer?.id).map((a) => <AnsweredLine key={a.reqId} a={a} />)}
        {running && chat && state.consents.filter((c) => (c.chatId ? c.chatId === chat.id : c.turnId === state.running[chat.id])).map((c) => {
          const who = whoAsks(c, chat, service);
          const answer = (allow: boolean, remember = false, windowId?: string) => {
            setAnswered((list) => [...list, { reqId: c.reqId, chatId: chat.id, messageId: lastAnswer?.id, allowed: allow, text: askText(c, who.name) }]);
            service.answerConsent(c.reqId, allow, remember, windowId);
          };
          return c.confirm ? <ConfirmCard key={c.reqId} c={c} who={who} answer={answer} /> : c.access ? <AccessCard key={c.reqId} c={c} who={who} answer={answer} /> : <ConsentCard key={c.reqId} c={c} who={who} answer={answer} />;
        })}
      </div>
      <RunDock service={service} chat={chat} running={running} onReveal={reveal} />
      <Composer service={service} chat={chat} running={running} />
    </div>
  );
}

/** An approval answered: a quiet line where its card was ("Allowed · Claude Code, publish the library"). */
type Answered = { reqId: number; chatId: string; messageId?: string; allowed: boolean; text: string };

function AnsweredLine({ a }: { a: Answered }) {
  useT();
  return (
    <div className={styles.asked} data-consent-answered={a.allowed ? "allowed" : "denied"}>
      <span className={styles.toolIcon}><Icon name={a.allowed ? "16.check" : "16.close"} /></span>
      <span className={styles.askedText}>{`${a.allowed ? t("Allowed") : t("Denied")} · ${a.text}`}</span>
    </div>
  );
}

/** Who asks: the manager's task's agent, or the chat turn's (the manager or the agent the answer is from). */
function whoAsks(c: ConnectorConsent, chat: Chat, service: AgentsService): { name: string; providerId?: string; manager?: boolean } {
  const state = service.get();
  const task = chat.tasks?.find((x) => x.worker?.turnId === c.turnId);
  if (task) return { name: state.providers.find((p) => p.id === task.route.providerId)?.label ?? task.worker?.provider ?? task.route.providerId, providerId: task.route.providerId };
  const m = chat.messages.find((x) => x.turnId === c.turnId);
  if (m?.manager) return { name: managerName(service.managerSettings()), manager: true };
  const label = m?.provider ?? t("Agent");
  return { name: label, providerId: m?.providerId ?? providerIdOf(label, state.providers) };
}

/** "Claude Code: publish this file as a library · Wecra UI" — what an answered card leaves. */
function askText(c: ConnectorConsent, who: string): string {
  const action = c.confirm ? t(c.confirm.action) : c.access ? t(c.access.action) : t("use {tool}", { tool: c.tool });
  const target = c.confirm?.target ?? c.access?.target ?? c.connector;
  return `${who}: ${action}${target ? ` · ${target}` : ""}`;
}

const TYPE_ICON: Record<string, IconName> = { FRAME: "16.frame", TEXT: "16.text", RECTANGLE: "16.rectangle", COMPONENT: "16.component", SYMBOL: "16.component", INSTANCE: "16.instance", IMAGE: "16.image" };

function ContextChip({ item, onRemove }: { item: NonNullable<ChatMessage["context"]>[number]; onRemove?: () => void }) {
  useT();
  return (
    <span className={styles.chip} data-context-chip="" {...tooltipProps(`${item.format ? `${t(item.format)} · ` : ""}${Math.round(item.width)} × ${Math.round(item.height)}`)}>
      <Icon name={TYPE_ICON[item.type] ?? "16.frame"} />
      <span className={styles.chipName}>{item.name || item.type.toLowerCase()}</span>
      {/* A Social post shows its format (docs/social.md §6.3) */}
      {item.format && <span className={styles.contextFormat} data-context-format="">{t(item.format)}</span>}
      {onRemove && (
        <button type="button" className={styles.chipRemove} aria-label={t("Remove from context")} onClick={onRemove}>
          <Icon name="16.close" />
        </button>
      )}
    </span>
  );
}

/** A file attached to a message: its picture (or a document glyph), its name, and ✕ while it is in the composer. */
function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  useT();
  const kind = a.mime === "application/pdf" ? "PDF" : a.mime.replace("image/", "").toUpperCase().replace("JPEG", "JPG");
  return (
    <span className={cx(styles.chip, styles.fileChip)} data-attachment-chip={a.mime} {...tooltipProps(`${a.name} · ${kind} · ${fileSize(a.size)}`)}>
      {a.thumb ? <img className={styles.fileThumb} src={a.thumb} alt="" draggable={false} /> : <Icon name={isImageMime(a.mime) ? "16.image" : "16.document"} />}
      <span className={styles.chipName}>{a.name}</span>
      {onRemove && (
        <button type="button" className={styles.chipRemove} aria-label={t("Remove {name}", { name: a.name })} onClick={onRemove} data-attachment-remove="">
          <Icon name="16.close" />
        </button>
      )}
    </span>
  );
}

const fileSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <div className={styles.user} data-message="user">
      {!!m.context?.length && (
        <div className={styles.chips}>
          {m.context.slice(0, 3).map((c) => <ContextChip key={c.id} item={c} />)}
          {m.context.length > 3 && <span className={styles.more}>+{m.context.length - 3}</span>}
        </div>
      )}
      {!!m.attachments?.length && (
        <div className={styles.chips} data-message-attachments="">
          {m.attachments.map((a) => <AttachmentChip key={a.id} a={a} />)}
        </div>
      )}
      {!!m.text && <div className={styles.userBubble}>{m.text}</div>}
    </div>
  );
}

function AgentMessage({ m, service }: { m: ChatMessage; service: AgentsService }) {
  useT();
  const segments = segmentsOf(m);
  const providerId = m.manager ? undefined : (m.providerId ?? providerIdOf(m.provider, service.get().providers));
  // A single agent's groups carry its mark; the manager's keep the Agents glyph (turning while it works).
  const who = !m.manager && m.provider ? { providerId } : undefined;
  return (
    <div className={styles.agent} data-message="assistant" data-state={m.state}>
      {/* The manager's answers carry its name as it is now (Agent settings › Manager › Name) */}
      {(m.manager || m.provider) && (
        <span className={styles.agentName} data-agent-name="">
          <AgentMark manager={m.manager} providerId={providerId} />
          {m.manager ? managerName(service.managerSettings()) : m.provider}
        </span>
      )}
      {segments.map((s) => (s.kind === "text" ? <div key={s.key} className={styles.agentText} data-agent-text="">{renderText(s.text)}</div> : <StepGroup key={s.key} seg={s} since={m.startedAt} who={who} />))}
      {/* The tasks first, the cards under them: a card waits on the owner, nearest the composer */}
      {m.manager && <ManagerTasks messageId={m.id} service={service} />}
      {m.cards?.map((c) => <ManagerCard key={c.id} card={c} service={service} />)}
      {m.error && <div className={styles.error} role="alert">{m.error}</div>}
      {m.state === "stopped" && <div className={styles.stopped}>{t("Stopped")}</div>}
      {m.changes && m.turnId && <Changes turnId={m.turnId} changes={m.changes} service={service} />}
      {m.usage && m.state !== "running" && <Credits usage={m.usage} />}
    </div>
  );
}

/** The tasks a manager's answer started (docs/studio.md §2.3), one card each. */
function ManagerTasks({ messageId, service }: { messageId: string; service: AgentsService }) {
  const chat = service.currentChat();
  const tasks = chat ? service.tasksOf(chat, messageId) : [];
  if (!tasks.length) return null;
  return (
    <div className={styles.tasks} data-tasks="">
      {tasks.map((t) => <TaskCard key={t.id} task={t} service={service} />)}
    </div>
  );
}

/** A finished reply's AI credits icon: the turn's credits on hover (docs/ai.md §7, Figma's agent prompt). */
function Credits({ usage }: { usage: NonNullable<ChatMessage["usage"]> }) {
  useT();
  const credits = creditsFor("agent", usage);
  const label = `${tp(credits, "{count} AI credit", "{count} AI credits", { count: credits.toLocaleString(intlLocale()) })} · ${t("{tokens} tokens", { tokens: formatTokens(usage.input + usage.output) })}`;
  return (
    <span className={styles.credits} aria-label={label} {...tooltipProps(label)} data-credits={credits}>
      <Icon name="16.sparkle" />
    </span>
  );
}

type Who = { name: string; providerId?: string; manager?: boolean };
type Answer = (allow: boolean, remember?: boolean, windowId?: string) => void;

/** An approval's one line: who wants what, the target after it (quieter); details (arguments, a preview) folded. */
function AskLine({ who, what, target }: { who: Who; what: string; target?: string }) {
  return (
    <div className={styles.askLine}>
      <AgentMark providerId={who.providerId} manager={who.manager} />
      <span className={styles.askText} data-ask-text="">
        {t("{who} wants to {action}", { who: who.name, action: what })}
        {target && <span className={styles.askTarget}>{` · ${target}`}</span>}
      </span>
    </div>
  );
}

function AskDetails({ text, ...data }: { text: string } & Record<`data-${string}`, string>) {
  useT();
  return (
    <details className={styles.askDetails}>
      <summary>{t("Details")}</summary>
      <pre className={styles.consentArgs} {...data}>{text}</pre>
    </details>
  );
}

/** A connector's tool asks to run (its policy is Ask): "Allow once", "Always allow", "Deny" (docs/ai.md §2.11). */
function ConsentCard({ c, who, answer }: { c: ConnectorConsent; who: Who; answer: Answer }) {
  useT();
  const args = JSON.stringify(c.args ?? {}, null, 1);
  return (
    <div className={styles.ask} role="alertdialog" aria-label={t("{connector} wants to use {tool}", { connector: c.connector, tool: c.tool })} data-consent={c.reqId}>
      <AskLine who={who} what={t("use {tool}", { tool: c.tool })} target={c.connector} />
      {args !== "{}" && <AskDetails text={args.slice(0, 2000)} />}
      <div className={styles.actions}>
        <Button variant="primary" onClick={() => answer(true)} data-consent-once="">
          {t("Allow once")}
        </Button>
        <Button variant="secondary" onClick={() => answer(true, true)} data-consent-always="">
          {t("Always allow")}
        </Button>
        <Button variant="secondary" onClick={() => answer(false)} data-consent-deny="">
          {t("Deny")}
        </Button>
      </div>
    </div>
  );
}

/**
 * An agent's destructive or outward action waits for the owner (docs/research/agent-parity.md §4): one line — who
 * wants to ‹action› · the target —, what it will save (a skill's text, a comment) folded under Details, "Allow" /
 * "Deny" — never remembered. Answered, it leaves a quiet line ("Allowed · …").
 */
function ConfirmCard({ c, who, answer }: { c: ConnectorConsent; who: Who; answer: Answer }) {
  useT();
  const k = c.confirm!;
  return (
    <div className={styles.ask} role="alertdialog" aria-label={t("{who} wants to {action}", { who: who.name, action: t(k.action) })} data-consent={c.reqId} data-confirm-consent={c.tool}>
      <AskLine who={who} what={t(k.action)} target={k.target} />
      {k.preview && <AskDetails text={k.preview} data-confirm-preview="" />}
      <div className={styles.actions}>
        <Button variant="primary" onClick={() => answer(true)} data-consent-once="">
          {t("Allow")}
        </Button>
        <Button variant="secondary" onClick={() => answer(false)} data-consent-deny="">
          {t("Deny")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Agents' reach asks first (docs/agents-reach.md §3): who wants to open a web page · the target, "Allow once",
 * "Always allow", "Deny" — or, for Local apps, the window picker: the owner's click on a window is the consent.
 */
function AccessCard({ c, who, answer }: { c: ConnectorConsent; who: Who; answer: Answer }) {
  useT();
  const a = c.access!;
  return (
    <div className={styles.ask} role="alertdialog" aria-label={t("{who} wants to {action}", { who: who.name, action: t(a.action) })} data-consent={c.reqId} data-access-consent={a.capability}>
      <AskLine who={who} what={t(a.action)} target={a.target} />
      {a.windows ? (
        <>
          {!a.windows.length && <p className={styles.consentMeta}>{t("No windows to pick: open the app and ask again.")}</p>}
          <div className={styles.windowGrid}>
            {a.windows.map((w) => (
              <button key={w.id} type="button" className={styles.windowTile} onClick={() => answer(true, false, w.id)} data-window-pick={w.id}>
                <img className={styles.windowThumb} src={w.thumb} alt="" />
                <span className={styles.windowName}>{w.name}</span>
              </button>
            ))}
          </div>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => answer(false)} data-consent-deny="">
              {t("Deny")}
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => answer(true)} data-consent-once="">
            {t("Allow once")}
          </Button>
          <Button variant="secondary" onClick={() => answer(true, true)} data-consent-always="">
            {t("Always allow")}
          </Button>
          <Button variant="secondary" onClick={() => answer(false)} data-consent-deny="">
            {t("Deny")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A run of the agent's steps as a row with its steps open under it — the single agent's work is read without a click;
 * the row's chevron folds them (then "· 5 steps" says what is folded). The row: the agent's mark (the manager's Agents
 * glyph), a line, the count, a chevron. While the turn is in it the row is the thinking line — the glyph turning, what
 * it does now ("Reading the design…", "Thinking…") in grey with a lighter sweep, the seconds after 5 s (only they
 * re-render each second); then it settles to its last step's words ("Read the design"). Each step is a quiet line: its
 * icon, what it did and, quieter, what it said of it. An image's group keeps its card under the row.
 */
function StepGroup({ seg, since, who }: { seg: Exclude<Segment, { kind: "text" }>; since?: number; who?: { providerId?: string } }) {
  useT();
  const [open, setOpen] = useState(true);
  const image = seg.kind === "image" ? seg.image : undefined;
  const hasSteps = seg.steps.length > 0;
  // A card put up for a picture the agent never started, fading out: no row of its own.
  const row = seg.active || hasSteps || image?.state !== "cancelled";
  const thinking = seg.active ? "" : undefined;
  const n = seg.steps.length;
  const head = (
    <>
      {who ? (
        <AgentMark providerId={who.providerId} className={styles.groupMark} />
      ) : (
        <span className={cx(styles.groupIcon, seg.active && styles.groupIconActive)} aria-hidden="true">
          <Icon name="24.agents" />
        </span>
      )}
      <span className={cx(styles.groupLabel, seg.active && styles.thinkingText)} data-thinking-label={thinking} data-group-label="" aria-live={seg.active ? "polite" : undefined}>
        <HeldLabel label={seg.label} hold={seg.active} />
      </span>
      {!seg.active && n > 1 && <span className={styles.groupCount} data-group-count={n}>{tp(n, "· {n} step", "· {n} steps")}</span>}
      {seg.active && <Elapsed since={since} />}
      {hasSteps && (
        <span className={cx(styles.groupChevron, open && styles.groupChevronOpen)}>
          <Icon name="16.chevron.down" />
        </span>
      )}
    </>
  );
  return (
    <div className={styles.stepGroup} data-step-group={seg.kind} data-group-state={seg.active ? "running" : "done"}>
      {row &&
        (hasSteps ? (
          <button type="button" className={styles.groupHeader} aria-expanded={open} onClick={() => setOpen(!open)} data-thinking={thinking} data-group-toggle="">
            {head}
          </button>
        ) : (
          <div className={styles.groupHeader} role="status" data-thinking={thinking}>
            {head}
          </div>
        ))}
      {open && hasSteps && (
        <div className={styles.groupSteps} data-group-steps="">
          {seg.steps.map((p) => <ToolRow key={p.id} p={p} />)}
        </div>
      )}
      {image && <ImageCard p={image} />}
    </div>
  );
}

/**
 * The running group's line, held at least a beat per step: an agent's steps can come and go in a few milliseconds, and
 * the line is there so one can read what the wait is about.
 */
function HeldLabel({ label, hold }: { label: string; hold: boolean }) {
  const [shown, setShown] = useState(label);
  const since = useRef(0);
  useEffect(() => {
    if (!hold) return;
    const wait = Math.max(0, since.current + HOLD_MS - Date.now());
    const t = setTimeout(() => {
      since.current = Date.now();
      setShown(label);
    }, wait);
    return () => clearTimeout(t);
  }, [label, hold]);
  return <>{hold ? shown : label}</>;
}
const HOLD_MS = 1200;

/** The seconds since the turn was sent, from 5 s on; ticks once a second (only itself re-renders). */
function Elapsed({ since }: { since: number | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  const text = elapsedLabel(since, now);
  return text ? <span className={styles.thinkingTime} data-thinking-time="">{text}</span> : null;
}

/** A picture's bytes from the file's images, as a URL for the card (released with it). */
function useImageUrl(hash: string | undefined): string | null {
  const ed = useEditor();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!hash) return;
    let live = true;
    let made: string | null = null;
    void ed.images.bytes(hash).then((bytes) => {
      if (!live || !bytes) return;
      made = URL.createObjectURL(new Blob([bytes as BlobPart]));
      setUrl(made);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [ed, hash]);
  return url;
}

/** How long a reveal waits for the picture's bytes before showing it without one. */
const REVEAL_WAIT_MS = 3000;

/**
 * An image the agent makes: grey with a soft light sweeping across while it is made, then the picture. A card seen
 * being made plays the reveal when the picture comes (a last brighter sweep, then the grey dissolves over the picture,
 * blurred to sharp); a card put up for a picture the prompt asked for, that never came, fades out.
 */
function ImageCard({ p }: { p: ImagePart }) {
  useT();
  const busy = p.state === "generating" || p.state === "ready";
  const url = useImageUrl(p.state === "placed" ? p.hash : undefined);
  // "wait": the picture came, its bytes are loading under the grey; "play": the reveal.
  const [reveal, setReveal] = useState<"none" | "wait" | "play">("none");
  const [prev, setPrev] = useState(p.state);
  if (prev !== p.state) {
    setPrev(p.state);
    if (p.state === "placed" && (prev === "generating" || prev === "ready")) setReveal("wait");
  }
  useEffect(() => {
    if (reveal === "none") return;
    // Played (or the bytes never came): the picture alone.
    const timer = setTimeout(() => setReveal("none"), reveal === "play" ? REVEAL_MS : REVEAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [reveal]);
  const caption = p.state === "generating" || p.state === "cancelled" ? t("Making an image…") : p.state === "ready" || reveal !== "none" ? t("Placing the image…") : p.state === "failed" ? t("Image not placed") : null;
  return (
    <div className={styles.imageCard} data-image-card={p.state} data-reveal={reveal === "none" ? undefined : reveal} style={{ "--aspect": Math.max(0.25, Math.min(4, p.aspect || 1)) } as CSSProperties}>
      {p.state === "placed" && (url ? <img className={styles.imageCardImg} src={url} alt="" draggable={false} onLoad={() => setReveal((r) => (r === "wait" ? "play" : r))} /> : <span className={styles.imageCardFill} />)}
      {(busy || p.state === "cancelled" || reveal !== "none") && <span className={cx(styles.imageCardFill, styles.imageCardBusy)} data-image-veil="" />}
      {caption && <span className={styles.imageCardCaption}>{caption}</span>}
    </div>
  );
}

function Changes({ turnId, changes, service }: { turnId: string; changes: NonNullable<ChatMessage["changes"]>; service: AgentsService }) {
  useT();
  const label = changes.count ? tp(changes.count, "Changed {n} layer", "Changed {n} layers") : t("Changed the file");
  return (
    <div className={styles.changes} data-changes={changes.state}>
      <span className={styles.changesLabel}>{changes.state === "undone" ? t("Undone") : label}</span>
      {changes.state === "applied" && (
        <Button variant="secondary" onClick={() => service.undoTurn(turnId)} data-turn-undo="">
          {t("Undo")}
        </Button>
      )}
      {changes.state === "undone" && (
        <Button variant="secondary" onClick={() => service.applyTurn(turnId)} data-turn-apply="">
          {t("Apply")}
        </Button>
      )}
      {changes.state === "stale" && <span className={styles.changesHint} {...tooltipProps(t("Everything it changed was changed again since: nothing left to undo"))}>{t("Edited since")}</span>}
      {changes.state !== "stale" && !!changes.overwritten && (
        <span className={styles.changesHint} data-changes-overwritten="" {...tooltipProps(tp(changes.overwritten, "{n} layer it changed was changed again since (by you or another chat). Undo leaves those changes as they are.", "{n} layers it changed were changed again since (by you or another chat). Undo leaves those changes as they are."))}>
          {t("Partly edited since")}
        </span>
      )}
    </div>
  );
}

/** Paragraphs, "- " lists, **bold** and `code` — the agent's markdown, as React nodes (never as HTML). */
export function renderText(text: string): ReactNode[] {
  const blocks = text.trim().split(/\n{2,}/);
  return blocks.map((block, i) => {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)))
      return (
        <ul key={i} className={styles.list}>
          {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>)}
        </ul>
      );
    return <p key={i} className={styles.para}>{lines.map((l, j) => <Fragment key={j}>{j ? <br /> : null}{inline(l)}</Fragment>)}</p>;
  });
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((seg, i) => (seg.startsWith("**") && seg.endsWith("**") && seg.length > 4 ? <strong key={i}>{seg.slice(2, -2)}</strong> : seg.startsWith("`") && seg.endsWith("`") && seg.length > 2 ? <code key={i}>{seg.slice(1, -1)}</code> : seg));
}

/**
 * The message box, Claude's desktop composer in Figma's chrome: the selection and the attached files as chips, the
 * text, and under it "+" (add files) on the left; the model, its effort, the usage ring and Send on the right. Files
 * come from "+" (main's dialog), a drop, or ⌘V (a screenshot, a copied picture, files copied in Finder).
 */
function Composer({ service, chat, running }: { service: AgentsService; chat: Chat | null; running: boolean }) {
  useT();
  const [text, setText] = useState("");
  const [dropped, setDropped] = useState<string[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [adding, setAdding] = useState(0);
  const [dragging, setDragging] = useState(false);
  const selection = useSelectionContext(service);
  const context = (selection ?? []).filter((s) => !dropped.includes(s.id));
  const state = service.get();
  const provider = service.activeProvider();
  // Files belong to the chat they were attached in (its folder): another chat starts without them.
  const chatId = chat?.id ?? null;
  const [filesChat, setFilesChat] = useState(chatId);
  if (filesChat !== chatId) {
    setFilesChat(chatId);
    // A new chat just made from this message keeps nothing either (they were sent).
    setFiles([]);
    setProblems([]);
  }
  const full = files.length >= MAX_ATTACHMENTS;
  const add = (job: Promise<AttachResult>) => {
    setAdding((n) => n + 1);
    void job
      .then(
        (r) => {
          setFiles((list) => [...list, ...r.attachments].slice(0, MAX_ATTACHMENTS));
          setProblems(r.errors);
        },
        (err: unknown) => setProblems([err instanceof Error ? err.message : String(err)])
      )
      .finally(() => setAdding((n) => n - 1));
  };
  // Skills (`/name`, the "+" menu's Skills ▸) and the chat's connectors (Connectors ▸) — docs/ai.md §2.10–2.11.
  const { list: skills } = useSkills();
  const { list: allConnectors } = useConnectors(service.api);
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  // Text from outside (Social's Ask agent…): taken once, the caret at its end; an empty one only focuses the field.
  const outside = useContext(DraftContext);
  const [draftSeen, setDraftSeen] = useState<number | null>(null);
  if (outside.draft && outside.draft.id !== draftSeen) {
    setDraftSeen(outside.draft.id);
    if (outside.draft.text) {
      setText(outside.draft.text);
      setCaret(outside.draft.text.length);
    }
  }
  useEffect(() => {
    if (!outside.draft) return;
    outside.taken();
    requestAnimationFrame(() => {
      const end = input.current?.value.length ?? 0;
      input.current?.focus();
      input.current?.setSelectionRange(end, end);
    });
    // Once per draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outside.draft?.id]);
  const [slashActive, setSlashActive] = useState(0);
  const [slashClosed, setSlashClosed] = useState<string | null>(null);
  const slash = slashQuery(text, caret);
  const slashMatches = slash && slashClosed !== text ? skills.filter((s) => s.enabled && s.name.startsWith(slash.query)).slice(0, 8) : [];
  const on = service.chatConnectors(chatId);
  const chatConnectors = allConnectors.filter((c) => c.enabled && on.includes(c.id));
  const pickSkill = (name: string) => {
    const at = slash ?? { start: 0, query: "" };
    const before = slash ? text.slice(0, at.start) : "";
    const after = slash ? text.slice(at.start + 1 + at.query.length) : text;
    const next = `${before}/${name} ${after.replace(/^\s+/, "")}`;
    setText(next);
    const pos = before.length + name.length + 2;
    setCaret(pos);
    setSlashActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(pos, pos);
    });
  };
  const plus = (id: string) => {
    if (id === "files") return add(service.pickAttachments());
    if (id.startsWith("skill:")) return pickSkill(id.slice(6));
    if (id.startsWith("connector:")) return service.toggleConnector(chatId, id.slice(10));
    if (id === "add-skill" || id === "add-connector") return service.openSetting(id);
    if (id === "manage-skills") return service.openSetting("section:skills");
    if (id === "manage-connectors") return service.openSetting("section:connectors");
  };
  const canSend = (!!text.trim() || files.length > 0) && !!provider && !adding;
  // A message written while the turn runs waits (one at a time: a new one replaces it) and goes when the turn ends.
  const [queued, setQueued] = useState<{ chatId: string | null; text: string; context: typeof context; files: Attachment[] } | null>(null);
  const clear = () => {
    setText("");
    setDropped([]);
    setFiles([]);
    setProblems([]);
  };
  const send = () => {
    if (!canSend) return;
    if (running) {
      setQueued({ chatId, text, context, files });
      return clear();
    }
    void service.send(text, context, files, skills);
    clear();
  };
  // The turn over: the queued message goes (into the chat it was written in).
  const waiting = queued && queued.chatId === chatId ? queued : null;
  const sent = useRef<typeof waiting>(null);
  useEffect(() => {
    if (running || !waiting || sent.current === waiting) return;
    sent.current = waiting;
    void service.send(waiting.text, waiting.context, waiting.files, skills).finally(() => setQueued((q) => (q === waiting ? null : q)));
    // Once per turn's end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, waiting]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        return setSlashActive((i) => (i + (e.key === "ArrowDown" ? 1 : slashMatches.length - 1)) % slashMatches.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        return pickSkill(slashMatches[Math.min(slashActive, slashMatches.length - 1)].name);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return setSlashClosed(text);
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    // Keys typed here are the message's, never the canvas's shortcuts.
    e.stopPropagation();
  };
  // ⌘V of a picture or a file attaches it; text pastes as text. (The canvas's paste leaves text fields alone.)
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    if (!data || !hasFiles(data)) return;
    e.preventDefault();
    e.stopPropagation();
    if (full) return setProblems([t("Up to {n} files a message", { n: MAX_ATTACHMENTS })]);
    add(service.attachPasted([...data.files]));
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (full) return setProblems([t("Up to {n} files a message", { n: MAX_ATTACHMENTS })]);
    add(service.attachFiles([...e.dataTransfer.files]));
  };
  return (
    <div
      className={cx(styles.composer, dragging && styles.composerDrop)}
      data-composer=""
      data-dragging={dragging || undefined}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {(context.length > 0 || files.length > 0 || adding > 0 || chatConnectors.length > 0) && (
        <div className={styles.chips}>
          {chatConnectors.map((c) => (
            <span key={c.id} className={cx(styles.chip, styles.connectorChip)} data-connector-chip={c.id} {...tooltipProps(t("{name} is on for this chat", { name: c.name }))}>
              <Icon name="16.slot" />
              <span className={styles.chipName}>{c.name}</span>
              <button type="button" className={styles.chipRemove} aria-label={t("Turn off {name}", { name: c.name })} onClick={() => service.toggleConnector(chatId, c.id)}>
                <Icon name="16.close" />
              </button>
            </span>
          ))}
          {context.slice(0, 3).map((c) => <ContextChip key={c.id} item={c} onRemove={() => setDropped([...dropped, c.id])} />)}
          {context.length > 3 && <span className={styles.more}>+{context.length - 3}</span>}
          {files.map((f) => <AttachmentChip key={f.id} a={f} onRemove={() => setFiles(files.filter((x) => x.id !== f.id))} />)}
          {adding > 0 && (
            <span className={cx(styles.chip, styles.fileChip)} data-attachment-adding="">
              <Spinner size={16} />
              <span className={styles.chipName}>{t("Adding…")}</span>
            </span>
          )}
        </div>
      )}
      {problems.length > 0 && (
        <div className={styles.attachProblem} role="alert" data-attach-problem="">
          {problems.join(". ")}
        </div>
      )}
      {slashMatches.length > 0 && (
        <div className={styles.slashList} role="listbox" aria-label={t("Skills")} data-slash-list="">
          {slashMatches.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={i === slashActive}
              className={styles.slashItem}
              data-active={i === slashActive || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickSkill(s.name)}
              data-slash-skill={s.name}
            >
              <span className={styles.slashName}>/{s.name}</span>
              <span className={styles.slashDesc}>{s.description}</span>
            </button>
          ))}
        </div>
      )}
      {waiting && (
        <div className={styles.queued} data-queued="">
          <span className={styles.toolIcon}><Icon name="16.timing" /></span>
          <span className={styles.queuedText} {...tooltipProps(waiting.text)}>
            <span className={styles.queuedLabel}>{t("Queued")} · </span>
            {waiting.text || waiting.files.map((f) => f.name).join(", ")}
          </span>
          {/* Now: this turn stops, and the message goes as it ends */}
          <button type="button" className={styles.link} onClick={() => chat && service.stop(chat.id)} data-queued-now="">
            {t("Send now")}
          </button>
          <IconButton icon="24.close.small" label={t("Remove from queue")} tone="secondary" className={styles.queuedRemove} onClick={() => setQueued(null)} data-queued-remove="" />
        </div>
      )}
      <textarea
        ref={input}
        className={styles.input}
        value={text}
        rows={2}
        placeholder={running ? t("Add to the queue… (sent when this finishes)") : chat?.messages.length ? t("Reply…") : t("Describe a design or a change")}
        aria-label={t("Message")}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setSlashActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKey}
        onPaste={onPaste}
        data-agents-input=""
      />
      <div className={styles.composerBar}>
        <span className={styles.plus} data-attach="">
        <MenuButton
          label={t("Add")}
          tooltip={t("Add files, skills and connectors")}
          placement="top"
          className={styles.barButton}
          disabled={!state.available}
          entries={() => [
            { id: "files", label: t("Add files and photos"), disabled: full },
            {
              id: "skills",
              label: t("Skills"),
              items: [
                ...skills.filter((s) => s.enabled).map((s) => ({ id: `skill:${s.name}`, label: `/${s.name}` })),
                ...(skills.some((s) => s.enabled) ? ["-" as const] : []),
                { id: "add-skill", label: t("Add skill") },
                { id: "manage-skills", label: t("Manage skills") },
              ],
            },
            ...(service.api?.connectors
              ? [
                  {
                    id: "connectors",
                    label: t("Connectors"),
                    items: [
                      ...allConnectors.filter((c) => c.enabled).map((c) => ({ id: `connector:${c.id}`, label: c.name, checked: on.includes(c.id) })),
                      ...(allConnectors.some((c) => c.enabled) ? ["-" as const] : []),
                      { id: "add-connector", label: t("Add connector") },
                      { id: "manage-connectors", label: t("Manage connectors") },
                    ],
                  },
                ]
              : []),
          ]}
          onSelect={plus}
        >
          <Icon name="24.plus.small" />
        </MenuButton>
        </span>
        <span className={styles.barGap} />
        {service.inSocial() && state.providers.some((p) => p.available) ? (
          <SocialAgentMenu service={service} provider={provider} />
        ) : provider || service.managerProvider() ? (
          <ModelPicker service={service} provider={provider} />
        ) : (
          <button type="button" className={styles.noProvider} onClick={() => service.setView("settings")}>
            {state.providersLoading ? t("Looking for agents…") : t("Connect an agent")}
          </button>
        )}
        {provider && <UsageRing service={service} provider={provider} chat={chat} />}
        {running ? (
          <button type="button" className={cx(styles.send, styles.stop)} aria-label={t("Stop")} {...tooltipProps(t("Stop"))} onClick={() => chat && service.stop(chat.id)} data-agents-stop="">
            <span className={styles.stopGlyph} />
          </button>
        ) : (
          <button type="button" className={styles.send} aria-label={t("Send")} {...tooltipProps(t("Send"), "↩")} disabled={!canSend} onClick={send} data-agents-send="">
            <Icon name="16.arrow.up" />
          </button>
        )}
      </div>
    </div>
  );
}

/** A paste that carries files or a picture (a screenshot, a copied image, files copied in Finder). */
const hasFiles = (d: DataTransfer) => d.types.includes("Files") || [...d.items].some((i) => i.kind === "file");

/** Social's agent menu's value for the manager. */
const MANAGER_VALUE = "manager";

/**
 * Social's composer (docs/social.md §1.3): the manager by default — every turn its — or an agent's model (the agents as
 * headings, as the model menu lists them) for direct turns, until the manager is picked again.
 */
function SocialAgentMenu({ service, provider }: { service: AgentsService; provider: ProviderInfo | null }) {
  useT();
  const state = service.get();
  const effort = provider ? service.current(provider).effort : undefined;
  const value = state.socialDirect && provider ? `${provider.id}${MODEL_SEP}${service.current(provider).option?.key ?? ""}` : MANAGER_VALUE;
  return (
    <Select
      label={t("Agent")}
      variant="ghost"
      width="hug"
      value={value}
      options={[{ value: MANAGER_VALUE, label: managerName(service.managerSettings()) }, "-", ...modelMenu(state.providers, state.resolved)]}
      onChange={(v) => {
        if (v === MANAGER_VALUE) return void service.chooseInSocial(null);
        const [id, key] = v.split(MODEL_SEP);
        const p = state.providers.find((x) => x.id === id);
        if (!p) return;
        const next = pickModel(p, key, effort?.id, state.resolved);
        void service.chooseInSocial({ providerId: id, model: next.model || undefined, effort: p.efforts?.length ? next.effort : undefined });
      }}
      className={cx(styles.menu, styles.modelMenu)}
      data-social-agent-menu=""
    />
  );
}

/**
 * The used part as a filled slice from 12 o'clock, clockwise (a pie in the 16 box, radius 5 inside the 6.5 track): a
 * slice never reads as a turn still running, as an arc beside Send did.
 */
function pieOf(pct: number): string {
  const r = 5;
  const a = (Math.min(100, pct) / 100) * 2 * Math.PI;
  if (pct >= 100) return `M8 3a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}Z`;
  const x = 8 + r * Math.sin(a);
  const y = 8 - r * Math.cos(a);
  return `M8 8V3A${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`;
}

/**
 * How much of the plan is used (Claude's composer ring): the most used limit the agent's CLI reports, with a card on
 * hover (pinned by a click) — each limit, when it resets, and this chat's tokens. Nothing reported: the tokens only.
 */
function UsageRing({ service, provider, chat }: { service: AgentsService; provider: ProviderInfo; chat: Chat | null }) {
  useT();
  const state = service.get();
  const info = state.usage[provider.id];
  const windows = relevantWindows(info, service.modelOf(provider));
  const ring = ringOf(windows);
  const tokens = chat?.tokens;
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<"hover" | "pinned" | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    void service.refreshUsage(provider.id);
  }, [service, provider.id]);
  useDismiss(card, () => setOpen(null), { enabled: open === "pinned", ignore: button });
  useLayoutEffect(() => {
    const el = card.current;
    const b = button;
    if (!open || !el || !b) return;
    const p = place(b.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, "top", "end", 8);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.visibility = "visible";
  }, [open, button, windows.length, tokens?.input]);
  const hover = (on: boolean) => {
    if (leave.current) clearTimeout(leave.current);
    leave.current = null;
    if (on) setOpen((o) => o ?? "hover");
    else leave.current = setTimeout(() => setOpen((o) => (o === "hover" ? null : o)), 150);
  };
  const top = windows.length ? windows.reduce((a, b) => (b.usedPct > a.usedPct ? b : a)) : null;
  return (
    <>
      <button
        ref={setButton}
        type="button"
        className={styles.usage}
        data-usage={ring.state}
        aria-label={top ? t("Usage: {label} {used}", { label: top.label, used: usedLabel(top) }) : t("Usage")}
        aria-expanded={!!open}
        onClick={() => setOpen((o) => (o === "pinned" ? null : "pinned"))}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
      >
        <svg viewBox="0 0 16 16" className={styles.usageSvg} aria-hidden="true">
          <circle className={styles.usageTrack} cx="8" cy="8" r="6.5" />
          {ring.pct > 0 && <path className={styles.usageValue} d={pieOf(ring.pct)} data-usage-pct={Math.round(ring.pct)} />}
        </svg>
      </button>
      {open && (
        <Portal anchor={button}>
          <div ref={card} className={styles.usageCard} role="dialog" aria-label={t("Usage")} data-usage-card="" onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
            <div className={styles.usageHead}>
              <span className={styles.usageTitle}>{provider.label}</span>
              {provider.auth?.plan && <span className={styles.usagePlan} data-usage-plan="">{provider.auth.plan}</span>}
            </div>
            {windows.map((w) => (
              <div key={`${w.group ?? ""}${w.label}`} className={styles.usageRow} data-usage-window="">
                <div className={styles.usageLine}>
                  <span className={styles.usageLabel}>{w.group ? `${w.group} · ${w.label}` : w.label}</span>
                  <span className={styles.usagePct}>{usedLabel(w)}</span>
                </div>
                <span className={styles.usageBar}>
                  <span className={styles.usageBarFill} data-usage={ringOf([w]).state} style={{ width: `${Math.max(0, Math.min(100, w.usedPct))}%` }} />
                </span>
                {resetLabel(w) && <span className={styles.usageReset}>{resetLabel(w)}</span>}
              </div>
            ))}
            {!windows.length && <p className={styles.usageNote}>{info === undefined ? t("Reading the plan’s limits…") : t("{name} doesn’t report its plan’s limits here.", { name: provider.label })}</p>}
            <div className={styles.usageTokens} data-usage-tokens="">
              <span>{t("This chat")}</span>
              <span>{tokens ? t("{tokens} tokens", { tokens: formatTokens(tokens.input + tokens.output) }) : t("No tokens yet")}</span>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
