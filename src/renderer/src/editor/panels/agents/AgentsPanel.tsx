/**
 * The Agents tab (left rail; docs/research/figma/R12-agents-mcp.md §3): Figma's agent chat, driven here by the AI
 * tools on this computer. Its views: the file's chats (by recency, "New chat"), a chat (the prompts with the
 * selection they were about, the agent's answer streamed with its steps, the turn's changes with Undo / Apply,
 * Stop while it runs, the agent and model under the message box), and Agent settings (AgentSettings.tsx).
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button, EmptyState, Icon, IconButton, Portal, Select, Spinner, cx, place, timeAgo, tooltipProps, useDismiss, type IconName } from "@/ds";
import { readableError } from "@shared/agents/errors";
import { MAX_ATTACHMENTS, isImageMime, type Attachment, type AttachResult } from "@shared/agents/attachments";
import type { ProviderInfo } from "@shared/agents/types";
import { useEditor } from "../../controller";
import { useTopics } from "../../hooks";
import { agentsOf, toolLabel, type AgentsService, type Chat, type ChatMessage, type ImagePart, type MessagePart } from "../../agents/service";
import { MODEL_SEP, effortMenu, modelMenu, pickModel } from "../../agents/models";
import { formatTokens, relevantWindows, resetLabel, ringOf, usedLabel } from "../../agents/usage";
import { elapsedLabel, segmentsOf, toolActiveLabel, type Segment, type ToolPart } from "../../agents/activity";
import { REVEAL_MS } from "../../agents/imagePlaceholder";
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

/** A file attached to a message: its picture (or a document glyph), its name, and ✕ while it is in the composer. */
function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  const kind = a.mime === "application/pdf" ? "PDF" : a.mime.replace("image/", "").toUpperCase().replace("JPEG", "JPG");
  return (
    <span className={cx(styles.chip, styles.fileChip)} data-attachment-chip={a.mime} {...tooltipProps(`${a.name} · ${kind} · ${fileSize(a.size)}`)}>
      {a.thumb ? <img className={styles.fileThumb} src={a.thumb} alt="" draggable={false} /> : <Icon name={isImageMime(a.mime) ? "16.image" : "16.document"} />}
      <span className={styles.chipName}>{a.name}</span>
      {onRemove && (
        <button type="button" className={styles.chipRemove} aria-label={`Remove ${a.name}`} onClick={onRemove} data-attachment-remove="">
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
  const segments = segmentsOf(m);
  return (
    <div className={styles.agent} data-message="assistant" data-state={m.state}>
      {m.provider && <span className={styles.agentName}>{m.provider}</span>}
      {segments.map((s) => (s.kind === "text" ? <div key={s.key} className={styles.agentText} data-agent-text="">{renderText(s.text)}</div> : <StepGroup key={s.key} seg={s} since={m.startedAt} />))}
      {m.error && <div className={styles.error} role="alert">{m.error}</div>}
      {m.state === "stopped" && <div className={styles.stopped}>Stopped</div>}
      {m.changes && m.turnId && <Changes turnId={m.turnId} changes={m.changes} service={service} />}
    </div>
  );
}

/**
 * A run of the agent's steps as one row, collapsed (Claude's desktop way): the Agents icon, a line, a chevron that
 * opens the steps. While the turn is in it the row is the thinking line — the icon turning, what it does now
 * ("Reading the design…", "Thinking…") in grey with a lighter sweep, the seconds after 5 s (only they re-render each
 * second); then it settles ("Thinking · 4 steps"). An image's group keeps its card under the row.
 */
function StepGroup({ seg, since }: { seg: Exclude<Segment, { kind: "text" }>; since?: number }) {
  const [open, setOpen] = useState(false);
  const image = seg.kind === "image" ? seg.image : undefined;
  const hasSteps = seg.steps.length > 0;
  // A card put up for a picture the agent never started, fading out: no row of its own.
  const row = seg.active || hasSteps || image?.state !== "cancelled";
  const thinking = seg.active ? "" : undefined;
  const head = (
    <>
      <span className={cx(styles.groupIcon, seg.active && styles.groupIconActive)} aria-hidden="true">
        <Icon name="24.agents" />
      </span>
      <span className={cx(styles.groupLabel, seg.active && styles.thinkingText)} data-thinking-label={thinking} data-group-label="" aria-live={seg.active ? "polite" : undefined}>
        {seg.label}
      </span>
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
    const t = setTimeout(() => setReveal("none"), reveal === "play" ? REVEAL_MS : REVEAL_WAIT_MS);
    return () => clearTimeout(t);
  }, [reveal]);
  const caption = p.state === "generating" || p.state === "cancelled" ? "Making an image…" : p.state === "ready" || reveal !== "none" ? "Placing the image…" : p.state === "failed" ? "Image not placed" : null;
  return (
    <div className={styles.imageCard} data-image-card={p.state} data-reveal={reveal === "none" ? undefined : reveal} style={{ "--aspect": Math.max(0.25, Math.min(4, p.aspect || 1)) } as CSSProperties}>
      {p.state === "placed" && (url ? <img className={styles.imageCardImg} src={url} alt="" draggable={false} onLoad={() => setReveal((r) => (r === "wait" ? "play" : r))} /> : <span className={styles.imageCardFill} />)}
      {(busy || p.state === "cancelled" || reveal !== "none") && <span className={cx(styles.imageCardFill, styles.imageCardBusy)} data-image-veil="" />}
      {caption && <span className={styles.imageCardCaption}>{caption}</span>}
    </div>
  );
}

/** A step in its group: ✓ and what it did, a spinner and what it does; a failed one opens to its whole error. */
function ToolRow({ p }: { p: ToolPart }) {
  const [open, setOpen] = useState(false);
  const icon = <span className={styles.toolIcon}>{p.state === "running" ? <Spinner size={16} /> : p.state === "error" ? <Icon name="16.warning" /> : <Icon name="16.check" />}</span>;
  if (p.state !== "error" || !p.summary)
    return (
      <div className={styles.tool} data-tool={p.name} data-tool-state={p.state} {...tooltipProps(p.summary)}>
        {icon}
        <span className={styles.toolLabel}>{p.state === "running" ? toolActiveLabel(p.name) : toolLabel(p.name)}</span>
      </div>
    );
  return (
    <div className={styles.toolFailed} data-tool={p.name} data-tool-state={p.state}>
      <button type="button" className={styles.tool} data-tool-state={p.state} aria-expanded={open} onClick={() => setOpen(!open)} data-tool-toggle="">
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

/**
 * The message box, Claude's desktop composer in Figma's chrome: the selection and the attached files as chips, the
 * text, and under it "+" (add files) on the left; the model, its effort, the usage ring and Send on the right. Files
 * come from "+" (main's dialog), a drop, or ⌘V (a screenshot, a copied picture, files copied in Finder).
 */
function Composer({ service, chat, running }: { service: AgentsService; chat: Chat | null; running: boolean }) {
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
  const canSend = (!!text.trim() || files.length > 0) && !!provider && !adding;
  const send = () => {
    if (!canSend || running) return;
    void service.send(text, context, files);
    setText("");
    setDropped([]);
    setFiles([]);
    setProblems([]);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (full) return setProblems([`Up to ${MAX_ATTACHMENTS} files a message`]);
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
    if (full) return setProblems([`Up to ${MAX_ATTACHMENTS} files a message`]);
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
      {(context.length > 0 || files.length > 0 || adding > 0) && (
        <div className={styles.chips}>
          {context.slice(0, 3).map((c) => <ContextChip key={c.id} item={c} onRemove={() => setDropped([...dropped, c.id])} />)}
          {context.length > 3 && <span className={styles.more}>+{context.length - 3}</span>}
          {files.map((f) => <AttachmentChip key={f.id} a={f} onRemove={() => setFiles(files.filter((x) => x.id !== f.id))} />)}
          {adding > 0 && (
            <span className={cx(styles.chip, styles.fileChip)} data-attachment-adding="">
              <Spinner size={16} />
              <span className={styles.chipName}>Adding…</span>
            </span>
          )}
        </div>
      )}
      {problems.length > 0 && (
        <div className={styles.attachProblem} role="alert" data-attach-problem="">
          {problems.join(". ")}
        </div>
      )}
      <textarea
        className={styles.input}
        value={text}
        rows={2}
        placeholder={chat?.messages.length ? "Reply…" : "Describe a design or a change"}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        data-agents-input=""
      />
      <div className={styles.composerBar}>
        <IconButton icon="24.plus.small" label="Add files and photos" tone="secondary" disabled={full || !state.available} onClick={() => add(service.pickAttachments())} data-attach="" />
        <span className={styles.barGap} />
        {provider ? (
          <ModelMenus service={service} provider={provider} />
        ) : (
          <button type="button" className={styles.noProvider} onClick={() => service.setView("settings")}>
            {state.providersLoading ? "Looking for agents…" : "Connect an agent"}
          </button>
        )}
        {provider && <UsageRing service={service} provider={provider} chat={chat} />}
        {running ? (
          <button type="button" className={cx(styles.send, styles.stop)} aria-label="Stop" {...tooltipProps("Stop")} onClick={() => chat && service.stop(chat.id)} data-agents-stop="">
            <span className={styles.stopGlyph} />
          </button>
        ) : (
          <button type="button" className={styles.send} aria-label="Send" {...tooltipProps("Send", "↩")} disabled={!canSend} onClick={send} data-agents-send="">
            <Icon name="16.arrow.up" />
          </button>
        )}
      </div>
    </div>
  );
}

/** A paste that carries files or a picture (a screenshot, a copied image, files copied in Finder). */
const hasFiles = (d: DataTransfer) => d.types.includes("Files") || [...d.items].some((i) => i.kind === "file");

/** The model by its short name (the agents as headings in its menu) and, when the agent has one, its effort. */
function ModelMenus({ service, provider }: { service: AgentsService; provider: ProviderInfo }) {
  const state = service.get();
  const { option, effort } = service.current(provider);
  const efforts = effortMenu(option);
  return (
    <>
      <Select
        label="Model"
        variant="ghost"
        width="hug"
        value={`${provider.id}${MODEL_SEP}${option?.key ?? ""}`}
        options={modelMenu(state.providers, state.resolved)}
        onChange={(v) => {
          const [id, key] = v.split(MODEL_SEP);
          const p = state.providers.find((x) => x.id === id);
          if (!p) return;
          const next = pickModel(p, key, effort?.id, state.resolved);
          void service.choose(id, next.model || undefined, p.efforts?.length ? next.effort : undefined);
        }}
        className={cx(styles.menu, styles.modelMenu)}
        data-model-menu=""
      />
      {efforts.length > 0 && option && (
        <Select
          label="Effort"
          variant="ghost"
          width="hug"
          value={effort?.id ?? ""}
          options={efforts}
          onChange={(id) => {
            const e = option.efforts.find((x) => x.id === id);
            if (e) void service.choose(provider.id, e.model, option.inSlug ? undefined : id);
          }}
          className={styles.menu}
          data-effort-menu=""
        />
      )}
    </>
  );
}

/**
 * How much of the plan is used (Claude's composer ring): the most used limit the agent's CLI reports, with a card on
 * hover (pinned by a click) — each limit, when it resets, and this chat's tokens. Nothing reported: the tokens only.
 */
function UsageRing({ service, provider, chat }: { service: AgentsService; provider: ProviderInfo; chat: Chat | null }) {
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
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <>
      <button
        ref={setButton}
        type="button"
        className={styles.usage}
        data-usage={ring.state}
        aria-label={top ? `Usage: ${top.label} ${usedLabel(top)}` : "Usage"}
        aria-expanded={!!open}
        onClick={() => setOpen((o) => (o === "pinned" ? null : "pinned"))}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
      >
        <svg viewBox="0 0 16 16" className={styles.usageSvg} aria-hidden="true">
          <circle className={styles.usageTrack} cx="8" cy="8" r={r} />
          {ring.pct > 0 && <circle className={styles.usageValue} cx="8" cy="8" r={r} strokeDasharray={`${(c * ring.pct) / 100} ${c}`} transform="rotate(-90 8 8)" data-usage-pct={Math.round(ring.pct)} />}
        </svg>
      </button>
      {open && (
        <Portal anchor={button}>
          <div ref={card} className={styles.usageCard} role="dialog" aria-label="Usage" data-usage-card="" onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
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
            {!windows.length && <p className={styles.usageNote}>{info === undefined ? "Reading the plan’s limits…" : `${provider.label} doesn’t report its plan’s limits here.`}</p>}
            <div className={styles.usageTokens} data-usage-tokens="">
              <span>This chat</span>
              <span>{tokens ? `${formatTokens(tokens.input + tokens.output)} tokens` : "No tokens yet"}</span>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
