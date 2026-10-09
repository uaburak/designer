/**
 * The Agents tab's state for one open file (docs/research/figma/R12-agents-mcp.md): its chats (kept per file on
 * this machine), the providers and settings main reports, the MCP server's connections — and the tool calls main
 * forwards for this file, run on the engine (mcpTools.ts) with one undo step per chat turn (turns.ts).
 *
 * The backend is the editor view's preload (`window.designer.agents`); in a browser it is `window.__designerAgents`
 * when a page provides one (the editor shots' stand-in), else none — the panel then says agents need the desktop app.
 */
import type { AgentSettings, AgentsApi, ChatEvent, ChatTurnMessage, McpClientInfo, McpState, ProviderInfo, TurnEvent } from "@shared/agents/types";
import type { EditorController } from "../controller";
import { editorBridge } from "../desktop";
import { runTool } from "./mcpTools";
import { AgentTurns, type TurnRecord } from "./turns";

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; state: "running" | "done" | "error"; summary?: string }
  | { kind: "status"; text: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** user: the prompt; assistant: its parts in order */
  text?: string;
  parts?: MessagePart[];
  /** The selection the prompt was about */
  context?: { id: string; name: string; type: string; width: number; height: number }[];
  state?: "running" | "done" | "stopped" | "error";
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
  providerId: string | null;
  model?: string;
  /** The CLI's own session (Claude Code --resume) */
  resume?: string;
  messages: ChatMessage[];
}

export type AgentsView = "list" | "chat" | "settings";

export interface AgentsState {
  available: boolean;
  view: AgentsView;
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
};
export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.replace(/_/g, " ");

export class AgentsService {
  readonly api: AgentsApi | null;
  readonly turns: AgentTurns;
  private state: AgentsState;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private storageKey: string;
  /** Turn → its chat and assistant message */
  private turnTarget = new Map<string, { chat: string; message: string; providerLabel: string; prompt: string }>();
  private touched = new Map<string, Set<string>>();

  constructor(
    private ed: EditorController,
    api: AgentsApi | null = agentsBackend()
  ) {
    this.api = api;
    this.turns = new AgentTurns(ed);
    this.storageKey = `designer.agents.chats.${(ed.source as { fileKey?: string }).fileKey ?? ed.source.previews?.fileKey ?? ed.ui.get().fileName}`;
    this.state = { available: !!api, view: "list", chats: this.load(), current: null, providers: [], providersLoading: false, settings: EMPTY_SETTINGS, mcp: { running: false, url: null, connections: [] }, clients: [], running: {} };
    if (!this.state.chats.length) this.state.view = "chat";
    if (!api) return;
    this.offs.push(
      api.onEvent((e) => this.onEvent(e)),
      api.onToolCall(async (call) => {
        const env = { ed: this.ed, write: <T>(_label: string, fn: () => T) => this.turns.write(call.turnId, call.client, fn) };
        const r = await runTool(env, call.name, call.args ?? {});
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
    this.set({ view });
    if (view === "settings") void this.refreshSetup();
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

  /** The provider a new turn uses: the chosen one if it is there, else the first available. */
  activeProvider(): ProviderInfo | null {
    const { providers, settings } = this.state;
    const chosen = providers.find((p) => p.id === settings.providerId && p.available);
    return chosen ?? providers.find((p) => p.available) ?? null;
  }

  modelOf(p: ProviderInfo): string | undefined {
    const m = this.state.settings.models[p.id];
    return m && (p.models.includes(m) || p.kind !== "openai-compatible") ? m : p.models[0];
  }

  async choose(providerId: string, model?: string) {
    if (!this.api) return;
    const settings = await this.api.setSettings({ providerId, ...(model ? { models: { [providerId]: model } } : {}) });
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
      chat = { id: uid(), title: text.slice(0, 60), updatedAt: Date.now(), providerId: provider?.id ?? null, messages: [] };
      this.set({ chats: [chat, ...this.state.chats], current: chat.id });
    }
    const chatId = chat.id;
    if (this.state.running[chatId]) return;
    const user: ChatMessage = { id: uid(), role: "user", text, context };
    const answer: ChatMessage = { id: uid(), role: "assistant", parts: [], state: "running", provider: provider?.label };
    const history: ChatTurnMessage[] = chat.messages.map((m) => (m.role === "user" ? { role: "user", text: m.text ?? "" } : { role: "assistant", text: (m.parts ?? []).filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") }));
    this.updateChat(chatId, (c) => ({ ...c, messages: [...c.messages, user, answer] }));
    if (!provider) {
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, state: "error", error: "No agent found on this computer. Install Claude Code, or start Ollama or LM Studio — then pick it in Agent settings." }));
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
        resume: provider.id === chat.providerId ? chat.resume : undefined,
        context: { fileName: this.ed.ui.get().fileName, pageName, selection: context ?? [] },
      });
      this.turns.start(turnId, provider.label);
      this.turnTarget.set(turnId, { chat: chatId, message: answer.id, providerLabel: provider.label, prompt: text });
      this.set({ running: { ...this.state.running, [chatId]: turnId } });
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, turnId }));
      if (chat.providerId !== provider.id) this.updateChat(chatId, (c) => ({ ...c, providerId: provider.id, resume: undefined }));
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
      this.updateChat(chat, (c) => ({ ...c, resume: event.resume }));
      return;
    }
    if (event.type === "done") {
      this.finish(turnId, event);
      return;
    }
    this.updateMessage(chat, message, (m) => ({ ...m, ...applyEvent(m, event) }));
  }

  private finish(turnId: string, event: Extract<ChatEvent, { type: "done" }>) {
    const target = this.turnTarget.get(turnId);
    if (!target) return;
    const record = this.turns.finish(turnId);
    const touched = this.touched.get(turnId)?.size ?? 0;
    const running = { ...this.state.running };
    delete running[target.chat];
    this.set({ running });
    this.updateMessage(target.chat, target.message, (m) => ({
      ...m,
      state: m.state === "error" ? "error" : event.stopped ? "stopped" : "done",
      parts: (m.parts ?? []).filter((p) => p.kind !== "status").map((p) => (p.kind === "tool" && p.state === "running" ? { ...p, state: event.stopped ? "error" : "done" } : p)),
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
      return { parts: clean };
    }
    case "error":
      return { state: "error", error: m.error ? `${m.error}\n${e.message}` : e.message };
    default:
      return {};
  }
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
