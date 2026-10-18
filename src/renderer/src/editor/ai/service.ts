/**
 * The AI actions (docs/ai.md §3, round 6a): Rename layers, Rewrite this… / Shorten / Translate to…, Replace content,
 * Add interactions and First Draft. Each one reads the selection, asks main for one structured answer (`runOnce` over
 * `window.designer.ai`, src/shared/ai/api.ts), checks it (src/shared/ai/schemas.ts) and applies it as **one step of
 * the user's history** (`AgentTurns.writeAction`). The text tools (Rewrite, Shorten, Translate, Replace content) write
 * as the answer streams, as Figma's adjust_text does (atlas 18 §5): each text's characters so far go into the layer,
 * every later write merged into the first one's step, and Stop, Esc, closing Actions or a failure put the originals
 * back; the other actions write nothing before the answer is complete, so they cancel with nothing to roll back.
 * Every run is recorded in the usage ledger (`store.ai.record`, the store taking the org from the file). One run at a
 * time per file.
 */
import { showToast } from "@/ds";
import { intlLocale, t } from "@/i18n";
import type { Guid, NodeChange } from "@/engine/codec";
import { fonts } from "@/engine/fonts";
import { getStoreClient } from "@/store";
import { AiRunError, runOnce, type AiApi } from "@shared/ai/api";
import { AI_ACTION_LABEL } from "@shared/ai/labels";
import { policyOf, type OrgAiPolicy } from "@shared/ai/orgPolicy";
import { firstDraftPrompt, formatOutline, interactionsPrompt, renamePrompt, replaceContentPrompt, textPrompt, type OutlineNode, type PromptPair, type TextTask } from "@shared/ai/prompts";
import { AnswerError, draftSchema, INTERACTIONS_SCHEMA, readDraft, readInteractions, readRename, readTexts, readTextsSoFar, RENAME_SCHEMA, TEXTS_SCHEMA, type DraftPlan } from "@shared/ai/schemas";
import { creditsFor, DEFAULT_AI_SETTINGS, type AiAction, type AiRunEvent, type AiRunRequest, type AiSettings, type AiUsage, type AiUsageEntry } from "@shared/ai/types";
import { kitById, kitFor, type KitId, type LibraryChoice } from "@shared/ai/kits";
import type { EditorController } from "../controller";
import { editorBridge } from "../desktop";
import { agentsOf } from "../agents/service";
import { EngineBusy } from "../agents/turns";
import { applySelection, createNodes, type ToolEnv } from "../agents/mcpTools";
import { addInteractionTool } from "../agents/prototypeTools";
import { loadAiBalance, openAiBalance } from "../../settings/AiBalance";
import { buildDraft, DEFAULT_STYLE, type DraftStyle } from "./draft/build";
import { flatten, outlineBatches, readLayers, type Layer } from "./layers";
import { aiMessage, type AiProblem } from "./messages";
import { matchGroups, RENAME_MAX_LAYERS, renameCandidates } from "./rename";
import { encodePng } from "../agents/png";
import { liveInteractions, type PrototypeInteraction } from "../model/prototype";

/** What the actions need of main (tests pass a fake). */
export type AiRunApi = Pick<AiApi, "run" | "cancel" | "onEvent"> & Partial<Pick<AiApi, "settings">>;

export interface AiBackend {
  api: AiRunApi | null;
  /** The usage ledger (default: the store's) */
  record?: (e: Omit<AiUsageEntry, "id" | "at">) => Promise<unknown>;
  /** The organizations' AI policy (default: the store's orgs) */
  policy?: () => Promise<OrgAiPolicy>;
  /** The month's credits left and when they reset (default: the ledger's, AI balance's); null when it can't say */
  balance?: (monthly: number) => Promise<{ remaining: number; resetsAt: number } | null>;
}

/** Why Actions' AI rows can't run (Figma's "AI not available" banners, atlas 18 §2.2, §9.2). */
export type AiUnavailable = "turned-off" | "org-disabled";

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
  /** Why not (null: enabled, or no backend) */
  unavailable: AiUnavailable | null;
  /** The credits stop is on and the month's credits are used: when they reset (the actions that cost credits are off) */
  outOfCredits: { resetsAt: number } | null;
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

