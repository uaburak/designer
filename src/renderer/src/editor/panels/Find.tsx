/**
 * Find and replace in the left panel (⌘F, the Pages header's Find; help "Find and replace in Figma"): the query
 * (layer names, and the text of text layers) with the results as you type, on this page or all pages; layer-type
 * filters; ↑ ↓ (Enter / ⇧Enter) move through the results, each shown and selected; Settings: Match case, Whole
 * words, Other (slices and the like); Replace (the mode menu): "Replace with", Replace on the selected results,
 * Replace all. A click selects a result (⇧ a range, ⌘ adds); ✕ or Esc goes back to the layers.
 */
import { useMemo, useRef } from "react";
import { Button, Icon, IconButton, MenuButton, SearchField, Select, TextInput, VirtualList, cx, showToast, type MenuEntry } from "@/ds";
import { useSelection } from "@/engine/hooks";
import { useEditor } from "../controller";
import { command, shortcutOf } from "../commands";
import { closeFind, findResults, replaceInLayers, showResult, stepFind, EMPTY_FIND } from "../find";
import { useDocumentVersion, usePages, useUI } from "../hooks";
import { FIND_FILTERS, type FindResult } from "../model/find";
import { layerIcon } from "./Layers";
import type { FindState } from "../uiStore";
import type { TreeNode } from "../model/layerTree";
import styles from "./Find.module.css";

const ROW = 32;

type Item = { kind: "page"; page: string; name: string } | { kind: "result"; result: FindResult; index: number };

/** A result's glyph, as the Layers row would draw it. */
const glyph = (r: FindResult) => layerIcon({ type: r.type, group: r.filter === "group", stateGroup: r.filter === "component" && r.type === "FRAME", media: r.filter === "image" ? "IMAGE" : undefined } as unknown as TreeNode);

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

