/**
 * Find and replace in the left panel (⌘F, the Pages header's Find; help "Find and replace in Figma"; geometry from
 * the live capture, docs/research/figma/live/left/find-*.txt): it replaces the whole panel under the file header.
 * The field ("Find" and the query, 156 wide at 16) with Settings and Close at 180 / 204; "20 results · This page"
 * (the scope) with Previous / Next result at 184 / 208; the results in document order — a layer with a parent shows
 * the parent's name on a second line (52 high), a top-level one a single line (34). Settings: Find / Replace, the
 * layer types (All, Text, Frame / Group, Component, Instance, Image, Shape, Other, with counts), Match case, Whole
 * words. Enter / ⇧Enter or the arrows move through the results, each shown and selected; a click selects (⇧ a
 * range, ⌘ adds); Replace changes the selected text results, Replace all every one; ✕ or Esc goes back.
 */
import { useMemo, useRef, useState } from "react";
import { Button, ContextMenu, Icon, IconButton, Select, TextInput, cx, showToast, type IconName, type MenuEntry } from "@/ds";
import { useSelection } from "@/engine/hooks";
import { useEditor } from "../controller";
import { command, shortcutOf } from "../commands";
import { closeFind, findResults, findScope, replaceInLayers, showResult, stepFind, EMPTY_FIND } from "../find";
import { useDocumentVersion, usePages, useUI } from "../hooks";
import { FIND_FILTERS, countByType, type FindFilter, type FindResult } from "../model/find";
import { layerIcon } from "./Layers";
import type { FindState } from "../uiStore";
import type { TreeNode } from "../model/layerTree";
import styles from "./Find.module.css";

/** A result's glyph, as the Layers row draws it. */
const glyph = (r: FindResult) => layerIcon({ type: r.type, group: false, stateGroup: r.filter === "component" && r.type === "FRAME", media: r.filter === "image" ? "IMAGE" : undefined } as unknown as TreeNode);

/** The label with its matches marked; a long text starts a little before its first match. */
function Marked({ r }: { r: FindResult }) {
  const lead = r.inText && r.ranges[0][0] > 24 ? r.ranges[0][0] - 12 : 0;
  const parts: React.ReactNode[] = [];
  let at = lead;
  if (lead) parts.push("…");
  r.ranges.forEach(([from, to], i) => {
    if (to <= at) return;
    parts.push(r.label.slice(at, Math.max(at, from)));
    parts.push(<mark key={i} className={styles.mark}>{r.label.slice(Math.max(at, from), to)}</mark>);
    at = to;
  });
  parts.push(r.label.slice(at));
  return <span className={styles.label}>{parts}</span>;
}

/** The type rows' glyphs (live: an icon column before each type, docs/research/figma/live/img/left-find-results-and-filter-menu.jpg). */
const FILTER_ICONS: Record<FindFilter, IconName> = {
  text: "24.text",
  frame: "24.frame",
  component: "24.component.small",
  instance: "24.instance.small",
  image: "24.image",
  shape: "24.shapes",
  other: "24.more",
};

