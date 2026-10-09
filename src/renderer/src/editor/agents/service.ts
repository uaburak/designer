/**
 * The Agents tab's state for one open file (docs/research/figma/R12-agents-mcp.md): its chats (kept per file on
 * this machine), the providers and settings main reports, the MCP server's connections — and the tool calls main
 * forwards for this file, run on the engine (mcpTools.ts) with one undo step per chat turn (turns.ts).
 *
 * The backend is the editor view's preload (`window.designer.agents`); in a browser it is `window.__designerAgents`
 * when a page provides one (the editor shots' stand-in), else none — the panel then says agents need the desktop app.
 */
import type { SelectEntry } from "@/ds";
import type { AgentSettings, AgentsApi, ChatEvent, ChatTurnMessage, McpClientInfo, McpState, ProviderInfo, TurnEvent } from "@shared/agents/types";
import type { EditorController } from "../controller";
import { editorBridge } from "../desktop";
import type { ToolResult } from "@shared/agents/tools";
import { runTool } from "./mcpTools";
import { requestedAspect } from "./activity";
import { ImagePlaceholders, placeholderArgs, placeholderTarget, type PlaceholderEnv } from "./imagePlaceholder";
import { AgentTurns, type TurnRecord } from "./turns";

/** An image the agent makes: being made, made (about to be placed), on the canvas, or not placed (an error, Stop). */
export type ImagePart = { kind: "image"; id: string; state: "generating" | "ready" | "placed" | "failed"; aspect: number; hash?: string; width?: number; height?: number };

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; state: "running" | "done" | "error"; summary?: string }
  | { kind: "status"; text: string }
  | ImagePart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** user: the prompt; assistant: its parts in order */
  text?: string;
  parts?: MessagePart[];
  /** The selection the prompt was about */
  context?: { id: string; name: string; type: string; width: number; height: number }[];
  state?: "running" | "done" | "stopped" | "error";
  /** When the turn was sent (the Thinking… row's seconds) */
  startedAt?: number;
  error?: string;
  turnId?: string;
  /** The turn's step: how many layers it touched, and whether it is applied / undone / stale */
  changes?: { count: number; state: TurnRecord["state"] };
  provider?: string;
}

export interface Chat {
  id: string;
  title: string;
  updatedAt: number;
  /** The agent the chat was started with — or switched to since (the picker under the message box) */
  providerId: string | null;
  model?: string;
  /** Each agent's own session of this chat (Claude Code --resume), valid while no other agent answered since: `upTo` is the chat's length after its last turn */
  sessions?: Record<string, { id: string; upTo: number }>;
  /** (Older chats) the CLI session of `providerId` */
  resume?: string;
  messages: ChatMessage[];
}

/** The agent and model last picked in this file (a new chat starts with it). */
export interface AgentChoice {
  providerId: string;
  model?: string;
}

export type AgentsView = "list" | "chat" | "settings";

export interface AgentsState {
  available: boolean;
  view: AgentsView;
  /** Agent settings' open page: null for the list, else an item ("provider:antigravity", "add-server", "mcp", "client:cursor") */
  settingsItem: string | null;
  chats: Chat[];
  current: string | null;
  providers: ProviderInfo[];
  providersLoading: boolean;
  settings: AgentSettings;
  mcp: McpState;
  clients: McpClientInfo[];
  /** The chat's running turn */
  running: Record<string, string>;
}

const EMPTY_SETTINGS: AgentSettings = { providerId: null, models: {}, custom: [] };

