/**
 * The Agents tab's state for one open file (docs/research/figma/R12-agents-mcp.md): its chats (kept per file on
 * this machine), the providers and settings main reports, the MCP server's connections — and the tool calls main
 * forwards for this file, run on the engine (mcpTools.ts) with one undo step per chat turn (turns.ts).
 *
 * The backend is the editor view's preload (`window.designer.agents`); in a browser it is `window.__designerAgents`
 * when a page provides one (the editor shots' stand-in), else none — the panel then says agents need the desktop app.
 */
import type { AgentSettings, AgentsApi, ChatEvent, ChatTurnMessage, McpClientInfo, McpState, ProviderInfo, TokenUsage, TurnEvent, TurnRequest, UsageInfo } from "@shared/agents/types";
import { MAX_ATTACHMENTS, type Attachment, type AttachResult } from "@shared/agents/attachments";
import { currentOf, type ResolvedModels } from "./models";
import { addTokens } from "./usage";
import { messageText, shortStatus, shortTitle } from "./chatList";
import type { EditorController } from "../controller";
import { editorBridge } from "../desktop";
import type { ToolResult } from "@shared/agents/tools";
import { applySelection, runTool, type ToolEnv } from "./mcpTools";
import { textResult } from "@shared/agents/tools";
import type { Guid } from "@/engine/codec";
import { asksForImage, requestedAspect } from "./activity";
import { FADE_MS, ImagePlaceholders, placeholderArgs, placeholderTarget, reshapeTarget, targetAspect, type PlaceholderEnv } from "./imagePlaceholder";
import { AgentTurns, EngineBusy, type TurnRecord } from "./turns";
import type { AgentSetupHost } from "./setup";
import { creditsFor, type AiSkill, type ConnectorConsent } from "@shared/ai/types";
import { invokedSkill } from "@shared/ai/skillFile";
import { SKILL_WRITE_TOOLS } from "@shared/agents/appTools";
import { skillsBox } from "../panels/agents/aiData";
import { getStoreClient } from "@/store";
import { t } from "@/i18n";
import { MANAGER_TOOLS, type ToolDef } from "@shared/agents/tools";
import type { ManagerToolDef } from "@shared/agents/types";
import { DEFAULT_MANAGER_SETTINGS, IMAGE_TASKS_AT_ONCE, brandsUnavailable, type BrandsRepository, type ManagerSettings, type StudioTask } from "@shared/studio/types";
import type { ImageRouteInfo } from "@shared/ai/types";
import { managerPrompt, managerReminder, type ManagerPromptContext } from "@shared/studio/managerPrompt";
import { formatById } from "@shared/social/formats";
import type { SocialPromptContext } from "@shared/social/types";
import { readPost, writePost } from "../social/posts";
import { socialOf } from "../social/socialState";
import { LIBRARY_TOOLS, runLibraryTool } from "../studio/libraryTools";
import { blurRegions, runStudioImage } from "../studio/images";
import { makeBrandLibrary } from "../social/templates/brandLibrary";
import { postSlots } from "../social/templates/templates";
import type { Writer } from "../social/actions";
import { TaskQueue, isEnded, type TaskResult } from "./tasks";
import { isManagerTool, relayoutTask, runAgain, runManagerTool, type CardAnswer, type ManagerEnv, type StudioChatData, type TaskExtra, type ViewCard } from "./managerTools";
import { paintImageHash } from "../model/paints";
import { agentPresenceOf } from "../multiplayer/agentsOnCanvas";
import { LEAVE_AFTER_MS, type AgentActor } from "../multiplayer/agentPresence";
import { managerName, workerName } from "./managerName";
import { viewRect } from "../canvas/viewInsets";

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
  context?: { id: string; name: string; type: string; width: number; height: number; /** A Social post's format name (docs/social.md §6.3) */ format?: string }[];
  /** user: the files attached to it (copies in the chat's folder) */
  attachments?: Attachment[];
  state?: "running" | "done" | "stopped" | "error";
  /** When the turn was sent (the Thinking… row's seconds) */
  startedAt?: number;
  /** When it ended (the pinned progress's time) */
  endedAt?: number;
  error?: string;
  turnId?: string;
  /** The turn's step: how many layers it touched, and whether it is applied / undone / stale */
  changes?: { count: number; state: TurnRecord["state"]; overwritten?: number };
  provider?: string;
  /** assistant: the agent's id (its mark); older answers have its label only */
  providerId?: string;
  /** assistant: the turn's tokens (its AI credits on hover — docs/ai.md §7) */
  usage?: TokenUsage;
  /** user: the Skill it ran with /name */
  skill?: string;
  /** assistant: the manager's answer (docs/studio.md §2.2): its task cards and the cards it waits on */
  manager?: boolean;
  cards?: ViewCard[];
}

/** A worker's turn as its task card's disclosure draws it: its words and steps, the way an answer is drawn. */
export interface WorkerLog {
  parts: MessagePart[];
  state: "running" | "done" | "stopped" | "error";
  error?: string;
  usage?: TokenUsage;
  turnId?: string;
  provider?: string;
}

/** A task the manager handed out, kept with its chat (docs/studio.md §2.3). */
export type ChatTask = StudioTask & TaskExtra & { worker?: WorkerLog };

export interface Chat extends StudioChatData {
  id: string;
  /** A short title (2–5 words) from the first message (chatList.ts shortTitle), or the owner's own (`renamed`) */
  title: string;
  /** The owner renamed it: kept, never replaced by a derived one */
  renamed?: boolean;
  /** One short sentence on where it stands, from the last answer (chatList.ts shortStatus) */
  status?: string;
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
  /** The connectors turned on for this chat (docs/ai.md §2.11: enabled per chat) */
  connectors?: string[];
  /** The manager's tasks (docs/studio.md §2.3), with their workers' logs */
  tasks?: ChatTask[];
}

/** The agent and model last picked in this file (a new chat starts with it). */
export interface AgentChoice {
  providerId: string;
  model?: string;
  effort?: string;
}

/** "settings" (as callers ask for it): opens Agent settings over the view, which stays as it was */
export type AgentsView = "list" | "chat" | "settings";

