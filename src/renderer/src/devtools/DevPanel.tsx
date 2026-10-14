// TEMPORARY developer tool (owner, 2026-10-14: "only for us while we redo the whole UI for our own brand; we'll remove
// it later"). A floating panel over any view of the app (desktop and web) with two tabs:
// - Tokens: the chrome's live tokens — colours (brand first), spacing, radius, sizes — as the current theme resolves
//   them; an edit changes the whole UI at once, for that theme, also inside the dark menus and popovers.
// - Report: Inspect (like the browser's) picks any element; it lands in the report with its name, selector and look,
//   a note for the revision, and live style edits that apply to every element like it (every file card …).
// Everything is kept in localStorage (store.ts), shared by the app's views; "Copy report" gives Markdown with the
// notes, the edits and the changed tokens, "Download" the same as JSON.
//
// Open/close: ⌥⇧⌘D (Ctrl+Alt+Shift+D elsewhere), or start a view with `?tokens`; Inspect: ⌥⇧⌘C or the panel's
// button (Esc stops, ↑ / ⌥-scroll goes to the parent, Enter picks). Not translated on purpose (dev only).
// To remove: delete src/renderer/src/devtools/ and its two lines in main.tsx.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flash, lookOf, nameOf, PROPS, selectorFor, startPicking, viewName, type Picker } from "./inspect";
import { brandTokens } from "./brand";
import { css, getState, subscribe, update, type ReportItem, type Theme } from "./store";
import styles from "./DevPanel.module.css";

type Group = "brand" | "colors" | "spacing" | "radius" | "sizes";
const GROUPS: { id: Group; label: string; match: (name: string) => boolean }[] = [
  { id: "brand", label: "Brand", match: (n) => /brand|selected|component|accent|ai-/.test(n) && /color/.test(n) },
  { id: "colors", label: "Colors", match: (n) => /color/.test(n) },
  { id: "spacing", label: "Spacing", match: (n) => n.startsWith("--ds-space-") },
  { id: "radius", label: "Radius", match: (n) => n.startsWith("--ds-radius-") },
  { id: "sizes", label: "Sizes", match: (n) => n.startsWith("--ds-size-") },
];

/** Every custom property the stylesheets declare on :root or a theme selector. */
function tokenNames(): string[] {
  const names = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (!/:root|\[data-theme/.test(rule.selectorText)) continue;
        for (const prop of Array.from(rule.style)) if (prop.startsWith("--ds-") || prop.startsWith("--figma-color-")) names.add(prop);
      } else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    if ((sheet.ownerNode as Element | null)?.hasAttribute?.("data-dev-panel")) continue;
    try {
      walk(sheet.cssRules);
    } catch {
      // a cross-origin sheet: not ours
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

const isColor = (v: string) => /^(#|rgb|hsl|color\(|oklch|transparent)/i.test(v);
const px = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && /px$/.test(v.trim()) ? n : null;
};
const themeNow = (): Theme => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
const toHex = (v: string): string | null => {
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const m = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : null;
};

export function DevPanel() {
  const state = useSyncExternalStore(subscribe, getState);
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has("tokens"));
  const [tab, setTab] = useState<"tokens" | "report">("tokens");
  const [picking, setPicking] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [theme, setTheme] = useState(themeNow);
  const panel = useRef<HTMLDivElement>(null);
  const picker = useRef<Picker | null>(null);

  const startInspect = () => {
    if (picker.current) return;
    setOpen(true);
    setPicking(true);
    picker.current = startPicking(
      panel.current,
      (el) => {
        const r = el.getBoundingClientRect();
        const selector = selectorFor(el);
        const existing = getState().report.find((i) => i.selector === selector);
        if (existing) setFocus(existing.id);
        else {
          const item: ReportItem = {
            id: Math.random().toString(36).slice(2, 10),
            view: viewName(),
            url: location.pathname + location.search,
            label: nameOf(el),
            text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
            selector,
            size: [Math.round(r.width), Math.round(r.height)],
            before: lookOf(el),
            edits: {},
            note: "",
            at: Date.now(),
          };
          update((s) => ({ ...s, report: [item, ...s.report] }));
          setFocus(item.id);
        }
        setTab("report");
        picker.current?.stop();
      },
      () => {
        picker.current = null;
        setPicking(false);
      },
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.altKey && e.shiftKey && (e.metaKey || e.ctrlKey))) return;
      if (e.code === "KeyD") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.code === "KeyC") {
        e.preventDefault();
        if (picker.current) picker.current.stop();
        else startInspect();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const mo = new MutationObserver(() => setTheme(themeNow()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-contrast"] });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      mo.disconnect();
      picker.current?.stop();
    };
  }, []);

  if (!open) return null;
  return (
    <div ref={panel} className={styles.panel} role="dialog" aria-label="Design tokens and report">
      <div className={styles.head}>
        <div className={styles.tabs}>
          <button type="button" data-on={tab === "tokens" || undefined} onClick={() => setTab("tokens")}>
            Tokens
          </button>
          <button type="button" data-on={tab === "report" || undefined} onClick={() => setTab("report")}>
            Report{state.report.length ? ` ${state.report.length}` : ""}
          </button>
        </div>
        <button type="button" className={styles.inspect} data-on={picking || undefined} onClick={() => (picker.current ? picker.current.stop() : startInspect())} title="Inspect (⌥⇧⌘C)">
          {picking ? "Picking… Esc" : "Inspect"}
        </button>
        <span className={styles.theme}>{theme}</span>
        <button type="button" className={styles.icon} onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </div>
      {tab === "tokens" ? <Tokens theme={theme} overrides={state.tokens[theme]} /> : <Report items={state.report} focus={focus} setFocus={setFocus} />}
    </div>
  );
}

