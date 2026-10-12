/**
 * The AI actions (docs/ai.md §3, round 6a): Rename layers, Rewrite this… / Shorten / Translate to…, Replace content,
 * Add interactions and First Draft. Each one reads the selection, asks main for one structured answer (`runOnce` over
 * `window.designer.ai`, src/shared/ai/api.ts), checks it (src/shared/ai/schemas.ts) and applies it as **one step of
 * the user's history** (`AgentTurns.writeAction`). Nothing is written before the answer is complete, so Stop, Esc and
 * closing Actions cancel with nothing to roll back. Every run is recorded in the usage ledger (`store.ai.record`, the
 * store taking the org from the file). One run at a time per file.
 */
import { showToast } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";
import { fonts } from "@/engine/fonts";
import { getStoreClient } from "@/store";
import { AiRunError, runOnce, type AiApi } from "@shared/ai/api";
import { AI_ACTION_LABEL } from "@shared/ai/labels";
import { policyOf, type OrgAiPolicy } from "@shared/ai/orgPolicy";
import { firstDraftPrompt, formatOutline, interactionsPrompt, renamePrompt, replaceContentPrompt, textPrompt, type OutlineNode, type PromptPair, type TextTask } from "@shared/ai/prompts";
import { AnswerError, draftSchema, INTERACTIONS_SCHEMA, readDraft, readInteractions, readRename, readTexts, RENAME_SCHEMA, TEXTS_SCHEMA, type DraftPlan } from "@shared/ai/schemas";
import { creditsFor, type AiAction, type AiSettings, type AiUsage, type AiUsageEntry } from "@shared/ai/types";
import { kitById, kitFor, type KitId, type LibraryChoice } from "@shared/ai/kits";
import type { EditorController } from "../controller";
import { editorBridge } from "../desktop";
import { agentsOf } from "../agents/service";
import { EngineBusy } from "../agents/turns";
import { applySelection, createNodes, type ToolEnv } from "../agents/mcpTools";
import { addInteractionTool } from "../agents/prototypeTools";
import { openAiBalance } from "../../settings/AiBalance";
import { buildDraft, DEFAULT_STYLE, type DraftStyle } from "./draft/build";
import { flatten, outlineBatches, readLayers, type Layer } from "./layers";
import { aiMessage, type AiProblem } from "./messages";
import { matchGroups, renameCandidates } from "./rename";
import { guidString } from "../draw/panels/drawPanel";

/** What the actions need of main (tests pass a fake). */
export type AiRunApi = Pick<AiApi, "run" | "cancel" | "onEvent"> & Partial<Pick<AiApi, "settings">>;

export interface AiBackend {
  api: AiRunApi | null;
  /** The usage ledger (default: the store's) */
  record?: (e: Omit<AiUsageEntry, "id" | "at">) => Promise<unknown>;
  /** The organizations' AI policy (default: the store's orgs) */
  policy?: () => Promise<OrgAiPolicy>;
}

/** The text actions' Actions-panel forms, and First Draft's. */
export type AiForm = "rewrite" | "translate" | "replace-content" | "first-draft";

export interface AiRun {
  id: string;
  action: AiAction;
  /** "Renaming layers…" */
  label: string;
  /** Started from the Actions panel (closing it stops the run) */
  fromPanel: boolean;
}

export interface AiFailure {
  action: AiAction;
  code: AiProblem;
  message: string;
}

/** A bottom banner after an action (Add interactions: Preview / Keep it), or suggesting one (Replace content). */
export type AiBanner = { kind: "interactions"; count: number; start: Guid } | { kind: "replace-content"; refs: Guid[] };

/** First Draft after "Make it": what the themes and Make changes rebuild. */
export interface DraftSession {
  prompt: string;
  plan: DraftPlan;
  kit: KitId;
  theme: string;
  style: DraftStyle;
  frame: Guid;
}

export interface AiState {
  /** A backend exists (the desktop app) */
  available: boolean;
  /** Settings › AI is on and no organization turned AI off */
  enabled: boolean;
  /** The Actions panel shows this form instead of its list */
  form: AiForm | null;
  run: AiRun | null;
  error: AiFailure | null;
  banner: AiBanner | null;
  draft: DraftSession | null;
}

