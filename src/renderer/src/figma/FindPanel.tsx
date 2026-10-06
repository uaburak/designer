import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fi } from "@/components/admin/figmaIcons";
import type { MenuEntry } from "@/components/admin/ContextMenu";
import { ScrollArea } from "@/components/ScrollArea";
import { hoverNode, layerIcon } from "./Layers";
import { isFrameLike, layerName, walk, wordsIn, wordsPatch, type FigmaDocument, type LangCode, type SceneNode, type TextNode } from "./model";
import { IconButton } from "./ui";

/**
 * Figma's Find (and Replace), in the left sidebar: the layers whose names —
 * a text's words too — hold what is typed, on the open page or on every
 * page, grouped under the top-level layer holding them; the pages whose
 * names hold it, first. The filter menu: Find / Replace, the kinds of layer
 * (with their counts), match case, whole words. A result picked selects the
 * layer (on its page) and brings it into view.
 */

export type FindKind = "text" | "frame" | "component" | "instance" | "image" | "shape" | "other";

const KINDS: { kind: FindKind; label: string; icon: ReactNode }[] = [
  { kind: "text", label: "Text", icon: fi("16.text") },
  { kind: "frame", label: "Frame / Group", icon: fi("16.frame") },
  { kind: "component", label: "Component", icon: fi("16.component") },
  { kind: "instance", label: "Instance", icon: fi("16.instance") },
  { kind: "image", label: "Image", icon: fi("16.image") },
  { kind: "shape", label: "Shape", icon: fi("24.shapes", 16) },
  { kind: "other", label: "Other", icon: fi("16.more") },
];

/** The kind of layer Find counts it as. */
function kindOf(node: SceneNode): FindKind {
  switch (node.type) {
    case "text": return "text";
    case "component": case "componentSet": return "component";
    case "instance": return "instance";
    case "frame": return node.embed ? "other" : "frame";
    default: return node.fills.some((p) => p.type === "image" && p.visible !== false) ? "image" : "shape";
  }
}

/** What is typed, as a pattern: as it is (not a pattern itself), its case kept or not, as a whole word or anywhere. */
function patternOf(query: string, matchCase: boolean, wholeWords: boolean): { test: RegExp; all: RegExp } | null {
  if (!query.trim()) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = wholeWords ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
  const flags = matchCase ? "u" : "iu";
  return { test: new RegExp(source, flags), all: new RegExp(source, `g${flags}`) };
}