export interface AgentsState {
  available: boolean;
  view: Exclude<AgentsView, "settings">;
  /** Agent settings (the modal over the panel) is open */
  settingsOpen: boolean;
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
  /** Connectors' tools waiting for the user's answer (the consent cards), by turn */
  consents: ConnectorConsent[];
  /** The connectors a new chat will start with (before its first message) */
  draftConnectors: string[];
  /** Social's composer picked an agent instead of the manager: its turns go straight to that agent (docs/social.md §1.3) */
  socialDirect: boolean;
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
  pathfinder: "Ran a Pathfinder",
  set_selection: "Selected the result",
  place_image: "Placed an image",
  generate_image: "Made an image",
  // Motion for agents (docs/research/motion-for-agents.md)
  animate: "Animated layers",
  get_motion_frames: "Watched the animation",
  generate_sound: "Made sound",
  score_motion: "Read the animation's beats",
  get_sound_mix: "Listened to the mix",
  // The app beyond the canvas and Skills (docs/research/agent-parity.md)
  list_skills: "Read your skills",
  create_skill: "Added a skill",
  update_skill: "Changed a skill",
  remove_skill: "Removed a skill",
  install_skill: "Installed a skill",
  find_skills: "Looked for skills",
  read_skill: "Read a skill",
  get_comments: "Read the comments",
  add_comment: "Commented",
  reply_comment: "Replied",
  list_versions: "Read the version history",
  save_version: "Saved a version",
  restore_version: "Restored a version",
  export_nodes: "Exported",
  get_libraries: "Read the libraries",
  publish_library: "Published the library",
  list_files: "Looked at your files",
  file_action: "Worked on files",
  set_app_setting: "Changed a setting",
  run_plugin: "Ran a plugin",
  // The manager's (docs/studio.md §2.2) and the library's (§3.3)
  delegate_task: "Handed out a task",
  wait_tasks: "Waited for the tasks",
  stop_task: "Stopped a task",
  ask_choice: "Asked you",
  show_form: "Opened a form",
  make_posts: "Started the posts",
  review: "Looked at the results",
  report_review: "Reported the review",
  library_find: "Searched the library",
  library_get: "Read the library",
  library_missing: "Checked what is missing",
  library_save_brand: "Saved the brand",
  library_save_product: "Saved the product",
  library_add_image: "Added a picture to the library",
  library_read_labels: "Read the labels",
  library_image: "Looked at a library picture",
};
export const toolLabel = (name: string) => (TOOL_LABEL[name] ? t(TOOL_LABEL[name]) : name.replace(/_/g, " "));

/** What the manager's tools use besides the editor (docs/studio.md): the library, the image runs, the ledger — fakes in tests. */
export interface StudioDeps {
  brands(): BrandsRepository;
  library(ed: EditorController, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  runImage: typeof runStudioImage;
  blur: typeof blurRegions;
  imageRoutes(): Promise<ImageRouteInfo[]>;
  /** make_brand_library (docs/social.md §4.1, round 18b): the Brands library made or updated, its writes through `w` */
  brandLibrary(ed: EditorController, w: Writer): Promise<{ fileKey: string; brands: string[] }>;
  record(e: { action: "agent"; providerId: string; model?: string; input: number; output: number; images: number; credits: number; local: boolean; ok: boolean }, fileKey: string | null): void;
}

const studioDefaults = (): StudioDeps => ({
  brands: () => {
    try {
      return getStoreClient().brands ?? brandsUnavailable();
    } catch {
      return brandsUnavailable();
    }
  },
  library: runLibraryTool,
  brandLibrary: (ed, w) => makeBrandLibrary(ed, w),
  runImage: runStudioImage,
  blur: blurRegions,
  imageRoutes: async () => (await editorBridge()?.ai?.imageRoutes?.()) ?? [],
  record: (e, fileKey) => {
    try {
      void getStoreClient().ai.record({ ...e, fileKey, orgId: null }).catch(() => {});
    } catch {
      /* no store here (a browser stand-in) */
    }
  },
});

/** A manager-only tool as the turn carries it to main. */
const managerDef = (t: ToolDef): ManagerToolDef => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema });

export class AgentsService implements AgentSetupHost {
  readonly api: AgentsApi | null;
  readonly turns: AgentTurns;
  /** The manager's tasks in this file (docs/studio.md §2.3): several at once per chat, each its own turn or image run */
  readonly queue: TaskQueue;
  private studio: StudioDeps;
  /** Workers' turns: their chat and task, and how their run ends */
  private workers = new Map<string, { chat: string; taskId: string; providerId: string; model?: string; end: (log: WorkerLog, stopped: boolean) => void }>();
  /** Cards waiting for the owner (ask_choice, show_form, report_review), by card id */
  private waits = new Map<string, { chat: string; message: string; turnId: string; resolve: (a: CardAnswer) => void }>();
  /** Each running manager turn's abort: its waits end with it */
  private managerAborts = new Map<string, AbortController>();
  /** The review card's thumbnails, by layer */
  private thumbs = new Map<string, Promise<string | null>>();
  /** Images being made, shown where they will land on the canvas (canvas/AgentImagePlaceholders.tsx) */
  readonly placeholders = new ImagePlaceholders();
  private state: AgentsState;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private storageKey: string;
  /** Turn → its chat and assistant message */
  private turnTarget = new Map<string, { chat: string; message: string; providerId: string; providerLabel: string; prompt: string; model?: string; role?: "manager"; sessionKey?: string }>();
  private choiceKey: string;
  private choice: AgentChoice | null;
  private touched = new Map<string, Set<string>>();
  /** A new chat's id before its first message (its attachments' folder) */
  private draftId: string | null = null;
  private usageAsked = new Map<string, number>();
  /** Each running turn: the user's selection and page when it began, and what set_selection asked for */
  private turnStarts = new Map<string, { selection: Guid[]; page: Guid | null; select?: Guid[] }>();
  /** An outside MCP client's page (set_current_page): never the user's */
  private outsidePages = new Map<string, Guid>();

  constructor(
    private ed: EditorController,
    api: AgentsApi | null = agentsBackend(),
    studio: Partial<StudioDeps> = {}
  ) {
    this.api = api;
    this.turns = new AgentTurns(ed);
    this.studio = { ...studioDefaults(), ...studio };
    this.queue = new TaskQueue({ limits: () => ({ cli: this.managerSettings().parallel, image: IMAGE_TASKS_AT_ONCE }), onChange: (t) => this.taskChanged(t) });
    const fileId = (ed.source as { fileKey?: string }).fileKey ?? ed.source.previews?.fileKey ?? ed.ui.get().fileName;
    this.storageKey = `designer.agents.chats.${fileId}`;
    this.choiceKey = `designer.agents.choice.${fileId}`;
    this.choice = this.loadChoice();
    this.state = { available: !!api, view: "list", settingsOpen: false, settingsItem: null, chats: this.load(), current: null, providers: [], providersLoading: false, settings: EMPTY_SETTINGS, mcp: { running: false, url: null, connections: [] }, clients: [], running: {}, usage: {}, resolved: loadResolved(), consents: [], draftConnectors: [], socialDirect: false };
    if (!this.state.chats.length) this.state.view = "chat";
    this.queue.restore(this.state.chats.flatMap((c) => c.tasks ?? []));
    if (!api) return;
    this.offs.push(
      api.onEvent((e) => this.onEvent(e)),
      api.onToolCall(async (call) => {
        // The manager's own tools (docs/studio.md §2.2): its turns only — a worker (or anyone else) is refused.
        if (isManagerTool(call.name)) {
          const target = call.turnId ? this.turnTarget.get(call.turnId) : undefined;
          if (!call.turnId || target?.role !== "manager") return textResult(`${call.name} is the manager's tool: a task can't call it.`, true);
          agentPresenceOf(this.ed).join(this.actorOf(call));
          return runManagerTool(this.managerEnv(call.turnId, target), call.name, call.args ?? {});
        }
        const env = this.toolEnv(call.turnId, call.client);
        // An image the chat is making lands where its placeholder is, unless the agent said where.
        const waiting = call.name === "place_image" && call.turnId ? this.placeholders.next(call.turnId) : undefined;
        const r = await this.runWhenIdle(env, call.name, placeholderArgs(call.args ?? {}, waiting));
        if (call.name === "place_image" && call.turnId && !r.isError) this.imagePlaced(call.turnId, r, waiting?.id);
        if (call.turnId && r.touched?.length) {
          const set = this.touched.get(call.turnId) ?? new Set();
          r.touched.forEach((id) => set.add(id));
          this.touched.set(call.turnId, set);
        }
        // The agent as a collaborator: its cursor and outline at what it touched (ephemeral — docs/ai.md §2.13).
        if (!this.ed.engine.destroyed) agentPresenceOf(this.ed).activity(this.actorOf(call), call.name, call.args, r);
        return r;
      }),
      api.onMcpState((mcp) => this.mcpChanged(mcp)),
      api.onConsent?.((c) => this.set({ consents: [...this.state.consents.filter((x) => x.reqId !== c.reqId), c] })) ?? (() => {}),
      this.turns.onChange((t) => this.onTurnChange(t))
    );
    void api.mcp().then((mcp) => this.mcpChanged(mcp), () => {});
    void api.settings().then((settings) => this.set({ settings }), () => {});
  }