async function storeBalance(monthly: number): Promise<{ remaining: number; resetsAt: number } | null> {
  return (await loadAiBalance(monthly)).balance;
}

async function storeRecord(e: Omit<AiUsageEntry, "id" | "at">): Promise<unknown> {
  return getStoreClient().ai.record(e);
}

/**
 * Texts are written whole: the characters, every character in the first run's style (a single style keeps it). With
 * `range` (the text-edit selection, atlas 18 §5: only the selected range is replaced) `characters` replace that range
 * alone, in the style of its first character, and the rest keeps its runs.
 */
export function textDataFor(old: Record<string, unknown> | undefined, characters: string, range?: readonly [number, number]): Record<string, unknown> {
  const td = { ...(old ?? {}) } as { characters?: string; characterStyleIDs?: number[]; lines?: unknown[]; [k: string]: unknown };
  let full = characters;
  let ids: number[];
  if (range) {
    const was = td.characters ?? "";
    const styles = was.length ? Array.from({ length: was.length }, (_, i) => td.characterStyleIDs?.[i] ?? 0) : [];
    const id = styles[range[0]] ?? styles[0] ?? 0;
    full = was.slice(0, range[0]) + characters + was.slice(range[1]);
    ids = [...styles.slice(0, range[0]), ...new Array<number>(characters.length).fill(id), ...styles.slice(range[1])];
    if (ids.every((x) => !x)) ids = [];
  } else {
    const first = td.characterStyleIDs?.[0] ?? 0;
    ids = first ? new Array<number>(characters.length).fill(first) : [];
  }
  const out: Record<string, unknown> = { ...td, characters: full, characterStyleIDs: ids };
  const paragraphs = full.split("\n").length;
  if (Array.isArray(td.lines) && td.lines.length) out.lines = Array.from({ length: paragraphs }, (_, i) => td.lines![Math.min(i, td.lines!.length - 1)]);
  return out;
}

/** Figma's caps on the text tools (atlas 18 §5): text layers, and characters in all of them. */
export const TEXT_TOOLS_MAX_LAYERS = 100;
export const TEXT_TOOLS_MAX_CHARACTERS = 40_000;
/** How often streamed texts are written (ms) [ours: Figma writes each delta]. */
export const TEXT_STREAM_MS = 50;