/** `text` with what matches in bold. */
function highlighted(text: string, all: RegExp): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(all)) {
    if (m.index === undefined || !m[0]) continue;
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(<b key={m.index} className="font-[650]">{m[0]}</b>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** A text's words in the language edited (its base-language ones when it has none in it). */
const wordsOf = (node: TextNode, lang: LangCode) => wordsIn(node, lang) ?? node.characters;

interface Hit {
  page: string;
  node: SceneNode;
  parent: SceneNode | null;
  top: SceneNode;
  kind: FindKind;
  /** What is shown: its name — a text's words, when they matched and its name didn't */
  label: string;
}

export interface FindPage {
  id: string;
  name: string;
  nodes: readonly SceneNode[];
}

export function FindPanel({ query, onQuery, current, pages, lang, onClose, onPick, onPickPage, onReplace, openMenu }: {
  query: string;
  onQuery: (query: string) => void;
  /** "This page": the open page (a component edited on its own: it alone) */
  current: FindPage;
  /** "All pages": every page of the file */
  pages: readonly FindPage[];
  lang: LangCode;
  onClose: () => void;
  /** A layer picked: selected, on its page */
  onPick: (page: string, id: string) => void;
  onPickPage: (page: string) => void;
  /** Replace all: the file changed by `update` */
  onReplace: (update: (doc: FigmaDocument) => FigmaDocument) => void;
  openMenu: (el: HTMLElement, entries: MenuEntry[]) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [kind, setKind] = useState<FindKind | null>(null);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWords, setWholeWords] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const pattern = useMemo(() => patternOf(query, matchCase, wholeWords), [query, matchCase, wholeWords]);
  const scope = useMemo(() => (everywhere ? pages : [current]), [everywhere, pages, current]);

  // Every layer that matches, in the scope — the kinds counted before the kind picked keeps its own.
  const hits = useMemo(() => {
    const out: Hit[] = [];
    if (!pattern) return out;
    for (const page of scope) {
      const tops = new Map<string, SceneNode>();
      walk(page.nodes, (node, parent, path) => {
        if (!parent) tops.set(node.id, node);
        const words = node.type === "text" ? wordsOf(node, lang) : "";
        const inName = pattern.test.test(node.name);
        if (!inName && !(words && pattern.test.test(words))) return;
        out.push({ page: page.id, node, parent, top: tops.get(path[0]) ?? node, kind: kindOf(node), label: inName ? node.name : words.replace(/\s+/g, " ").trim().slice(0, 120) });
      });
    }
    return out;
  }, [pattern, scope, lang]);
  const counts = useMemo(() => {
    const c: Record<FindKind, number> = { text: 0, frame: 0, component: 0, instance: 0, image: 0, shape: 0, other: 0 };
    hits.forEach((h) => c[h.kind]++);
    return c;
  }, [hits]);
  const shown = kind ? hits.filter((h) => h.kind === kind) : hits;
  const pagesFound = pattern && !kind ? pages.filter((pg) => pattern.test.test(pg.name)) : [];
  // Grouped under their top-level layer, in the order they were met.
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; page: string; top: SceneNode; hits: Hit[] }>();
    for (const h of shown) {
      const key = `${h.page}/${h.top.id}`;
      const group = map.get(key) ?? { key, page: h.page, top: h.top, hits: [] };
      group.hits.push(h);
      map.set(key, group);
    }
    return [...map.values()];
  }, [shown]);
  const pageName = (id: string) => pages.find((pg) => pg.id === id)?.name ?? "";
  const texts = hits.filter((h) => h.node.type === "text" && pattern?.test.test(wordsOf(h.node as TextNode, lang)));

  const replaceAll = () => {
    if (!pattern || !texts.length) return;
    const ids = new Set(texts.map((h) => h.node.id));
    const inScope = new Set(scope.map((pg) => pg.id));
    const all = pattern.all;
    const fix = (list: SceneNode[], inComponent: boolean): SceneNode[] =>
      list.map((n) => {
        let next = n;
        if (n.type === "text" && ids.has(n.id)) {
          const before = wordsOf(n, lang);
          const after = before.replace(all, () => replacement);
          // A text named after its words (as one typed is) keeps being so — but in a component: its instances' changes are kept under its layers' names.
          const renamed = !n.fixed && !inComponent && n.name === layerName(before.trim().slice(0, 40)) ? { name: layerName(after.trim().slice(0, 40)) || "Text" } : {};
          next = { ...n, ...wordsPatch(n, lang, after), ...renamed } as TextNode;
        }
        return isFrameLike(next) ? { ...next, children: fix(next.children, inComponent || next.type === "component" || next.type === "componentSet") } : next;
      });
    onReplace((d) => ({
      ...d,
      nodes: inScope.has("") ? fix(d.nodes, false) : d.nodes,
      pages: d.pages?.map((pg) => (inScope.has(pg.id) ? { ...pg, nodes: fix(pg.nodes, false) } : pg)),
    }));
  };

  const filterMenu = (el: HTMLElement) => openMenu(el, [
    { label: "Find", checked: !replacing, onSelect: () => setReplacing(false) },
    { label: "Replace", checked: replacing, onSelect: () => setReplacing(true) },
    "-",
    { label: "All", icon: fi("collapse-layers.small"), hint: pattern ? String(hits.length) : undefined, checked: kind === null, onSelect: () => setKind(null) },
    ...KINDS.map(({ kind: k, label, icon }) => ({ label, icon, hint: pattern && counts[k] ? String(counts[k]) : undefined, checked: kind === k, onSelect: () => setKind(k) })),
    "-",
    { label: "Match case", checked: matchCase, onSelect: () => setMatchCase((v) => !v) },
    { label: "Whole words", checked: wholeWords, onSelect: () => setWholeWords((v) => !v) },
  ]);
  const scopeMenu = (el: HTMLElement) => openMenu(el, [
    { label: "This page", checked: !everywhere, onSelect: () => setEverywhere(false) },
    { label: "All pages", checked: everywhere, onSelect: () => setEverywhere(true) },
  ]);

  const total = shown.length + pagesFound.length;
  const LIMIT = 300;
  let left = LIMIT;
  const filtered = Boolean(kind || matchCase || wholeWords);
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* The field, the filter menu's button, close. */}
      <div className="shrink-0 flex items-center gap-1 h-12 pl-3 pr-3 border-b border-[var(--f-border)]">
        <div className="flex flex-1 min-w-0 items-center gap-1 h-8 pl-1 pr-2 rounded-[5px] bg-[var(--f-bg-secondary)] border border-transparent focus-within:border-[var(--f-border-selected)]">
          <span className="flex shrink-0 text-[var(--f-icon)]">{fi("24.search.small")}</span>
          <input
            autoFocus
            aria-label="Find"
            value={query}
            placeholder="Find…"
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") onClose();
            }}
            className="min-w-0 flex-1 h-full bg-transparent text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)] outline-none"
          />
        </div>
        <IconButton label="Find and replace options" icon={fi("24.adjust.small")} active={replacing || filtered} onClick={(e) => filterMenu(e.currentTarget)} />
        <IconButton label="Close (Esc)" icon={fi("close.small")} onClick={onClose} />
      </div>
      {replacing && (
        <div className="shrink-0 flex items-center gap-1 h-12 pl-3 pr-3 border-b border-[var(--f-border)]">
          <input
            aria-label="Replace with"
            value={replacement}
            placeholder="Replace with…"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") replaceAll();
              if (e.key === "Escape") onClose();
            }}
            className="min-w-0 flex-1 h-8 px-2 rounded-[5px] bg-[var(--f-bg-secondary)] border border-transparent focus:border-[var(--f-border-selected)] text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)] outline-none"
          />
          <button type="button" disabled={!texts.length} onClick={replaceAll} title="Replace the words in every text found" className="shrink-0 h-8 px-2.5 rounded-[5px] bg-[var(--f-bg-brand)] text-[11px] font-[450] text-white disabled:opacity-40 cursor-pointer disabled:cursor-default">
            Replace all{texts.length ? ` (${texts.length})` : ""}
          </button>
        </div>
      )}
      {/* How many, and where. */}
      <div className="shrink-0 flex items-center gap-1 h-10 pl-4 pr-3 text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)]">
        {pattern && <span>{total} {total === 1 ? "result" : "results"} ·</span>}
        <button type="button" onClick={(e) => scopeMenu(e.currentTarget)} className="flex items-center gap-0.5 h-6 pl-1 pr-0.5 rounded-[5px] hover:bg-[var(--f-bg-hover)] cursor-pointer">
          {everywhere ? "All pages" : "This page"}
          <span className="text-[var(--f-icon-secondary)]">{fi("16.chevron.down")}</span>
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0" viewportClassName="h-full overflow-x-hidden flex flex-col pb-4" inset={8} edge={2}>
        {!pattern && <p className="px-4 py-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">Find layers and texts by name or words.</p>}
        {pattern && total === 0 && <p className="px-4 py-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">No results.</p>}
        {pagesFound.length > 0 && (
          <Group label="Pages" open={!closed.has("pages")} onToggle={() => toggle(setClosed, "pages")}>
            {pagesFound.map((pg) => (
              <Row key={pg.id || "main"} icon={fi("16.page")} onClick={() => onPickPage(pg.id)}>
                <span className="truncate text-[var(--f-text)]">{highlighted(pg.name, pattern!.all)}</span>
              </Row>
            ))}
          </Group>
        )}
        {groups.map((g) => {
          if (left <= 0) return null;
          const open = !closed.has(g.key);
          const rows = open ? g.hits.slice(0, left) : [];
          left -= rows.length;
          return (
            <Group key={g.key} label={g.top.name} hint={everywhere ? pageName(g.page) : undefined} open={open} onToggle={() => toggle(setClosed, g.key)}>
              {rows.map((h) => {
                const purple = h.kind === "component" || h.kind === "instance";
                return (
                  <Row key={`${h.page}/${h.node.id}`} icon={layerIcon(h.node)} purple={purple} onClick={() => onPick(h.page, h.node.id)} onHover={(on) => hoverNode(on ? h.node.id : null)}>
                    <span className={cn("truncate", purple ? "text-[var(--f-text-component)]" : "text-[var(--f-text)]")}>{highlighted(h.label, pattern!.all)}</span>
                    <span className={cn("truncate", purple ? "text-[var(--f-text-component)]" : "text-[var(--f-text-secondary)]")}>{h.parent?.name ?? pageName(h.page)}</span>
                  </Row>
                );
              })}
            </Group>
          );
        })}
        {pattern && shown.length > LIMIT && <p className="px-4 py-2 text-[11px] leading-4 text-[var(--f-text-secondary)]">Showing the first {LIMIT} of {shown.length}. Type more to narrow them.</p>}
      </ScrollArea>
    </div>
  );
}

