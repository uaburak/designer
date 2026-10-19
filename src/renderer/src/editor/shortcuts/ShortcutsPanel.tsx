/**
 * Figma's Keyboard shortcuts panel (⌃⇧?, Help ▸ Keyboard shortcuts; the owner's screenshots of live Figma in
 * docs/research/shortcuts-panel/): docked along the editor's bottom, the full width, 240 high — the panels end over
 * it and the bottom toolbar sits 12 over it; the canvas keeps its size (EditorApp.module.css). Dark in both themes,
 * as Figma's menus. A tab row (Essential … Components, Layout at the right, ✕), and each tab's shortcuts in three
 * columns: a row's label (an icon in Tools and Shape) and its key caps. A shortcut the user has used is lit — the
 * label blue, the caps filled (usage.ts); a tab whose every shortcut is used is lit too.
 *
 * The owner's addition: a command's keys are the user's to change. A click on a row's caps records new keys (Esc
 * cancels, ⌫ clears); a key another command has asks first (Replace / Cancel), one the app or the canvas keeps is
 * refused; "Reset to default" per row, "Reset all" in the tab row. The keys work at once in the editor, the menu bar
 * and the tooltips (keymap.ts, prefs.ts; main rebuilds the menu bar).
 */
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, IS_MAC, Icon, IconButton, KeyCap, Popover, Select, Tabs, radius, size, space, type SelectEntry } from "@/ds";
import { t, useT } from "@/i18n";
import { KEYBOARD_LAYOUTS, type KeyCombo, type KeyboardLayoutId } from "@shared/shortcuts";
import { useEditor } from "../controller";
import { useLibraries, useUI } from "../hooks";
import { bindingCode, comboText } from "../commands";
import { comboCaps, fixedCaps, rowCaps, type Cap } from "./caps";
import { comboOfPress, commandName, conflictsOf, isCustom, keysOf, withBinding, withoutBinding, type Conflict } from "./keymap";
import { drawnKeyboard, layoutMap } from "./layouts";
import { CELEBRATE_END_MS, CELEBRATE_START_MS, ESSENTIALS, SHORTCUT_TABS, celebrateDelay, completedTab, tabUsageIds, usageIds, type ShortcutRow, type ShortcutTab } from "./panelData";
import { shortcutPrefs, useShortcutSettings } from "./prefs";
import styles from "./ShortcutsPanel.module.css";

/** The modifiers held while recording a shortcut: ⌘ is the mod on a Mac (⌃ its own), Ctrl elsewhere. */
const heldOf = (e: KeyboardEvent) => ({ mod: (IS_MAC ? e.metaKey : e.ctrlKey) || undefined, ctrl: (IS_MAC && e.ctrlKey) || undefined, alt: e.altKey || undefined, shift: e.shiftKey || undefined });

/** help.figma.com "Select a keyboard layout" (the Layout tab's "Learn more"). */
const LAYOUT_HELP = "https://help.figma.com/hc/en-us/articles/360040328653";

interface Recording {
  command: string;
  /** The row and part whose caps are being recorded */
  key: string;
}

interface Pending {
  command: string;
  combo: KeyCombo;
  conflicts: Conflict[];
  anchor: HTMLElement | null;
}

export function ShortcutsPanel() {
  const open = useUI((s) => s.shortcutsOpen);
  // Closed: gone, with whatever was being recorded.
  return open ? <Panel /> : null;
}

