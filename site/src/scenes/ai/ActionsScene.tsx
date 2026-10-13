// AI actions (docs/ai.md §1, §3): the Actions palette (⌘K) over a small file — its All tab with the AI sections and
// badges from the app's own row list (editor/ai/actionRows.ts) and the app's look (ActionsPanel.module.css,
// AiPanel.module.css) — and the file's Layers panel (the ds LayerRow). A row runs on the canvas: Rename layers names
// the layers by Figma's rules, Shorten / Rewrite this… / Translate to… change the selected texts, Replace content
// fills the placeholders, Add interactions connects the two frames (the banner's Preview / Keep it), First Draft
// lays out a screen in a kit theme. Each run is one undo step. The canvas is DOM (one live engine per page).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { Badge } from "@/ds/components/Misc";
import { LayerRow } from "@/ds/components/LayerRow";
import { Select } from "@/ds/components/Select";
import { Spinner } from "@/ds/components/Spinner";
import { Tabs } from "@/ds/components/Tabs";
import { TextArea, TextInput } from "@/ds/components/TextInput";
import { Icon, type IconName } from "@/ds/icons/Icon";
import { AI_ROWS, type AiRowDef } from "@/editor/ai/actionRows";
import actionsCss from "@/editor/panels/ActionsPanel.module.css";
import aiCss from "@/editor/ai/AiPanel.module.css";
import { FIRST_DRAFT_SUGGESTIONS } from "@shared/ai/prompts";
import { DESIGN_THEMES } from "@shared/ai/kits/themes";
import type { KitTheme } from "@shared/ai/kits/types";
import { Panel, SceneBody, SceneCanvas, SceneWindow, Selection, boxIn, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { AiBadge, RunPill, World, shared, useFit, useJobs, useUndoKey } from "./shared";
import { CONTENT_SETS, FIRST_TEXTS, LANGUAGES, NODE, PARENT, REWRITES, SHORTER, TREE, inLanguage, renameCandidates, textsIn, type Language, type SceneNode } from "./actionsData";
import styles from "./actions.module.css";

// ---- the document ------------------------------------------------------------------------------------------------

interface Doc {
  names: Record<string, string>;
  texts: Record<string, string>;
  lang: Record<string, Language>;
  interactions: boolean;
  draft: { theme: string } | null;
  rewrites: number;
}

const FIRST: Doc = { names: {}, texts: FIRST_TEXTS, lang: {}, interactions: false, draft: null, rewrites: 0 };

const textOf = (doc: Doc, id: string) => inLanguage(doc.texts[id] ?? "", doc.lang[id] ?? "English");
/** The Layers panel's name: a rename, the default name, or a text's own text */
const nameOf = (doc: Doc, n: SceneNode) => doc.names[n.id] ?? n.name ?? textOf(doc, n.id).slice(0, 40);

// ---- the palette's rows ------------------------------------------------------------------------------------------

/** The rows' glyphs, as the app lists them (written out so the site's icon subset keeps them) */
const ROW_ICON: Record<string, IconName> = {
  "ai.make-image": "24.image",
  "ai.remove-background": "24.erase",
  "ai.boost-resolution": "24.expand",
  "ai.edit-image": "24.pencil",
  "ai.find-more-like": "24.search",
  "ai.rename-layers": "24.text",
  "ai.replace-content": "24.styles",
  "ai.add-interactions": "24.prototyping",
  "ai.first-draft": "24.frame",
  "ai.shorten": "24.text",
  "ai.rewrite": "24.pencil",
  "ai.translate": "24.globe",
};

/** Image rows belong to the image tools and visual search, further down the page */
const ROW_TARGET: Record<string, string> = {
  "ai.make-image": "#image-tools",
  "ai.remove-background": "#image-tools",
  "ai.boost-resolution": "#image-tools",
  "ai.edit-image": "#image-tools",
  "ai.find-more-like": "#visual-search",
};

const RUNNING: Record<string, string> = {
  "rename-layers": "Renaming layers…",
  rewrite: "Rewriting…",
  shorten: "Shortening…",
  translate: "Translating…",
  "replace-content": "Replacing content…",
  "add-interactions": "Adding interactions…",
  "first-draft": "Making your design…",
};

type View = null | { form: "rewrite" | "replace-content" | "translate" | "first-draft" | "draft" } | { run: string; title: string };
type Pill = null | { kind: "done"; text: string } | { kind: "interactions" } | { kind: "note"; text: string };

const SECTIONS = ["Image editing", "Design tools", "Riffing and writing"] as const;

// ---- the world ---------------------------------------------------------------------------------------------------

const FW = 260;
const FH = 384;
const GAP = 44;
const TOP = 26;

export default function ActionsScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [doc, setDoc] = useState<Doc>(FIRST);
  const [past, setPast] = useState<{ doc: Doc; label: string }[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<View>(null);
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const [pill, setPill] = useState<Pill>(null);
  const [fresh, setFresh] = useState<{ ids: string[]; n: number; names?: boolean }>({ ids: [], n: 0 });
  const [preview, setPreview] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<{ sel: Box[]; hover: Box | null }>({ sel: [], hover: null });
  const jobs = useJobs();

  const worldW = doc.draft ? FW * 3 + GAP * 2 : FW * 2 + GAP;
  const worldH = FH + TOP + 8;
  const scale = useFit(areaRef, worldW, worldH, { pad: 28, max: 1.15 });

  // ---- history: every run is one step ----
  const docRef = useRef(doc);
  docRef.current = doc;
  const pastRef = useRef(past);
  pastRef.current = past;
  const commit = useCallback((label: string, next: (d: Doc) => Doc, changed: string[]) => {
    const d = docRef.current;
    const n = next(d);
    docRef.current = n;
    pastRef.current = [...pastRef.current.slice(-19), { doc: d, label }];
    setPast(pastRef.current);
    setDoc(n);
    setFresh((f) => ({ ids: changed, n: f.n + 1, names: label === "Rename layers" }));
  }, []);
  const undo = useCallback(() => {
    jobs.cancel();
    const last = pastRef.current[pastRef.current.length - 1];
    setView((v) => (v && "run" in v ? null : v));
    setPreview(null);
    if (!last) return;
    pastRef.current = pastRef.current.slice(0, -1);
    docRef.current = last.doc;
    setPast(pastRef.current);
    setDoc(last.doc);
    setPill({ kind: "note", text: `Undo ${last.label}` });
    setFresh((f) => ({ ids: [], n: f.n + 1 }));
  }, [jobs]);
  useUndoKey(rootRef, undo);

  useEffect(() => {
    if (pill?.kind !== "note") return;
    const t = setTimeout(() => setPill(null), 1800);
    return () => clearTimeout(t);
  }, [pill]);

  // ---- the selection's boxes (the engine's overlay, drawn over the scaled world) ----
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => {
      const at = (id: string) => boxIn(area.querySelector(`[data-node="${id}"]`), area);
      setBoxes({ sel: selection.map(at).filter((b): b is Box => !!b), hover: hover && !selection.includes(hover) ? at(hover) : null });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(area);
    return () => ro.disconnect();
  }, [selection, hover, doc, scale]);

  // ---- running a row ----
  const remember = (id: string) => setRecents((r) => [id, ...r.filter((x) => x !== id)].slice(0, 3));

  const run = (row: AiRowDef, label: string, apply: () => void, ms = 1900) => {
    setPill(null);
    setView({ run: RUNNING[row.action] ?? `${row.label}…`, title: row.label });
    remember(row.id);
    void jobs.start(async (wait) => {
      await wait(ms);
      apply();
      setView(row.action === "first-draft" ? { form: "draft" } : null);
      if (label) setPill(row.action === "add-interactions" ? { kind: "interactions" } : { kind: "done", text: label });
    });
  };

  /** The texts a writing action takes: the selection's, else the description (selected for it) */
  const textTargets = (prefer: string): string[] => {
    const t = textsIn(selection);
    if (t.length) return t;
    setSelection([prefer]);
    return textsIn([prefer]);
  };

  const doRow = (row: AiRowDef) => {
    const target = ROW_TARGET[row.id];
    if (target) {
      document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    switch (row.action) {
      case "rename-layers": {
        const nodes = renameCandidates(selection).filter((n) => doc.names[n.id] !== n.rename);
        if (!nodes.length) {
          remember(row.id);
          setPill({ kind: "note", text: "No layers need renaming" });
          return;
        }
        run(row, `Renamed ${nodes.length} ${nodes.length === 1 ? "layer" : "layers"}`, () =>
          commit("Rename layers", (d) => ({ ...d, names: { ...d.names, ...Object.fromEntries(nodes.map((n) => [n.id, n.rename!])) } }), nodes.map((n) => n.id)),
        );
        return;
      }
      case "shorten": {
        const ids = textTargets("t-body");
        const changed = ids.filter((id) => SHORTER[doc.texts[id]]);
        run(row, changed.length ? `Shortened ${changed.length} ${changed.length === 1 ? "text" : "texts"}` : "Already short", () =>
          commit("Shorten", (d) => ({ ...d, texts: { ...d.texts, ...Object.fromEntries(changed.map((id) => [id, SHORTER[d.texts[id]] ?? d.texts[id]])) } }), changed),
        );
        return;
      }
      case "add-interactions": {
        setSelection(["f12", "f14"]);
        if (doc.interactions) {
          setPill({ kind: "note", text: "These frames are already connected" });
          return;
        }
        run(row, "interactions", () => commit("Add interactions", (d) => ({ ...d, interactions: true }), []), 2300);
        return;
      }
      default:
        setView({ form: row.action as "rewrite" | "replace-content" | "translate" | "first-draft" });
    }
  };

  const rewrite = (prompt: string) => {
    const row = AI_ROWS.find((r) => r.action === "rewrite")!;
    const ids = textTargets("t-body").filter((id) => REWRITES[id]);
    void prompt;
    run(row, `Rewrote ${ids.length} ${ids.length === 1 ? "text" : "texts"}`, () =>
      commit("Rewrite this...", (d) => ({ ...d, rewrites: d.rewrites + 1, texts: { ...d.texts, ...Object.fromEntries(ids.map((id) => [id, REWRITES[id][d.rewrites % REWRITES[id].length]])) } }), ids),
    );
  };

  const translate = (lang: Language) => {
    const row = AI_ROWS.find((r) => r.action === "translate")!;
    const ids = textTargets("t-body");
    run(row, `Translated ${ids.length} ${ids.length === 1 ? "text" : "texts"} to ${lang}`, () => commit("Translate to...", (d) => ({ ...d, lang: { ...d.lang, ...Object.fromEntries(ids.map((id) => [id, lang])) } }), ids), 2100);
  };

  const replaceContent = (prompt: string) => {
    const row = AI_ROWS.find((r) => r.action === "replace-content")!;
    const set = CONTENT_SETS.find((s) => s.match?.test(prompt)) ?? CONTENT_SETS[0];
    let ids = textsIn(selection).filter((id) => /^(t-team|m\d)/.test(id));
    if (!ids.length) {
      setSelection(["f14"]);
      ids = textsIn(["f14"]);
    }
    const values: Record<string, string> = { "t-team": set.header };
    set.people.forEach(([name, role], i) => {
      values[`m${i + 1}-name`] = name;
      values[`m${i + 1}-role`] = role;
    });
    const changed = ids.filter((id) => values[id]);
    run(row, `Replaced ${changed.length} ${changed.length === 1 ? "text" : "texts"}`, () => commit("Replace content", (d) => ({ ...d, texts: { ...d.texts, ...Object.fromEntries(changed.map((id) => [id, values[id]])) }, lang: Object.fromEntries(Object.entries(d.lang).filter(([k]) => !changed.includes(k))) }), changed), 2300);
  };

  const firstDraft = () => {
    const row = AI_ROWS.find((r) => r.action === "first-draft")!;
    run(row, "", () => commit("First Draft", (d) => ({ ...d, draft: { theme: DESIGN_THEMES[0].id } }), ["draft"]), 2600);
    setSelection(["draft"]);
  };

  // ---- the list ----
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = AI_ROWS.filter((r) => !q || r.label.toLowerCase().includes(q));
    if (q) return list.map((r) => ({ row: r, section: "" }));
    const out: { row: AiRowDef; section: string }[] = [];
    for (const id of recents) {
      const r = AI_ROWS.find((x) => x.id === id);
      if (r) out.push({ row: r, section: "Recents" });
    }
    for (const s of SECTIONS) for (const r of list.filter((x) => x.section === s)) out.push({ row: r, section: s });
    return out;
  }, [query, recents]);
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % Math.max(1, rows.length));
    } else if (e.key === "Enter" && rows[activeIndex]) {
      e.preventDefault();
      doRow(rows[activeIndex].row);
    }
  };

  // ---- the canvas ----
  const select = (id: string, add: boolean) => {
    setSelection((s) => (add ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
  };
  const nodeProps = (id: string) => ({
    "data-node": id,
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      select(id, e.shiftKey);
    },
    onPointerEnter: () => setHover(id),
    onPointerLeave: () => setHover((h) => (h === id ? null : h)),
  });
  const inkFresh = (id: string) => !fresh.names && fresh.ids.includes(id);
  const textKey = (id: string) => `${id}:${inkFresh(id) ? fresh.n : 0}`;
  const textClass = (id: string) => (inkFresh(id) ? shared.aiInk : undefined);
  const txt = (id: string, className?: string) => (
    <span key={textKey(id)} className={`${className ?? ""} ${textClass(id) ?? ""}`} {...nodeProps(id)}>
      {textOf(doc, id)}
    </span>
  );

  const theme = DESIGN_THEMES.find((t) => t.id === doc.draft?.theme) ?? DESIGN_THEMES[0];

  const reset = () => {
    jobs.cancel();
    setDoc(FIRST);
    setPast([]);
    setSelection([]);
    setView(null);
    setQuery("");
    setTab("all");
    setRecents([]);
    setPill(null);
    setPreview(null);
  };

  const api = { doRow, translate, replaceContent, rewrite, setSelection, setPill, setView };
  const apiRef = useRef(api);
  apiRef.current = api;
  const { cursor } = useDemo(rootRef, (r) => demo(r, apiRef), { onStart: reset });

  // ---- layers ----
  const layerRows: { n: SceneNode; depth: number }[] = [];
  const walk = (n: SceneNode, depth: number) => {
    layerRows.push({ n, depth });
    n.children?.forEach((c) => walk(c, depth + 1));
  };
  TREE.forEach((n) => walk(n, 0));
  const draftNode: SceneNode = { id: "draft", kind: "FRAME", name: "Sign up" };
  const isSelected = (id: string) => selection.includes(id);
  const ancestorSelected = (id: string) => {
    for (let p = PARENT.get(id); p; p = PARENT.get(p)) if (selection.includes(p)) return true;
    return false;
  };
  const LAYER_ICON: Record<string, IconName> = { FRAME: "16.frame", TEXT: "16.text", IMAGE: "16.image", RECTANGLE: "16.rectangle", ELLIPSE: "16.ellipse", VECTOR: "16.vector" };

  const label = (id: string, x: number) => (
    <span className={styles.frameLabel} data-selected={isSelected(id) || undefined} style={{ left: x, top: TOP - 4, transform: `translateY(-100%) scale(${1 / scale})` }}>
      <span key={`${id}:${fresh.names && fresh.ids.includes(id) ? fresh.n : 0}`} className={fresh.names && fresh.ids.includes(id) ? shared.aiText : undefined}>
        {id === "draft" ? "Sign up" : nameOf(doc, NODE.get(id)!)}
      </span>
    </span>
  );

  const viewTitle = view && "run" in view ? view.title : view?.form === "draft" ? "First Draft" : view ? AI_ROWS.find((r) => r.action === view.form)?.label ?? "" : "";

  return (
    <SceneWindow ref={rootRef} title="Tempo — Onboarding" tabIndex={-1}>
      <SceneBody stack={false}>
        <Panel side="left" title="Layers" style={{ width: 232 }}>
          <div role="tree" aria-label="Layers" className={styles.layers}>
            {layerRows.map(({ n, depth }) => (
              <LayerRow
                key={fresh.names && fresh.ids.includes(n.id) ? `${n.id}:${fresh.n}` : n.id}
                id={n.id}
                depth={depth}
                name={nameOf(doc, n)}
                icon={LAYER_ICON[n.kind]}
                expanded={n.children ? true : undefined}
                selected={isSelected(n.id)}
                selectedAncestor={ancestorSelected(n.id)}
                hovered={hover === n.id}
                strong={depth === 0}
                className={fresh.names && fresh.ids.includes(n.id) ? shared.aiTextHost : undefined}
                onPointerDown={(e) => select(n.id, e.shiftKey)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(null)}
              />
            ))}
            {doc.draft && <LayerRow id="draft" depth={0} name={draftNode.name!} icon="16.frame" expanded={false} strong selected={isSelected("draft")} onPointerDown={() => select("draft", false)} />}
          </div>
        </Panel>
        <SceneCanvas className={styles.canvas} onPointerDown={() => setSelection([])}>
          <div className={styles.layout}>
            <div ref={areaRef} className={styles.area}>
              <World w={worldW} h={worldH} scale={scale}>
                {label("f12", 0)}
                {label("f14", FW + GAP)}
                {doc.draft && label("draft", (FW + GAP) * 2)}
                {/* Frame 12: the welcome screen */}
                <div className={styles.frame} style={{ left: 0, top: TOP }} {...nodeProps("f12")}>
                  <div className={styles.hero} {...nodeProps("r4")}>
                    <HeroArt />
                  </div>
                  {txt("t-title", styles.title)}
                  {txt("t-body", styles.body)}
                  <div className={styles.button} {...nodeProps("f13")}>
                    {txt("t-cta")}
                  </div>
                </div>
                {/* Frame 14: the team list, placeholders until Replace content */}
                <div className={styles.frame} style={{ left: FW + GAP, top: TOP }} {...nodeProps("f14")}>
                  <div className={styles.back} {...nodeProps("f18")}>
                    <svg width="14" height="14" viewBox="0 0 14 14" {...nodeProps("v1")}>
                      <path d="M8.5 2.5 4 7l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  {txt("t-team", styles.title)}
                  {[1, 2, 3].map((n) => (
                    <div key={n} className={styles.member} {...nodeProps(`f${14 + n}`)}>
                      <span className={styles.avatar} data-filled={doc.texts[`m${n}-name`] !== "Name" || undefined} style={{ ["--hue" as string]: [200, 28, 150][n - 1] }} {...nodeProps(`e${n}`)} />
                      <span className={styles.memberText}>
                        {txt(`m${n}-name`, styles.memberName)}
                        {txt(`m${n}-role`, styles.memberRole)}
                      </span>
                    </div>
                  ))}
                </div>
                {doc.draft && (
                  <div key={`draft-${fresh.n}`} className={`${styles.frame} ${styles.draftIn}`} style={{ left: (FW + GAP) * 2, top: TOP, padding: 0 }} {...nodeProps("draft")}>
                    <Draft theme={theme} />
                  </div>
                )}
                {doc.interactions && <Noodles />}
              </World>
              {boxes.sel.map((b, i) => (
                <Selection key={i} box={b} instant handles={boxes.sel.length === 1} label={boxes.sel.length === 1 ? sizeLabel(selection[0]) : undefined} />
              ))}
              {boxes.hover && <div className={styles.hover} style={{ left: boxes.hover.x, top: boxes.hover.y, width: boxes.hover.w, height: boxes.hover.h }} />}
              {preview && <Preview at={preview} doc={doc} onGo={setPreview} onClose={() => setPreview(null)} />}
              {pill?.kind === "interactions" ? (
                <RunPill>
                  <span className={shared.pillText}>Added 2 interactions</span>
                  <Button variant="secondary" onClick={() => setPreview("f12")}>
                    Preview
                  </Button>
                  <Button variant="primary" onClick={() => setPill(null)} data-keep="">
                    Keep it
                  </Button>
                  <IconButton
                    icon="24.close.small"
                    label="Undo"
                    tone="secondary"
                    onClick={() => {
                      undo();
                      setPill(null);
                    }}
                  />
                </RunPill>
              ) : pill?.kind === "done" ? (
                <RunPill done={pill.text} onUndo={undo} />
              ) : pill?.kind === "note" ? (
                <RunPill done={pill.text} />
              ) : null}
            </div>
            <div className={styles.paletteSlot}>
              <div className={`${actionsCss.panel} ${styles.palette}`} role="dialog" aria-label="Actions" data-palette="" onPointerDown={(e) => e.stopPropagation()}>
                {view ? (
                  <div className={aiCss.view} data-ai-view={"run" in view ? "run" : view.form}>
                    <div className={aiCss.header}>
                      <IconButton icon="24.arrow.left" label="Back" tone="secondary" disabled={"run" in view} onClick={() => setView(null)} />
                      <span className={aiCss.title}>{viewTitle}</span>
                      <Badge>AI</Badge>
                    </div>
                    <div className={aiCss.body}>
                      {"run" in view ? (
                        <div className={aiCss.running} role="status">
                          <Spinner size={24} label={view.run} />
                          <span>{view.run}</span>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              jobs.cancel();
                              setView(null);
                            }}
                          >
                            Stop
                          </Button>
                        </div>
                      ) : view.form === "rewrite" ? (
                        <PromptForm placeholder="Describe how to rewrite it" button="Rewrite" required initial="Make it friendlier" onSubmit={rewrite} />
                      ) : view.form === "replace-content" ? (
                        <PromptForm placeholder="Describe the content (optional)" button="Replace content" onSubmit={replaceContent} />
                      ) : view.form === "translate" ? (
                        <Languages onPick={translate} />
                      ) : view.form === "first-draft" ? (
                        <FirstDraftForm onMake={firstDraft} />
                      ) : (
                        <DraftThemes
                          theme={theme.id}
                          onTheme={(id) => commit("Theme", (d) => ({ ...d, draft: { theme: id } }), [])}
                          onDone={() => {
                            setView(null);
                            setPill({ kind: "done", text: "First Draft made “Sign up”" });
                          }}
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={actionsCss.search}>
                      <span className={actionsCss.searchIcon}>
                        <Icon name="24.search.small" />
                      </span>
                      <input
                        ref={inputRef}
                        type="text"
                        aria-label="Search"
                        placeholder="Search actions"
                        spellCheck={false}
                        autoComplete="off"
                        value={query}
                        className={actionsCss.input}
                        onChange={(e) => {
                          setQuery(e.target.value);
                          setActive(0);
                        }}
                        onKeyDown={onInputKey}
                      />
                      <IconButton icon="24.image" label="Visual search (AI beta)" className={actionsCss.visualSearch} onClick={() => document.querySelector("#visual-search")?.scrollIntoView({ behavior: "smooth", block: "start" })} />
                    </div>
                    <Tabs
                      label="Action kinds"
                      className={actionsCss.tabs}
                      value={tab}
                      tabs={[
                        { value: "all", label: "All" },
                        { value: "assets", label: "Assets" },
                        { value: "plugins", label: "Plugins & widgets" },
                      ]}
                      onChange={setTab}
                    />
                    <div role="listbox" aria-label="Results" className={actionsCss.list} data-actions-list="">
                      {tab === "assets" ? (
                        <p className={actionsCss.empty}>No components in this file</p>
                      ) : tab === "plugins" ? (
                        <p className={actionsCss.empty}>No plugins yet. Import one from its manifest below</p>
                      ) : !rows.length ? (
                        <p className={actionsCss.empty}>No results for “{query.trim()}”</p>
                      ) : (
                        rows.map(({ row, section }, i) => (
                          <div key={`${section}:${row.id}`}>
                            {section && section !== rows[i - 1]?.section && (
                              <div role="presentation" className={actionsCss.header}>
                                {section}
                              </div>
                            )}
                            <div
                              role="option"
                              aria-selected={i === activeIndex}
                              className={actionsCss.row}
                              data-active={i === activeIndex || undefined}
                              data-row={row.id}
                              onPointerEnter={() => setActive(i)}
                              onClick={() => doRow(row)}
                            >
                              <span className={actionsCss.glyph}>
                                <Icon name={ROW_ICON[row.id] ?? "24.actions"} />
                              </span>
                              <span className={actionsCss.label}>{row.label}</span>
                              <AiBadge />
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
      </SceneBody>
    </SceneWindow>
  );

  function sizeLabel(id: string | undefined): string | undefined {
    if (!id) return undefined;
    if (id === "f12" || id === "f14" || id === "draft") return `${FW} × ${FH}`;
    return undefined;
  }
}

function PromptForm({ placeholder, button, required, initial = "", onSubmit }: { placeholder: string; button: string; required?: boolean; initial?: string; onSubmit: (prompt: string) => void }) {
  const [text, setText] = useState(initial);
  const submit = () => (!required || text.trim()) && onSubmit(text.trim());
  return (
    <div className={aiCss.form} data-prompt-form="">
      <TextArea label={placeholder} placeholder={placeholder} value={text} onChange={setText} onExit={(r) => r === "enter" && submit()} minRows={3} maxRows={5} />
      <div className={aiCss.actions}>
        <Button variant="primary" disabled={required && !text.trim()} onClick={submit} data-submit="">
          {button}
        </Button>
      </div>
    </div>
  );
}

function Languages({ onPick }: { onPick: (l: Language) => void }) {
  const [q, setQ] = useState("");
  const list = LANGUAGES.filter((l) => l.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className={aiCss.form}>
      <TextInput label="Search languages" placeholder="Search languages" value={q} onChange={setQ} prefix="24.search.small" />
      <div role="listbox" aria-label="Languages" className={aiCss.list}>
        {list.map((l) => (
          <div key={l} role="option" aria-selected={false} tabIndex={0} className={aiCss.option} data-language={l} onClick={() => onPick(l)} onKeyDown={(e) => e.key === "Enter" && onPick(l)}>
            {l}
          </div>
        ))}
        {!list.length && <p className={aiCss.note}>No languages match</p>}
      </div>
    </div>
  );
}

function FirstDraftForm({ onMake }: { onMake: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [library, setLibrary] = useState("auto");
  return (
    <div className={aiCss.form}>
      <TextArea label="Describe what you want to make" placeholder="Describe what you want to make" value={prompt} onChange={setPrompt} minRows={2} maxRows={4} />
      <div className={aiCss.chips}>
        {FIRST_DRAFT_SUGGESTIONS.slice(0, 2).map((s) => (
          <button key={s} type="button" className={aiCss.chip} onClick={() => setPrompt(s)}>
            {s}
          </button>
        ))}
      </div>
      <div className={aiCss.actions}>
        <Select
          label="Library"
          prefix="24.library"
          value={library}
          options={[
            { value: "auto", label: "Auto" },
            { value: "app-wireframe", label: "App wireframe" },
            { value: "web-wireframe", label: "Website wireframe" },
            { value: "app-design", label: "App design" },
            { value: "web-design", label: "Website design" },
          ]}
          onChange={setLibrary}
          width={180}
        />
        <Button variant="primary" disabled={!prompt.trim()} onClick={onMake}>
          Make it
        </Button>
      </div>
    </div>
  );
}

function DraftThemes({ theme, onTheme, onDone }: { theme: string; onTheme: (id: string) => void; onDone: () => void }) {
  return (
    <div className={aiCss.form}>
      <div className={aiCss.label}>Theme</div>
      <div className={aiCss.themes} role="radiogroup" aria-label="Theme">
        {DESIGN_THEMES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={t.id === theme} aria-label={t.name} className={`${aiCss.theme} ${t.id === theme ? aiCss.themeOn : ""}`} onClick={() => onTheme(t.id)}>
            <span className={aiCss.themeSwatches} style={{ background: t.light.background }}>
              <span style={{ background: t.light.primary }} />
              <span style={{ background: t.light.text }} />
              <span style={{ background: t.light.surface }} />
            </span>
            <span>{t.name}</span>
          </button>
        ))}
      </div>
      <div className={aiCss.actions}>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** First Draft's frame: an app sign-up screen from the kit's blocks, in the picked theme's light palette. */
function Draft({ theme }: { theme: KitTheme }) {
  const p = theme.light;
  const r = theme.radius;
  const font = (f: { family: string }) => `"${f.family}", "Inter Variable", Inter, sans-serif`;
  const s: CSSProperties = { background: p.background, color: p.text, fontFamily: font(theme.fonts.body) };
  return (
    <div className={styles.draft} style={s}>
      <div className={styles.status}>
        <span>9:41</span>
        <span className={styles.statusIcons} />
      </div>
      <div className={styles.draftArt} style={{ background: p.placeholder, borderRadius: r }} />
      <div className={styles.draftTitle} style={{ fontFamily: font(theme.fonts.title) }}>
        Breathe in. Start here.
      </div>
      <div className={styles.draftText} style={{ color: p.muted }}>
        Five quiet minutes a day, guided by voice.
      </div>
      {["Email", "Password"].map((f) => (
        <div key={f} className={styles.field} style={{ borderColor: p.border, borderRadius: r, background: p.surface, color: p.muted }}>
          {f}
        </div>
      ))}
      <div className={styles.draftButton} style={{ background: p.primary, color: p.onPrimary, borderRadius: r, fontFamily: font(theme.fonts.label) }}>
        Create account
      </div>
      <div className={styles.draftFoot} style={{ color: p.muted }}>
        Already have an account? <b style={{ color: p.primary }}>Log in</b>
      </div>
    </div>
  );
}

/** The interactions Add interactions made: Get started → Team (On click, Navigate to), and the back button (Back). */
function Noodles() {
  const x1 = FW - 18;
  const y1 = TOP + FH - 18 - 20;
  const x2 = FW + GAP;
  const y2 = TOP + FH / 2;
  const bx = FW + GAP + 18 + 14;
  const by = TOP + 18 + 14;
  return (
    <svg className={styles.noodles} width={FW * 2 + GAP} height={FH + TOP + 8} aria-hidden="true">
      <path className={styles.noodle} d={`M${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2 - 6} ${y2}`} pathLength={1} />
      <path className={styles.arrow} d={`M${x2 - 8} ${y2 - 5} L${x2} ${y2} L${x2 - 8} ${y2 + 5} Z`} />
      <circle className={styles.dot} cx={x1} cy={y1} r={4} />
      <path className={styles.noodle} d={`M${bx} ${by} C ${bx - 30} ${by - 40}, ${FW - 40} ${TOP - 30}, ${FW - 8} ${TOP + 30}`} pathLength={1} style={{ animationDelay: "260ms" }} />
      <path className={styles.arrow} d={`M${FW - 14} ${TOP + 24} L${FW - 7} ${TOP + 31} L${FW - 4} ${TOP + 22} Z`} style={{ animationDelay: "260ms" }} />
      <circle className={styles.dot} cx={bx} cy={by} r={4} />
    </svg>
  );
}

/** Preview: the prototype from the first frame, inline over the canvas (Get started goes on, the back button back). */
function Preview({ at, doc, onGo, onClose }: { at: string; doc: Doc; onGo: (id: string) => void; onClose: () => void }) {
  const t = (id: string) => inLanguage(doc.texts[id] ?? "", doc.lang[id] ?? "English");
  return (
    <div className={styles.preview} onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Preview">
      <div className={styles.previewBar}>
        <span>Preview</span>
        <IconButton icon="24.close.small" label="Close" tone="secondary" onClick={onClose} />
      </div>
      <div key={at} className={`${styles.frame} ${styles.previewFrame}`}>
        {at === "f12" ? (
          <>
            <div className={styles.hero}>
              <HeroArt />
            </div>
            <span className={styles.title}>{t("t-title")}</span>
            <span className={styles.body}>{t("t-body")}</span>
            <button type="button" className={`${styles.button} ${styles.hot}`} onClick={() => onGo("f14")}>
              {t("t-cta")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={`${styles.back} ${styles.hot}`} aria-label="Back" onClick={() => onGo("f12")}>
              <svg width="14" height="14" viewBox="0 0 14 14">
                <path d="M8.5 2.5 4 7l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className={styles.title}>{t("t-team")}</span>
            {[1, 2, 3].map((n) => (
              <div key={n} className={styles.member}>
                <span className={styles.avatar} data-filled={doc.texts[`m${n}-name`] !== "Name" || undefined} style={{ ["--hue" as string]: [200, 28, 150][n - 1] }} />
                <span className={styles.memberText}>
                  <span className={styles.memberName}>{t(`m${n}-name`)}</span>
                  <span className={styles.memberRole}>{t(`m${n}-role`)}</span>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** Rectangle 4's picture: a calm week drawn in shapes (design content, its own colours). */
function HeroArt() {
  return (
    <svg viewBox="0 0 224 128" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" aria-hidden="true">
      <defs>
        <linearGradient id="act-sky" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9e4ff" />
          <stop offset="1" stopColor="#ffe9dc" />
        </linearGradient>
      </defs>
      <rect width="224" height="128" fill="url(#act-sky)" />
      <circle cx="176" cy="34" r="18" fill="#ffb98a" opacity="0.9" />
      <rect x="34" y="30" width="120" height="78" rx="10" fill="#fff" />
      <rect x="34" y="30" width="120" height="18" rx="9" fill="#6d5dfc" />
      {Array.from({ length: 12 }, (_, i) => (
        <rect key={i} x={44 + (i % 4) * 26} y={56 + Math.floor(i / 4) * 16} width="18" height="10" rx="3" fill={i === 5 ? "#ff8a5b" : i === 2 || i === 9 ? "#b9b0ff" : "#eceaf6"} />
      ))}
    </svg>
  );
}

// ---- the guided demo ---------------------------------------------------------------------------------------------

type Api = {
  doRow: (row: AiRowDef) => void;
  translate: (l: Language) => void;
  replaceContent: (p: string) => void;
  rewrite: (p: string) => void;
  setSelection: (s: string[]) => void;
  setPill: (p: Pill) => void;
  setView: (v: View) => void;
};

async function demo(run: SceneRun, api: { current: Api }) {
  const row = (id: string) => AI_ROWS.find((r) => r.id === id)!;
  const rowEl = (id: string) => run.$(`[data-row="${id}"]`);
  const scrollTo = (id: string) => rowEl(id)?.scrollIntoView({ block: "nearest" });
  await run.wait(900);
  // Rename layers, on the whole page
  scrollTo("ai.rename-layers");
  await run.click(rowEl("ai.rename-layers"));
  api.current.doRow(row("ai.rename-layers"));
  await run.wait(3600);
  // Select the description and translate it
  await run.click(run.$('[data-node="t-body"]'));
  api.current.setSelection(["t-body"]);
  await run.wait(500);
  scrollTo("ai.translate");
  await run.click(rowEl("ai.translate"));
  api.current.doRow(row("ai.translate"));
  await run.wait(700);
  await run.click(run.$('[data-language="Turkish"]'));
  api.current.translate("Turkish");
  await run.wait(3400);
  // Fill the placeholders
  await run.click(run.$('[data-node="f14"]'), { dy: -150 });
  api.current.setSelection(["f14"]);
  scrollTo("ai.replace-content");
  await run.click(rowEl("ai.replace-content"));
  api.current.doRow(row("ai.replace-content"));
  await run.wait(600);
  await run.click(run.$("[data-submit]"));
  api.current.replaceContent("");
  await run.wait(3600);
  // Connect the frames
  scrollTo("ai.add-interactions");
  await run.click(rowEl("ai.add-interactions"));
  api.current.doRow(row("ai.add-interactions"));
  await run.wait(3800);
  await run.click(run.$("[data-keep]"));
  api.current.setPill(null);
  run.hide();
  await run.wait(2400);
}