const toggle = (set: (update: (s: Set<string>) => Set<string>) => void, key: string) =>
  set((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

/** A group of results: its name (bold) with a chevron, its rows under it. */
function Group({ label, hint, open, onToggle, children }: { label: string; hint?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col pb-1">
      <button type="button" onClick={onToggle} className="flex items-center gap-1 h-8 pl-2 pr-3 text-left cursor-pointer select-none">
        <span className={cn("flex w-4 h-4 shrink-0 items-center justify-center text-[var(--f-icon-secondary)] transition-transform", !open && "-rotate-90")}>{fi("16.chevron.down")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-[550] leading-4 tracking-[0.055px] text-[var(--f-text)]">{label}</span>
        {hint && <span className="shrink-0 truncate max-w-[40%] text-[11px] leading-4 text-[var(--f-text-secondary)]">{hint}</span>}
      </button>
      {open && children}
    </div>
  );
}

/** A result: its layer's icon, its name over where it sits — one line for a page. */
function Row({ icon, purple = false, onClick, onHover, children }: { icon: ReactNode; purple?: boolean; onClick: () => void; onHover?: (on: boolean) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className="group/hit flex items-start gap-2 w-full min-h-8 py-1.5 pl-6 pr-3 text-left cursor-pointer hover:bg-[var(--f-bg-row-hover)]"
    >
      <span className={cn("flex w-4 h-4 shrink-0 items-center justify-center", purple ? "text-[var(--f-text-component)]" : "text-[var(--f-icon-secondary)]")}>{icon}</span>
      <span className="min-w-0 flex-1 flex flex-col text-[11px] leading-4 tracking-[0.055px]">{children}</span>
    </button>
  );
}
