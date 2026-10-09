/**
 * The Agents tab's state for one open file (docs/research/figma/R12-agents-mcp.md): its chats (kept per file on
 * this machine), the providers and settings main reports, the MCP server's connections — and the tool calls main
 * forwards for this file, run on the engine (mcpTools.ts) with one undo step per chat turn (turns.ts).
 *
 * The backend is the editor view's preload (`window.designer.agents`); in a browser it is `window.__designerAgents`
 * when a page provides one (the editor shots' stand-in), else none — the panel then says agents need the desktop app.
 */
import type { AgentSettings, AgentsApi, ChatEvent, ChatTurnMessage, McpClientInfo, McpState, ProviderInfo, TokenUsage, TurnEvent, UsageInfo } from "@shared/agents/types";
import { MAX_ATTACHMENTS, type Attachment, type AttachResult } from "@shared/agents/attachments";
import { currentOf, type ResolvedModels } from "./models";
import { addTokens } from "./usage";
import type { EditorController } from "../controller";
import { editorBridge } from "../desktop";
import type { ToolResult } from "@shared/agents/tools";
import { runTool } from "./mcpTools";
import { asksForImage, requestedAspect } from "./activity";
import { FADE_MS, ImagePlaceholders, placeholderArgs, placeholderTarget, reshapeTarget, targetAspect, type PlaceholderEnv } from "./imagePlaceholder";
import { AgentTurns, type TurnRecord } from "./turns";

/**
 * An image the agent makes: being made, made (about to be placed), on the canvas, or not placed (an error, Stop) — or
 * asked for in the prompt and never made (`cancelled`: it fades out, then goes). A card put up as the prompt was sent
 * (`asked`) shows the agent's first generate_image once it starts (`tool`); `fill`: it will fill the selected layer,
 * whose aspect it has.
 */