export function agentsBackend(): AgentsApi | null {
  const desk = editorBridge();
  if (desk?.agents) return desk.agents;
  return (window as unknown as { __designerAgents?: AgentsApi }).__designerAgents ?? null;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const TOOL_LABEL: Record<string, string> = {
  get_selection: "Looked at the selection",
  get_metadata: "Read the layers",
  get_design_context: "Read the design",
  get_screenshot: "Took a screenshot",
  get_variable_defs: "Read variables and styles",
  create_nodes: "Created layers",
  update_nodes: "Edited layers",
  delete_nodes: "Deleted layers",
  duplicate_nodes: "Duplicated layers",
  reparent_nodes: "Moved layers",
  set_auto_layout: "Set auto layout",
  apply_variable: "Applied a variable",
  apply_style: "Applied a style",
  create_responsive_variant: "Made a responsive version",
  set_selection: "Selected the result",
  place_image: "Placed an image",
  generate_image: "Made an image",
};
export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.replace(/_/g, " ");

export class AgentsService {
  readonly api: AgentsApi | null;
  readonly turns: AgentTurns;
  /** Images being made, shown where they will land on the canvas (canvas/AgentImagePlaceholders.tsx) */
  readonly placeholders = new ImagePlaceholders();
  private state: AgentsState;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private storageKey: string;
  /** Turn → its chat and assistant message */
  private turnTarget = new Map<string, { chat: string; message: string; providerId: string; providerLabel: string; prompt: string }>();
  private choiceKey: string;
  private choice: AgentChoice | null;
  private touched = new Map<string, Set<string>>();

  constructor(
    private ed: EditorController,
    api: AgentsApi | null = agentsBackend()
  ) {
    this.api = api;
    this.turns = new AgentTurns(ed);
    const fileId = (ed.source as { fileKey?: string }).fileKey ?? ed.source.previews?.fileKey ?? ed.ui.get().fileName;
    this.storageKey = `designer.agents.chats.${fileId}`;
    this.choiceKey = `designer.agents.choice.${fileId}`;
    this.choice = this.loadChoice();
    this.state = { available: !!api, view: "list", settingsItem: null, chats: this.load(), current: null, providers: [], providersLoading: false, settings: EMPTY_SETTINGS, mcp: { running: false, url: null, connections: [] }, clients: [], running: {} };
    if (!this.state.chats.length) this.state.view = "chat";
    if (!api) return;
    this.offs.push(
      api.onEvent((e) => this.onEvent(e)),
      api.onToolCall(async (call) => {
        const env = { ed: this.ed, write: <T>(_label: string, fn: () => T) => this.turns.write(call.turnId, call.client, fn) };
        // An image the chat is making lands where its placeholder is, unless the agent said where.
        const waiting = call.name === "place_image" && call.turnId ? this.placeholders.next(call.turnId) : undefined;
        const r = await runTool(env, call.name, placeholderArgs(call.args ?? {}, waiting));
        if (call.name === "place_image" && call.turnId && !r.isError) this.imagePlaced(call.turnId, r, waiting?.id);
        if (call.turnId && r.touched?.length) {
          const set = this.touched.get(call.turnId) ?? new Set();
          r.touched.forEach((id) => set.add(id));
          this.touched.set(call.turnId, set);
        }
        return r;
      }),
      api.onMcpState((mcp) => this.set({ mcp })),
      this.turns.onChange((t) => this.onTurnChange(t))
    );
    void api.mcp().then((mcp) => this.set({ mcp }), () => {});
    void api.settings().then((settings) => this.set({ settings }), () => {});
  }

  dispose() {
    this.offs.forEach((off) => off());
    this.turns.dispose();
    this.placeholders.dispose();
  }

  /** What placeholderTarget reads: the page, the selection, the view. */
  placeholderEnv(): PlaceholderEnv {
    const ed = this.ed;
    return {
      page: ed.store.page,
      selection: ed.selection,
      read: (id) => {
        const n = ed.engine.readNode(id, { fields: ["type", "size", "transform", "parentIndex", "stackMode"] });
        if (!n) return null;
        return { type: String(ed.withRealType(n).type), size: n.size, transform: n.transform, parent: n.parentIndex?.guid ?? null, autoLayout: !!n.stackMode && n.stackMode !== "NONE" };
      },
      camera: ed.store.camera,
      viewport: { width: ed.canvas?.clientWidth ?? 0, height: ed.canvas?.clientHeight ?? 0 },
    };
  }

  /** place_image put a picture on the canvas for a chat turn: its placeholder goes, the chat's image card shows it. */
  private imagePlaced(turnId: string, r: ToolResult, placeholderId: string | undefined) {
    if (placeholderId) this.placeholders.placed(placeholderId);
    const target = this.turnTarget.get(turnId);
    const info = placedInfo(r);
    if (!target || !info) return;
    this.updateMessage(target.chat, target.message, (m) => ({ ...m, parts: withPlacedImage(m.parts ?? [], info) }));
  }

  // ---- A tiny store for React ----

  get = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<AgentsState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private load(): Chat[] {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const chats = raw ? (JSON.parse(raw) as Chat[]) : [];
      // A turn that was running when the file closed is over.
      return chats.map((c) => ({ ...c, messages: c.messages.map((m) => (m.state === "running" ? { ...m, state: "stopped" as const } : m)) }));
    } catch {
      return [];
    }
  }

  private loadChoice(): AgentChoice | null {
    try {
      const c = JSON.parse(localStorage.getItem(this.choiceKey) ?? "null") as AgentChoice | null;
      return c && typeof c.providerId === "string" ? c : null;
    } catch {
      return null;
    }
  }

  private save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.state.chats.slice(0, 50)));
    } catch {
      /* private mode, full */
    }
  }

  private updateChat(id: string, fn: (c: Chat) => Chat) {
    this.set({ chats: this.state.chats.map((c) => (c.id === id ? fn(c) : c)) });
    this.save();
  }

  private updateMessage(chat: string, message: string, fn: (m: ChatMessage) => ChatMessage) {
    this.updateChat(chat, (c) => ({ ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === message ? fn(m) : m)) }));
  }

  // ---- Navigation ----

  setView(view: AgentsView) {
    this.set({ view, settingsItem: null });
    if (view === "settings") void this.refreshSetup();
  }

  /** Agent settings: one item's page, or the list (null). */
  openSetting(item: string | null) {
    this.set({ view: "settings", settingsItem: item });
  }

  newChat() {
    this.set({ current: null, view: "chat" });
  }

  openChat(id: string) {
    this.set({ current: id, view: "chat" });
  }

  deleteChat(id: string) {
    this.set({ chats: this.state.chats.filter((c) => c.id !== id), current: this.state.current === id ? null : this.state.current });
    this.save();
  }

  currentChat(): Chat | null {
    return this.state.chats.find((c) => c.id === this.state.current) ?? null;
  }

  // ---- Providers, settings, setup ----

  async refreshProviders() {
    if (!this.api) return;
    this.set({ providersLoading: true });
    try {
      const [providers, settings] = await Promise.all([this.api.providers(), this.api.settings()]);
      this.set({ providers, settings });
    } finally {
      this.set({ providersLoading: false });
    }
  }

  async refreshSetup() {
    if (!this.api) return;
    const [mcp, clients] = await Promise.all([this.api.mcp(), this.api.clients()]);
    this.set({ mcp, clients });
  }

  /** Agents the chat can use: installed and signed in (a CLI), answering with models (a server). */
  usable(): ProviderInfo[] {
    return this.state.providers.filter((p) => p.available);
  }

  /**
   * The agent a turn uses: the open chat's own (it keeps the agent it was started with until the user switches), else
   * the one last picked in this file, else the app's last pick, else the first usable.
   */
  activeProvider(): ProviderInfo | null {
    const usable = this.usable();
    const chat = this.currentChat();
    const ids = [chat?.providerId, this.choice?.providerId, this.state.settings.providerId];
    for (const id of ids) {
      const p = id ? usable.find((x) => x.id === id) : undefined;
      if (p) return p;
    }
    return usable[0] ?? null;
  }

  modelOf(p: ProviderInfo): string | undefined {
    const chat = this.currentChat();
    const fits = (m: string | undefined): m is string => !!m && (p.models.includes(m) || p.kind !== "openai-compatible");
    const candidates = [chat?.providerId === p.id ? chat.model : undefined, this.choice?.providerId === p.id ? this.choice.model : undefined, this.state.settings.models[p.id]];
    return candidates.find(fits) ?? p.models[0];
  }

  /** The picker: the chat's agent and model (switching mid-chat), remembered for this file and as the app's default. */
  async choose(providerId: string, model?: string) {
    const p = this.state.providers.find((x) => x.id === providerId);
    const m = model ?? (p ? this.modelOf(p) : undefined);
    this.choice = { providerId, ...(m ? { model: m } : {}) };
    try {
      localStorage.setItem(this.choiceKey, JSON.stringify(this.choice));
    } catch {
      /* private mode */
    }
    const chat = this.currentChat();
    if (chat) this.updateChat(chat.id, (c) => ({ ...c, providerId, model: m }));
    else this.set({});
    if (!this.api) return;
    const settings = await this.api.setSettings({ providerId, ...(m ? { models: { [providerId]: m } } : {}) });
    this.set({ settings });
  }

  // ---- Turns ----

  selectionContext(): ChatMessage["context"] {
    return this.ed.selection.slice(0, 20).flatMap((id) => {
      const n = this.ed.engine.readNode(id, { fields: ["name", "type", "size"] });
      if (!n) return [];
      const real = this.ed.withRealType(n);
      return [{ id, name: n.name ?? "", type: real.type === "ROUNDED_RECTANGLE" ? "RECTANGLE" : String(real.type), width: n.size?.x ?? 0, height: n.size?.y ?? 0 }];
    });
  }

  async send(prompt: string, context: ChatMessage["context"] = this.selectionContext()) {
    const text = prompt.trim();
    if (!text || !this.api) return;
    const provider = this.activeProvider();
    let chat = this.currentChat();
    if (!chat) {
      chat = { id: uid(), title: text.slice(0, 60), updatedAt: Date.now(), providerId: provider?.id ?? null, model: provider ? this.modelOf(provider) : undefined, messages: [] };
      this.set({ chats: [chat, ...this.state.chats], current: chat.id });
    }
    const chatId = chat.id;
    if (this.state.running[chatId]) return;
    const user: ChatMessage = { id: uid(), role: "user", text, context };
    const answer: ChatMessage = { id: uid(), role: "assistant", parts: [], state: "running", startedAt: Date.now(), provider: provider?.label };
    const history: ChatTurnMessage[] = chat.messages.map((m) => (m.role === "user" ? { role: "user", text: m.text ?? "" } : { role: "assistant", text: (m.parts ?? []).filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") }));
    this.updateChat(chatId, (c) => ({ ...c, messages: [...c.messages, user, answer] }));
    if (!provider) {
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, state: "error", error: "No agent is connected. Open Agent settings to install or sign in to one — Claude Code, Antigravity, Codex, Cursor — or start Ollama or LM Studio." }));
      return;
    }
    const page = this.ed.store.page;
    const pageName = page ? (this.ed.engine.readNode(page, { fields: ["name"] })?.name ?? "") : "";
    try {
      const { turnId } = await this.api.turn({
        chatId,
        providerId: provider.id,
        model: this.modelOf(provider),
        prompt: text,
        history,
        resume: sessionOf(chat, provider.id),
        context: { fileName: this.ed.ui.get().fileName, pageName, selection: context ?? [] },
      });
      this.turns.start(turnId, provider.label);
      this.turnTarget.set(turnId, { chat: chatId, message: answer.id, providerId: provider.id, providerLabel: provider.label, prompt: text });
      this.set({ running: { ...this.state.running, [chatId]: turnId } });
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, turnId }));
      if (chat.providerId !== provider.id) this.updateChat(chatId, (c) => ({ ...c, providerId: provider.id, model: this.modelOf(provider) }));
    } catch (err) {
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, state: "error", error: err instanceof Error ? err.message : String(err) }));
    }
  }

  stop(chatId: string) {
    const turnId = this.state.running[chatId];
    if (turnId && this.api) void this.api.stop(turnId);
  }

  private onEvent({ turnId, event }: TurnEvent) {
    const target = this.turnTarget.get(turnId);
    if (!target) return;
    const { chat, message } = target;
    if (event.type === "session") {
      // Valid up to the end of this turn (finish() sets upTo); another agent's turn after it makes it stale.
      this.updateChat(chat, (c) => ({ ...c, sessions: { ...c.sessions, [target.providerId]: { id: event.resume, upTo: -1 } } }));
      return;
    }
    if (event.type === "done") {
      this.finish(turnId, event);
      return;
    }
    if (event.type === "tool" && event.name === "generate_image") {
      const known = this.state.chats.find((c) => c.id === chat)?.messages.find((m) => m.id === message)?.parts?.some((p) => p.kind === "image" && p.id === imagePartId(event.id));
      // As soon as the image is asked for: where it will land, on the canvas.
      if (event.state === "running" && !known) this.placeholders.start(turnId, placeholderTarget(this.placeholderEnv(), requestedAspect(event.args)));
      if (event.state === "error") this.placeholders.fail(turnId);
    }
    this.updateMessage(chat, message, (m) => ({ ...m, ...applyEvent(m, event) }));
  }

  private finish(turnId: string, event: Extract<ChatEvent, { type: "done" }>) {
    const target = this.turnTarget.get(turnId);
    if (!target) return;
    const record = this.turns.finish(turnId);
    this.placeholders.end(turnId);
    const touched = this.touched.get(turnId)?.size ?? 0;
    const running = { ...this.state.running };
    delete running[target.chat];
    this.set({ running });
    this.updateChat(target.chat, (c) => {
      const own = c.sessions?.[target.providerId];
      return own ? { ...c, sessions: { ...c.sessions, [target.providerId]: { ...own, upTo: c.messages.length } } } : c;
    });
    this.updateMessage(target.chat, target.message, (m) => ({
      ...m,
      state: m.state === "error" ? "error" : event.stopped ? "stopped" : "done",
      parts: (m.parts ?? []).filter((p) => p.kind !== "status").map((p) => (p.kind === "tool" && p.state === "running" ? { ...p, state: event.stopped ? "error" : "done" } : p.kind === "image" && (p.state === "generating" || p.state === "ready") ? { ...p, state: "failed" } : p)),
      changes: record && record.state !== "none" ? { count: touched, state: record.state } : undefined,
    }));
    // Attributed in version history: the turn's changes are a named version of their own.
    if (record && record.state !== "none" && this.ed.source.saveVersion) void this.ed.source.saveVersion({ title: `${target.providerLabel}: ${target.prompt.slice(0, 80)}`, description: "Made in the Agents tab" }).catch(() => {});
  }

  private onTurnChange(t: TurnRecord) {
    const target = this.turnTarget.get(t.id);
    if (!target || t.state === "running") return;
    this.updateMessage(target.chat, target.message, (m) => (m.changes ? { ...m, changes: { ...m.changes, state: t.state } } : m));
  }

  undoTurn(turnId: string) {
    this.turns.undo(turnId);
  }

  applyTurn(turnId: string) {
    this.turns.redo(turnId);
  }

  turnState(turnId: string | undefined): TurnRecord["state"] | null {
    return turnId ? (this.turns.get(turnId)?.state ?? null) : null;
  }
}