export function FindPanel() {
  const ed = useEditor();
  const f = useUI((s) => s.find) ?? EMPTY_FIND;
  const pages = usePages();
  const version = useDocumentVersion();
  const selection = useSelection(ed.store).refs;
  const anchor = useRef<number>(-1);
  const set = (patch: Partial<FindState>) => ed.ui.set((s) => ({ find: { ...(s.find ?? EMPTY_FIND), ...patch } }));

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version`: the document changed, read it again
  const results = useMemo(() => findResults(ed, f), [ed, f.query, f.scope, f.types, f.matchCase, f.wholeWords, f.other, version, pages]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const items = useMemo(() => {
    const out: Item[] = [];
    let page = "";
    results.forEach((r, index) => {
      if (f.scope === "all" && r.page !== page) {
        page = r.page;
        out.push({ kind: "page", page, name: pages.find((p) => p.guid === page)?.name ?? "" });
      }
      out.push({ kind: "result", result: r, index });
    });
    return out;
  }, [results, f.scope, pages]);

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

  const settings: MenuEntry[] = [
    { id: "matchCase", label: "Match case", checked: f.matchCase },
    { id: "wholeWords", label: "Whole words", checked: f.wholeWords },
    "-",
    { id: "other", label: "Other", checked: f.other },
  ];
  const filters: MenuEntry[] = FIND_FILTERS.map((t) => ({ id: t.id, label: t.label, checked: f.types.includes(t.id) }));
  const textResults = results.filter((r) => r.inText);
  const replaceTargets = textResults.filter((r) => selected.has(r.id));

  const replace = (all: boolean) => {
    const targets = all ? textResults : replaceTargets;
    const n = replaceInLayers(ed, f, targets);
    if (!n) showToast({ message: f.query ? "No text layers to replace" : "Type what to find first" });
  };

  return (
    <section className={styles.find} aria-label="Find" data-find="">
      <div className={styles.header}>
        <MenuButton
          label="Find or replace"
          className={styles.mode}
          entries={[
            { id: "find", label: "Find", checked: !f.replace },
            { id: "replace", label: "Replace", checked: f.replace },
          ]}
          onSelect={(id) => set({ replace: id === "replace" })}
        >
          <span>{f.replace ? "Replace" : "Find"}</span>
          <Icon name="16.chevron.down" />
        </MenuButton>
        <span className={styles.grow} />
        <MenuButton label="Settings" className={styles.iconMenu} entries={settings} onSelect={(id) => set({ [id]: !f[id as "matchCase" | "wholeWords" | "other"] } as Partial<FindState>)}>
          <Icon name="24.adjust.small" />
        </MenuButton>
        <IconButton icon="24.close.small" label="Close" tone="secondary" onClick={() => closeFind(ed)} />
      </div>
      <div
        className={styles.queryRow}
        onKeyDownCapture={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          stepFind(ed, e.shiftKey ? -1 : 1);
        }}
      >
        <SearchField
          className={styles.query}
          data-find-query=""
          label="Find"
          placeholder="Find…"
          value={f.query}
          autoFocus
          onChange={(query) => set({ query, at: -1 })}
          onExit={(r) => {
            if (r === "escape") closeFind(ed);
          }}
        />
        <MenuButton label="Filter by layer type" className={cx(styles.iconMenu, f.types.length > 0 && styles.on)} entries={filters} onSelect={(id) => set({ types: f.types.includes(id) ? f.types.filter((t) => t !== id) : [...f.types, id], at: -1 })}>
          <Icon name="24.filter" />
        </MenuButton>
      </div>
      {f.types.length > 0 && (
        <div className={styles.chips} aria-label="Filters">
          {f.types.map((t) => (
            <button key={t} type="button" className={styles.chip} aria-label={`Remove ${FIND_FILTERS.find((x) => x.id === t)?.label ?? t} filter`} onClick={() => set({ types: f.types.filter((x) => x !== t), at: -1 })}>
              {FIND_FILTERS.find((x) => x.id === t)?.label ?? t}
              <Icon name="24.close.small" />
            </button>
          ))}
        </div>
      )}
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
        <Select
          label="Search in"
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
        {f.query && <span className={styles.count} data-find-count={results.length}>{results.length === 1 ? "1 result" : `${results.length} results`}</span>}
        <IconButton icon="16.arrow.up" label={command("edit.find-previous").label} shortcut={shortcutOf(command("edit.find-previous"))} tone="secondary" disabled={!results.length} onClick={() => stepFind(ed, -1)} />
        <IconButton icon="16.arrow.down" label={command("edit.find-next").label} shortcut={shortcutOf(command("edit.find-next"))} tone="secondary" disabled={!results.length} onClick={() => stepFind(ed, 1)} />
      </div>
      <div className={styles.results} role="listbox" aria-label="Results" aria-multiselectable data-find-results="" data-keys="panel">
        {f.query && !results.length ? (
          <div className={styles.none}>No results for “{f.query}”</div>
        ) : (
          <VirtualList
            count={items.length}
            rowHeight={ROW}
            label="Results"
            scrollToIndex={f.at >= 0 ? items.findIndex((it) => it.kind === "result" && it.index === f.at) : undefined}
            renderRow={(i) => {
              const it = items[i];
              if (it.kind === "page") return <div className={styles.pageHeader}>{it.name}</div>;
              const r = it.result;
              const on = selected.has(r.id) && r.page === ed.store.page;
              return (
                <div
                  role="option"
                  aria-selected={on}
                  data-find-result={r.id}
                  data-current={it.index === f.at || undefined}
                  className={styles.row}
                  onClick={(e) => pick(e, r, it.index)}
                >
                  <span className={styles.box}>
                    <Icon name={glyph(r)} className={styles.glyph} />
                    <Marked r={r} />
                    {r.top && <span className={styles.top}>{r.top}</span>}
                  </span>
                </div>
              );
            }}
          />
        )}
      </div>
    </section>
  );
}
