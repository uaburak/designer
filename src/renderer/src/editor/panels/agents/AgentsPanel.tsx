/**
 * The Agents tab (left rail; docs/research/figma/R12-agents-mcp.md §3): Figma's agent chat, driven here by the AI
 * tools on this computer. Its views: the file's chats (by recency, "New chat"), a chat (the prompts with the
 * selection they were about, the agent's answer streamed with its steps, the turn's changes with Undo / Apply,
 * Stop while it runs, the agent and model under the message box), and Agent settings (AgentSettings.tsx).
 */
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Button, EmptyState, Icon, IconButton, Select, Spinner, cx, timeAgo, tooltipProps, type IconName } from "@/ds";
import { readableError } from "@shared/agents/errors";
import { useEditor } from "../../controller";
import { useTopics } from "../../hooks";
import { agentsOf, pickerOptions, toolLabel, type AgentsService, type Chat, type ChatMessage, type MessagePart } from "../../agents/service";
import { TabHeader } from "../TabHeader";
import { AgentSettings } from "./AgentSettings";
import styles from "./Agents.module.css";

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

export function AgentsPanel() {
  const [service, state] = useAgents();
  useEffect(() => {
    if (state.available && !state.providers.length && !state.providersLoading) void service.refreshProviders();
    // Once per panel: providers are refreshed from settings after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);
  const actions = (
    <>
      <IconButton icon="24.settings.small" label="Agent settings" tone="secondary" disabled={!state.available} onClick={() => service.setView(state.view === "settings" ? "chat" : "settings")} data-agents-settings="" />
      <IconButton icon="24.plus.small" label="New chat" tone="secondary" disabled={!state.available} onClick={() => service.newChat()} />
    </>
  );
  return (
    <div className={styles.panel} data-agents="" data-view={state.view}>
      <TabHeader title="Agents" actions={actions} />
      {!state.available ? (
        <EmptyState icon="24.agents" title="Agents run in the desktop app" body="Open this file in DesignerV2 to chat with the AI tools on your computer." />
      ) : state.view === "settings" ? (
        <AgentSettings service={service} />
      ) : state.view === "list" && state.chats.length ? (
        <ChatList service={service} chats={state.chats} />
      ) : (
        <ChatView service={service} chat={service.currentChat()} />
      )}
    </div>
  );
}

// ---- The chats ------------------------------------------------------------------------------------------------------

function ChatList({ service, chats }: { service: AgentsService; chats: Chat[] }) {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className={styles.scroll} role="list" aria-label="Chats">
      {sorted.map((c) => {
        const last = [...c.messages].reverse().find((m) => m.role === "assistant");
        const preview = last ? partsText(last).slice(0, 120) || last.error || "" : "";
        return (
          <div key={c.id} role="listitem" className={styles.chatRow} data-chat={c.id}>
            <button type="button" className={styles.chatOpen} onClick={() => service.openChat(c.id)}>
              <span className={styles.chatTitle}>{c.title}</span>
              <span className={styles.chatPreview}>{preview}</span>
              <span className={styles.chatTime}>{timeAgo(c.updatedAt)}</span>
            </button>
            <IconButton icon="24.trash.outline" label="Delete chat" tone="secondary" className={styles.chatDelete} onClick={() => service.deleteChat(c.id)} />
          </div>
        );
      })}
    </div>
  );
}

const partsText = (m: ChatMessage) => (m.parts ?? []).filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("");

const SUGGESTIONS_WITH_SELECTION = ["Make the mobile version of this", "Make this responsive with auto layout", "Rename these layers"];
const SUGGESTIONS = ["Design a login screen for a mobile app", "What's on this page?"];

function ChatView({ service, chat }: { service: AgentsService; chat: Chat | null }) {
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
  return (
    <div className={styles.chat}>
      {state.chats.length > 0 && (
        <div className={styles.chatBar}>
          <IconButton icon="24.arrow.left" label="Back" tone="secondary" onClick={() => service.setView("list")} />
          <span className={styles.chatBarTitle}>{chat?.title ?? "New chat"}</span>
        </div>
      )}
      <div ref={scroller} className={styles.scroll} data-messages="">
        {!chat || !chat.messages.length ? (
          <div className={styles.intro}>
            <span className={styles.introIcon}><Icon name="24.agents" /></span>
            <p className={styles.introTitle}>What should we design?</p>
            <p className={styles.introBody}>Agents on this computer read and edit this file. Select a frame and ask — every reply’s changes are one undo step.</p>
            <div className={styles.suggestions}>
              {(selection?.length ? SUGGESTIONS_WITH_SELECTION : SUGGESTIONS).map((s) => (
                <button key={s} type="button" className={styles.suggestion} onClick={() => void service.send(s)} data-suggestion="">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          chat.messages.map((m) => (m.role === "user" ? <UserMessage key={m.id} m={m} /> : <AgentMessage key={m.id} m={m} service={service} />))
        )}
      </div>
      <Composer service={service} chat={chat} running={running} />
    </div>
  );
}

const TYPE_ICON: Record<string, IconName> = { FRAME: "16.frame", TEXT: "16.text", RECTANGLE: "16.rectangle", COMPONENT: "16.component", SYMBOL: "16.component", INSTANCE: "16.instance", IMAGE: "16.image" };

function ContextChip({ item, onRemove }: { item: NonNullable<ChatMessage["context"]>[number]; onRemove?: () => void }) {
  return (
    <span className={styles.chip} data-context-chip="" {...tooltipProps(`${Math.round(item.width)} × ${Math.round(item.height)}`)}>
      <Icon name={TYPE_ICON[item.type] ?? "16.frame"} />
      <span className={styles.chipName}>{item.name || item.type.toLowerCase()}</span>
      {onRemove && (
        <button type="button" className={styles.chipRemove} aria-label="Remove from context" onClick={onRemove}>
          <Icon name="16.close" />
        </button>
      )}
    </span>
  );
}

function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <div className={styles.user} data-message="user">
      {!!m.context?.length && (
        <div className={styles.chips}>
          {m.context.slice(0, 3).map((c) => <ContextChip key={c.id} item={c} />)}
          {m.context.length > 3 && <span className={styles.more}>+{m.context.length - 3}</span>}
        </div>
      )}
      <div className={styles.userBubble}>{m.text}</div>
    </div>
  );
}

function AgentMessage({ m, service }: { m: ChatMessage; service: AgentsService }) {
  const parts = m.parts ?? [];
  return (
    <div className={styles.agent} data-message="assistant" data-state={m.state}>
      {m.provider && <span className={styles.agentName}>{m.provider}</span>}
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <div key={i} className={styles.agentText}>{renderText(p.text)}</div>
        ) : p.kind === "status" ? (
          <div key={i} className={styles.status}><Spinner size={16} /> {p.text}</div>
        ) : (
          <ToolRow key={p.id} p={p} />
        )
      )}
      {m.state === "running" && !parts.length && <div className={styles.status}><Spinner size={16} /> Thinking…</div>}
      {m.error && <div className={styles.error} role="alert">{m.error}</div>}
      {m.state === "stopped" && <div className={styles.stopped}>Stopped</div>}
      {m.changes && m.turnId && <Changes turnId={m.turnId} changes={m.changes} service={service} />}
    </div>
  );
}

