/**
 * The Agents tab (left rail; docs/research/figma/R12-agents-mcp.md §3): Figma's agent chat, driven here by the AI
 * tools on this computer. Its views: the file's chats (by recency, "New chat"), a chat (the prompts with the
 * selection they were about, the agent's answer streamed with its steps, the turn's changes with Undo / Apply,
 * Stop while it runs, the agent and model under the message box), and Agent settings (the agents found here, a
 * server by URL, the MCP server and "Connect" for MCP clients).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Button, EmptyState, Icon, IconButton, Select, Spinner, TextInput, cx, showToast, timeAgo, tooltipProps, type IconName } from "@/ds";
import type { McpClientInfo, ProviderInfo } from "@shared/agents/types";
import { useEditor } from "../../controller";
import { useTopics } from "../../hooks";
import { agentsOf, toolLabel, type AgentsService, type Chat, type ChatMessage, type MessagePart } from "../../agents/service";
import { TabHeader } from "../TabHeader";
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
          <div key={p.id} className={styles.tool} data-tool={p.name} data-tool-state={p.state} {...tooltipProps(p.summary)}>
            <span className={styles.toolIcon}>{p.state === "running" ? <Spinner size={16} /> : p.state === "error" ? <Icon name="16.warning" /> : <Icon name="16.check" />}</span>
            <span className={styles.toolLabel}>{toolLabel(p.name)}</span>
          </div>
        )
      )}
      {m.state === "running" && !parts.length && <div className={styles.status}><Spinner size={16} /> Thinking…</div>}
      {m.error && <div className={styles.error} role="alert">{m.error}</div>}
      {m.state === "stopped" && <div className={styles.stopped}>Stopped</div>}
      {m.changes && m.turnId && <Changes turnId={m.turnId} changes={m.changes} service={service} />}
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
    return <p key={i} className={styles.para}>{lines.flatMap((l, j) => (j ? [<br key={`b${j}`} />, ...inline(l)] : inline(l)))}</p>;
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
  const options = state.providers.filter((p) => p.available).flatMap((p) => (p.models.length > 1 ? p.models.map((m) => ({ value: `${p.id}\u0000${m}`, label: `${p.label} · ${m}` })) : [{ value: `${p.id}\u0000${p.models[0] ?? ""}`, label: p.label }]));
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
            {state.providersLoading ? "Looking for agents…" : "No agent found — set up"}
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

// ---- Settings ---------------------------------------------------------------------------------------------------------

function AgentSettings({ service }: { service: AgentsService }) {
  const state = service.get();
  useEffect(() => {
    void service.refreshSetup();
  }, [service]);
  return (
    <div className={styles.scroll} data-agent-settings="">
      <div className={styles.chatBar}>
        <IconButton icon="24.arrow.left" label="Back" tone="secondary" onClick={() => service.setView(state.chats.length ? "list" : "chat")} />
        <span className={styles.chatBarTitle}>Agent settings</span>
      </div>
      <Section title="Agents on this computer" action={<IconButton icon="24.reset.instance.small" label="Look again" tone="secondary" onClick={() => void service.refreshProviders()} />}>
        {state.providersLoading && !state.providers.length && <div className={styles.status}><Spinner size={16} /> Looking for agents…</div>}
        {state.providers.map((p) => <ProviderRow key={p.id} p={p} service={service} />)}
        <p className={styles.note}>Nothing leaves this computer except what the agent you pick sends to its own service. CLIs run in an empty folder with only this file’s design tools.</p>
      </Section>
      <Section title="Add a server">
        <AddServer service={service} />
      </Section>
      <McpSetup service={service} />
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ProviderRow({ p, service }: { p: ProviderInfo; service: AgentsService }) {
  const state = service.get();
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = service.activeProvider()?.id === p.id;
  const custom = p.id.startsWith("custom:");
  return (
    <div className={styles.provider} data-provider={p.id} data-available={p.available || undefined}>
      <div className={styles.providerHead}>
        <span className={cx(styles.dot, p.available && styles.dotOn)} />
        <span className={styles.providerName}>{p.label}</span>
        {chosen && <span className={styles.badge}>In use</span>}
        {custom && <IconButton icon="24.trash.outline" label="Remove server" tone="secondary" onClick={() => void service.api?.removeServer(p.id).then(() => service.refreshProviders())} />}
      </div>
      <div className={styles.providerDetail}>{p.available ? p.detail : p.problem}</div>
      {p.available && (
        <div className={styles.providerActions}>
          {p.models.length > 1 && <Select label="Model" width="hug" value={service.modelOf(p) ?? ""} options={p.models.map((m) => ({ value: m, label: m }))} onChange={(m) => void service.choose(p.id, m)} />}
          {!chosen && (
            <Button variant="secondary" onClick={() => void service.choose(p.id)}>
              Use
            </Button>
          )}
          <Button
            variant="ghost"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const r = await service.api!.test(p.id).catch((err: unknown) => ({ ok: false, models: [], error: String(err) }));
              setBusy(false);
              setTest({ ok: r.ok, text: r.ok ? (p.kind === "openai-compatible" ? `Connected · ${r.models.length} models` : "Ready") : (r.error ?? "Failed") });
            }}
          >
            Test connection
          </Button>
        </div>
      )}
      {test && <div className={cx(styles.testResult, !test.ok && styles.testFail)}>{test.text}</div>}
      {!p.available && state.providers.length > 0 && p.kind === "openai-compatible" && !custom && <div className={styles.providerHint}>Start {p.label} and load a model, then “Look again”.</div>}
    </div>
  );
}

function AddServer({ service }: { service: AgentsService }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  return (
    <div className={styles.form}>
      <TextInput label="Name" placeholder="Name" value={label} onChange={setLabel} />
      <TextInput label="Base URL" placeholder="http://localhost:8080/v1" value={url} onChange={setUrl} />
      <TextInput label="API key (optional)" placeholder="API key (optional, kept in the keychain)" value={key} onChange={setKey} />
      <Button
        variant="secondary"
        disabled={!/^https?:\/\//i.test(url.trim())}
        onClick={async () => {
          try {
            await service.api!.addServer({ label: label.trim(), baseUrl: url.trim(), apiKey: key || undefined });
            setLabel("");
            setUrl("");
            setKey("");
            await service.refreshProviders();
          } catch (err) {
            showToast({ message: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err), kind: "error" });
          }
        }}
      >
        Add server
      </Button>
    </div>
  );
}

/** The MCP server and "Connect" for MCP clients (Figma's "Set up agents for Figma MCP"). */
export function McpSetup({ service }: { service: AgentsService }) {
  const { mcp, clients } = service.get();
  const n = mcp.connections.length;
  return (
    <>
      <Section title="MCP server">
        <div className={styles.mcpUrl} data-mcp-url="">
          <code>{mcp.url ?? "Not running"}</code>
          {mcp.url && <IconButton icon="24.copy.small" label="Copy URL" tone="secondary" onClick={() => void navigator.clipboard.writeText(mcp.url!).then(() => showToast({ message: "Copied to clipboard" }))} />}
        </div>
        <div className={styles.note}>{n === 0 ? "No connections" : n === 1 ? "1 connection" : `${n} connections`}{n > 0 && `: ${[...new Set(mcp.connections.map((c) => c.client))].join(", ")}`}</div>
        <p className={styles.note}>Only apps on this computer that have its token can connect. They work on the file in front.</p>
      </Section>
      <Section title="Connect an app">
        {clients.map((c) => <ClientRow key={c.id} c={c} service={service} />)}
      </Section>
    </>
  );
}