  /** Main's MCP connections: the outside clients bound to this file are its collaborators while connected. */
  private mcpChanged(mcp: McpState) {
    this.set({ mcp });
    const mine = this.fileKey();
    const clients = mcp.connections.filter((c) => !c.chat && c.fileKey && (!mine || c.fileKey === mine));
    // One collaborator per client app: a client that opens a session per run (a script, a CLI) is still one agent
    const byClient = new Map(clients.map((c) => [`client:${c.client}`, { key: `client:${c.client}`, name: c.client }]));
    agentPresenceOf(this.ed).syncClients([...byClient.values()]);
  }

  /**
   * Who made a tool call, as a collaborator: a worker (its task), the manager or a chat (the chat), or an outside
   * client (by its app's name: all its sessions are one collaborator).
   */
  actorOf(call: { turnId: string | null; client: string; session?: string }): AgentActor {
    const manager = managerName(this.managerSettings());
    const worker = call.turnId ? this.workers.get(call.turnId) : undefined;
    if (worker) {
      const chat = this.state.chats.find((c) => c.id === worker.chat);
      const agents = (chat?.tasks ?? []).filter((x) => x.kind === "agent");
      const index = agents.findIndex((x) => x.id === worker.taskId);
      // The manager is "1": its workers are "<name> · 2", "· 3"… in the order the chat's tasks were made.
      return { key: `task:${worker.taskId}`, name: workerName(manager, (index < 0 ? agents.length : index) + 2), kind: "worker", detail: agents[index]?.title };
    }
    const target = call.turnId ? this.turnTarget.get(call.turnId) : undefined;
    if (target?.role === "manager") return { key: `manager:${target.chat}`, name: manager, kind: "manager" };
    if (target) return { key: `chat:${target.chat}`, name: target.providerLabel, kind: "chat" };
    return { key: `client:${call.client}`, name: call.client, kind: "client" };
  }

  /**
   * A tool call's environment: writes as the turn's actor (turns.ts — never the user's selection, page or view), the
   * turn's own page, and set_selection held until the turn ends.
   */
  toolEnv(turnId: string | null, client: string): ToolEnv {
    if (turnId) this.noteTurnStart(turnId);
    const outsidePage = (p?: Guid) => {
      if (p) this.outsidePages.set(client, p);
      return this.outsidePages.get(client) ?? null;
    };
    return {
      ed: this.ed,
      write: <T>(_label: string, fn: () => T, refs?: readonly Guid[]) => this.turns.write(turnId, client, fn, refs),
      page: () => (turnId ? (this.turns.get(turnId)?.page ?? null) : outsidePage()),
      setPage: (page) => {
        if (!turnId) return void outsidePage(page);
        (this.turns.get(turnId) ?? this.turns.start(turnId, client)).page = page;
      },
      ...(turnId
        ? {
            requestSelection: (refs: Guid[]) => {
              const at = this.turnStarts.get(turnId);
              if (at) at.select = refs;
            },
          }
        : {}),
    };
  }

  /** A tool call, run when the canvas is free: while the user drags or scrubs, it waits (their gesture goes on). */
  async runWhenIdle(env: ToolEnv, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    for (let i = 0; ; i++) {
      await this.turns.idle();
      try {
        return await runTool(env, name, args);
      } catch (err) {
        if (!(err instanceof EngineBusy) || i > 2000) return textResult(err instanceof Error ? err.message : String(err), true);
      }
    }
  }

  /** What the user had selected when the turn began (set_selection applies only if it is still that). */
  private noteTurnStart(turnId: string) {
    if (!this.turnStarts.has(turnId)) this.turnStarts.set(turnId, { selection: [...this.ed.store.selection.refs], page: this.ed.store.page });
  }

  /** The turn ended: what it asked to select becomes the user's selection — unless they changed theirs meanwhile. */
  private applyRequestedSelection(turnId: string) {
    const at = this.turnStarts.get(turnId);
    this.turnStarts.delete(turnId);
    if (!at?.select?.length || this.ed.engine.destroyed) return;
    const now = this.ed.store.selection.refs;
    const same = this.ed.store.page === at.page && now.length === at.selection.length && now.every((id, i) => id === at.selection[i]);
    if (same && this.ed.engine.idle()) applySelection(this.ed, at.select, true);
  }