/** A step of the turn; a failed one opens to its whole error (a nested API error read down to its message). */
function ToolRow({ p }: { p: Extract<MessagePart, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const icon = <span className={styles.toolIcon}>{p.state === "running" ? <Spinner size={16} /> : p.state === "error" ? <Icon name="16.warning" /> : <Icon name="16.check" />}</span>;
  if (p.state !== "error" || !p.summary)
    return (
      <div className={styles.tool} data-tool={p.name} data-tool-state={p.state} {...tooltipProps(p.summary)}>
        {icon}
        <span className={styles.toolLabel}>{toolLabel(p.name)}</span>
      </div>
    );
  return (
    <div className={styles.toolFailed} data-tool={p.name} data-tool-state={p.state}>
      <button type="button" className={styles.tool} aria-expanded={open} onClick={() => setOpen(!open)} data-tool-toggle="">
        {icon}
        <span className={styles.toolLabel}>{toolLabel(p.name)}</span>
        <span className={cx(styles.toolChevron, open && styles.toolChevronOpen)}><Icon name="16.chevron.right" /></span>
      </button>
      {open && <div className={styles.toolError} data-tool-error="">{readableError(p.summary)}</div>}
    </div>
  );
}

function Changes({ turnId, changes, service }: { turnId: string; changes: NonNullable<ChatMessage["changes"]>; service: AgentsService }) {
  const label = changes.count === 1 ? "Changed 1 layer" : changes.count ? `Changed ${changes.count} layers` : "Changed the file";
  return (
    <div className={styles.changes} data-changes={changes.state}>
      <span className={styles.changesLabel}>{changes.state === "undone" ? "Undone" : label}</span>
      {changes.state === "applied" && (
        <Button variant="secondary" onClick={() => service.undoTurn(turnId)} data-turn-undo="">
          Undo
        </Button>
      )}
      {changes.state === "undone" && (
        <Button variant="secondary" onClick={() => service.applyTurn(turnId)} data-turn-apply="">
          Apply
        </Button>
      )}
      {changes.state === "stale" && <span className={styles.changesHint} {...tooltipProps("Other changes came after it: use Edit › Undo")}>Edited since</span>}
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

function Composer({ service, chat, running }: { service: AgentsService; chat: Chat | null; running: boolean }) {
  const [text, setText] = useState("");
  const [dropped, setDropped] = useState<string[]>([]);
  const selection = useSelectionContext(service);
  const context = (selection ?? []).filter((s) => !dropped.includes(s.id));
  const state = service.get();
  const provider = service.activeProvider();
  const send = () => {
    if (!text.trim() || running) return;
    void service.send(text, context);
    setText("");
    setDropped([]);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    // Keys typed here are the message's, never the canvas's shortcuts.
    e.stopPropagation();
  };
  const options = pickerOptions(state.providers);
  const current = provider ? `${provider.id}\u0000${service.modelOf(provider) ?? ""}` : "";
  return (
    <div className={styles.composer} data-composer="">
      {context.length > 0 && (
        <div className={styles.chips}>
          {context.slice(0, 3).map((c) => <ContextChip key={c.id} item={c} onRemove={() => setDropped([...dropped, c.id])} />)}
          {context.length > 3 && <span className={styles.more}>+{context.length - 3}</span>}
        </div>
      )}
      <textarea
        className={styles.input}
        value={text}
        rows={3}
        placeholder={chat?.messages.length ? "Reply…" : "Describe a design or a change"}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        data-agents-input=""
      />
      <div className={styles.composerBar}>
        {options.length ? (
          <Select
            label="Agent and model"
            variant="ghost"
            width="hug"
            value={current}
            options={options}
            onChange={(v) => {
              const [id, model] = v.split("\u0000");
              void service.choose(id, model || undefined);
            }}
            className={styles.providerSelect}
          />
        ) : (
          <button type="button" className={styles.noProvider} onClick={() => service.setView("settings")}>
            {state.providersLoading ? "Looking for agents…" : "Connect an agent"}
          </button>
        )}
        {running ? (
          <button type="button" className={cx(styles.send, styles.stop)} aria-label="Stop" {...tooltipProps("Stop")} onClick={() => chat && service.stop(chat.id)} data-agents-stop="">
            <span className={styles.stopGlyph} />
          </button>
        ) : (
          <button type="button" className={styles.send} aria-label="Send" {...tooltipProps("Send", "↩")} disabled={!text.trim() || !provider} onClick={send} data-agents-send="">
            <Icon name="16.arrow.up" />
          </button>
        )}
      </div>
    </div>
  );
}