/** A text the text tools change: the layer, and the range of it (the text-edit selection) when only that changes. */
export interface TextTarget {
  layer: Layer;
  /** The characters sent (the range's, or the whole text) */
  text: string;
  range?: [number, number];
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
    this.state = { available: !!backend.api, enabled: !!backend.api, unavailable: null, outOfCredits: null, form: null, run: null, error: null, banner: null, draft: null };
    // A frame duplicated with text in it: the banner suggests Replace content [unverified when Figma shows it].
    this.offs.push(
      ed.engine.onDocumentChanged((changes, ev) => {
        if (ev.kind !== "USER" || ev.actor || !/^Duplicate/.test(ev.label) || !this.state.enabled || this.state.run) return;
        const made = changes.filter((c) => (c as { phase?: string }).phase === "CREATED");
        if (!made.some((c) => c.type === "TEXT")) return;
        const tops = ed.selection.filter((id) => made.some((c) => c.guid === id));
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

  /** Settings › AI, the organizations' policy and the month's credits, read again (the Actions panel calls it when it opens). */
  async refresh(): Promise<void> {
    const api = this.backend.api;
    if (!api) return this.set({ available: false, enabled: false, unavailable: null, outOfCredits: null });
    const settings = api.settings ? await api.settings().catch(() => null) : null;
    this.settings = settings;
    const policy = await (this.backend.policy ?? storePolicy)().catch(() => ({ disabled: false, limit: null }));
    const unavailable: AiUnavailable | null = !(settings?.enabled ?? true) ? "turned-off" : policy.disabled ? "org-disabled" : null;
    let outOfCredits: AiState["outOfCredits"] = null;
    if (!unavailable && (settings?.stopAtLimit ?? true)) {
      const b = await (this.backend.balance ?? storeBalance)(settings?.monthlyCredits ?? DEFAULT_AI_SETTINGS.monthlyCredits).catch(() => null);
      if (b && b.remaining <= 0) outOfCredits = { resetsAt: b.resetsAt };
    }
    this.set({ available: true, enabled: !unavailable, unavailable, outOfCredits });
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
          showToast({ message: t(failure.message), kind: "error", ...(failure.code === "over-limit" ? { action: { label: t("AI balance"), onAction: openAiBalance } } : {}) });
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

  /**
   * One structured run; its usage goes to the ledger whatever the outcome. `onText` sees the answer's text as it
   * streams (from the start again when main asks a second time to repair it).
   */
  private async ask(action: AiAction, pair: PromptPair, schema: Record<string, unknown>, signal: AbortSignal, o: { onText?: (raw: string) => void; timeoutMs?: number; images?: AiRunRequest["images"] } = {}): Promise<unknown> {
    const { onText, timeoutMs, images } = o;
    const api = this.backend.api!;
    const runId = uid();
    let usage: AiUsage | undefined;
    let ok = false;
    let raw = "";
    const onEvent = (e: AiRunEvent) => {
      if (e.type === "usage") usage = e.usage;
      else if (e.type === "status") raw = "";
      else if (e.type === "delta" && onText) onText((raw += e.text));
    };
    try {
      const out = await runOnce(api, { runId, action, system: pair.system, prompt: pair.prompt, schema, ...(timeoutMs ? { timeoutMs } : {}), ...(images?.length ? { images } : {}) }, { signal, onEvent });
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
      // Who answered as main says (with "Automatic" only main knows), else the route Settings › AI picks.
      providerId: usage?.providerId ?? route?.providerId ?? "auto",
      ...((usage?.model ?? route?.model) ? { model: usage?.model ?? route?.model } : {}),
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

  /** `fn` as one step of the user's history (`merge`: joined to its last step). */
  private apply<T>(label: string, fn: (env: ToolEnv) => T, refs: readonly Guid[] = [], merge = false): T {
    const turns = agentsOf(this.ed).turns;
    const env: ToolEnv = { ed: this.ed, write: (_l, f) => f() };
    return turns.writeAction(label, () => fn(env), refs, merge);
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
   * "No layers need renaming" with "Rename anyway". Figma's cap: 500 visible layers in the trees. Each selected
   * top-level layer goes along as a picture (≤ 1024 px, for routes that read images). Resolves to how many were
   * renamed (0: none, null: failed).
   */
  renameLayers(o: { refs?: Guid[]; anyway?: boolean; fromPanel?: boolean } = {}): Promise<number | null> {
    const refs = o.refs ?? this.selectionOrPage();
    const roots = readLayers(this.ed, refs);
    const sent = flatten(roots).filter((l) => !l.hidden && !l.transparent).length;
    if (sent > RENAME_MAX_LAYERS) {
      const message = t("Too many layers selected: {count} / {max}. Select fewer layers to rename.", { count: sent.toLocaleString(intlLocale()), max: RENAME_MAX_LAYERS });
      if (o.fromPanel) this.set({ error: { action: "rename-layers", code: "too-large", message } });
      else showToast({ message, kind: "error" });
      return Promise.resolve(null);
    }
    const candidates = renameCandidates(roots, !!o.anyway);
    if (!candidates.length) {
      showToast({ message: t("No layers need renaming"), action: { label: t("Rename anyway"), onAction: () => void this.renameLayers({ refs, anyway: true }) } });
      return Promise.resolve(0);
    }
    return this.execute("rename-layers", !!o.fromPanel, async (signal) => {
      const groups = matchGroups(candidates);
      const asked = new Set(groups.map((g) => g[0].id));
      const names = new Map<string, string>();
      const images = await layerImages(this.ed, roots.slice(0, 8));
      for (const batch of outlineBatches(roots, (l) => (asked.has(l.id) ? "rename" : undefined))) {
        const ids = idsMarked(batch, "rename");
        if (!ids.size) continue;
        const json = await this.ask("rename-layers", renamePrompt(formatOutline(batch)), RENAME_SCHEMA as unknown as Record<string, unknown>, signal, { images });
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

  /**
   * The texts the text actions change: selected texts and texts in selected layers (visible, unlocked) — or, while a
   * text is being edited with a range selected (`range`: Rewrite, Shorten, Translate), that range alone. Figma's caps
   * (atlas 18 §5): 100 text layers and 40,000 characters; `single` (Shorten): exactly one text layer.
   */
  private textTargets(o: { range?: boolean; single?: boolean } = {}): { roots: Layer[]; targets: TextTarget[] } {
    const edit = o.range ? this.ed.engine.textEdit : null;
    const selection = edit?.ref && edit.selEnd > edit.selStart ? [edit.ref] : this.ed.selection;
    if (!selection.length) throw new AiActionError("nothing-selected", "Select text layers, or frames with text in them.");
    const roots = readLayers(this.ed, selection);
    const texts: Layer[] = [];
    const walk = (l: Layer) => {
      if (l.hidden || l.locked) return;
      if (l.type === "TEXT") texts.push(l);
      l.children.forEach(walk);
    };
    roots.forEach(walk);
    if (!texts.length) throw new AiActionError("nothing-selected", "Select text layers, or frames with text in them.");
    if (o.single && texts.length > 1) throw new AiActionError("nothing-selected", "Select a single text layer.");
    if (texts.length > TEXT_TOOLS_MAX_LAYERS) throw new AiActionError("too-large", t("Select up to {n} text layers.", { n: TEXT_TOOLS_MAX_LAYERS }));
    const missing = new Set(fonts.missing().map((m) => `${m.family}
${m.style}`.toLowerCase()));
    const isMissing = (f?: { family: string; style: string }) => !!f && missing.has(`${f.family}
${f.style}`.toLowerCase());
    if (texts.some((t) => isMissing(t.font) || t.runFonts?.some(isMissing))) throw new AiActionError("missing-fonts");
    const targets: TextTarget[] = texts.map((l) => {
      const all = l.text ?? "";
      if (!edit?.ref || edit.ref !== l.id || edit.selEnd <= edit.selStart) return { layer: l, text: all };
      const range: [number, number] = [Math.max(0, Math.min(edit.selStart, all.length)), Math.max(0, Math.min(edit.selEnd, all.length))];
      return { layer: l, text: all.slice(range[0], range[1]), range };
    });
    const characters = targets.reduce((n, x) => n + x.text.length, 0);
    if (characters > TEXT_TOOLS_MAX_CHARACTERS) throw new AiActionError("too-large", t("Select less text: {count} / {max} characters.", { count: characters.toLocaleString(intlLocale()), max: TEXT_TOOLS_MAX_CHARACTERS.toLocaleString(intlLocale()) }));
    return { roots, targets };
  }

  /**
   * One text tool's run over `targets`, batch by batch (`pairOf` each batch's prompt): each batch's answer streamed
   * into its layers (`TextStream`), the complete answer read with `readTexts` (`groupsOf`: Replace content's groups
   * that must differ) and written last. Answers how many layers changed.
   */
  private async streamTexts(action: AiAction, label: string, roots: Layer[], targets: TextTarget[], signal: AbortSignal, pairOf: (list: { id: string; characters: string }[], outline: string, inBatch: Set<string>) => PromptPair, groupsOf: (inBatch: Set<string>) => string[][] = () => []): Promise<number> {
    const byId = new Map(targets.map((x) => [x.layer.id, x]));
    const stream = new TextStream(this.ed, (fn, merge) => this.apply(label, fn, [], merge), byId);
    // Someone else's step in the user's history while it streams: merging would join it — the run stops (Figma stops
    // when the user edits the layer).
    const off = this.ed.engine.onDocumentChanged((_c, ev) => {
      if (ev.kind === "SYSTEM" || ev.actor) return;
      stream.foreign = true;
      this.stop();
    });
    try {
      for (const batch of outlineBatches(roots, (l) => (byId.has(l.id) ? "text" : undefined))) {
        const inBatch = idsMarked(batch, "text");
        if (!inBatch.size) continue;
        const list = targets.filter((x) => inBatch.has(x.layer.id)).map((x) => ({ id: x.layer.id, characters: x.text }));
        const json = await this.ask(action, pairOf(list, formatOutline(batch), inBatch), TEXTS_SCHEMA as unknown as Record<string, unknown>, signal, { onText: (raw) => stream.update(readTextsSoFar(raw, inBatch)) });
        stream.done(readTexts(json, inBatch, groupsOf(inBatch)));
      }
      return stream.finish();
    } catch (err) {
      stream.restore();
      throw err;
    } finally {
      off();
    }
  }

  /** Rewrite this… (`prompt`), Shorten (one text layer), Translate to… (`language`). */
  editTexts(task: TextTask, o: { fromPanel?: boolean } = {}): Promise<number | null> {
    const action: AiAction = task.kind;
    return this.execute(action, !!o.fromPanel, async (signal) => {
      const { roots, targets } = this.textTargets({ range: true, single: task.kind === "shorten" });
      return this.streamTexts(action, AI_ACTION_LABEL[action].replace(/\.\.\.$/, ""), roots, targets, signal, (list, outline) => textPrompt(task, list, outline));
    });
  }

  /** Replace content: placeholder text → realistic copy, repeated layers different. */
  replaceContent(prompt = "", o: { fromPanel?: boolean; refs?: Guid[] } = {}): Promise<number | null> {
    return this.execute("replace-content", !!o.fromPanel, async (signal) => {
      if (o.refs) applySelection(this.ed, o.refs, false);
      const { roots, targets } = this.textTargets();
      const ids = new Set(targets.map((x) => x.layer.id));
      const groups = repeatGroups(roots).map((g) => g.filter((id) => ids.has(id))).filter((g) => g.length > 1);
      const groupsIn = (inBatch: Set<string>) => groups.filter((g) => g.every((id) => inBatch.has(id)));
      return this.streamTexts("replace-content", "Replace content", roots, targets, signal, (list, outline, inBatch) => replaceContentPrompt(list, groupsIn(inBatch), outline, prompt), groupsIn);
    });
  }

  // ---- Add interactions ---------------------------------------------------------------------------------------------

  /**
   * The selected top-level frames, connected (20 credits) — Figma's magic-link (atlas 18 §6): 2 to 10 top-level
   * frames; a layer that already has an On click interaction is left alone; NAVIGATE, OVERLAY (SWAP from a frame an
   * overlay opens), CLOSE and BACK, each On click and Instant; written in Figma's order — navigate, then overlays and
   * close, then back, 200 ms apart, the status saying which — as one undo step; 60 s for the answer. The banner then
   * offers Preview and Keep it.
   */
  addInteractions(o: { fromPanel?: boolean } = {}): Promise<number | null> {
    return this.execute("add-interactions", !!o.fromPanel, async (signal) => {
      const page = this.ed.store.page;
      const frames = this.ed.selection.filter((id) => {
        const n = this.ed.engine.readNode(id, { fields: ["parentIndex", "type", "resizeToFit"] });
        return n?.parentIndex?.guid === page && ["FRAME", "SYMBOL", "INSTANCE"].includes(String(n.type)) && !(n as { resizeToFit?: boolean }).resizeToFit;
      });
      if (frames.length < 2) throw new AiActionError("nothing-selected", "Select two or more top-level frames to connect.");
      if (frames.length > INTERACTIONS_MAX_FRAMES) throw new AiActionError("too-large", t("Select up to {n} top-level frames to connect.", { n: INTERACTIONS_MAX_FRAMES }));
      const roots = readLayers(this.ed, frames);
      const all = flatten(roots).filter((l) => !frames.includes(l.id) && !l.hidden);
      const linked = new Set(all.filter((l) => hasClick(this.ed, l.id)).map((l) => l.id));
      const sources = new Set(all.filter((l) => !linked.has(l.id)).map((l) => l.id));
      const topOf = new Map(all.map((l) => [l.id, l.top]));
      const found: ReturnType<typeof readInteractions> = [];
      for (const batch of outlineBatches(roots, (l) => (frames.includes(l.id) ? "screen" : linked.has(l.id) ? "has interaction" : likelyButton(l) ? "button?" : undefined))) {
        const json = await this.ask("add-interactions", interactionsPrompt(roots.map((r) => ({ id: r.id, name: r.name })), formatOutline(batch)), INTERACTIONS_SCHEMA as unknown as Record<string, unknown>, signal, { timeoutMs: INTERACTIONS_TIMEOUT_MS });
        found.push(...readInteractions(json, sources, new Set(frames), (id) => topOf.get(id) ?? null).filter((x) => !found.some((f) => f.sourceId === x.sourceId)));
      }
      if (!found.length) throw new AiActionError("nothing-selected", linked.size ? "No interactions were added: these layers already have interactions." : "Couldn't find anything to connect in these frames.");
      // Opened as overlays here: an overlay opened from one of them swaps it.
      const overlays = new Set(found.filter((x) => x.action === "OVERLAY").map((x) => x.destinationId));
      const actionOf = (x: (typeof found)[number]): Record<string, unknown> =>
        x.action === "BACK" ? { type: "BACK" } : x.action === "CLOSE" ? { type: "CLOSE" } : x.action === "OVERLAY" ? { type: overlays.has(topOf.get(x.sourceId) ?? "") ? "SWAP_OVERLAY" : "OPEN_OVERLAY", destinationId: x.destinationId, transition: { type: "INSTANT" } } : { type: "NAVIGATE", destinationId: x.destinationId, transition: { type: "INSTANT" } };
      const stages: { label: string; list: typeof found }[] = [
        { label: "Adding navigate interactions…", list: found.filter((x) => x.action === "NAVIGATE") },
        { label: "Adding overlay interactions…", list: found.filter((x) => x.action === "OVERLAY" || x.action === "CLOSE") },
        { label: "Adding back interactions…", list: found.filter((x) => x.action === "BACK") },
      ].filter((st) => st.list.length);
      let count = 0;
      let steps = 0;
      let foreign = false;
      const off = this.ed.engine.onDocumentChanged((_c, ev) => {
        if (ev.kind !== "SYSTEM" && !ev.actor) foreign = true;
      });
      try {
        for (const [i, st] of stages.entries()) {
          if (i > 0) await new Promise((r) => setTimeout(r, INTERACTIONS_STAGE_MS));
          if (signal.aborted) break;
          if (this.state.run) this.set({ run: { ...this.state.run, label: st.label } });
          let wrote = 0;
          this.apply(
            "Add interactions",
            (env) => {
              for (const x of st.list) {
                try {
                  addInteractionTool(env, { nodeId: x.sourceId, trigger: { type: "ON_CLICK" }, actions: [actionOf(x)] });
                  wrote++;
                } catch {
                  // One the tool refuses is left out.
                }
              }
            },
            [],
            steps > 0 && !foreign
          );
          count += wrote;
          if (wrote) steps++;
        }
      } finally {
        off();
      }
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

/**
 * A text tool's writes as its answer streams (atlas 18 §5, Figma's adjust_text): every `TEXT_STREAM_MS` the texts'
 * characters so far go into their layers — the first write a step of the user's history, each later one merged into
 * it (Figma's AI_TEXT_MANIPULATION_START / _DELTA), so the whole run is one undo step. `restore` puts the originals
 * back (Stop, a failure), merged too unless someone else's step came in between.
 */
class TextStream {
  /** Someone else wrote to the user's history since the first write */
  foreign = false;
  private steps = 0;
  private pending = new Map<string, string>();
  private final = new Map<string, string>();
  private written = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private originals = new Map<string, Record<string, unknown> | undefined>();

  constructor(
    private ed: EditorController,
    private write: (fn: () => void, merge: boolean) => void,
    private targets: ReadonlyMap<string, TextTarget>
  ) {}

  /** Characters so far (a text's first delta replaces its text, or its range). */
  update(values: ReadonlyMap<string, string>) {
    for (const [id, v] of values) if (!this.final.has(id) && this.written.get(id) !== v) this.pending.set(id, v);
    if (this.pending.size && !this.timer && !this.foreign) this.timer = setTimeout(() => this.streamed(), TEXT_STREAM_MS);
  }

  /** A batch's complete, checked texts (written with the next flush or `finish`). */
  done(values: ReadonlyMap<string, string>) {
    for (const [id, v] of values) {
      this.final.set(id, v);
      this.pending.set(id, v);
    }
  }

  /** A timed write while it streams (a failure here is left to the last write, which reports it). */
  private streamed() {
    try {
      this.flush();
    } catch {
      this.timer = null;
    }
  }

  private flush(last = false): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.size || this.foreign) return false;
    const values = new Map(this.pending);
    try {
      this.write(() => {
        for (const [id, characters] of values) {
          const target = this.targets.get(id);
          if (!target) continue;
          const node = this.ed.engine.readNode(id, { fields: ["textData"] }) as (NodeChange & { textData?: Record<string, unknown> }) | null;
          if (!node) continue;
          if (!this.originals.has(id)) this.originals.set(id, node.textData);
          // A range is replaced within the text as it was (its first write's).
          const base = this.originals.get(id);
          this.ed.engine.setProps([id], { textData: textDataFor(target.range ? base : node.textData, characters, target.range) } as never);
        }
      }, this.steps > 0);
    } catch (err) {
      // The user's gesture is open: the next flush tries again (the last one fails as "busy").
      if (err instanceof EngineBusy && !last) {
        this.timer = setTimeout(() => this.streamed(), TEXT_STREAM_MS);
        return false;
      }
      throw err;
    }
    for (const [id, v] of values) {
      this.written.set(id, v);
      this.pending.delete(id);
    }
    this.steps++;
    return true;
  }

  /** The complete answer written (merged into the streamed step); how many layers changed. */
  finish(): number {
    this.flush(true);
    let count = 0;
    for (const [id, v] of this.final) {
      const was = (this.originals.get(id) as { characters?: string } | undefined)?.characters;
      const t = this.targets.get(id);
      if (this.originals.has(id) && (t?.range ? t.text !== v : was !== v)) count++;
    }
    return count;
  }

  /** Back to the originals (nothing streamed: nothing to do). */
  restore() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    if (!this.steps) return;
    const merge = !this.foreign;
    try {
      this.write(() => {
        for (const [id, td] of this.originals) if (td) this.ed.engine.setProps([id], { textData: td } as never);
      }, merge);
    } catch {
      // The originals stay in the history: ⌘Z brings them back.
    }
  }
}

/** Figma's Add interactions (atlas 18 §6): 2–10 top-level frames, 60 s for the answer, 200 ms between its stages. */
export const INTERACTIONS_MAX_FRAMES = 10;
export const INTERACTIONS_TIMEOUT_MS = 60_000;
export const INTERACTIONS_STAGE_MS = 200;

/** The layer has an On click interaction with a real action (Add interactions leaves it alone). */
function hasClick(ed: EditorController, id: Guid): boolean {
  const list = liveInteractions((ed.engine.readNode(id, { fields: ["prototypeInteractions"] }) as { prototypeInteractions?: PrototypeInteraction[] } | null)?.prototypeInteractions);
  return list.some((i) => i.event?.interactionType === "ON_CLICK" && (i.actions ?? []).some((a) => !!a.connectionType && a.connectionType !== "NONE" && (a.connectionType !== "INTERNAL_NODE" || !!a.transitionNodeID)));
}

/** Each layer as a PNG (base64), the long side ≤ 1024 (Rename layers sends its top-level layers so). */
async function layerImages(ed: EditorController, layers: readonly Layer[]): Promise<{ name: string; data: string }[]> {
  const out: { name: string; data: string }[] = [];
  for (const l of layers) {
    const scale = Math.min(1, 1024 / Math.max(1, l.width, l.height));
    try {
      const r = ed.engine.exportNodes([l.id], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: scale } }, { allowPending: true });
      if (r.status !== "ok" || !("pixels" in r)) continue;
      const png = await encodePng(r.pixels.width, r.pixels.height, r.pixels.pixels);
      let bin = "";
      for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
      out.push({ name: `${l.name || "Layer"}.png`, data: btoa(bin) });
    } catch {
      // A layer that can't be drawn goes without its picture.
    }
  }
  return out;
}

/** The action costs credits (the credits stop turns it off when they're used; Rename layers and search are free). */
export const costsCredits = (action: AiAction): boolean => creditsFor(action, { input: 1, output: 1, megapixels: 1, colors: 2 }) > 0;

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