// ── Tokens ───────────────────────────────────────────────────────────────────────────────────────────────────────

function setToken(theme: Theme, name: string, value: string) {
  update((s) => {
    const t = { ...s.tokens[theme] };
    if (value) t[name] = value;
    else delete t[name];
    return { ...s, tokens: { ...s.tokens, [theme]: t } };
  });
}

function Tokens({ theme, overrides }: { theme: Theme; overrides: Record<string, string> }) {
  const [group, setGroup] = useState<Group>("brand");
  const [query, setQuery] = useState("");
  const names = useMemo(() => tokenNames(), []);
  const cs = getComputedStyle(document.documentElement);
  const g = GROUPS.find((x) => x.id === group)!;
  const q = query.trim().toLowerCase();
  const rows = names.filter((n) => g.match(n) && (!q || n.includes(q))).map((n) => ({ name: n, value: cs.getPropertyValue(n).trim() }));
  const changed = Object.keys(overrides).length;
  return (
    <>
      <BrandColor />
      <div className={styles.subtabs}>
        {GROUPS.map((x) => (
          <button key={x.id} type="button" data-on={x.id === group || undefined} onClick={() => setGroup(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <input className={styles.search} placeholder="Filter tokens" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      <div className={styles.list}>
        {rows.map(({ name, value }) => (
          <TokenRow key={name} name={name} value={value} group={group} changed={name in overrides} onSet={(v) => setToken(theme, name, v)} />
        ))}
        {rows.length === 0 && <p className={styles.empty}>No tokens</p>}
      </div>
      <div className={styles.foot}>
        <span>{changed ? `${changed} changed in ${theme}` : `${rows.length} tokens`}</span>
        <button type="button" disabled={!changed} onClick={() => update((s) => ({ ...s, tokens: { ...s.tokens, [theme]: {} } }))}>
          Reset {theme}
        </button>
      </div>
    </>
  );
}

/** One brand colour in: the whole brand family (hover, pressed, tints, text, borders, selection) for both themes. */
function BrandColor() {
  const current = getComputedStyle(document.documentElement).getPropertyValue("--figma-color-bg-brand").trim();
  const [hex, setHex] = useState(() => toHex(current) ?? "#0d99ff");
  const apply = (v: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(v)) return;
    setHex(v);
    update((s) => ({ ...s, tokens: { light: { ...s.tokens.light, ...brandTokens(v, "light") }, dark: { ...s.tokens.dark, ...brandTokens(v, "dark") } } }));
  };
  return (
    <div className={styles.brand}>
      <span className={styles.name}>Brand colour</span>
      <label className={styles.swatch} style={{ background: hex }}>
        <input type="color" value={hex} onChange={(e) => apply(e.target.value)} />
      </label>
      <ValueField value={hex} onCommit={(v) => apply(v.startsWith("#") ? v : `#${v}`)} />
      <span className={styles.meta}>sets every brand token, light + dark</span>
    </div>
  );
}

function TokenRow({ name, value, group, changed, onSet }: { name: string; value: string; group: Group; changed: boolean; onSet: (v: string) => void }) {
  const size = px(value);
  const short = name.replace(/^--(ds|figma)-(color-)?/, "");
  const hex = toHex(value);
  return (
    <div className={styles.row} data-changed={changed || undefined} title={name}>
      <span className={styles.preview}>
        {isColor(value) ? (
          <label className={styles.swatch} style={{ background: value }}>
            {hex && <input type="color" value={hex} onChange={(e) => onSet(e.target.value)} />}
          </label>
        ) : group === "radius" && size !== null ? (
          <span className={styles.radius} style={{ borderRadius: Math.min(size, 14) }} />
        ) : size !== null ? (
          <span className={styles.bar} style={{ width: Math.max(2, Math.min(size, 28)) }} />
        ) : null}
      </span>
      <span className={styles.name}>{short}</span>
      <ValueField value={value} onCommit={onSet} />
      {changed ? (
        <button type="button" className={styles.icon} onClick={() => onSet("")} aria-label={`Reset ${name}`} title="Reset">
          ↺
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** A value field that commits on Enter or blur, from the field's own text (never a stale draft). */
function ValueField({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (v: string) => {
    v = v.trim();
    if (v !== value) onCommit(v);
    setDraft(null);
  };
  return (
    <input
      className={styles.value}
      value={draft ?? value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => draft !== null && commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────────────────────────

const editItem = (id: string, fn: (i: ReportItem) => ReportItem) => update((s) => ({ ...s, report: s.report.map((i) => (i.id === id ? fn(i) : i)) }));

function markdown(items: ReportItem[]): string {
  const s = getState();
  const out = ["# Wecra UI report", "", `${items.length} item(s), ${new Date().toLocaleString()}`, ""];
  for (const i of [...items].reverse()) {
    out.push(`## ${i.label} — ${i.view}`, "", `- Selector: \`${i.selector}\``, `- Size: ${i.size[0]} × ${i.size[1]}`);
    if (i.text) out.push(`- Text: “${i.text}”`);
    if (i.note) out.push("", i.note);
    const edits = Object.entries(i.edits);
    if (edits.length) {
      out.push("", "Edits:", ...edits.map(([k, v]) => `- ${k}: ${i.before[k] ?? "?"} → **${v}**`));
    }
    out.push("");
  }
  for (const theme of ["light", "dark"] as const) {
    const t = Object.entries(s.tokens[theme]);
    if (t.length) out.push(`## Tokens (${theme})`, "", ...t.map(([k, v]) => `- ${k}: **${v}**`), "");
  }
  out.push("## CSS", "", "```css", css(s).trim(), "```");
  return out.join("\n");
}

function Report({ items, focus, setFocus }: { items: ReportItem[]; focus: string | null; setFocus: (id: string | null) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(markdown(items)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const download = () => {
    const blob = new Blob([JSON.stringify({ ...getState(), css: css() }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wecra-ui-report-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <>
      <div className={styles.list}>
        {items.length === 0 && <p className={styles.empty}>Press Inspect (⌥⇧⌘C), then click anything in the app to add it here with your note.</p>}
        {items.map((i) => (
          <Item key={i.id} item={i} open={focus === i.id} onToggle={() => setFocus(focus === i.id ? null : i.id)} />
        ))}
      </div>
      <div className={styles.foot}>
        <span>{items.length} items</span>
        <button type="button" onClick={copy} disabled={!items.length}>
          {copied ? "Copied" : "Copy report"}
        </button>
        <button type="button" onClick={download} disabled={!items.length}>
          Download
        </button>
        <button type="button" onClick={() => confirm("Clear the whole report and its edits?") && update((s) => ({ ...s, report: [] }))} disabled={!items.length}>
          Clear
        </button>
      </div>
    </>
  );
}

function Item({ item, open, onToggle }: { item: ReportItem; open: boolean; onToggle: () => void }) {
  const unflash = useRef<(() => void) | null>(null);
  const note = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) note.current?.focus();
  }, [open]);
  const matches = (() => {
    try {
      return document.querySelectorAll(item.selector).length;
    } catch {
      return 0;
    }
  })();
  const hover = (on: boolean) => {
    unflash.current?.();
    unflash.current = on ? flash(item.selector) : null;
  };
  const now = (() => {
    try {
      const el = document.querySelector(item.selector);
      return el ? lookOf(el) : item.before;
    } catch {
      return item.before;
    }
  })();
  const edits = Object.keys(item.edits).length;
  return (
    <div className={styles.item} data-open={open || undefined} onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
      <button type="button" className={styles.itemHead} onClick={onToggle}>
        <strong>{item.label}</strong>
        <span className={styles.meta}>
          {item.view}
          {edits ? ` · ${edits} edit${edits > 1 ? "s" : ""}` : ""}
          {item.note ? " · note" : ""}
        </span>
      </button>
      {!open && item.note && <p className={styles.notePreview}>{item.note}</p>}
      {open && (
        <div className={styles.itemBody}>
          <textarea
            ref={note}
            className={styles.note}
            placeholder="What should change here?"
            defaultValue={item.note}
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={(e) => editItem(item.id, (i) => ({ ...i, note: e.currentTarget.value }))}
          />
          <div className={styles.selector} title="Edits apply to every element this selector matches">
            <code>{item.selector}</code>
            <span>{matches} on this page</span>
          </div>
          {item.text && <p className={styles.meta}>“{item.text}”</p>}
          <div className={styles.props}>
            {PROPS.map((p) => {
              const v = item.edits[p] ?? now[p] ?? "";
              const hex = /color/.test(p) ? toHex(v) : null;
              return (
                <div key={p} className={styles.row} data-changed={p in item.edits || undefined}>
                  <span className={styles.preview}>
                    {/color/.test(p) && (
                      <label className={styles.swatch} style={{ background: v }}>
                        {hex && <input type="color" value={hex} onChange={(e) => editItem(item.id, (i) => ({ ...i, edits: { ...i.edits, [p]: e.target.value } }))} />}
                      </label>
                    )}
                  </span>
                  <span className={styles.name}>{p}</span>
                  <ValueField
                    value={v}
                    onCommit={(nv) =>
                      editItem(item.id, (i) => {
                        const e = { ...i.edits };
                        if (nv && nv !== (i.before[p] ?? "")) e[p] = nv;
                        else delete e[p];
                        return { ...i, edits: e };
                      })
                    }
                  />
                  {p in item.edits ? (
                    <button
                      type="button"
                      className={styles.icon}
                      title="Reset"
                      onClick={() =>
                        editItem(item.id, (i) => {
                          const e = { ...i.edits };
                          delete e[p];
                          return { ...i, edits: e };
                        })
                      }
                    >
                      ↺
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>
          <div className={styles.itemFoot}>
            <span className={styles.meta}>
              {item.size[0]} × {item.size[1]} · {new Date(item.at).toLocaleString()}
            </span>
            <button
              type="button"
              onClick={() => {
                unflash.current?.();
                update((s) => ({ ...s, report: s.report.filter((i) => i.id !== item.id) }));
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