/**
 * The agent's own session to continue, when nothing happened in the chat since its last turn (another agent's turns
 * aren't in that session: the turn then starts a new one with the conversation so far).
 */
export function sessionOf(chat: Chat, providerId: string): string | undefined {
  const s = chat.sessions?.[providerId];
  if (s) return s.upTo === chat.messages.length ? s.id : undefined;
  // An older chat: its one session, while the chat is still that agent's alone.
  return chat.providerId === providerId && chat.messages.every((m) => m.role === "user" || !m.provider || m.provider === chat.messages.find((x) => x.role === "assistant")?.provider) ? chat.resume : undefined;
}

const MODEL_LABEL: Record<string, string> = { default: "Default", auto: "Auto" };
export const modelLabel = (m: string, p?: Pick<ProviderInfo, "modelLabels">) => p?.modelLabels?.[m] ?? MODEL_LABEL[m] ?? m;

/** The composer's picker: the connected agents, each under its heading with its models. */
export function pickerOptions(providers: ProviderInfo[]): SelectEntry[] {
  return providers
    .filter((p) => p.available)
    .flatMap((p) => [
      { header: p.label },
      ...(p.models.length ? p.models : [""]).map((m) => ({ value: `${p.id}\u0000${m}`, label: m ? modelLabel(m, p) : p.label, valueLabel: m && p.models.length > 1 ? `${p.label} · ${modelLabel(m, p)}` : p.label })),
    ]);
}