function ClientRow({ c, service }: { c: McpClientInfo; service: AgentsService }) {
  const copy = async () => {
    const cfg = await service.api!.clientConfig(c.id);
    await navigator.clipboard.writeText(cfg.text);
    showToast({ message: `Copied — paste it into ${cfg.path.replace(/^\/Users\/[^/]+/, "~")}` });
  };
  return (
    <div className={styles.client} data-client={c.id} data-connected={c.connected || undefined}>
      <div className={styles.providerHead}>
        <span className={cx(styles.dot, c.connected && styles.dotOn)} />
        <span className={styles.providerName}>{c.label}</span>
        <span className={styles.clientState}>{c.connected ? "Connected" : c.installed ? "" : "Not found"}</span>
      </div>
      <div className={styles.providerActions}>
        {c.connected ? (
          <Button variant="secondary" onClick={async () => { const r = await service.api!.disconnect(c.id); if (!r.ok && r.error) showToast({ message: r.error, kind: "error" }); await service.refreshSetup(); }}>
            Disconnect
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={!c.installed}
            onClick={async () => {
              const r = await service.api!.connect(c.id);
              if (r.ok) showToast({ message: `Connected ${c.label}${r.backup ? " (the old config was kept as a backup)" : ""}. Restart it if it was open.` });
              else if (r.error) showToast({ message: r.error, kind: "error" });
              await service.refreshSetup();
            }}
          >
            {`Connect to ${c.label}`}
          </Button>
        )}
        <Button variant="ghost" onClick={() => void copy()}>
          Copy config
        </Button>
      </div>
    </div>
  );
}