export function FindPanel() {
  const ed = useEditor();
  const f = useUI((s) => s.find) ?? EMPTY_FIND;
  const pages = usePages();
  const version = useDocumentVersion();
  const selection = useSelection(ed.store).refs;
  const anchor = useRef<number>(-1);
  const settingsButton = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const set = (patch: Partial<FindState>) => ed.ui.set((s) => ({ find: { ...(s.find ?? EMPTY_FIND), ...patch } }));

  // `version` and `pages`: the document changed, read it again (only while there is a query).
  const searching = f.query !== "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nodes = useMemo(() => (searching ? findScope(ed, f.scope) : []), [ed, searching, f.scope, version, pages]);
  const results = useMemo(() => findResults(ed, f, nodes), [ed, f, nodes]);
  const counts = useMemo(() => countByType(nodes, f.query, { matchCase: f.matchCase, wholeWords: f.wholeWords }), [nodes, f.query, f.matchCase, f.wholeWords]);
  const selected = useMemo(() => new Set(selection), [selection]);

  const pick = (e: React.MouseEvent, r: FindResult, index: number) => {
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = anchor.current <= index ? [anchor.current, index] : [index, anchor.current];
      const span = results.slice(a, b + 1).filter((x) => x.page === r.page);
      if (r.page !== ed.store.page) ed.engine.setCurrentPage(r.page);
      ed.engine.setSelection(span.map((x) => x.id));
    } else if (e.metaKey || e.ctrlKey) {
      if (r.page !== ed.store.page) ed.engine.setCurrentPage(r.page);
      const now = ed.selection;
      ed.engine.setSelection(now.includes(r.id) ? now.filter((id) => id !== r.id) : [...now, r.id]);
      anchor.current = index;
    } else {
      showResult(ed, r);
      anchor.current = index;
    }
    set({ at: index });
  };

  const count = (id: string) => (counts[id] ? String(counts[id]) : undefined);
  const settings: MenuEntry[] = [
    { id: "mode:find", label: "Find", checked: !f.replace },
    { id: "mode:replace", label: "Replace", checked: f.replace },
    "-",
    { id: "type:all", label: "All", icon: "24.select-matching.small", checked: f.types.length === 0, hint: count("all") },
    ...FIND_FILTERS.map((t) => ({ id: `type:${t.id}`, label: t.label, icon: FILTER_ICONS[t.id], checked: f.types.includes(t.id), hint: count(t.id) })),
    "-",
    { id: "matchCase", label: "Match case", checked: f.matchCase },
    { id: "wholeWords", label: "Whole words", checked: f.wholeWords },
  ];
  const onSetting = (id: string) => {
    if (id === "mode:find" || id === "mode:replace") return set({ replace: id === "mode:replace" });
    if (id === "type:all") return set({ types: [], at: -1 });
    if (id.startsWith("type:")) {
      const t = id.slice(5);
      return set({ types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t], at: -1 });
    }
    if (id === "matchCase" || id === "wholeWords") set({ [id]: !f[id], at: -1 } as Partial<FindState>);
  };

  const textResults = results.filter((r) => r.inText);
  const replaceTargets = textResults.filter((r) => selected.has(r.id));
  const replace = (all: boolean) => {
    const n = replaceInLayers(ed, f, all ? textResults : replaceTargets);
    if (!n) showToast({ message: "No text layers to replace" });
  };
  const current = f.at >= 0 ? results[f.at] : undefined;

  return (
    <section className={styles.find} aria-label="Find" data-find="">
      <div className={styles.top}>
        <label className={styles.field} data-find-query="">
          <Icon name="24.search.small" className={styles.fieldIcon} />
          <input
            className={styles.input}
            aria-label="Find…"
            placeholder="Find…"
            value={f.query}
            autoFocus
            spellCheck={false}
            onChange={(e) => set({ query: e.target.value, at: -1 })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                stepFind(ed, e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind(ed);
              }
            }}
          />
        </label>
        <div ref={settingsButton} style={{ display: "contents" }}>
          <IconButton
            icon="24.adjust.small"
            label="Settings"
            tone="secondary"
            aria-expanded={!!menu}
            aria-pressed={!!menu}
            className={cx(f.types.length > 0 && styles.on)}
            onClick={(e) => {
              if (menu) return setMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
          />
        </div>
        <IconButton icon="24.close.small" label="Close" tone="secondary" onClick={() => closeFind(ed)} />
      </div>
      {f.replace && (
        <div className={styles.replaceRow}>
          <TextInput label="Replace with" placeholder="Replace with…" value={f.replaceWith} selectAllOnFocus={false} onChange={(replaceWith) => set({ replaceWith })} onCommit={(replaceWith) => set({ replaceWith })} data-find-replace="" />
          <div className={styles.replaceButtons}>
            <Button variant="secondary" disabled={!replaceTargets.length} onClick={() => replace(false)}>
              Replace
            </Button>
            <Button variant="secondary" disabled={!textResults.length} onClick={() => replace(true)}>
              Replace all
            </Button>
          </div>
        </div>
      )}
      <div className={styles.status}>
        {f.query && (
          <>
            <span className={styles.count} data-find-count={results.length}>
              {results.length === 1 ? "1 result" : `${results.length} results`}
            </span>
            <span className={styles.dot} aria-hidden>
              ·
            </span>
          </>
        )}
        <Select
          label={`Search scope set to ${f.scope === "all" ? "All pages" : "This page"}`}
          variant="ghost"
          width="hug"
          value={f.scope}
          options={[
            { value: "page", label: "This page" },
            { value: "all", label: "All pages" },
          ]}
          onChange={(v) => set({ scope: v as "page" | "all", at: -1 })}
        />
        <span className={styles.grow} />
        {current && (
          <span className={styles.srOnly} aria-live="polite">
            {current.label}, result {f.at + 1} of {results.length}
          </span>
        )}
        <IconButton icon="16.arrow.up" label="Previous result" shortcut={shortcutOf(command("edit.find-previous"))} tone="secondary" disabled={!results.length} onClick={() => stepFind(ed, -1)} />
        <IconButton icon="16.arrow.down" label="Next result" shortcut={shortcutOf(command("edit.find-next"))} tone="secondary" disabled={!results.length} onClick={() => stepFind(ed, 1)} />
      </div>
      <div className={styles.results} role="listbox" aria-label="Search results" aria-multiselectable data-find-results="" data-keys="panel">
        {f.query && !results.length && <div className={styles.none}>No results for “{f.query}”</div>}
        {results.map((r, index) => {
          const page = f.scope === "all" && (index === 0 || results[index - 1].page !== r.page) ? pages.find((p) => p.guid === r.page)?.name : undefined;
          const on = selected.has(r.id) && r.page === ed.store.page;
          return (
            <div key={`${r.page}/${r.id}`} style={{ display: "contents" }}>
              {page !== undefined && <div className={styles.pageHeader}>{page}</div>}
              <div
                role="option"
                aria-selected={on}
                data-find-result={r.id}
                data-current={index === f.at || undefined}
                className={cx(styles.row, r.parent !== undefined && styles.twoLine)}
                onClick={(e) => pick(e, r, index)}
                ref={(el) => {
                  if (el && index === f.at) el.scrollIntoView({ block: "nearest" });
                }}
              >
                <span className={styles.glyph}>
                  <Icon name={glyph(r)} />
                </span>
                <span className={styles.text}>
                  <Marked r={r} />
                  {r.parent !== undefined && <span className={styles.parent}>{r.parent}</span>}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu at={menu} entries={settings} label="Settings" ignore={settingsButton} onSelect={onSetting} onClose={() => setMenu(null)} />}
    </section>
  );
}
