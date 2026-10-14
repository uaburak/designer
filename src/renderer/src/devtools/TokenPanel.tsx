// TEMPORARY developer tool (owner, 2026-10-14: "only for us while we build the app's design system; we'll remove it
// later"). A floating panel over any view that lists the chrome's live tokens — colours (brand first), spacing, radius
// and sizes — as the current theme resolves them, and lets us change one and see the whole UI follow at once (an
// inline override on <html>, kept in localStorage until reset). "Copy CSS" copies the changed tokens.
//
// Open/close: ⌥⇧⌘D (Ctrl+Alt+Shift+D elsewhere), or start a view with `?tokens`. Not translated on purpose (dev only).
// To remove: delete src/renderer/src/devtools/ and its two lines in main.tsx.
import { useEffect, useMemo, useState } from "react";
import styles from "./TokenPanel.module.css";

type Group = "brand" | "colors" | "spacing" | "radius" | "sizes";
const GROUPS: { id: Group; label: string; match: (name: string) => boolean }[] = [
  { id: "brand", label: "Brand", match: (n) => /brand|selected|component|accent|ai-/.test(n) && /color/.test(n) },
  { id: "colors", label: "Colors", match: (n) => /color/.test(n) },
  { id: "spacing", label: "Spacing", match: (n) => n.startsWith("--ds-space-") },
  { id: "radius", label: "Radius", match: (n) => n.startsWith("--ds-radius-") },
  { id: "sizes", label: "Sizes", match: (n) => n.startsWith("--ds-size-") },
];
const STORE = "wecra.dev.tokens";

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
    try {
      walk(sheet.cssRules);
    } catch {
      // a cross-origin sheet: not ours
    }
  }
  return [...names].sort(natural);
}
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function loadOverrides(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function applyOverrides(o: Record<string, string>) {
  for (const [k, v] of Object.entries(o)) document.documentElement.style.setProperty(k, v);
}
// Overrides apply as soon as the module loads (before the panel is ever opened)
applyOverrides(loadOverrides());

const isColor = (v: string) => /^(#|rgb|hsl|color\(|oklch|transparent)/i.test(v);
const px = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && /px$/.test(v.trim()) ? n : null;
};

export function TokenPanel() {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has("tokens"));
  const [group, setGroup] = useState<Group>("brand");
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState(loadOverrides);
  const [tick, setTick] = useState(0); // the theme changed: re-read the values

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyD" && e.altKey && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    const mo = new MutationObserver(() => setTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-contrast"] });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      mo.disconnect();
    };
  }, []);

  const names = useMemo(() => (open ? tokenNames() : []), [open]);
  const rows = useMemo(() => {
    if (!open) return [];
    const cs = getComputedStyle(document.documentElement);
    const g = GROUPS.find((x) => x.id === group)!;
    const q = query.trim().toLowerCase();
    return names.filter((n) => g.match(n) && (!q || n.includes(q))).map((n) => ({ name: n, value: cs.getPropertyValue(n).trim() }));
    // tick: re-read when the theme changes; overrides: re-read after an edit
  }, [open, names, group, query, tick, overrides]);

  const set = (name: string, value: string) => {
    const next = { ...overrides };
    if (value) {
      next[name] = value;
      document.documentElement.style.setProperty(name, value);
    } else {
      delete next[name];
      document.documentElement.style.removeProperty(name);
    }
    setOverrides(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      // storage off: the change lasts until reload
    }
  };
  const resetAll = () => {
    for (const k of Object.keys(overrides)) document.documentElement.style.removeProperty(k);
    setOverrides({});
    try {
      localStorage.removeItem(STORE);
    } catch {
      // nothing stored
    }
  };
  const copy = () => {
    const css = `:root {\n${Object.entries(overrides)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n")}\n}`;
    void navigator.clipboard?.writeText(css);
  };

  if (!open) return null;
  const changed = Object.keys(overrides).length;
  return (
    <div className={styles.panel} data-theme-follow="" role="dialog" aria-label="Design tokens">
      <div className={styles.head}>
        <strong>Design tokens</strong>
        <span className={styles.theme}>{document.documentElement.getAttribute("data-theme") ?? "light"}</span>
        <button type="button" className={styles.icon} onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </div>
      <div className={styles.tabs}>
        {GROUPS.map((g) => (
          <button key={g.id} type="button" data-on={g.id === group || undefined} onClick={() => setGroup(g.id)}>
            {g.label}
          </button>
        ))}
      </div>
      <input className={styles.search} placeholder="Filter tokens" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      <div className={styles.list}>
        {rows.map(({ name, value }) => (
          <Row key={name} name={name} value={value} group={group} changed={name in overrides} onSet={(v) => set(name, v)} />
        ))}
        {rows.length === 0 && <p className={styles.empty}>No tokens</p>}
      </div>
      <div className={styles.foot}>
        <span>{changed ? `${changed} changed` : `${rows.length} tokens`}</span>
        <button type="button" onClick={copy} disabled={!changed}>
          Copy CSS
        </button>
        <button type="button" onClick={resetAll} disabled={!changed}>
          Reset all
        </button>
      </div>
    </div>
  );
}

function Row({ name, value, group, changed, onSet }: { name: string; value: string; group: Group; changed: boolean; onSet: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const size = px(value);
  const short = name.replace(/^--(ds|figma)-(color-)?/, "");
  return (
    <div className={styles.row} data-changed={changed || undefined} title={name}>
      <span className={styles.preview}>
        {isColor(value) ? (
          <label className={styles.swatch} style={{ background: value }}>
            {/^#[0-9a-f]{6}$/i.test(value) && <input type="color" value={value} onChange={(e) => onSet(e.target.value)} />}
          </label>
        ) : group === "radius" && size !== null ? (
          <span className={styles.radius} style={{ borderRadius: Math.min(size, 14) }} />
        ) : size !== null ? (
          <span className={styles.bar} style={{ width: Math.min(size, 64) }} />
        ) : null}
      </span>
      <span className={styles.name}>{short}</span>
      <input
        className={styles.value}
        value={draft ?? value}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (v && v !== value) onSet(v);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            const v = e.currentTarget.value.trim();
            if (v && v !== value) onSet(v);
            setDraft(null);
          } else if (e.key === "Escape") setDraft(null);
        }}
      />
      {changed && (
        <button type="button" className={styles.icon} onClick={() => onSet("")} aria-label={`Reset ${name}`} title="Reset">
          ↺
        </button>
      )}
    </div>
  );
}