/** A message with one more event of its turn. */
export function applyEvent(m: ChatMessage, e: ChatEvent): Partial<ChatMessage> {
  const parts = [...(m.parts ?? [])];
  switch (e.type) {
    case "status":
      if (!parts.some((p) => p.kind !== "status")) return { parts: [{ kind: "status", text: e.text }] };
      return {};
    case "text": {
      const clean = parts.filter((p) => p.kind !== "status");
      const last = clean[clean.length - 1];
      if (last?.kind === "text") clean[clean.length - 1] = { kind: "text", text: last.text + e.delta };
      else clean.push({ kind: "text", text: e.delta });
      return { parts: clean };
    }
    case "tool": {
      const clean = parts.filter((p) => p.kind !== "status");
      const i = clean.findIndex((p) => p.kind === "tool" && p.id === e.id);
      const part: MessagePart = { kind: "tool", id: e.id, name: e.name, state: e.state, summary: e.summary };
      if (i >= 0) clean[i] = { ...(clean[i] as MessagePart & { kind: "tool" }), state: e.state, summary: e.summary ?? (clean[i] as { summary?: string }).summary };
      else clean.push(part);
      if (e.name === "generate_image") {
        // The image's card, right after its step: being made → made → (place_image) on the canvas. A failed step says
        // why itself: its card goes.
        const id = imagePartId(e.id);
        const j = clean.findIndex((p) => p.kind === "image" && p.id === id);
        if (j < 0) {
          if (e.state !== "error") clean.splice(clean.findIndex((p) => p.kind === "tool" && p.id === e.id) + 1, 0, { kind: "image", id, state: e.state === "done" ? "ready" : "generating", aspect: requestedAspect(e.args) });
        } else {
          const img = clean[j] as ImagePart;
          if (e.state === "error" && img.state !== "placed") clean.splice(j, 1);
          else if (img.state === "generating" && e.state === "done") clean[j] = { ...img, state: "ready" };
        }
      }
      return { parts: clean };
    }
    case "error":
      return { state: "error", error: m.error ? `${m.error}\n${e.message}` : e.message };
    default:
      return {};
  }
}