const RUNNING_LABEL: Partial<Record<AiAction, string>> = {
  "rename-layers": "Renaming layers…",
  rewrite: "Rewriting…",
  shorten: "Shortening…",
  translate: "Translating…",
  "replace-content": "Replacing content…",
  "add-interactions": "Adding interactions…",
  "first-draft": "Making your design…",
};

const uid = () => `ai-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

/** A failure the action raises itself (nothing to act on, missing fonts, an answer that doesn't fit). */
export class AiActionError extends Error {
  constructor(
    readonly code: AiProblem,
    message?: string
  ) {
    super(message ?? aiMessage(code));
  }
}

function defaultBackend(): AiBackend {
  const bridge = editorBridge() as { ai?: AiRunApi } | null;
  const api = bridge?.ai ?? (window as unknown as { __designerAi?: AiRunApi }).__designerAi ?? null;
  return { api };
}

async function storePolicy(): Promise<OrgAiPolicy> {
  const store = getStoreClient();
  const orgs = await store.orgs.list().catch(() => []);
  const infos = await Promise.all(orgs.filter((o) => o.role !== "guest").map((o) => store.orgs.get(o.id).then((i) => ({ role: o.role, settings: i.settings }), () => null)));
  return policyOf(infos.filter((x): x is NonNullable<typeof x> => x !== null));
}

async function storeRecord(e: Omit<AiUsageEntry, "id" | "at">): Promise<unknown> {
  return getStoreClient().ai.record(e);
}

/** Texts are written whole: the characters, every character in the first run's style (a single style keeps it). */
export function textDataFor(old: Record<string, unknown> | undefined, characters: string): Record<string, unknown> {
  const td = { ...(old ?? {}) } as { characterStyleIDs?: number[]; lines?: unknown[]; [k: string]: unknown };
  const first = td.characterStyleIDs?.[0] ?? 0;
  const out: Record<string, unknown> = { ...td, characters, characterStyleIDs: first ? new Array(characters.length).fill(first) : [] };
  const paragraphs = characters.split("\n").length;
  if (Array.isArray(td.lines) && td.lines.length) out.lines = Array.from({ length: paragraphs }, (_, i) => td.lines![Math.min(i, td.lines!.length - 1)]);
  return out;
}

/** Repeated siblings (same shape: types and names all the way down) → for each place inside them, their texts' ids. */
export function repeatGroups(roots: readonly Layer[]): string[][] {
  const sig = (l: Layer): string => `${l.type}:${l.name}(${l.children.map(sig).join(",")})`;
  const out: string[][] = [];
  const textsByPath = (l: Layer, path = ""): Map<string, string> => {
    const m = new Map<string, string>();
    if (l.type === "TEXT") m.set(path, l.id);
    l.children.forEach((c, i) => textsByPath(c, `${path}/${i}`).forEach((v, k) => m.set(k, v)));
    return m;
  };
  const walk = (l: Layer) => {
    const buckets = new Map<string, Layer[]>();
    for (const c of l.children) buckets.set(sig(c), [...(buckets.get(sig(c)) ?? []), c]);
    for (const same of buckets.values()) {
      if (same.length < 2) continue;
      const maps = same.map((s) => textsByPath(s));
      for (const path of maps[0].keys()) {
        const ids = maps.map((m) => m.get(path)).filter((x): x is string => !!x);
        if (ids.length > 1) out.push(ids);
      }
    }
    l.children.forEach(walk);
  };
  // Selected layers that repeat each other count too.
  walk({ children: [...roots] } as Layer);
  return out;
}

const BUTTON_WORDS = /\b(button|btn|cta|link|tab|back|next|continue|close|cancel|done|sign ?(in|up)|log ?in|submit|menu|nav)\b/i;

/** A layer that looks like something to click (Add interactions marks it). */
export function likelyButton(l: Layer): boolean {
  if (BUTTON_WORDS.test(l.name)) return true;
  if ((l.type === "FRAME" || l.type === "INSTANCE" || l.type === "GROUP") && l.height > 0 && l.height <= 64 && l.children.length > 0 && l.children.length <= 3 && l.children.some((c) => c.type === "TEXT")) return true;
  return l.type === "TEXT" && !!l.text && l.text.length <= 24 && BUTTON_WORDS.test(l.text);
}

export class AiActions {
  private state: AiState;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private settings: AiSettings | null = null;
  private offs: (() => void)[] = [];

  constructor(
    private ed: EditorController,
    private backend: AiBackend = defaultBackend()
  ) {
    this.state = { available: !!backend.api, enabled: !!backend.api, form: null, run: null, error: null, banner: null, draft: null };
    // A frame duplicated with text in it: the banner suggests Replace content [unverified when Figma shows it].
    this.offs.push(
      ed.engine.onDocumentChanged((changes, ev) => {
        if (ev.kind !== "USER" || ev.actor || !/^Duplicate/.test(ev.label) || !this.state.enabled || this.state.run) return;
        const made = changes.filter((c) => (c as { phase?: string }).phase === "CREATED");
        if (!made.some((c) => c.type === "TEXT")) return;
        // DOCUMENT_CHANGED's guid arrives as {sessionID, localID} at runtime (the type says string): compare as "s:l".
        const tops = ed.selection.filter((id) => made.some((c) => guidString(c.guid) === id));
        if (tops.length) this.set({ banner: { kind: "replace-content", refs: [...tops] } });
      })
    );
  }

  dispose() {
    this.stop();
    this.offs.forEach((f) => f());
  }

  get(): AiState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<AiState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Settings › AI and the organizations' policy, read again (the Actions panel calls it when it opens). */
  async refresh(): Promise<void> {
    const api = this.backend.api;
    if (!api) return this.set({ available: false, enabled: false });
    const settings = api.settings ? await api.settings().catch(() => null) : null;
    this.settings = settings;
    const policy = await (this.backend.policy ?? storePolicy)().catch(() => ({ disabled: false, limit: null }));
    this.set({ available: true, enabled: (settings?.enabled ?? true) && !policy.disabled });
  }

  openForm(form: AiForm | null) {
    this.set({ form, error: null });
  }

  dismissError() {
    this.set({ error: null });
  }

  /** Stop: the running action is cancelled (nothing was written). */
  stop() {
    this.abort?.abort();
  }

  /** The Actions panel closed: its run stops, its form and First Draft's session end (Figma: the libraries can't be used after Actions closes). */
  panelClosed() {
    if (this.state.run?.fromPanel) this.stop();
    this.set({ form: null, error: null, draft: null });
  }

  closeBanner(undo = false) {
    const b = this.state.banner;
    this.set({ banner: null });
    if (undo && b?.kind === "interactions" && this.ed.store.undo.canUndo) void this.ed.engine.undo();
  }

  // ---- Running ------------------------------------------------------------------------------------------------------

  /** Runs `body` as `action` (one at a time); a failure becomes the state's error (and a toast outside the panel). */
  private async execute<T>(action: AiAction, fromPanel: boolean, body: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    if (this.state.run) return null;
    const abort = new AbortController();
    this.abort = abort;
    this.set({ run: { id: uid(), action, label: RUNNING_LABEL[action] ?? `${AI_ACTION_LABEL[action]}…`, fromPanel }, error: null, banner: null });
    try {
      if (!this.backend.api) throw new AiActionError("no-provider", "AI actions run in the desktop app.");
      if (!this.state.enabled) {
        await this.refresh();
        if (!this.state.enabled) throw new AiActionError("disabled");
      }
      const out = await body(abort.signal);
      this.set({ run: null });
      return out;
    } catch (err) {
      const failure = this.failureOf(action, err);
      this.set({ run: null, error: failure });
      if (failure) {
        if (failure.code === "over-limit") openAiBalance();
        if (!fromPanel) {
          showToast({ message: failure.message, kind: "error", ...(failure.code === "over-limit" ? { action: { label: "AI balance", onAction: openAiBalance } } : {}) });
          this.set({ error: null });
        }
      }
      return null;
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private failureOf(action: AiAction, err: unknown): AiFailure | null {
    if (err instanceof AiRunError) {
      if (err.code === "cancelled") return null;
      return { action, code: err.code, message: aiMessage(err.code, err.message) };
    }
    if (err instanceof AiActionError) return { action, code: err.code, message: err.message };
    if (err instanceof AnswerError) return { action, code: "bad-output", message: aiMessage("bad-output") };
    if (err instanceof EngineBusy) return { action, code: "busy", message: aiMessage("busy") };
    return { action, code: "apply", message: err instanceof Error && err.message ? err.message : aiMessage("apply") };
  }

  /** One structured run; its usage goes to the ledger whatever the outcome. */
  private async ask(action: AiAction, pair: PromptPair, schema: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const api = this.backend.api!;
    const runId = uid();
    let usage: AiUsage | undefined;
    let ok = false;
    try {
      const out = await runOnce(api, { runId, action, system: pair.system, prompt: pair.prompt, schema }, { signal, onEvent: (e) => e.type === "usage" && (usage = e.usage) });
      usage = out.usage ?? usage;
      let json = out.json;
      if (json === undefined) {
        try {
          json = JSON.parse(out.text) as unknown;
        } catch {
          throw new AiRunError("bad-output", "The answer isn't JSON.");
        }
      }
      ok = true;
      return json;
    } finally {
      this.recordRun(action, usage, ok);
    }
  }

  private recordRun(action: AiAction, usage: AiUsage | undefined, ok: boolean) {
    const route = this.settings?.actions[action] ?? this.settings?.text ?? null;
    const credits = usage ? (usage.credits ?? creditsFor(action, usage)) : ok ? creditsFor(action, {}) : 0;
    const entry: Omit<AiUsageEntry, "id" | "at"> = {
      action,
      providerId: route?.providerId ?? "auto",
      ...(route?.model ? { model: route.model } : {}),
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      images: 0,
      credits,
      fileKey: (this.ed.source as { fileKey?: string }).fileKey ?? null,
      orgId: null,
      local: false,
      ok,
    };
    try {
      void (this.backend.record ?? storeRecord)(entry).catch(() => {});
    } catch {
      // No store here (a browser stand-in).
    }
  }

  /** `fn` as one step of the user's history. */
  private apply<T>(label: string, fn: (env: ToolEnv) => T, refs: readonly Guid[] = []): T {
    const turns = agentsOf(this.ed).turns;
    const env: ToolEnv = { ed: this.ed, write: (_l, f) => f() };
    return turns.writeAction(label, () => fn(env), refs);
  }

  private selectionOrPage(): Guid[] {
    if (this.ed.selection.length) return [...this.ed.selection];
    // Nothing selected: the page's layers [unverified for every action].
    const page = this.ed.engine.readNode(this.ed.store.page, { childIds: true });
    return [...(page?.childIds ?? [])].reverse();
  }

  // ---- Rename layers ------------------------------------------------------------------------------------------------

  /**
   * Rename layers (free). `refs`: the layers (default: the selection, else the page). With none to rename: the toast
   * "No layers need renaming" with "Rename anyway". Resolves to how many were renamed (0: none, null: failed).
   */
  renameLayers(o: { refs?: Guid[]; anyway?: boolean; fromPanel?: boolean } = {}): Promise<number | null> {
    const refs = o.refs ?? this.selectionOrPage();
    const roots = readLayers(this.ed, refs);
    const candidates = renameCandidates(roots, !!o.anyway);
    if (!candidates.length) {
      showToast({ message: "No layers need renaming", action: { label: "Rename anyway", onAction: () => void this.renameLayers({ refs, anyway: true }) } });
      return Promise.resolve(0);
    }
    return this.execute("rename-layers", !!o.fromPanel, async (signal) => {
      const groups = matchGroups(candidates);
      const asked = new Set(groups.map((g) => g[0].id));
      const names = new Map<string, string>();
      for (const batch of outlineBatches(roots, (l) => (asked.has(l.id) ? "rename" : undefined))) {
        const ids = idsMarked(batch, "rename");
        if (!ids.size) continue;
        const json = await this.ask("rename-layers", renamePrompt(formatOutline(batch)), RENAME_SCHEMA as unknown as Record<string, unknown>, signal);
        readRename(json, ids).forEach((v, k) => names.set(k, v));
      }
      let count = 0;
      this.apply("Rename layers", () => {
        for (const g of groups) {
          const name = names.get(g[0].id);
          if (!name) continue;
          for (const l of g) {
            if (this.ed.engine.setProps([l.id], (l.type === "TEXT" ? { name, autoRename: false } : { name }) as never) === 0) count++;
          }
        }
      });
      return count;
    });
  }

  // ---- Texts --------------------------------------------------------------------------------------------------------

  /** The texts the text actions change: selected texts and texts in selected layers (visible, unlocked). */
  private textTargets(): { roots: Layer[]; texts: Layer[] } {
    if (!this.ed.selection.length) throw new AiActionError("nothing-selected", "Select text layers, or frames with text in them.");
    const roots = readLayers(this.ed, this.ed.selection);
    const texts: Layer[] = [];
    const walk = (l: Layer) => {
      if (l.hidden || l.locked) return;
      if (l.type === "TEXT") texts.push(l);
      l.children.forEach(walk);
    };
    roots.forEach(walk);
    if (!texts.length) throw new AiActionError("nothing-selected", "Select text layers, or frames with text in them.");
    const missing = new Set(fonts.missing().map((m) => `${m.family}\n${m.style}`.toLowerCase()));
    const isMissing = (f?: { family: string; style: string }) => !!f && missing.has(`${f.family}\n${f.style}`.toLowerCase());
    if (texts.some((t) => isMissing(t.font) || t.runFonts?.some(isMissing))) throw new AiActionError("missing-fonts");
    return { roots, texts };
  }

  private writeTexts(label: string, values: Map<string, string>): number {
    let count = 0;
    this.apply(label, () => {
      for (const [id, characters] of values) {
        const old = this.ed.engine.readNode(id, { fields: ["textData"] }) as (NodeChange & { textData?: Record<string, unknown> }) | null;
        if (!old || (old.textData as { characters?: string } | undefined)?.characters === characters) continue;
        if (this.ed.engine.setProps([id], { textData: textDataFor(old.textData, characters) } as never) === 0) count++;
      }
    });
    return count;
  }

  /** Rewrite this… (`prompt`), Shorten, Translate to… (`language`). */
  editTexts(task: TextTask, o: { fromPanel?: boolean } = {}): Promise<number | null> {
    const action: AiAction = task.kind;
    return this.execute(action, !!o.fromPanel, async (signal) => {
      const { roots, texts } = this.textTargets();
      const ids = new Set(texts.map((t) => t.id));
      const values = new Map<string, string>();
      for (const batch of outlineBatches(roots, (l) => (ids.has(l.id) ? "text" : undefined))) {
        const inBatch = idsMarked(batch, "text");
        if (!inBatch.size) continue;
        const list = texts.filter((t) => inBatch.has(t.id)).map((t) => ({ id: t.id, characters: t.text ?? "" }));
        const json = await this.ask(action, textPrompt(task, list, formatOutline(batch)), TEXTS_SCHEMA as unknown as Record<string, unknown>, signal);
        readTexts(json, inBatch).forEach((v, k) => values.set(k, v));
      }
      return this.writeTexts(AI_ACTION_LABEL[action].replace(/\.\.\.$/, ""), values);
    });
  }

  /** Replace content: placeholder text → realistic copy, repeated layers different. */
  replaceContent(prompt = "", o: { fromPanel?: boolean; refs?: Guid[] } = {}): Promise<number | null> {
    return this.execute("replace-content", !!o.fromPanel, async (signal) => {
      if (o.refs) applySelection(this.ed, o.refs, false);
      const { roots, texts } = this.textTargets();
      const ids = new Set(texts.map((t) => t.id));
      const groups = repeatGroups(roots).map((g) => g.filter((id) => ids.has(id))).filter((g) => g.length > 1);
      const values = new Map<string, string>();
      for (const batch of outlineBatches(roots, (l) => (ids.has(l.id) ? "text" : undefined))) {
        const inBatch = idsMarked(batch, "text");
        if (!inBatch.size) continue;
        const list = texts.filter((t) => inBatch.has(t.id)).map((t) => ({ id: t.id, characters: t.text ?? "" }));
        const bg = groups.filter((g) => g.every((id) => inBatch.has(id)));
        const json = await this.ask("replace-content", replaceContentPrompt(list, bg, formatOutline(batch), prompt), TEXTS_SCHEMA as unknown as Record<string, unknown>, signal);
        readTexts(json, inBatch, bg).forEach((v, k) => values.set(k, v));
      }
      return this.writeTexts("Replace content", values);
    });
  }

  // ---- Add interactions ---------------------------------------------------------------------------------------------

  /** The selected top-level frames, connected (20 credits). The banner then offers Preview and Keep it. */
  addInteractions(o: { fromPanel?: boolean } = {}): Promise<number | null> {
    return this.execute("add-interactions", !!o.fromPanel, async (signal) => {
      const page = this.ed.store.page;
      const frames = this.ed.selection.filter((id) => {
        const n = this.ed.engine.readNode(id, { fields: ["parentIndex", "type", "resizeToFit"] });
        return n?.parentIndex?.guid === page && ["FRAME", "SYMBOL", "INSTANCE"].includes(String(n.type)) && !(n as { resizeToFit?: boolean }).resizeToFit;
      });
      if (frames.length < 2) throw new AiActionError("nothing-selected", "Select two or more top-level frames to connect.");
      const roots = readLayers(this.ed, frames);
      const all = flatten(roots).filter((l) => !frames.includes(l.id) && !l.hidden);
      const sources = new Set(all.map((l) => l.id));
      const topOf = new Map(all.map((l) => [l.id, l.top]));
      const found: ReturnType<typeof readInteractions> = [];
      for (const batch of outlineBatches(roots, (l) => (frames.includes(l.id) ? "screen" : likelyButton(l) ? "button?" : undefined))) {
        const json = await this.ask("add-interactions", interactionsPrompt(roots.map((r) => ({ id: r.id, name: r.name })), formatOutline(batch)), INTERACTIONS_SCHEMA as unknown as Record<string, unknown>, signal);
        found.push(...readInteractions(json, sources, new Set(frames), (id) => topOf.get(id) ?? null).filter((x) => !found.some((f) => f.sourceId === x.sourceId)));
      }
      if (!found.length) throw new AiActionError("nothing-selected", "Couldn't find anything to connect in these frames.");
      let count = 0;
      this.apply("Add interactions", (env) => {
        for (const x of found) {
          try {
            addInteractionTool(env, { nodeId: x.sourceId, trigger: { type: "ON_CLICK" }, actions: [x.action === "BACK" ? { type: "BACK" } : { type: "NAVIGATE", destinationId: x.destinationId, transition: { type: "INSTANT" } }] });
            count++;
          } catch {
            // One the tool refuses is left out.
          }
        }
      });
      this.set({ banner: { kind: "interactions", count, start: frames[0] } });
      return count;
    });
  }

  /** The banner's Preview: the inline preview from the first connected frame. */
  previewInteractions() {
    const b = this.state.banner;
    if (b?.kind !== "interactions") return;
    this.ed.ui.set({ preview: { page: this.ed.store.page, node: b.start } });
  }

  // ---- First Draft --------------------------------------------------------------------------------------------------

  /** "Make it": the plan from the prompt, built with the library's first theme as a new frame, selected. */
  firstDraft(prompt: string, library: LibraryChoice = "auto"): Promise<Guid | null> {
    return this.execute("first-draft", true, async (signal) => {
      const kit = kitFor(library, prompt);
      const json = await this.ask("first-draft", firstDraftPrompt(prompt, kit), draftSchema(kit.blocks.map((b) => b.id)) as unknown as Record<string, unknown>, signal);
      const plan = readDraft(json, new Set(kit.blocks.map((b) => b.id)));
      const theme = kit.themes[0];
      const frame = this.apply("First Draft", (env) => created(createNodes(env, { nodes: [buildDraft(plan, kit, theme, DEFAULT_STYLE)] })));
      applySelection(this.ed, [frame], true);
      this.set({ draft: { prompt, plan, kit: kit.id, theme: theme.id, style: DEFAULT_STYLE, frame } });
      return frame;
    });
  }

  /** A theme thumbnail, or a style control: the draft frame replaced (one step). */
  restyleDraft(patch: { theme?: string; style?: Partial<DraftStyle> }): Guid | null {
    const d = this.state.draft;
    if (!d || this.state.run) return null;
    const next: DraftSession = { ...d, theme: patch.theme ?? d.theme, style: { ...d.style, ...patch.style } };
    try {
      const frame = this.rebuild(next);
      this.set({ draft: { ...next, frame }, error: null });
      return frame;
    } catch (err) {
      this.set({ error: this.failureOf("first-draft", err) });
      return null;
    }
  }

  /** Make changes with a prompt: the plan changed by the model, rebuilt in the same theme and style. */
  changeDraft(prompt: string): Promise<Guid | null> {
    const d = this.state.draft;
    if (!d) return Promise.resolve(null);
    return this.execute("first-draft", true, async (signal) => {
      const kit = kitById(d.kit);
      const json = await this.ask("first-draft", firstDraftPrompt(prompt, kit, d.plan), draftSchema(kit.blocks.map((b) => b.id)) as unknown as Record<string, unknown>, signal);
      const plan = readDraft(json, new Set(kit.blocks.map((b) => b.id)));
      const next = { ...d, plan };
      const frame = this.rebuild(next);
      this.set({ draft: { ...next, frame } });
      return frame;
    });
  }

  private rebuild(d: DraftSession): Guid {
    const kit = kitById(d.kit);
    const theme = kit.themes.find((t) => t.id === d.theme) ?? kit.themes[0];
    const old = this.ed.engine.readNode(d.frame, { fields: ["transform"] });
    const at = old?.transform ? { x: Math.round(old.transform.m02), y: Math.round(old.transform.m12) } : undefined;
    const frame = this.apply("First Draft", (env) => {
      if (old) this.ed.engine.command("DELETE");
      return created(createNodes(env, { nodes: [buildDraft(d.plan, kit, theme, d.style, at)] }));
    }, old ? [d.frame] : []);
    applySelection(this.ed, [frame], false);
    return frame;
  }
}

/** The ids an outline batch marks with `mark`. */
function idsMarked(batch: readonly OutlineNode[], mark: string): Set<string> {
  const out = new Set<string>();
  const walk = (n: OutlineNode) => {
    if (n.mark === mark) out.add(n.id);
    n.children?.forEach(walk);
  };
  batch.forEach(walk);
  return out;
}

/** The frame create_nodes made. */
function created(r: { content: { type: string; text?: string }[]; isError?: boolean }): Guid {
  const text = r.content.map((c) => c.text ?? "").join("");
  const parsed = (() => {
    try {
      return JSON.parse(text) as { created?: { id: string }[] };
    } catch {
      return null;
    }
  })();
  const id = parsed?.created?.[0]?.id;
  if (r.isError || !id) throw new AiActionError("apply", "The design couldn't be made.");
  return id;
}

const services = new WeakMap<EditorController, AiActions>();

/** The file's AI actions (made on first use). */
export function aiOf(ed: EditorController): AiActions {
  let s = services.get(ed);
  if (!s) {
    s = new AiActions(ed);
    services.set(ed, s);
  }
  return s;
}

/** Tests: the file's AI actions on `backend`. */
export function setAiBackend(ed: EditorController, backend: AiBackend): AiActions {
  services.get(ed)?.dispose();
  const s = new AiActions(ed, backend);
  services.set(ed, s);
  return s;
}
