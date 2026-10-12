/**
 * Actions (⌘K, the toolbar's Actions, the Figma menu's "Actions…"; live toolbar/actions-panel.txt): a 529 × 354 palette
 * over the bottom toolbar, its left edge at the toolbar's and 8 above it — the search (431 × 32 at 44, 8), the tabs All
 * / Assets / Plugins & widgets (at 8, 48), the "Visual search (AI beta)" button at 491, 12 (opens visual search,
 * editor/search), then sections: a header (11 / 450, secondary) and rows of 32 (13 / 400, the text at 44 after a 24
 * glyph column). The All tab opens on Recents (what was run from the palette, kept per machine; none yet: the block's
 * header alone, as live's with no recents is unverified), then the AI sections — Image editing, Design tools, Riffing
 * and writing (editor/ai/actionRows.ts), each row with the "AI" badge; typing searches the editor's command registry
 * (menus.ts actionItems) and the AI rows. An AI row with a form (Rewrite this…, Translate to…, Replace content, First
 * Draft) shows it in the panel; a run started here shows its progress with Stop, and its error, in place of the list
 * (editor/ai/AiPanel.tsx); Esc or closing the panel stops it (docs/ai.md §2.3). Assets lists this file's components
 * (a pick inserts an instance in the middle of the view). Plugins & widgets (docs/plugins.md §6) lists the plugins by
 * section — Recents, Saved, Development, From ‹org› — and, typed into, their menu commands too (also in All's search);
 * a plugin with parameters prompts for them in the palette (suggestions from figma.parameters.on("input"), Tab / Enter
 * to the next, Enter on the last runs). ↑ ↓ move, Enter runs, Esc (or a press outside, or ⌘K) closes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, IconButton, MenuButton, Portal, Tabs, TOOLS, useDismiss, type IconName, type MenuEntry, type ToolId } from "@/ds";
import type { PluginParameter, PluginRef } from "@shared/plugins/types";
import { pluginsOf, usePlugins, type PluginService } from "../plugins/service";
import { pluginDesktop } from "../plugins/desktop";
import { pluginRows, suggestionsOf, type PluginRow, type Suggestion } from "../plugins/actions";
import type { PluginRun } from "../plugins/host";
import { allTabEmptyNote, takeRequestedTab } from "./actionsTab";
import { useEditor, type EditorController } from "../controller";
import { insertInstance } from "../components";
import { useUI } from "../hooks";
import { actionItems, runMenuItem, type ActionItem } from "../menus";
import { assetLabel, searchAssets } from "../model/components";
import { useComponentAssets } from "./design/ComponentPicker";
import { aiOf } from "../ai/service";
import { AI_ROW_BY_ID, AI_ROWS, imageRowHandler, type AiRowDef } from "../ai/actionRows";
import { AiBadge, AiPanelView, showsAiView, useAiState } from "../ai/AiPanel";
import { openVisualSearch } from "../search";
import styles from "./ActionsPanel.module.css";

/** Live: 529 × 354, 8 above the toolbar */
const WIDTH = 529;
const HEIGHT = 354;
const GAP = 8;
const RECENTS_KEY = "designer.actions.recents";
const RECENTS_MAX = 3;

type Tab = "all" | "assets" | "plugins";
const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "assets", label: "Assets" },
  { value: "plugins", label: "Plugins & widgets" },
];

/** A row: a command (or an asset to insert), under its section's header. */
interface Row {
  key: string;
  label: string;
  section: string;
  shortcut?: string;
  icon?: IconName;
  disabled?: boolean;
  run: () => boolean;
  /** A plugin's row: its ⋯ menu */
  plugin?: PluginRow;
  /** An AI row: the "AI" badge; the panel stays open for its form or progress */
  ai?: boolean;
}

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([id, ...loadRecents().filter((r) => r !== id)].slice(0, RECENTS_MAX)));
  } catch {
    // Private mode: no recents.
  }
}

/** The tool a command picks (its toolbar glyph). */
const toolIcon = (id: string): IconName | undefined => {
  const tool = id.startsWith("tool.") ? (id.slice(5) as ToolId) : null;
  return tool && tool in TOOLS ? TOOLS[tool].icon : undefined;
};