const imagePartId = (toolId: string) => `image:${toolId}`;

/** The picture place_image put on the canvas, from its result ({ nodeId, imageHash, imageSize }). */
export function placedInfo(r: ToolResult): { hash: string; width: number; height: number } | null {
  for (const c of r.content) {
    if (c.type !== "text") continue;
    try {
      const j = JSON.parse(c.text) as { imageHash?: unknown; imageSize?: { width?: unknown; height?: unknown } };
      if (typeof j.imageHash === "string") return { hash: j.imageHash, width: Number(j.imageSize?.width) || 1, height: Number(j.imageSize?.height) || 1 };
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/** The answer's parts with a placed picture: on the oldest image card still waiting, else a card of its own. */
export function withPlacedImage(parts: MessagePart[], img: { hash: string; width: number; height: number }): MessagePart[] {
  const i = parts.findIndex((p) => p.kind === "image" && (p.state === "generating" || p.state === "ready"));
  const placed = { state: "placed" as const, hash: img.hash, width: img.width, height: img.height, aspect: img.width / Math.max(1, img.height) };
  if (i >= 0) return parts.map((p, j) => (j === i ? { ...(p as ImagePart), ...placed } : p));
  return [...parts, { kind: "image", id: `image:${img.hash}:${parts.length}`, ...placed }];
}

const services = new WeakMap<EditorController, AgentsService>();

/** The file's agents (made on first use; disposed with the editor). */
export function agentsOf(ed: EditorController): AgentsService {
  let s = services.get(ed);
  if (!s) {
    s = new AgentsService(ed);
    services.set(ed, s);
  }
  return s;
}

/** The editor view's tool calls are answered from the start (an outside client may call before the tab is opened). */
export function attachAgents(ed: EditorController): () => void {
  const s = agentsOf(ed);
  return () => {
    s.dispose();
    services.delete(ed);
  };
}