function Panel() {
  useT();
  const ed = useEditor();
  // Dev Mode opens on View, Design on Essential (Atlas 03 §8).
  const tabId = useUI((s) => s.shortcutsTab ?? (s.mode === "dev" ? "view" : "essential"));
  // Components only when the file uses libraries (§8).
  const libraries = useLibraries().enabled.length > 0;
  const shownTabs = SHORTCUT_TABS.filter((x) => x.id !== "components" || libraries);
  const settings = useShortcutSettings();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [held, setHeld] = useState<Omit<KeyCombo, "code"> | null>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  // A tab just completed: its keys play (`playing`) from 1 500 to 6 000 ms after the shortcut that completed it.
  const [celebration, setCelebration] = useState<{ tab: string; from: number; playing: boolean } | null>(null);
  const usedBefore = useRef(new Set(settings.used));
  useEffect(() => {
    const after = new Set(settings.used);
    const done = completedTab(usedBefore.current, after, SHORTCUT_TABS);
    usedBefore.current = after;
    if (!done) return;
    setCelebration({ ...done, playing: false });
    const start = setTimeout(() => setCelebration((c) => (c && c.tab === done.tab ? { ...c, playing: true } : c)), CELEBRATE_START_MS);
    const end = setTimeout(() => setCelebration((c) => (c && c.tab === done.tab ? null : c)), CELEBRATE_END_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(end);
    };
  }, [settings.used]);

  // Recording: the next key press (not a modifier alone) is the command's — nothing else sees it.
  useEffect(() => {
    if (!recording) return;
    const stop = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      stop(e);
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (e.code === "Escape" && plain) return setRecording(null);
      if ((e.code === "Backspace" || e.code === "Delete") && plain) {
        shortcutPrefs.update({ bindings: withBinding(shortcutPrefs.get().bindings, recording.command, null) });
        return setRecording(null);
      }
      const code = bindingCode(e.code);
      const combo = code ? comboOfPress(e, code) : null;
      if (!combo) {
        setHeld(heldOf(e));
        return;
      }
      const bindings = shortcutPrefs.get().bindings;
      const conflicts = conflictsOf(combo, recording.command, bindings);
      if (conflicts.length) {
        setPending({ command: recording.command, combo, conflicts, anchor: anchors.current.get(recording.key) ?? null });
        return setRecording(null);
      }
      shortcutPrefs.update({ bindings: withBinding(bindings, recording.command, combo) });
      setRecording(null);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      stop(e);
      setHeld(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey ? heldOf(e) : null);
    };
    // A press anywhere else stops recording.
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-shortcut-recording]")) setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      setHeld(null);
    };
  }, [recording]);

  const tab = shownTabs.find((x) => x.id === tabId) ?? shownTabs[0];
  const used = new Set(settings.used);
  const legend = layoutMap(settings.layout).label;
  const identity = settings.layout === "generic" || settings.layout === "us";
  const anyCustom = Object.keys(settings.bindings).length > 0;
  const close = () => {
    ed.ui.set({ shortcutsOpen: false });
    ed.focusCanvas();
  };

  const start = (command: string, key: string) => {
    setPending(null);
    setRecording((r) => (r?.key === key ? null : { command, key }));
  };

  /** A command's caps: a button that records new keys. */
  const capsButton = (command: string, key: string, caps: Cap[], lit: boolean, label: string) => {
    const isRecording = recording?.key === key;
    return (
      <button
        key={key}
        type="button"
        ref={(el) => {
          if (el) anchors.current.set(key, el);
          else anchors.current.delete(key);
        }}
        className={styles.capsButton}
        aria-label={t("Change shortcut: {name}", { name: t(label) })}
        data-shortcut-caps={command}
        data-shortcut-recording={isRecording ? "" : undefined}
        onClick={() => start(command, key)}
      >
        {isRecording ? (
          <>
            {held && comboCaps({ code: "", ...held }).slice(0, -1).map((c, i) => <KeyCap key={i}>{c.text}</KeyCap>)}
            <KeyCap recording>{t("Press keys…")}</KeyCap>
          </>
        ) : caps.length ? (
          caps.map((c, i) => (
            <KeyCap key={i} lit={lit} icon={c.icon}>
              {c.text}
            </KeyCap>
          ))
        ) : (
          <span className={styles.none}>{t("None")}</span>
        )}
      </button>
    );
  };

  const resetButton = (commands: string[]) =>
    commands.some((c) => isCustom(c, settings.bindings)) ? (
      <IconButton
        icon="24.reset.instance.small"
        label={t("Reset to default")}
        tone="secondary"
        className={styles.reset}
        data-shortcut-reset={commands[0]}
        onClick={() => {
          let b = settings.bindings;
          for (const c of commands) b = withoutBinding(b, c);
          shortcutPrefs.update({ bindings: b });
        }}
      />
    ) : null;

  /** A row of the tab being celebrated: its keys play after their delay. */
  const celebrating = (row: Exclude<ShortcutRow, { kind: "heading" }>) => {
    if (!celebration?.playing || celebration.tab !== tab.id) return {};
    const at = tabUsageIds(tab).indexOf(usageIds(row)[0]);
    return { "data-celebrate": "", style: { "--celebrate-delay": `${celebrateDelay(Math.max(0, at), celebration.from)}ms` } as CSSProperties };
  };

  const renderRow = (row: ShortcutRow, i: number): ReactNode => {
    if (row.kind === "heading") return <div key={i} className={row.tone === "strong" ? styles.heading : styles.hint}>{t(row.text)}</div>;
    const lit = usageIds(row).some((u) => used.has(u));
    let keys: ReactNode;
    if (row.kind === "fixed") {
      keys = (
        <span className={styles.caps}>
          {fixedCaps(row.caps).map((c, j) => (
            <KeyCap key={j} lit={lit} icon={c.icon}>
              {c.text && t(c.text)}
            </KeyCap>
          ))}
        </span>
      );
    } else {
      const groups = rowCaps(row, settings.bindings, undefined, identity ? undefined : legend);
      keys = (
        <span className={styles.caps}>
          {resetButton(row.parts.map((p) => p.command))}
          {groups.map((g, j) => (
            <Fragment key={j}>
              {j > 0 && <span className={styles.and}>{t("and")}</span>}
              {capsButton(row.parts[g.part].command, `${row.id}:${g.part}`, g.caps, lit, row.parts.length > 1 ? commandName(row.parts[g.part].command) : row.label)}
            </Fragment>
          ))}
        </span>
      );
    }
    return (
      <div key={i} className={styles.row} data-shortcut-row={row.id} data-lit={lit ? "" : undefined} {...celebrating(row)}>
        {row.icon && <Icon name={row.icon} className={styles.icon} />}
        <span className={styles.label}>{t(row.label)}</span>
        {keys}
      </div>
    );
  };

  const tabs = shownTabs.map((tb: ShortcutTab) => {
    const ids = tabUsageIds(tb);
    return { value: tb.id, label: t(tb.label), lit: ids.length > 0 && ids.every((u) => used.has(u)) };
  });

  let body: ReactNode;
  if (tab.id === "essential") {
    body = (
      <div className={styles.essential}>
        <div className={styles.essentialTitle}>{t("Essential keyboard shortcuts")}</div>
        <div className={styles.grid}>
          {ESSENTIALS.map((item, i) => {
            const lit = used.has(item.command);
            const first = keysOf(item.command, settings.bindings)[0];
            return (
              <div key={item.command} className={styles.essentialItem} data-shortcut-row={item.command} data-lit={lit ? "" : undefined}>
                <span className={styles.number}>{i + 1}</span>
                <div className={styles.row}>
                  <span className={styles.essentialName}>{t(item.title)}</span>
                  <span className={styles.caps}>
                    {resetButton([item.command])}
                    {capsButton(item.command, `essential:${item.command}`, first ? comboCaps(first, undefined, identity ? undefined : legend) : [], lit, item.title)}
                  </span>
                </div>
                <p className={styles.description}>{t(item.description)}</p>
              </div>
            );
          })}
        </div>
      </div>
    );
  } else if (tab.id === "layout") {
    body = <LayoutTab layout={settings.layout} />;
  } else {
    body = (
      <div className={styles.grid}>
        {(tab.columns ?? []).map((col, c) => (
          <div key={c} className={styles.column}>
            {col.map(renderRow)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <section data-shortcuts-panel="" data-theme="dark" className={styles.panel} aria-label={t("Keyboard shortcuts")}>
      <div className={styles.tabRow}>
        <Tabs label={t("Keyboard shortcuts")} variant="card" className={styles.tabs} value={tab.id} tabs={tabs} onChange={(v) => ed.ui.set({ shortcutsTab: v })} />
        <div className={styles.actions}>
          {anyCustom && (
            <Button variant="ghost" data-shortcut-reset-all="" onClick={() => shortcutPrefs.update({ bindings: {} })}>
              {t("Reset all")}
            </Button>
          )}
          <IconButton icon="24.close.small" label={t("Close")} tone="secondary" onClick={close} />
        </div>
      </div>
      <div className={styles.body}>{body}</div>
      {pending && (
        <Popover anchor={pending.anchor} placement="top" width={240} label={t("Shortcut already in use")} onClose={() => setPending(null)}>
          <div className={styles.conflict}>
            <p>
              {pending.conflicts[0].id === null
                ? t("{keys} is used for {name} and can't be changed.", { keys: comboText(pending.combo), name: t(pending.conflicts[0].label) })
                : t("{keys} is already used for {names}.", { keys: comboText(pending.combo), names: pending.conflicts.map((c) => t(c.label)).join(", ") })}
            </p>
            <div className={styles.conflictActions}>
              <Button variant="secondary" onClick={() => setPending(null)}>
                {t("Cancel")}
              </Button>
              {pending.conflicts[0].id !== null && (
                <Button
                  variant="primary"
                  data-shortcut-replace=""
                  onClick={() => {
                    shortcutPrefs.update({ bindings: withBinding(shortcutPrefs.get().bindings, pending.command, pending.combo, true) });
                    setPending(null);
                  }}
                >
                  {t("Replace")}
                </Button>
              )}
            </div>
          </div>
        </Popover>
      )}
    </section>
  );
}

/**
 * An ISO keyboard's tall Return outlined: its upper part `top` wide, its lower part (the next row's) `lower` wide, the
 * right edges aligned — a key's border and corners (the cap itself draws none).
 */
function TallKeyShape({ top, lower }: { top: number; lower: number }) {
  const h = size["keyboard-key-height"];
  const total = 2 * h + space["2"];
  const r = radius.small;
  const e = 0.5; // the 1px stroke on the pixel grid
  const l = top - lower + e;
  const d = [
    `M ${e + r} ${e}`,
    `H ${top - e - r} Q ${top - e} ${e} ${top - e} ${e + r}`,
    `V ${total - e - r} Q ${top - e} ${total - e} ${top - e - r} ${total - e}`,
    `H ${l + r} Q ${l} ${total - e} ${l} ${total - e - r}`,
    `V ${h - e} H ${e + r} Q ${e} ${h - e} ${e} ${h - e - r}`,
    `V ${e + r} Q ${e} ${e} ${e + r} ${e} Z`,
  ].join(" ");
  return (
    <svg className={styles.tallKeyShape} width={top} height={total} viewBox={`0 0 ${top} ${total}`} aria-hidden>
      <path d={d} />
    </svg>
  );
}

/**
 * The Layout tab's list (Atlas 03 §8): the system's layout under "Detected", then "Other layouts" by name with Generic
 * (Figma's "default / unknown") last; without one detected, the list alone.
 */
export function layoutOptions(detected: KeyboardLayoutId | null): SelectEntry[] {
  const option = (l: (typeof KEYBOARD_LAYOUTS)[number]): SelectEntry => ({ value: l.id, label: t(l.label) });
  const others = [...KEYBOARD_LAYOUTS.slice(1), KEYBOARD_LAYOUTS[0]].filter((l) => l.id !== detected);
  const found = KEYBOARD_LAYOUTS.find((l) => l.id === detected);
  return found ? [{ header: t("Detected") }, option(found), { header: t("Other layouts") }, ...others.map(option)] : others.map(option);
}

/** The Layout tab: "Keyboard layout:" and the keyboard drawn with the layout's legends. */
function LayoutTab({ layout }: { layout: KeyboardLayoutId }) {
  useT();
  const shown = layout;
  const settings = useShortcutSettings();
  return (
    <div className={styles.layout}>
      <div className={styles.layoutSide}>
        <label className={styles.layoutField}>
          <span className={styles.layoutLabel}>{t("Keyboard layout:")}</span>
          <Select
            label={t("Keyboard layout")}
            value={layout}
            width={179}
            openUnhighlighted
            options={layoutOptions(shortcutPrefs.detectedLayout())}
            onChange={(v) => shortcutPrefs.update({ layout: v as KeyboardLayoutId })}
          />
        </label>
        {/* Figma's note under the list (hidden for its unknown layout); here once a layout is picked — until then the system's is followed. */}
        {settings.layoutPicked && layout !== "generic" && <p className={styles.layoutNote}>{t("Keyboard shortcuts won’t automatically change if you change your system keyboard layout")}</p>}
        <Button variant="link" className={styles.learnMore} onClick={() => window.open(LAYOUT_HELP, "_blank", "noopener")}>
          {t("Learn more")}
        </Button>
      </div>
      <div className={styles.keyboard} role="img" aria-label={t("{layout} keyboard", { layout: t(KEYBOARD_LAYOUTS.find((l) => l.id === shown)?.label ?? "") })} data-keyboard={shown}>
        {drawnKeyboard(shown).map((row, r) => (
          <div key={r} className={styles.keyboardRow}>
            {row.map((k) =>
              k.tall?.part === "below" ? (
                <span key={k.code} className={styles.keyRoom} style={{ width: k.width }} />
              ) : k.tall ? (
                <KeyCap key={k.code} size="small" className={styles.tallKey} style={{ width: k.width }} data-key={k.code}>
                  <TallKeyShape top={k.width} lower={k.tall.lower} />
                  {k.legend}
                </KeyCap>
              ) : (
                <KeyCap key={k.code} size="small" style={{ width: k.width }} data-key={k.code}>
                  {k.legend}
                </KeyCap>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