  dispose() {
    // The file closes: its tasks stop, the cards stop waiting.
    this.queue.stopWhere(() => true);
    for (const id of [...this.waits.keys()]) this.settleCard(id, { cancelled: true });
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
      view: visibleView(ed.canvas),
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
      return chats.map((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.state === "running" ? { ...m, state: "stopped" as const, parts: m.parts && withoutCancelled(turnOver(m.parts, true)) } : m.parts ? { ...m, parts: withoutCancelled(m.parts) } : m)),
        // Tasks running when the file closed are over too (docs/studio.md §2.3).
        ...(c.tasks ? { tasks: c.tasks.map(stoppedTask) } : {}),
      }));
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
    if (view === "settings") {
      // Agent settings opens over the panel (its modal); the chat or the list stays under it.
      this.set({ settingsOpen: true, settingsItem: null });
      void this.refreshSetup();
      return;
    }
    // The list's composer starts a new chat: none is the current one there.
    this.set({ view, settingsOpen: false, settingsItem: null, ...(view === "list" ? { current: null } : {}) });
  }

  /** Agent settings: one item's page, or its section (null) — the modal opens if it isn't. */
  openSetting(item: string | null) {
    if (!this.state.settingsOpen) void this.refreshSetup();
    this.set({ settingsOpen: true, settingsItem: item });
  }

  /** Agent settings closes: the panel as it was. */
  closeSettings() {
    this.set({ settingsOpen: false, settingsItem: null });
  }

  /** Agent settings' Back from the list: the panel as it was. */
  leaveSettings() {
    this.closeSettings();
  }

  newChat() {
    this.set({ current: null, view: "chat" });
  }

  openChat(id: string) {
    this.set({ current: id, view: "chat" });
  }

  /** The owner's own title: kept over the derived one. */
  renameChat(id: string, title: string) {
    const clean = title.trim();
    if (clean) this.updateChat(id, (c) => ({ ...c, title: clean, renamed: true }));
  }

  deleteChat(id: string) {
    this.queue.stopWhere((t) => t.chatId === id);
    // Its turns' histories go with it (their changes stay in the file).
    for (const m of this.state.chats.find((c) => c.id === id)?.messages ?? []) if (m.turnId) this.turns.forget(m.turnId);
    this.set({ chats: this.state.chats.filter((c) => c.id !== id), current: this.state.current === id ? null : this.state.current });
    this.save();
  }

  /** Every chat of this file (not a running one's turn: those are stopped first). */
  deleteAllChats() {
    for (const id of Object.keys(this.state.running)) this.stop(id);
    this.queue.stopWhere(() => true);
    this.set({ chats: [], current: null, view: "chat" });
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
    return this.contextOf(this.ed.selection);
  }

  /** Layers as a message's context (its chips; the agent reads their ids, sizes and — posts — formats). */
  contextOf(ids: readonly string[]): NonNullable<ChatMessage["context"]> {
    return ids.slice(0, 20).flatMap((id) => {
      const n = this.ed.engine.readNode(id, { fields: ["name", "type", "size"] });
      if (!n) return [];
      const real = this.ed.withRealType(n);
      // A post carries its format (docs/social.md §6.3): the chip and the agent see "Instagram story".
      const post = readPost(this.ed, id);
      const format = post ? (formatById(post.formatId)?.name ?? post.formatId) : null;
      return [{ id, name: n.name ?? "", type: real.type === "ROUNDED_RECTANGLE" ? "RECTANGLE" : String(real.type), width: n.size?.x ?? 0, height: n.size?.y ?? 0, ...(format ? { format } : {}) }];
    });
  }

  /**
   * Sends a message. `skills`: the user's Skills (docs/ai.md §2.10) — the first enabled one named with `/name` runs
   * (its instructions go with the turn, its token leaves the prompt), the other enabled ones are listed for get_skill.
   * `shown`: what the chat shows for the message when the prompt is a brief (Social's Make starter templates…).
   */
  async send(prompt: string, context: ChatMessage["context"] = this.selectionContext(), attachments: Attachment[] = [], skills: readonly AiSkill[] = [], shown?: string) {
    const files = attachments.slice(0, MAX_ATTACHMENTS);
    const text = prompt.trim();
    const invoked = invokedSkill(text, skills);
    const enabled = skills.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description }));
    if ((!text && !files.length) || !this.api) return;
    // With the manager on, every message is the manager's turn (docs/studio.md §2.2).
    const manager = this.managerProvider();
    const provider = manager ?? this.activeProvider();
    let chat = this.currentChat();
    if (!chat) {
      // The id its attachments were copied under.
      const id = this.draftId ?? uid();
      this.draftId = null;
      chat = { id, title: shortTitle(shown ?? text) || files.map((f) => f.name).join(", ").slice(0, 60), updatedAt: Date.now(), providerId: provider?.id ?? null, model: provider ? this.modelOf(provider) : undefined, effort: provider ? this.effortOf(provider) : undefined, messages: [], ...(this.state.draftConnectors.length ? { connectors: this.state.draftConnectors } : {}) };
      this.set({ chats: [chat, ...this.state.chats], current: chat.id, view: "chat", draftConnectors: [] });
    }
    const chatId = chat.id;
    if (this.state.running[chatId]) return;
    const user: ChatMessage = { id: uid(), role: "user", text: shown ?? text, context, ...(files.length ? { attachments: files } : {}), ...(invoked ? { skill: invoked.skill.name } : {}) };
    const answer: ChatMessage = { id: uid(), role: "assistant", parts: [], state: "running", startedAt: Date.now(), provider: manager ? managerName(this.managerSettings()) : provider?.label, ...(provider ? { providerId: provider.id } : {}), ...(manager ? { manager: true } : {}) };
    // A picture asked for: where it will land, in the chat and on the canvas, from now on (over the selected layer it fills).
    if (provider && !manager && asksForImage(text)) {
      const target = placeholderTarget({ ...this.placeholderEnv(), selection: (context ?? []).map((c) => c.id) });
      this.placeholders.start(answer.id, target);
      answer.parts = [{ kind: "image", id: `image:asked:${answer.id}`, state: "generating", aspect: targetAspect(target), asked: true, ...(target?.nodeId ? { fill: true } : {}) }];
    }
    const history: ChatTurnMessage[] = chat.messages.map((m) => (m.role === "user" ? { role: "user", text: `${m.text ?? ""}${m.attachments?.length ? ` [attached: ${m.attachments.map((a) => a.path).join(", ")}]` : ""}` } : { role: "assistant", text: (m.parts ?? []).filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") }));
    this.updateChat(chatId, (c) => ({ ...c, messages: [...c.messages, user, answer] }));
    if (!provider) {
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, state: "error", error: t("No agent is connected. Open Agent settings to install or sign in to one — Claude Code, Antigravity, Codex, Cursor — or start Ollama or LM Studio.") }));
      return;
    }
    const page = this.ed.store.page;
    const pageName = page ? (this.ed.engine.readNode(page, { fields: ["name"] })?.name ?? "") : "";
    try {
      const route = this.managerSettings().manager;
      const model = manager ? (route.model ?? this.modelOf(provider)) : this.modelOf(provider);
      const effort = manager ? (route.effort && provider.efforts?.includes(route.effort) ? route.effort : this.effortOf(provider)) : this.effortOf(provider);
      const sessionKey = manager ? `manager:${provider.id}` : provider.id;
      const resume = sessionOf(chat, sessionKey);
      // In Social, the manager's instructions carry the board (docs/social.md §7.4).
      const social = manager && this.inSocial() ? await this.socialContext() : undefined;
      const said = (invoked ? invoked.prompt || `Run the Skill /${invoked.skill.name}.` : text) || (files.length === 1 ? "Look at the attached file." : "Look at the attached files.");
      const { turnId } = await this.api.turn({
        chatId,
        providerId: provider.id,
        model,
        ...(effort ? { effort } : {}),
        // The manager's instructions open its turn (its own session keeps them: a reminder after the first).
        prompt: manager ? `${resume ? managerReminder(this.managerContext(chat, social)) : managerPrompt(this.managerContext(chat, social))}\n\n${said}` : said,
        ...(manager ? { role: "manager" as const, managerTools: [...MANAGER_TOOLS, ...LIBRARY_TOOLS].map(managerDef) } : {}),
        ...(invoked ? { skill: { name: invoked.skill.name, instructions: invoked.skill.instructions } } : {}),
        ...(enabled.length ? { skills: enabled } : {}),
        ...(chat.connectors?.length ? { connectors: chat.connectors } : {}),
        history,
        resume,
        context: { fileName: this.ed.ui.get().fileName, pageName, selection: context ?? [] },
        ...(files.length ? { attachments: files.map((f) => ({ path: f.path, name: f.name, mime: f.mime })) } : {}),
      });
      this.placeholders.rekey(answer.id, turnId);
      this.turns.start(turnId, provider.label);
      this.noteTurnStart(turnId);
      this.turnTarget.set(turnId, { chat: chatId, message: answer.id, providerId: provider.id, providerLabel: provider.label, prompt: text || files.map((f) => f.name).join(", "), model, ...(manager ? { role: "manager" as const, sessionKey } : {}) });
      agentPresenceOf(this.ed).join(this.actorOf({ turnId, client: provider.label }));
      if (manager) this.managerAborts.set(turnId, new AbortController());
      this.set({ running: { ...this.state.running, [chatId]: turnId } });
      this.updateMessage(chatId, answer.id, (m) => ({ ...m, turnId }));
      if (!manager && chat.providerId !== provider.id) this.updateChat(chatId, (c) => ({ ...c, providerId: provider.id, model: this.modelOf(provider) }));
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

  /** A consent card's answer: Allow once, Always allow (`remember`), Deny. */
  answerConsent(reqId: number, allow: boolean, remember = false, windowId?: string) {
    this.set({ consents: this.state.consents.filter((c) => c.reqId !== reqId) });
    this.api?.answerConsent?.(reqId, allow, remember, windowId);
  }

  /** The connectors on for a chat (the "+" menu's Connectors ▸); a new chat's until its first message. */
  chatConnectors(chatId: string | null): string[] {
    return chatId ? (this.state.chats.find((c) => c.id === chatId)?.connectors ?? []) : this.state.draftConnectors;
  }

  toggleConnector(chatId: string | null, id: string) {
    const now = this.chatConnectors(chatId);
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    if (!chatId) this.set({ draftConnectors: next });
    else this.updateChat(chatId, (c) => ({ ...c, connectors: next }));
  }

  /** A finished turn in the usage ledger (docs/ai.md §2.9: chat turns from their usage events); the store takes the org from the file (`orgId: null` = its space's). */
  private recordUsage(target: { chat: string; message: string; providerId: string; model?: string }) {
    const m = this.state.chats.find((c) => c.id === target.chat)?.messages.find((x) => x.id === target.message);
    const u = m?.usage;
    if (!u || !(u.input || u.output)) return;
    const provider = this.state.providers.find((p) => p.id === target.providerId);
    const fileKey = (this.ed.source as { fileKey?: string }).fileKey ?? null;
    try {
      void getStoreClient()
        .ai.record({ action: "agent", providerId: target.providerId, model: target.model, input: u.input, output: u.output, images: 0, credits: creditsFor("agent", u), fileKey, orgId: null, local: provider?.kind === "openai-compatible" && /localhost|127\.0\.0\.1/.test(provider.detail ?? ""), ok: m.state !== "error" })
        .catch(() => {});
    } catch {
      /* no store here (a browser stand-in) */
    }
  }

  stop(chatId: string) {
    const turnId = this.state.running[chatId];
    if (turnId && this.turnTarget.get(turnId)?.role === "manager") this.endManager(turnId, true);
    if (turnId && this.api) void this.api.stop(turnId);
  }

  private onEvent({ turnId, event }: TurnEvent) {
    const worker = this.workers.get(turnId);
    if (worker) return this.onWorkerEvent(turnId, worker, event);
    const target = this.turnTarget.get(turnId);
    if (!target) return;
    const { chat, message } = target;
    if (event.type === "session") {
      // Valid up to the end of this turn (finish() sets upTo); another agent's turn after it makes it stale.
      this.updateChat(chat, (c) => ({ ...c, sessions: { ...c.sessions, [target.sessionKey ?? target.providerId]: { id: event.resume, upTo: -1 } } }));
      if (event.model) this.resolve(target.providerId, target.model, event.model);
      return;
    }
    if (event.type === "usage") {
      this.updateChat(chat, (c) => ({ ...c, tokens: addTokens(c.tokens, event.usage), messages: c.messages.map((m) => (m.id === message ? { ...m, usage: addTokens(m.usage, event.usage) } : m)) }));
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
    // An agent changed the owner's Skills (main's skills.ts): the panel and the next message see the new list.
    if (event.type === "tool" && event.state === "done" && SKILL_WRITE_TOOLS.has(event.name.split("__").pop() ?? "")) void skillsBox.refresh().catch(() => {});
    this.updateMessage(chat, message, (m) => ({ ...m, ...applyEvent(m, event) }));
  }

  private finish(turnId: string, event: Extract<ChatEvent, { type: "done" }>) {
    const target = this.turnTarget.get(turnId);
    if (!target) return;
    const record = this.turns.finish(turnId);
    agentPresenceOf(this.ed).leave(this.actorOf({ turnId, client: target.providerLabel }).key, LEAVE_AFTER_MS);
    // A manager's turn over: its cards stop waiting; stopped, its tasks stop too (docs/studio.md §2.3).
    if (target.role === "manager") this.endManager(turnId, !!event.stopped);
    this.applyRequestedSelection(turnId);
    this.placeholders.end(turnId);
    const touched = this.touched.get(turnId)?.size ?? 0;
    const running = { ...this.state.running };
    delete running[target.chat];
    this.set({ running, consents: this.state.consents.filter((c) => c.turnId !== turnId) });
    this.recordUsage(target);
    this.updateChat(target.chat, (c) => {
      const key = target.sessionKey ?? target.providerId;
      const own = c.sessions?.[key];
      return own ? { ...c, sessions: { ...c.sessions, [key]: { ...own, upTo: c.messages.length } } } : c;
    });
    this.updateMessage(target.chat, target.message, (m) => ({
      ...m,
      state: m.state === "error" ? "error" : event.stopped ? "stopped" : "done",
      endedAt: Date.now(),
      parts: turnOver(m.parts ?? [], !!event.stopped),
      changes: record && record.state !== "none" ? { count: touched, state: record.state, ...(record.overwritten.length ? { overwritten: record.overwritten.length } : {}) } : undefined,
    }));
    this.dropCancelled(target.chat, target.message);
    // The list's row: the answer's first sentence as the chat's status (no model call: the agents are CLIs, a one-shot
    // turn would cost a process and plan usage), the title kept short unless the owner renamed it.
    this.updateChat(target.chat, (c) => {
      const answer = c.messages.find((m) => m.id === target.message);
      const status = answer ? shortStatus(messageText(answer)) : "";
      const first = c.messages.find((m) => m.role === "user")?.text ?? "";
      const title = c.renamed ? c.title : shortTitle(first) || c.title;
      return { ...c, title, ...(status ? { status } : {}) };
    });
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
    this.updateMessage(target.chat, target.message, (m) => (m.changes ? { ...m, changes: { ...m.changes, state: t.state, overwritten: t.overwritten.length || undefined } } : m));
  }

  // ---- The manager (docs/studio.md §2) ----

  /** Agent settings › Manager (main's; its defaults until main says). */
  managerSettings(): ManagerSettings {
    return this.state.settings.manager ?? DEFAULT_MANAGER_SETTINGS;
  }

  /**
   * The manager's agent when the manager is on — or the view is in Social mode, where every turn is the manager's
   * unless the composer's picker chose an agent for direct turns (docs/social.md §1.3) — and that agent can run; null:
   * messages go to the picked agent.
   */
  managerProvider(): ProviderInfo | null {
    const m = this.managerSettings();
    if (this.inSocial() ? this.state.socialDirect : !m.enabled) return null;
    return this.usable().find((p) => p.id === m.manager.providerId) ?? null;
  }

  /**
   * Social's composer picker (§1.3): an agent's model for direct turns (the agent and model chosen as anywhere), or
   * back to the manager (`null`). Kept for this view while it stays open.
   */
  async chooseInSocial(pick: { providerId: string; model?: string; effort?: string } | null) {
    if (pick) await this.choose(pick.providerId, pick.model, pick.effort);
    this.set({ socialDirect: !!pick });
  }

  /** The view is in Social mode (docs/social.md §7). */
  inSocial(): boolean {
    return this.ed.ui.get().mode === "social";
  }

  /** What the manager's Social paragraph says about the board (docs/social.md §7.4): its brand, campaigns and counts. */
  private async socialContext(): Promise<SocialPromptContext> {
    const board = socialOf(this.ed).get();
    const id = this.ed.ui.get().socialBrandId ?? null;
    const brand = id ? await this.studio.brands().get(id).catch(() => null) : null;
    return {
      brand: brand ? { id: brand.id, name: brand.name } : null,
      campaigns: board.groups.filter((g) => g.campaign).map((g) => ({ id: g.campaign!.id, name: g.campaign!.name, posts: g.posts.length })),
      unplaced: board.groups.find((g) => !g.campaign)?.posts.length ?? 0,
    };
  }

  /**
   * A post's Fix (the Post section, docs/social.md §6.5): the manager's turn on that problem, sent at once with the
   * post as its context — it runs the fix loop (a caption rewritten, a timeline retimed, a relayout task) and checks
   * again. Nothing is sent while the chat's turn runs.
   */
  fixProblem(post: { id: string; name: string }, problem: { kind: string; detail: string; fix: string }) {
    const chat = this.currentChat();
    if (chat && this.state.running[chat.id]) return;
    void this.send(`Fix on “${post.name}” (${post.id}): ${problem.kind} — ${problem.detail} (fix: ${problem.fix}).`, this.contextOf([post.id]));
  }

  /**
   * A post's relayout problem (safe area, contrast, logo — docs/social.md §7.3) fixed by a worker without a manager turn:
   * the Post section's Fix when nothing mechanical fixes it (`fixProblem` in social/actions.ts). The chat gets the
   * request and the task's card under the manager's answer, as the review's Fix selected starts it; the pin leaves when
   * the task ends done. False when nothing started (a turn running in the chat, no agent to run it).
   */
  async relayoutProblem(post: { id: string; name: string }, problem: { id: string; detail: string; box?: { x: number; y: number; width: number; height: number } }): Promise<boolean> {
    if (!this.managerProvider()) return false;
    let chat = this.currentChat();
    if (chat && this.state.running[chat.id]) return false;
    const text = `Fix on “${post.name}”: ${problem.detail}`;
    if (!chat) {
      chat = { id: uid(), title: shortTitle(text), updatedAt: Date.now(), providerId: null, messages: [] };
      this.set({ chats: [chat, ...this.state.chats], current: chat.id, view: "chat" });
    }
    const chatId = chat.id;
    const user: ChatMessage = { id: uid(), role: "user", text, context: this.contextOf([post.id]) };
    const answer: ChatMessage = { id: uid(), role: "assistant", parts: [{ kind: "text", text: t("Started a relayout task for {name}.", { name: post.name }) }], state: "done", provider: managerName(this.managerSettings()), manager: true };
    this.updateChat(chatId, (c) => ({ ...c, messages: [...c.messages, user, answer] }));
    const env = this.managerEnv(`fix:${answer.id}`, { chat: chatId, message: answer.id });
    const brandId = readPost(this.ed, post.id)?.brandId ?? null;
    const brand = brandId ? await env.brands.get(brandId).catch(() => null) : null;
    const task = relayoutTask(env, post.id, post.name, [problem], brand);
    void this.queue.ended(task.id).then((done) => {
      const now = done.state === "done" ? env.posts?.problems(post.id) : null;
      if (now?.some((p) => p.id === problem.id)) env.posts!.setProblems(post.id, now.filter((p) => p.id !== problem.id));
    });
    return true;
  }

  /** A follow-up chip (ask_choice {suggestions}) picked: it is the owner's next message; the chips are answered. */
  pickSuggestion(cardId: string, optionId: string) {
    const chat = this.currentChat();
    const message = chat?.messages.find((m) => m.cards?.some((c) => c.id === cardId));
    const card = message?.cards?.find((c) => c.id === cardId);
    if (!chat || !message || !card || card.kind !== "choice" || card.answer || this.state.running[chat.id]) return;
    const option = card.options.find((o) => o.id === optionId);
    if (!option) return;
    this.updateMessage(chat.id, message.id, (m) => ({ ...m, cards: (m.cards ?? []).map((c) => (c.id === cardId ? ({ ...c, answer: { optionId, remember: false } } as ViewCard) : c)) }));
    void this.send(option.label, []);
  }

  /** Agent settings › Manager changed: kept by main; the queue's limits follow. */
  async setManager(patch: Partial<ManagerSettings>) {
    const next = { ...this.managerSettings(), ...patch };
    this.set({ settings: { ...this.state.settings, manager: next } });
    this.queue.refresh();
    if (!this.api) return;
    const settings = await this.api.setSettings({ manager: next });
    this.set({ settings });
    this.queue.refresh();
  }

  /** What the manager's instructions say about this chat: the settings, the agents it may use, the image model, its briefs — and the board, in Social. */
  private managerContext(chat: Chat, social?: SocialPromptContext): ManagerPromptContext {
    const settings = this.managerSettings();
    const agents = this.usable().filter((p) => !settings.allowed.length || settings.allowed.includes(p.id));
    return { settings, agents: agents.map((p) => ({ id: p.id, label: p.label, models: p.models })), imageRoute: chat.imageRoute ?? settings.image, briefs: (chat.briefs ?? []).map((b) => ({ id: b.id, request: b.request })), ...(social ? { social } : {}) };
  }

  /** A manager's turn ended (or was stopped): its cards stop waiting; stopped, its tasks stop. */
  private endManager(turnId: string, stopped: boolean) {
    const target = this.turnTarget.get(turnId);
    this.managerAborts.get(turnId)?.abort();
    this.managerAborts.delete(turnId);
    for (const [id, w] of [...this.waits]) if (w.turnId === turnId) this.settleCard(id, { cancelled: true });
    if (stopped && target) this.queue.stopWhere((t) => t.chatId === target.chat && t.messageId === target.message);
  }

  /** The environment of a manager's tool call: its chat and answer, the queue, the cards, the library, the images. */
  managerEnv(turnId: string, target: { chat: string; message: string }): ManagerEnv {
    const abort = this.managerAborts.get(turnId) ?? new AbortController();
    this.managerAborts.set(turnId, abort);
    const chatId = target.chat;
    return {
      chatId,
      messageId: target.message,
      signal: abort.signal,
      settings: () => this.managerSettings(),
      providers: () => this.state.providers,
      queue: this.queue,
      data: () => this.state.chats.find((c) => c.id === chatId) ?? {},
      setData: (fn) => this.updateChat(chatId, (c) => ({ ...c, ...fn(c) })),
      ask: (card) => this.ask(chatId, target.message, turnId, card),
      noteTask: (taskId, extra) => this.patchTask(chatId, taskId, (t) => ({ ...t, ...extra })),
      runWorker: (task, prompt, signal, attachments) => this.runWorker(task, prompt, signal, attachments),
      brands: this.studio.brands(),
      library: (name, args) => this.studio.library(this.ed, name, args),
      runImage: (req, signal) => this.studio.runImage(this.ed, req, signal),
      blur: (nodeId, boxes) => this.studio.blur(this.ed, nodeId, boxes),
      imageRoutes: () => this.studio.imageRoutes(),
      attach: async (files) => {
        if (!this.api) return [];
        const r = await this.api.attach(chatId, files);
        return r.attachments.map((a) => ({ path: a.path, name: a.name, mime: a.mime }));
      },
      tool: (name, args) => this.runWhenIdle(this.studioToolEnv(), name, args),
      page: () => this.ed.store.page,
      read: (id) => this.readBox(id),
      pictureOf: (id) => this.pictureOf(id),
      pictureSlot: (id) => postSlots(this.ed, id).find((s) => s.data.role === "picture" && !s.data.locked)?.nodeId ?? null,
      social: () => this.inSocial(),
      // A post's pins: each change one step of the owner's history, as the studio's other writes.
      posts: {
        problems: (id) => readPost(this.ed, id)?.problems ?? null,
        setProblems: (id, problems) => {
          const data = readPost(this.ed, id);
          if (data) this.turns.writeAction("Studio: Review", () => writePost(this.ed, id, { ...data, problems }), [id]);
        },
      },
      suggest: (card) => this.updateMessage(chatId, target.message, (m) => ({ ...m, cards: [...(m.cards ?? []), card] })),
      // The Brands library (round 18b): its update one step of the owner's history, as the studio's other writes.
      brandLibrary: () => this.studio.brandLibrary(this.ed, (label, fn) => this.turns.writeAction(`Studio: ${label}`, fn)),
    };
  }

  private fileKey(): string | null {
    return (this.ed.source as { fileKey?: string }).fileKey ?? null;
  }

  /** The studio's own canvas writes (a picture into its frame): each one step of the owner's history (⌘Z). */
  private studioToolEnv(): ToolEnv {
    return { ed: this.ed, write: <T>(label: string, fn: () => T, refs?: readonly Guid[]) => this.turns.writeAction(`Studio: ${label}`, fn, refs) };
  }

  /** A layer's name, type, place, size and children (make_posts' frames, their Picture layer). */
  private readBox(id: string) {
    const n = this.ed.engine.readNode(id, { childIds: true, fields: ["name", "type", "size", "transform"] });
    if (!n) return null;
    return { name: n.name ?? "", type: String(this.ed.withRealType(n).type), x: n.transform?.m02 ?? 0, y: n.transform?.m12 ?? 0, width: n.size?.x ?? 0, height: n.size?.y ?? 0, children: (n.childIds ?? []) as string[] };
  }

  /** The picture filling a layer, as base64 (Fix label edits it). */
  private async pictureOf(id: string): Promise<string | null> {
    const n = this.ed.engine.readNode(id, { fields: ["fillPaints"] });
    const paints = (n?.fillPaints ?? []) as Parameters<typeof paintImageHash>[0][];
    const hash = paints.map((p) => paintImageHash(p)).find((h): h is string => !!h);
    const bytes = hash ? await this.ed.images.bytes(hash) : null;
    return bytes ? toBase64(bytes) : null;
  }

  /** A layer's size (the review card scales its problems' boxes to the thumbnail). */
  frameSize(nodeId: string): { width: number; height: number } | null {
    const n = this.ed.engine.readNode(nodeId, { fields: ["size"] });
    return n?.size ? { width: n.size.x, height: n.size.y } : null;
  }

  /** A frame's thumbnail for the review card (a PNG data URL), read once. */
  thumbnail(nodeId: string): Promise<string | null> {
    let p = this.thumbs.get(nodeId);
    if (!p) {
      p = runTool({ ed: this.ed, write: () => { throw new Error("read-only"); } }, "get_screenshot", { nodeId, maxSize: 480 }).then((r) => {
        const img = r.content.find((c) => c.type === "image");
        return img && img.type === "image" ? `data:${img.mimeType};base64,${img.data}` : null;
      }, () => null);
      this.thumbs.set(nodeId, p);
    }
    return p;
  }

  // ---- Cards that wait for the owner ----

  private ask(chatId: string, messageId: string, turnId: string, card: ViewCard): Promise<CardAnswer> {
    this.updateMessage(chatId, messageId, (m) => ({ ...m, cards: [...(m.cards ?? []), card] }));
    return new Promise((resolve) => this.waits.set(card.id, { chat: chatId, message: messageId, turnId, resolve }));
  }

  /** A card still waiting for its answer (one kept from before the file closed isn't). */
  cardOpen(cardId: string): boolean {
    return this.waits.has(cardId);
  }

  /** The owner answered a card: it shows the answer, the manager's tool call gets it. */
  answerCard(cardId: string, answer: CardAnswer) {
    this.settleCard(cardId, answer);
  }

  private settleCard(cardId: string, answer: CardAnswer) {
    const w = this.waits.get(cardId);
    if (!w) return;
    this.waits.delete(cardId);
    this.updateMessage(w.chat, w.message, (m) => ({ ...m, cards: (m.cards ?? []).map((c) => (c.id === cardId ? ({ ...c, answer } as ViewCard) : c)) }));
    w.resolve(answer);
  }

  // ---- Tasks ----

  /** The chat's tasks of a manager's answer (its task cards). */
  tasksOf(chat: Chat, messageId: string): ChatTask[] {
    return (chat.tasks ?? []).filter((t) => t.messageId === messageId);
  }

  stopTask(taskId: string) {
    this.queue.stop(taskId);
  }

  /**
   * A task's card ran it again with its prompt edited (docs/studio.md §5.2): a new task in the same manager's answer,
   * the old one kept. Resolves with why it couldn't start (null: started).
   */
  async runTaskAgain(taskId: string, prompt: string): Promise<string | null> {
    const chat = this.state.chats.find((c) => c.tasks?.some((x) => x.id === taskId));
    const task = chat?.tasks?.find((x) => x.id === taskId);
    if (!chat || !task || !isEnded(task)) return t("This task can't run again.");
    const env = this.managerEnv(`again:${task.messageId}`, { chat: chat.id, message: task.messageId });
    try {
      await runAgain(env, task, prompt);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private taskChanged(t: StudioTask) {
    this.updateChat(t.chatId, (c) => {
      const list = c.tasks ?? [];
      const i = list.findIndex((x) => x.id === t.id);
      return { ...c, tasks: i < 0 ? [...list, t] : list.map((x, j) => (j === i ? { ...x, ...t } : x)) };
    });
  }

  private patchTask(chatId: string, taskId: string, fn: (t: ChatTask) => ChatTask) {
    this.updateChat(chatId, (c) => ({ ...c, tasks: (c.tasks ?? []).map((t) => (t.id === taskId ? fn(t) : t)) }));
  }

  /**
   * An agent task as a worker's turn (docs/studio.md §2.2): its own CLI process or server call, folder, actor and undo
   * step; `role: "worker"`, so main lists no manager tool for it. Resolves with its last answer; Stop stops the turn.
   */
  private runWorker(task: StudioTask, prompt: string, signal: AbortSignal, attachments?: { path: string; name: string; mime: string }[]): Promise<TaskResult> {
    const api = this.api;
    if (!api) return Promise.reject(new Error(t("Agents run in the desktop app.")));
    const p = this.state.providers.find((x) => x.id === task.route.providerId && x.available);
    if (!p) return Promise.reject(new Error(`${task.route.providerId} isn't connected.`));
    const model = task.route.model ?? this.state.settings.models[p.id] ?? p.models[0];
    const effort = task.route.effort && p.efforts?.includes(task.route.effort) ? task.route.effort : undefined;
    const page = this.ed.store.page;
    const pageName = page ? (this.ed.engine.readNode(page, { fields: ["name"] })?.name ?? "") : "";
    return new Promise<TaskResult>((resolve, reject) => {
      let turnId: string | null = null;
      const onAbort = () => {
        if (turnId) void api.stop(turnId);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const end = (log: WorkerLog, stopped: boolean) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted || stopped) return reject(new Error("Stopped"));
        if (log.state === "error") return reject(new Error(log.error ?? `${p.label} failed.`));
        const said = log.parts.filter((x): x is Extract<MessagePart, { kind: "text" }> => x.kind === "text").map((x) => x.text).join("").trim();
        const touched = turnId ? [...(this.touched.get(turnId) ?? [])] : [];
        resolve({ summary: said.slice(-300) || "Done", ...(touched.length ? { nodeIds: touched.slice(0, 50) } : {}), ...(log.usage ? { credits: creditsFor("agent", log.usage) } : {}) });
      };
      api
        .turn({ chatId: task.chatId, providerId: p.id, model, ...(effort ? { effort } : {}), prompt, history: [], context: { fileName: this.ed.ui.get().fileName, pageName, selection: [] }, role: "worker", ...(attachments?.length ? { attachments: attachments as TurnRequest["attachments"] } : {}) })
        .then(({ turnId: id }) => {
          turnId = id;
          this.turns.start(id, p.label);
          this.workers.set(id, { chat: task.chatId, taskId: task.id, providerId: p.id, model, end });
          this.patchTask(task.chatId, task.id, (t) => ({ ...t, worker: { parts: [], state: "running", turnId: id, provider: p.label } }));
          agentPresenceOf(this.ed).join(this.actorOf({ turnId: id, client: p.label }));
          if (signal.aborted) void api.stop(id);
        }, reject);
    });
  }

  private onWorkerEvent(turnId: string, w: { chat: string; taskId: string; providerId: string; model?: string; end: (log: WorkerLog, stopped: boolean) => void }, event: ChatEvent) {
    const log = (): WorkerLog => this.state.chats.find((c) => c.id === w.chat)?.tasks?.find((t) => t.id === w.taskId)?.worker ?? { parts: [], state: "running" };
    const patch = (fn: (l: WorkerLog) => WorkerLog) => this.patchTask(w.chat, w.taskId, (t) => ({ ...t, worker: fn(t.worker ?? { parts: [], state: "running" }) }));
    if (event.type === "session") return;
    if (event.type === "usage") return patch((l) => ({ ...l, usage: addTokens(l.usage, event.usage) }));
    if (event.type === "limits") {
      const next: UsageInfo = { providerId: w.providerId, windows: event.windows, at: Date.now() };
      return this.set({ usage: { ...this.state.usage, [w.providerId]: mergeUsage(this.state.usage[w.providerId], next) } });
    }
    if (event.type === "done") {
      agentPresenceOf(this.ed).leave(`task:${w.taskId}`, LEAVE_AFTER_MS);
      this.workers.delete(turnId);
      this.turns.finish(turnId);
      this.turnStarts.delete(turnId);
      patch((l) => ({ ...l, state: l.state === "error" ? "error" : event.stopped ? "stopped" : "done", parts: turnOver(l.parts, !!event.stopped) }));
      const done = log();
      const u = done.usage;
      // In the ledger like any agent turn (docs/studio.md §2.3).
      if (u && (u.input || u.output)) this.studio.record({ action: "agent", providerId: w.providerId, model: w.model, input: u.input, output: u.output, images: 0, credits: creditsFor("agent", u), local: false, ok: done.state !== "error" }, this.fileKey());
      w.end(done, !!event.stopped);
      return;
    }
    patch((l) => {
      const m = applyEvent({ id: "", role: "assistant", parts: l.parts, state: "running", ...(l.error ? { error: l.error } : {}) }, event);
      return { ...l, ...(m.parts ? { parts: m.parts } : {}), ...(m.state === "error" ? { state: "error" as const, error: m.error } : {}) };
    });
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

export { modelLabel } from "./setup";

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

/** The part of the canvas the panels leave visible, in canvas px (undefined without a canvas: the whole of it). */
function visibleView(canvas: HTMLElement | null | undefined) {
  const v = viewRect(canvas);
  if (!canvas || !v) return undefined;
  const c = canvas.getBoundingClientRect();
  return { x: v.left - c.left, y: v.top - c.top, width: v.width, height: v.height };
}

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

/** A task kept from before the file closed: running or queued, it is over (stopped), its worker's log too. */
function stoppedTask(t: ChatTask): ChatTask {
  if (isEnded(t)) return t;
  return { ...t, state: "stopped", endedAt: t.endedAt ?? Date.now(), ...(t.worker && t.worker.state === "running" ? { worker: { ...t.worker, state: "stopped", parts: turnOver(t.worker.parts, true) } } : {}) };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