/** How well `label` answers `query`: 0 none, 3 it starts with it, 2 a word does, 1 it holds it. */
function score(label: string, query: string): number {
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  if (l.startsWith(q)) return 3;
  if (l.split(/[\s/(▸-]+/).some((w) => w.startsWith(q))) return 2;
  return l.includes(q) ? 1 : 0;
}

/**
 * The All tab's rows: with an empty query, Recents (live) — none when nothing was run yet —; else the
 * matches, best first, by section.
 */
export function actionRows(items: readonly ActionItem[], query: string, recents: readonly string[], run: (id: string) => boolean): Row[] {
  const row = (a: ActionItem, section = a.section): Row => ({ key: `${section}:${a.id}`, label: a.label, section, shortcut: a.shortcut, icon: AI_ROW_BY_ID.get(a.id)?.icon ?? toolIcon(a.id), disabled: a.disabled, run: () => run(a.id), ...(AI_ROW_BY_ID.has(a.id) ? { ai: true } : {}) });
  const q = query.trim();
  if (!q) {
    const byId = new Map(items.map((a) => [a.id, a]));
    const recent = recents.map((id) => byId.get(id)).filter((a): a is ActionItem => !!a);
    // (live: Recents, then the AI sections — no list of every command)
    return [...recent.map((a) => row(a, "Recents")), ...items.filter((a) => AI_ROW_BY_ID.has(a.id)).map((a) => row(a))];
  }
  const scored = items.map((a) => ({ a, s: score(a.label, q) })).filter((x) => x.s > 0);
  // Sections in the order of their best match; within one, best first (the menu's order breaks ties).
  const best = new Map<string, number>();
  for (const { a, s } of scored) best.set(a.section, Math.max(best.get(a.section) ?? 0, s));
  const order = [...best.keys()].sort((x, y) => best.get(y)! - best.get(x)!);
  return order.flatMap((section) =>
    scored
      .filter((x) => x.a.section === section)
      .sort((x, y) => y.s - x.s)
      .map((x) => row(x.a))
  );
}

export function ActionsPanel() {
  const open = useUI((s) => !!s.actionsOpen);
  return open ? <Actions /> : null;
}

/** Where the palette goes: over the bottom toolbar (its left edge), else centred near the window's bottom. */
function placement(): { left: number; top: number } {
  const bar = document.querySelector('[data-ds="EditorToolbar"]')?.getBoundingClientRect();
  const left = bar && bar.width ? bar.left : (window.innerWidth - WIDTH) / 2;
  const bottom = bar && bar.height ? bar.top - GAP : window.innerHeight - 60 - GAP;
  return { left: Math.round(Math.max(GAP, Math.min(left, window.innerWidth - GAP - WIDTH))), top: Math.round(Math.max(GAP, bottom - HEIGHT)) };
}

function close(ed: EditorController) {
  ed.ui.set({ actionsOpen: false });
  ed.focusCanvas();
}

/** The AI rows as palette items: disabled while AI is off (Settings › AI, an organization), image rows until their tools register. */
function aiItems(ed: EditorController, enabled: boolean): ActionItem[] {
  return AI_ROWS.map((r) => {
    const image = r.section === "Image editing";
    const h = image ? imageRowHandler(r.action) : undefined;
    return { id: r.id, label: r.label, section: r.section, disabled: !enabled || (image && !(h && (h.enabled?.(ed) ?? true))) };
  });
}

function Actions() {
  const ed = useEditor();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>(() => takeRequestedTab() ?? "all");
  const plugins = pluginsOf(ed);
  const pluginsSnap = usePlugins(plugins);
  // A plugin's parameters being asked for (Figma's Quick Actions prompt).
  const [prompt, setPrompt] = useState<ParameterPrompt | null>(null);
  // The row lit by ↑ ↓ or the pointer (its key); unset, typing lights the first match (Enter runs it) and an empty
  // query lights nothing (live).
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const [at] = useState(placement);
  const assets = useComponentAssets();
  const [recents] = useState(loadRecents);
  // The commands as they stand when the palette opens (enabled or not for this selection).
  const ai = aiOf(ed);
  const aiState = useAiState(ai);
  const items = useMemo(() => [...actionItems(ed), ...aiItems(ed, aiState.enabled)], [ed, aiState.enabled]);
  useEffect(() => {
    void ai.refresh();
    return () => ai.panelClosed();
  }, [ai]);
  const aiView = showsAiView(aiState);
  // The toolbar's Actions button toggles it itself.
  const [button] = useState(() => document.querySelector('[data-ds="EditorToolbar"] button[aria-label="Actions"]'));
  useDismiss(root, () => close(ed), { ignore: button, blur: true, resize: true, escape: false });

  const startPlugin = (r: PluginRow): boolean => {
    if (!plugins) return false;
    const defs = r.parameters?.length ? r.parameters : null;
    if (!defs) {
      void plugins.run(r.ref, r.command);
      return true;
    }
    void plugins.run(r.ref, r.command, { awaitParameters: true }).then((run) => {
      if (run) setPrompt({ run, ref: r.ref, defs, index: 0, values: {}, suggestions: [], error: null, loading: null });
    });
    return true;
  };
  const pluginRow = (r: PluginRow, section = r.section): Row => ({ key: `plugin:${r.key}`, label: r.label, section, icon: "24.plugin", disabled: !!r.disabled, run: () => startPlugin(r), plugin: r });

  const rows: Row[] = useMemo(() => {
    if (prompt) return prompt.suggestions.map((sg, i) => ({ key: `suggestion:${i}`, label: sg.name, section: `${prompt.ref.name} › ${prompt.defs[prompt.index].name}`, run: () => true }));
    if (tab === "plugins") return plugins ? pluginRows(plugins, query).map((r) => pluginRow(r)) : [];
    if (tab === "assets")
      return searchAssets(assets, query).map((a) => ({
        key: `asset:${a.id}`,
        label: assetLabel(a.name),
        section: a.pageName,
        icon: (a.kind === "set" ? "16.component.set" : "16.component") as IconName,
        run: () => insertInstance(ed, a.target) !== null,
      }));
    const commands = actionRows(items, query, recents, (id) => {
      const def = AI_ROW_BY_ID.get(id);
      const ran = def ? runAi(def) : runMenuItem(ed, id);
      if (ran) remember(id);
      return ran;
    });
    // All's search finds plugins and their commands too.
    const found = query.trim() && plugins ? pluginRows(plugins, query).map((r) => pluginRow(r, "Plugins")) : [];
    return [...commands, ...found];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pluginRow / startPlugin read the latest service and prompt
  }, [tab, assets, query, items, recents, ed, prompt, plugins, pluginsSnap]);

  /** An AI row: its form, or its run in the panel (closed when it succeeds); an image tool's row runs it. */
  const runAi = (def: AiRowDef): boolean => {
    if (def.section === "Image editing") {
      const h = imageRowHandler(def.action);
      if (!h) return false;
      close(ed);
      h.run(ed);
      return true;
    }
    if (def.form) {
      ai.openForm(def.form);
      return true;
    }
    const done = (r: number | null) => {
      if (r !== null && !ai.get().error) close(ed);
    };
    if (def.action === "rename-layers") void ai.renameLayers({ fromPanel: true }).then(done);
    else if (def.action === "shorten") void ai.editTexts({ kind: "shorten" }, { fromPanel: true }).then(done);
    else if (def.action === "add-interactions") void ai.addInteractions({ fromPanel: true }).then(done);
    return true;
  };

  /** The parameters prompt: the person typed `q` for the current parameter. */
  const askSuggestions = (p: ParameterPrompt, q: string) => {
    const def = p.defs[p.index];
    void p.run.parameterInput(def.key, q, p.values).then((a) => {
      setPrompt((cur) => (cur && cur.run === p.run && cur.index === p.index ? { ...cur, suggestions: suggestionsOf(a.suggestions), error: a.error ?? null, loading: a.loading ?? null } : cur));
    });
  };
  useEffect(() => {
    if (prompt && !prompt.suggestions.length && !prompt.error) askSuggestions(prompt, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per parameter
  }, [prompt?.run, prompt?.index]);
  /** Enter / Tab in the prompt: the picked suggestion (or the typed text, freeform) for this parameter; the last runs. */
  const acceptParameter = (picked: Suggestion | null) => {
    if (!prompt || prompt.error) return;
    const def = prompt.defs[prompt.index];
    const value = picked ? picked.data : def.allowFreeform || !prompt.suggestions.length ? query : undefined;
    if (value === undefined || (value === "" && !def.optional)) return;
    const values = { ...prompt.values, [def.key]: value };
    setQuery("");
    setActiveKey(undefined);
    if (prompt.index + 1 < prompt.defs.length) return setPrompt({ ...prompt, index: prompt.index + 1, values, suggestions: [], error: null, loading: null });
    setPrompt(null);
    close(ed);
    void prompt.run.submitParameters(values);
  };

  const active = activeKey === undefined ? (query.trim() ? rows.findIndex((r) => !r.disabled) : -1) : rows.findIndex((r) => r.key === activeKey);
  const setActive = (i: number) => setActiveKey(rows[i]?.key);
  useLayoutEffect(() => input.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const el = active >= 0 ? list.current?.querySelector<HTMLElement>(`[data-row="${active}"]`) : null;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (i: number) => {
    if (prompt) return acceptParameter(prompt.suggestions[i] ?? null);
    const r = rows[i];
    if (!r || r.disabled) return;
    const asks = !!r.plugin?.parameters?.length || !!r.ai;
    if (!asks) close(ed);
    else {
      setQuery("");
      setActiveKey(undefined);
    }
    r.run();
  };
  const step = (dir: 1 | -1) => {
    if (!rows.length) return;
    let i = active;
    for (let n = 0; n < rows.length; n++) {
      i = (i + dir + rows.length) % rows.length;
      if (!rows[i].disabled) return setActive(i);
    }
  };

  const allEmpty = allTabEmptyNote(query, rows.length, prompt !== null);
  return (
    <Portal>
      <div
        ref={root}
        role="dialog"
        aria-label="Actions"
        data-actions-panel=""
        className={styles.panel}
        style={{ left: at.left, top: at.top, width: WIDTH, height: HEIGHT }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (aiView) {
            // Esc stops the run, else leaves the form; the form's own keys stay its own.
            if (e.key === "Escape") {
              e.preventDefault();
              if (aiState.run) ai.stop();
              else ai.openForm(null);
            } else if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              close(ed);
            }
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            if (prompt) {
              prompt.run.stop();
              setPrompt(null);
              setQuery("");
            } else if (query) setQuery("");
            else close(ed);
          } else if (e.key === "Tab" && prompt) {
            e.preventDefault();
            pick(active);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            step(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(active);
          } else if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            close(ed);
          }
        }}
      >
        {aiView ? (
          <AiPanelView ai={ai} onDone={() => close(ed)} />
        ) : (
        <>
        <div className={styles.search}>
          <span className={styles.searchIcon}>
            <Icon name="24.search.small" />
          </span>
          <input
            ref={input}
            type="text"
            aria-label="Search"
            placeholder={prompt ? (prompt.defs[prompt.index].description ?? prompt.defs[prompt.index].name) : "Search actions"}
            spellCheck={false}
            autoComplete="off"
            value={query}
            className={styles.input}
            role="combobox"
            aria-expanded="true"
            aria-controls="actions-results"
            aria-activedescendant={active >= 0 ? `actions-row-${active}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveKey(undefined);
              if (prompt) askSuggestions(prompt, e.target.value);
            }}
          />
          {/* Live: "Visual search (AI beta)" at 491, 12 — opens visual search (docs/ai.md §6) */}
          <IconButton
            icon="24.image"
            label="Visual search (AI beta)"
            className={styles.visualSearch}
            disabled={!aiState.enabled}
            onClick={() => {
              close(ed);
              openVisualSearch({ selection: ed.selection.length > 0 });
            }}
          />
        </div>
        {/* Live: both lines are there for assistive tech — "Results will update as you type." at -1, 3 and "11 results available." at -1, 27 */}
        <div role="status" className={styles.srOnly}>
          Results will update as you type.
        </div>
        <div role="status" className={styles.srOnly} style={{ top: 24 }}>
          {`${rows.length} results available.`}
        </div>
        <Tabs label="Action kinds" className={styles.tabs} value={tab} tabs={TABS} onChange={(v) => {
            setTab(v as Tab);
            setActiveKey(undefined);
          }} />
        <div ref={list} id="actions-results" role="listbox" aria-label="Results" className={styles.list}>
          {prompt && (prompt.error || prompt.loading || !rows.length) && (
            <div role="presentation" className={styles.header}>
              {`${prompt.ref.name} › ${prompt.defs[prompt.index].name}`}
              {prompt.error ? ` — ${prompt.error}` : prompt.loading ? ` — ${prompt.loading}` : ""}
            </div>
          )}
          {!prompt && tab === "plugins" && !rows.length && <p className={styles.empty}>{query ? "No plugins match" : plugins ? "No plugins yet. Import one from its manifest below" : "Plugins aren’t available here"}</p>}
          {tab === "assets" && !rows.length && <p className={styles.empty}>{query ? "No components match" : "No components in this file"}</p>}
          {tab === "all" && allEmpty.kind === "no-results" && <p className={styles.empty}>No results for “{allEmpty.query}”</p>}
          {tab === "all" && allEmpty.kind === "recents" && (
            <div role="presentation" className={styles.header}>
              Recents
            </div>
          )}
          {rows.map((r, i) => (
            <div key={r.key} style={{ display: "contents" }}>
              {(i === 0 || rows[i - 1].section !== r.section) && (
                <div role="presentation" className={styles.header}>
                  {r.section}
                </div>
              )}
              <div
                id={`actions-row-${i}`}
                role="option"
                data-row={i}
                aria-selected={i === active}
                aria-disabled={r.disabled || undefined}
                data-active={i === active || undefined}
                className={styles.row}
                onPointerMove={() => !r.disabled && active !== i && setActive(i)}
                onClick={() => pick(i)}
              >
                <span className={styles.glyph}>{r.icon && <Icon name={r.icon} />}</span>
                <span className={styles.label}>{r.label}</span>
                {r.ai && <AiBadge />}
                {r.shortcut && <span className={styles.shortcut}>{r.shortcut}</span>}
                {r.plugin && plugins && (
                  <span className={styles.more} onClick={(e) => e.stopPropagation()}>
                    <MenuButton label="More" entries={() => pluginRowMenu(plugins, r.plugin!.ref)} onSelect={(id) => pluginRowAction(plugins, r.plugin!.ref, id)}>
                      <Icon name="24.more" />
                    </MenuButton>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        {/* A development plugin from its manifest.json (Plugins › Development › Import new plugin from manifest…), at the tab's foot */}
        {!prompt && tab === "plugins" && plugins && pluginDesktop() && (
          <button type="button" className={styles.footer} onClick={() => void plugins.importManifest()}>
            <span className={styles.glyph}>
              <Icon name="24.plus" />
            </span>
            <span className={styles.label}>Import new plugin from manifest…</span>
          </button>
        )}
        </>
        )}
      </div>
    </Portal>
  );
}

/** The parameters prompt's state: the run waiting for figma.on("run"), the parameter being asked, what was given. */
interface ParameterPrompt {
  run: PluginRun;
  ref: PluginRef;
  defs: PluginParameter[];
  index: number;
  values: Record<string, unknown>;
  suggestions: Suggestion[];
  error: string | null;
  loading: string | null;
}

/** A plugin row's ⋯: Save / Remove from saved; development plugins: Open console, Remove. */
function pluginRowMenu(s: PluginService, ref: PluginRef): MenuEntry[] {
  const out: MenuEntry[] = [{ id: "save", label: s.isSaved(ref) ? "Remove from saved" : "Save" }];
  if (ref.source.type === "development") out.push("-", { id: "console", label: "Open console" }, { id: "remove", label: "Remove" });
  return out;
}

function pluginRowAction(s: PluginService, ref: PluginRef, id: string): void {
  if (id === "save") void s.setSaved(ref, !s.isSaved(ref));
  else if (id === "console") s.openConsole();
  else if (id === "remove") void s.removeDevelopment(ref.id);
}