export type ImagePart = { kind: "image"; id: string; state: "generating" | "ready" | "placed" | "failed" | "cancelled"; aspect: number; asked?: boolean; tool?: string; fill?: boolean; hash?: string; width?: number; height?: number };

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
  /** user: the files attached to it (copies in the chat's folder) */
  attachments?: Attachment[];
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
  /** The effort picked for it (an agent with an effort flag; Antigravity's is in its model) */
  effort?: string;
  /** The chat's tokens so far (its turns' results) */
  tokens?: TokenUsage;
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
  effort?: string;
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
  /** Each agent's plan limits as last read (its /usage, or a turn's rate_limit_event); null: it reports none */
  usage: Record<string, UsageInfo | null>;
  /** What CLI aliases resolved to in their last turns ("opus" → "claude-opus-5-5"), for the short names */
  resolved: ResolvedModels;
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
  view_file: "Looked at the attached file",
  Read: "Looked at the attached file",
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
  private turnTarget = new Map<string, { chat: string; message: string; providerId: string; providerLabel: string; prompt: string; model?: string }>();
  private choiceKey: string;
  private choice: AgentChoice | null;
  private touched = new Map<string, Set<string>>();
  /** A new chat's id before its first message (its attachments' folder) */
  private draftId: string | null = null;
  private usageAsked = new Map<string, number>();

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
    this.state = { available: !!api, view: "list", settingsItem: null, chats: this.load(), current: null, providers: [], providersLoading: false, settings: EMPTY_SETTINGS, mcp: { running: false, url: null, connections: [] }, clients: [], running: {}, usage: {}, resolved: loadResolved() };
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
        const n = ed.engine.readNode(id, { fields: ["type", "size", "transform", "parentIndex", ...RADIUS_FIELDS] });
        if (!n) return null;
        return { type: String(ed.withRealType(n).type), size: n.size, transform: n.transform, parent: n.parentIndex?.guid ?? null, radius: radiiOf(n) };
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
      return chats.map((c) => ({ ...c, messages: c.messages.map((m) => (m.state === "running" ? { ...m, state: "stopped" as const, parts: m.parts && withoutCancelled(turnOver(m.parts, true)) } : m.parts ? { ...m, parts: withoutCancelled(m.parts) } : m)) }));
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

  /** The effort a turn of `p` asks for: the chat's, the file's last, else the agent's default (none without an effort flag). */
  effortOf(p: ProviderInfo): string | undefined {
    if (!p.efforts?.length) return undefined;
    const chat = this.currentChat();
    const candidates = [chat?.providerId === p.id ? chat.effort : undefined, this.choice?.providerId === p.id ? this.choice.effort : undefined];
    return candidates.find((e): e is string => !!e && p.efforts!.includes(e)) ?? p.efforts[0];
  }

  /** The composer's model and effort as the menus show them. */
  current(p: ProviderInfo) {
    return currentOf(p, this.modelOf(p), this.effortOf(p), this.state.resolved);
  }

  /** The menus: the chat's agent, model and effort (switching mid-chat), remembered for this file and as the app's default. */
  async choose(providerId: string, model?: string, effort?: string) {
    const p = this.state.providers.find((x) => x.id === providerId);
    const m = model ?? (p ? this.modelOf(p) : undefined);
    const e = effort ?? (p ? this.effortOf(p) : undefined);
    this.choice = { providerId, ...(m ? { model: m } : {}), ...(e ? { effort: e } : {}) };
    try {
      localStorage.setItem(this.choiceKey, JSON.stringify(this.choice));
    } catch {
      /* private mode */
    }
    const chat = this.currentChat();
    if (chat) this.updateChat(chat.id, (c) => ({ ...c, providerId, model: m, effort: e }));
    else this.set({});
    void this.refreshUsage(providerId);
    if (!this.api) return;
    const settings = await this.api.setSettings({ providerId, ...(m ? { models: { [providerId]: m } } : {}) });
    this.set({ settings });
  }

  // ---- Usage ----

  /** The plan's limits from the agent's CLI (no model call; main caches them a minute), at most every 30 s unless fresh. */
  async refreshUsage(providerId: string, fresh = false) {
    if (!this.api) return;
    const last = this.usageAsked.get(providerId) ?? 0;
    if (!fresh && Date.now() - last < 30_000) return;
    this.usageAsked.set(providerId, Date.now());
    try {
      const info = await this.api.usage(providerId, fresh);
      // A turn's own limits (rate_limit_event) are newer than an old read.
      const had = this.state.usage[providerId];
      if (info || !had) this.set({ usage: { ...this.state.usage, [providerId]: info ? mergeUsage(had, info) : null } });
    } catch {
      /* the CLI couldn't say */
    }
  }

  // ---- Attachments ----

  /** The chat the composer's files go with: the open one, or the new chat its first message will start. */
  draftChatId(): string {
    return this.currentChat()?.id ?? (this.draftId ??= uid());
  }

  /** Files dropped or pasted (their bytes): copied into the chat's folder by main. */
  async attachFiles(files: File[]): Promise<AttachResult> {
    if (!this.api) return { attachments: [], errors: [] };
    const list = files.slice(0, MAX_ATTACHMENTS + 1);
    const read = await Promise.all(list.map(async (f) => ({ name: f.name || "Pasted image.png", bytes: new Uint8Array(await f.arrayBuffer()) })));
    return this.api.attach(this.draftChatId(), read);
  }

  /** The "+" button: main's file dialog. */
  pickAttachments(): Promise<AttachResult> {
    return this.api ? this.api.pickAttachments(this.draftChatId()) : Promise.resolve({ attachments: [], errors: [] });
  }

  /**
   * ⌘V with a file or a picture on the clipboard: main reads the system clipboard (Finder's files, not the icon it puts
   * beside them; a screenshot); when it finds nothing there, the paste's own files (their bytes).
   */
  async attachPasted(files: File[]): Promise<AttachResult> {
    if (!this.api) return { attachments: [], errors: [] };
    const fromMain = await this.api.attachClipboard(this.draftChatId()).catch((): AttachResult => ({ attachments: [], errors: [] }));
    if (fromMain.attachments.length || fromMain.errors.length || !files.length) return fromMain;
    return this.attachFiles(files);
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

  async send(prompt: string, context: ChatMessage["context"] = this.selectionContext(), attachments: Attachment[] = []) {
    const files = attachments.slice(0, MAX_ATTACHMENTS);
    const text = prompt.trim();
    if ((!text && !files.length) || !this.api) return;
    const provider = this.activeProvider();
    let chat = this.currentChat();
    if (!chat) {
      // The id its attachments were copied under.
      const id = this.draftId ?? uid();
      this.draftId = null;
      chat = { id, title: (text || files.map((f) => f.name).join(", ")).slice(0, 60), updatedAt: Date.now(), providerId: provider?.id ?? null, model: provider ? this.modelOf(provider) : undefined, effort: provider ? this.effortOf(provider) : undefined, messages: [] };
      this.set({ chats: [chat, ...this.state.chats], current: chat.id });
    }
    const chatId = chat.id;
    if (this.state.running[chatId]) return;
    const user: ChatMessage = { id: uid(), role: "user", text, context, ...(files.length ? { attachments: files } : {}) };
    const answer: ChatMessage = { id: uid(), role: "assistant", parts: [], state: "running", startedAt: Date.now(), provider: provider?.label };
    // A picture asked for: where it will land, in the chat and on the canvas, from now on (over the selected layer it fills).
    if (provider && asksForImage(text)) {
      const target = placeholderTarget({ ...this.placeholderEnv(), selection: (context ?? []).map((c) => c.id) });
      this.placeholders.start(answer.id, target);
      answer.parts = [{ kind: "image", id: `image:asked:${answer.id}`, state: "generating", aspect: targetAspect(target), asked: true, ...(target?.nodeId ? { fill: true } : {}) }];
    }
    const history: ChatTurnMessage[] = chat.messages.map((m) => (m.role === "user" ? { role: "user", text: `${m.text ?? ""}${m.attachments?.length ? ` [attached: ${m.attachments.map((a) => a.path).join(", ")}]` : ""}` } : { role: "assistant", text: (m.parts ?? []).filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") }));
    this.updateChat(chatId, (c) => ({ ...c, messages: [...c.messages, user, answer] }));
    if (!provider) {
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, state: "error", error: "No agent is connected. Open Agent settings to install or sign in to one — Claude Code, Antigravity, Codex, Cursor — or start Ollama or LM Studio." }));
      return;
    }
    const page = this.ed.store.page;
    const pageName = page ? (this.ed.engine.readNode(page, { fields: ["name"] })?.name ?? "") : "";
    try {
      const model = this.modelOf(provider);
      const effort = this.effortOf(provider);
      const { turnId } = await this.api.turn({
        chatId,
        providerId: provider.id,
        model,
        ...(effort ? { effort } : {}),
        prompt: text || (files.length === 1 ? "Look at the attached file." : "Look at the attached files."),
        history,
        resume: sessionOf(chat, provider.id),
        context: { fileName: this.ed.ui.get().fileName, pageName, selection: context ?? [] },
        ...(files.length ? { attachments: files.map((f) => ({ path: f.path, name: f.name, mime: f.mime })) } : {}),
      });
      this.placeholders.rekey(answer.id, turnId);
      this.turns.start(turnId, provider.label);
      this.turnTarget.set(turnId, { chat: chatId, message: answer.id, providerId: provider.id, providerLabel: provider.label, prompt: text || files.map((f) => f.name).join(", "), model });
      this.set({ running: { ...this.state.running, [chatId]: turnId } });
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, turnId }));
      if (chat.providerId !== provider.id) this.updateChat(chatId, (c) => ({ ...c, providerId: provider.id, model: this.modelOf(provider) }));
    } catch (err) {
      this.placeholders.end(answer.id);
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, state: "error", error: err instanceof Error ? err.message : String(err), parts: turnOver(m.parts ?? [], false) }));
      this.dropCancelled(chatId, answer.id);
    }
  }

  /** A card asked for and never made fades out (CSS), then goes. */
  private dropCancelled(chat: string, message: string) {
    setTimeout(() => this.updateMessage(chat, message, (m) => (m.parts?.some(isCancelled) ? { ...m, parts: withoutCancelled(m.parts) } : m)), FADE_MS);
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
      if (event.model) this.resolve(target.providerId, target.model, event.model);
      return;
    }
    if (event.type === "usage") {
      this.updateChat(chat, (c) => ({ ...c, tokens: addTokens(c.tokens, event.usage) }));
      return;
    }
    if (event.type === "limits") {
      const next: UsageInfo = { providerId: target.providerId, windows: event.windows, at: Date.now() };
      this.set({ usage: { ...this.state.usage, [target.providerId]: mergeUsage(this.state.usage[target.providerId], next) } });
      return;
    }
    if (event.type === "done") {
      this.finish(turnId, event);
      return;
    }
    if (event.type === "tool" && event.name === "generate_image") {
      // The image is being made: the placeholder put up as the prompt was sent shows it (at the aspect asked for), else
      // one appears now where it will land.
      if (event.state !== "error" && !this.placeholders.ofTool(turnId, event.id)) {
        const env = this.placeholderEnv();
        const aspect = requestedAspect(event.args);
        if (!this.placeholders.bind(turnId, event.id, (t) => reshapeTarget(t, aspect, env.read))) this.placeholders.start(turnId, placeholderTarget(env, aspect), event.id);
      }
      if (event.state === "error") this.placeholders.fail(turnId, event.id);
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
      parts: turnOver(m.parts ?? [], !!event.stopped),
      changes: record && record.state !== "none" ? { count: touched, state: record.state } : undefined,
    }));
    this.dropCancelled(target.chat, target.message);
    // The turn used some of the plan: its limits read again (the CLI's /usage, no model call).
    void this.refreshUsage(target.providerId, true);
    // Attributed in version history: the turn's changes are a named version of their own.
    if (record && record.state !== "none" && this.ed.source.saveVersion) void this.ed.source.saveVersion({ title: `${target.providerLabel}: ${target.prompt.slice(0, 80)}`, description: "Made in the Agents tab" }).catch(() => {});
  }

  /** A CLI alias's model as its turn reported it ("default" → "claude-opus-5-5"): the menus' short names, kept app-wide. */
  private resolve(providerId: string, asked: string | undefined, real: string) {
    const alias = asked || "default";
    if (alias === real || this.state.resolved[providerId]?.[alias] === real) return;
    const resolved = { ...this.state.resolved, [providerId]: { ...this.state.resolved[providerId], [alias]: real } };
    this.set({ resolved });
    try {
      localStorage.setItem(RESOLVED_KEY, JSON.stringify(resolved));
    } catch {
      /* private mode */
    }
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

const RESOLVED_KEY = "designer.agents.resolved";

function loadResolved(): ResolvedModels {
  try {
    const r = JSON.parse(localStorage.getItem(RESOLVED_KEY) ?? "{}") as unknown;
    return r && typeof r === "object" && !Array.isArray(r) ? (r as ResolvedModels) : {};
  } catch {
    return {};
  }
}

/** Newer limits over older ones: the windows read now, and the older ones it didn't mention. */
export function mergeUsage(had: UsageInfo | null | undefined, next: UsageInfo): UsageInfo {
  const key = (w: { label: string; group?: string }) => `${w.group ?? ""}\u0000${w.label}`;
  const fresh = new Set(next.windows.map(key));
  return { ...next, windows: [...next.windows, ...(had?.windows ?? []).filter((w) => !fresh.has(key(w)))] };
}

const MODEL_LABEL: Record<string, string> = { default: "Default", auto: "Auto" };
export const modelLabel = (m: string, p?: Pick<ProviderInfo, "modelLabels">) => p?.modelLabels?.[m] ?? MODEL_LABEL[m] ?? m;

/** A message with one more event of its turn. */
export function applyEvent(m: ChatMessage, e: ChatEvent): Partial<ChatMessage> {
  const parts = [...(m.parts ?? [])];
  switch (e.type) {
    case "status":
      // The CLI's start line, until the agent says or does something (an image card put up for the prompt doesn't count).
      if (parts.some((p) => p.kind === "text" || p.kind === "tool")) return {};
      return { parts: [...parts.filter((p) => p.kind !== "status"), { kind: "status", text: e.text }] };
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
        let j = clean.findIndex((p) => p.kind === "image" && (p.id === id || p.tool === e.id));
        // The card put up as the prompt was sent now shows this image (at the aspect asked for, unless it fills a layer).
        const asked = j < 0 && e.state !== "error" ? clean.findIndex((p) => p.kind === "image" && !!p.asked && !p.tool && p.state === "generating") : -1;
        if (asked >= 0) {
          const card = clean[asked] as ImagePart;
          clean[asked] = { ...card, tool: e.id, aspect: card.fill ? card.aspect : requestedAspect(e.args) };
          j = asked;
        }
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

/**
 * An answer's parts once its turn is over: no status line, running steps done (failed when stopped), images still
 * being made not placed — and a card put up for a picture the prompt asked for, that the agent never started, cancelled.
 */
export function turnOver(parts: MessagePart[], stopped: boolean): MessagePart[] {
  return parts
    .filter((p) => p.kind !== "status")
    .map((p): MessagePart => {
      if (p.kind === "tool" && p.state === "running") return { ...p, state: stopped ? "error" : "done" };
      if (p.kind === "image" && (p.state === "generating" || p.state === "ready")) return { ...p, state: p.asked && !p.tool ? "cancelled" : "failed" };
      return p;
    });
}

const isCancelled = (p: MessagePart) => p.kind === "image" && p.state === "cancelled";
const withoutCancelled = (parts: MessagePart[]) => (parts.some(isCancelled) ? parts.filter((p) => !isCancelled(p)) : parts);

const RADIUS_FIELDS = ["cornerRadius", "rectangleCornerRadiiIndependent", "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius"];

/** A layer's corner radii, clockwise from the top left (its one radius, or each corner's); none when square. */
function radiiOf(n: { cornerRadius?: number; rectangleCornerRadiiIndependent?: boolean; rectangleTopLeftCornerRadius?: number; rectangleTopRightCornerRadius?: number; rectangleBottomRightCornerRadius?: number; rectangleBottomLeftCornerRadius?: number }): [number, number, number, number] | undefined {
  const r = n.cornerRadius ?? 0;
  const corners: [number, number, number, number] = n.rectangleCornerRadiiIndependent ? [n.rectangleTopLeftCornerRadius ?? r, n.rectangleTopRightCornerRadius ?? r, n.rectangleBottomRightCornerRadius ?? r, n.rectangleBottomLeftCornerRadius ?? r] : [r, r, r, r];
  return corners.some((c) => c > 0) ? corners : undefined;
}

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
