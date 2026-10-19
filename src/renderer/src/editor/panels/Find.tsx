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
import { Button, ContextMenu, Icon, IconButton, Select, TextInput, cx, showToast, tooltipProps, type IconName, type MenuEntry } from "@/ds";
import { useSelection } from "@/engine/hooks";
import { useEditor } from "../controller";
import { command, shortcutOf } from "../commands";
import { closeFind, findResults, findScope, replaceInLayers, showResult, stepFind, EMPTY_FIND } from "../find";
import { useDocumentVersion, usePages, useUI } from "../hooks";
import { FIND_FILTERS, countByType, type FindFilter, type FindResult } from "../model/find";
import { layerIcon, layerKind } from "./Layers";
import type { FindState } from "../uiStore";
import type { TreeNode } from "../model/layerTree";
import styles from "./Find.module.css";
import { t, tp, useT } from "@/i18n";

/** A result's glyph, as the Layers row draws it. */
const rowOf = (r: FindResult) =>
  ({ type: r.type, group: r.type === "GROUP", stateGroup: r.filter === "component" && r.type === "FRAME", media: r.filter === "image" ? "IMAGE" : undefined, stackMode: r.stackMode, stackWrap: r.stackWrap, slot: r.slot }) as unknown as TreeNode;
const glyph = (r: FindResult) => layerIcon(rowOf(r));
/** The glyph's name (live: img [Frame], [Text]…, as in Layers) */
const glyphLabel = (r: FindResult) => t(layerKind(rowOf(r)));

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
  useT();
  const ed = useEditor();
  const f = useUI((s) => s.find) ?? EMPTY_FIND;
  const pages = usePages();
  const version = useDocumentVersion();
  const selection = useSelection(ed.store).refs;
  const anchor = useRef<number>(-1);
  const settingsButton = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
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
    { id: "mode:find", label: t("Find"), checked: !f.replace },
    { id: "mode:replace", label: t("Replace"), checked: f.replace },
    "-",
    { id: "type:all", label: t("All"), icon: "24.select-matching.small", checked: f.types.length === 0, hint: count("all") },
    ...FIND_FILTERS.map((ft) => ({ id: `type:${ft.id}`, label: t(ft.label), icon: FILTER_ICONS[ft.id], checked: f.types.includes(ft.id), hint: count(ft.id) })),
    "-",
    { id: "matchCase", label: t("Match case"), checked: f.matchCase },
    { id: "wholeWords", label: t("Whole words"), checked: f.wholeWords },
  ];
  const onSetting = (id: string) => {
    if (id === "mode:find" || id === "mode:replace") return set({ replace: id === "mode:replace" });
    if (id === "type:all") return set({ types: [], at: -1 });
    if (id.startsWith("type:")) {
      const type = id.slice(5);
      return set({ types: f.types.includes(type) ? f.types.filter((x) => x !== type) : [...f.types, type], at: -1 });
    }
    if (id === "matchCase" || id === "wholeWords") set({ [id]: !f[id], at: -1 } as Partial<FindState>);
  };

  const textResults = results.filter((r) => r.inText);
  const replaceTargets = textResults.filter((r) => selected.has(r.id));
  const replace = (all: boolean) => {
    const n = replaceInLayers(ed, f, all ? textResults : replaceTargets);
    if (!n) showToast({ message: t("No text layers to replace") });
  };
  const current = f.at >= 0 ? results[f.at] : undefined;

  return (
    <section className={styles.find} aria-label={t("Find")} data-find="">
      <div className={styles.top}>
        <label className={styles.field} data-find-query="">
          <Icon name="24.search.small" className={styles.fieldIcon} />
          <input
            ref={field}
            className={styles.input}
            aria-label={t("Find…")}
            placeholder={t("Find…")}
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
            label={t("Settings")}
            tone="secondary"
            aria-expanded={!!menu}
            aria-pressed={!!menu}
            className={cx(f.types.length > 0 && styles.on)}
            onClick={(e) => {
              if (menu) return setMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              // Live (left-find-results-and-filter-menu): the field gives up its focus while the menu is open, the button shown pressed.
              field.current?.blur();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
          />
        </div>
        <IconButton icon="24.close.small" label={t("Close")} tone="secondary" onClick={() => closeFind(ed)} />
      </div>
      {f.replace && (
        <div className={styles.replaceRow}>
          <TextInput label={t("Replace with")} placeholder={t("Replace with…")} value={f.replaceWith} selectAllOnFocus={false} onChange={(replaceWith) => set({ replaceWith })} onCommit={(replaceWith) => set({ replaceWith })} data-find-replace="" />
          <div className={styles.replaceButtons}>
            <Button variant="secondary" disabled={!replaceTargets.length} onClick={() => replace(false)}>
              {t("Replace")}
            </Button>
            <Button variant="secondary" disabled={!textResults.length} onClick={() => replace(true)}>
              {t("Replace all")}
            </Button>
          </div>
        </div>
      )}
      <div className={styles.status}>
        {f.query && (
          <>
            <span className={styles.count} data-find-count={results.length}>
              {tp(results.length, "{n} result", "{n} results")}
            </span>
            <span className={styles.dot} aria-hidden>
              ·
            </span>
          </>
        )}
        <Select
          label={t("Search scope set to {scope}", { scope: f.scope === "all" ? t("All pages") : t("This page") })}
          className={styles.scope}
          variant="ghost"
          width="hug"
          value={f.scope}
          options={[
            { value: "page", label: t("This page") },
            { value: "all", label: t("All pages") },
          ]}
          onChange={(v) => set({ scope: v as "page" | "all", at: -1 })}
        />
        <span className={styles.grow} />
        {current && (
          <span className={styles.srOnly} aria-live="polite">
            {t("{label}, result {at} of {count}", { label: current.label, at: f.at + 1, count: results.length })}
          </span>
        )}
        <IconButton icon="16.arrow.up" label={t("Previous result")} shortcut={shortcutOf(command("edit.find-previous"))} tone="secondary" disabled={!results.length} onClick={() => stepFind(ed, -1)} />
        <IconButton icon="16.arrow.down" label={t("Next result")} shortcut={shortcutOf(command("edit.find-next"))} tone="secondary" disabled={!results.length} onClick={() => stepFind(ed, 1)} />
      </div>
      <div className={styles.results} role="listbox" aria-label={t("Search results")} aria-multiselectable data-find-results="" data-keys="panel">
        {f.query && !results.length && <div className={styles.none}>{t("No results for “{query}”", { query: f.query })}</div>}
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
                <span className={styles.glyph} role="img" aria-label={glyphLabel(r)} {...tooltipProps(glyphLabel(r))}>
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
      {menu && <ContextMenu at={menu} entries={settings} label={t("Settings")} ignore={settingsButton} onSelect={onSetting} onClose={() => setMenu(null)} />}
    </section>
  );
}
