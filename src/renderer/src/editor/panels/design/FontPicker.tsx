/**
 * The font picker (Figma UI3's Typography: help.figma.com "Browse and apply fonts", docs/research/figma/R11-fonts.md):
 * the Font family field opens a panel left of the right panel with a search, the filter menu ("All fonts", "In this
 * file", "Popular", "Installed by you", "Google fonts", "Variable fonts" — remembered for the session) and every family
 * in one list, each name drawn in its own face (only the rows on screen load one). Hovering a family, or moving to it
 * with ↑ ↓, previews it on the selected text; a click (or Enter) applies it, Esc or a click outside puts the text
 * back. A family with more than one style has a chevron that opens its styles (a variable font's named instances),
 * each in its face.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, Popover, SearchField, Select, VirtualList, type Mixed, isMixed } from "@/ds";
import { closestStyle, type FontFamily } from "@/engine/fonts";
import { FONT_FILTERS, filterFamilies, hasStyle, type FontFilter } from "../../fontList";
import { useFontPreview } from "../../fontPreview";
import styles from "./FontPicker.module.css";

const ROW = 32;
/** How long a hover rests on a family before the canvas previews it (a sweep across the list previews nothing). */
const PREVIEW_DELAY_MS = 120;

/** The filter chosen last, for the session (Figma remembers it per session). */
let sessionFilter: FontFilter = "all";

export interface FontFieldProps {
  family: Mixed<string>;
  style: Mixed<string>;
  list: readonly FontFamily[] | null;
  /** Families the document uses (lower case): "In this file" (read when the picker opens) */
  fileFamilies: () => ReadonlySet<string>;
  disabled?: boolean;
  /** Live preview of a family (null: back to what the text had) */
  onPreview?: (font: { family: string; style: string } | null) => void;
  onPick: (font: { family: string; style: string }) => void;
}

/** The Font family field and its picker. */
export function FontField({ family, style, list, fileFamilies, disabled, onPreview, onPick }: FontFieldProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // What the text had when the picker opened (a preview changes the live value; the tick stays on the original).
  const [opened, setOpened] = useState<{ family: string | null; style: string | null }>({ family: null, style: null });
  const open = (el: HTMLElement) => {
    setOpened({ family: isMixed(family) ? null : family, style: isMixed(style) ? null : style });
    setAnchor(el);
  };
  const known = !isMixed(family) && list ? list.some((f) => f.family.toLowerCase() === family.toLowerCase()) : true;
  const fam = !isMixed(family) && list ? list.find((f) => f.family.toLowerCase() === family.toLowerCase()) : undefined;
  const missing = !isMixed(family) && list !== null && (!known || (!isMixed(style) && fam !== undefined && !hasStyle(fam, style)));
  return (
    <>
      <button
        type="button"
        className={styles.field}
        aria-label="Font family"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        data-font-field=""
        disabled={disabled}
        onClick={(e) => (anchor ? setAnchor(null) : open(e.currentTarget))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open(e.currentTarget);
          }
        }}
      >
        {missing && (
          <span className={styles.missingIcon} title="Missing font" data-missing-font="">
            <Icon name="24.warning" />
          </span>
        )}
        <span className={isMixed(family) ? `${styles.fieldValue} ${styles.fieldMixed}` : styles.fieldValue}>{isMixed(family) ? "Mixed" : family}</span>
        <span className={styles.fieldChevron}>
          <Icon name="16.chevron.down" />
        </span>
      </button>
      {anchor && (
        <FontPicker
          anchor={anchor}
          family={opened.family}
          style={opened.style}
          list={list}
          fileFamilies={fileFamilies}
          onPreview={onPreview}
          onPick={(f) => {
            onPick(f);
            setAnchor(null);
          }}
          onClose={() => {
            onPreview?.(null);
            setAnchor(null);
          }}
        />
      )}
    </>
  );
}

export interface FontPickerProps {
  anchor: HTMLElement;
  family: string | null;
  style: string | null;
  list: readonly FontFamily[] | null;
  fileFamilies: () => ReadonlySet<string>;
  onPreview?: (font: { family: string; style: string } | null) => void;
  onPick: (font: { family: string; style: string }) => void;
  onClose: () => void;
}

export function FontPicker({ anchor, family, style, list, fileFamilies, onPreview, onPick, onClose }: FontPickerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilterState] = useState<FontFilter>(sessionFilter);
  const setFilter = (f: FontFilter) => {
    sessionFilter = f;
    setFilterState(f);
  };
  // The document's families as the picker opened (before any preview changed the text).
  const [inFile] = useState(fileFamilies);
  const shown = useMemo(() => filterFamilies(list ?? [], filter, query, inFile), [list, filter, query, inFile]);
  const currentIndex = family ? shown.findIndex((f) => f.family.toLowerCase() === family.toLowerCase()) : -1;
  const [active, setActive] = useState(currentIndex);
  const [scrollTo, setScrollTo] = useState(currentIndex >= 0 ? Math.max(0, currentIndex - 5) : 0);
  const [stylesOf, setStylesOf] = useState<{ family: FontFamily; anchor: HTMLElement } | null>(null);
  const previewTimer = useRef(0);
  const previewed = useRef<string | null>(null);

  // A new search or filter starts at the top.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setActive(query ? 0 : -1);
    setScrollTo(0);
  }, [query, filter]);

  const styleFor = (f: FontFamily) => closestStyle(f.styles, style ?? "Regular");
  const preview = (f: FontFamily | null, delay = PREVIEW_DELAY_MS) => {
    window.clearTimeout(previewTimer.current);
    if (!onPreview) return;
    const key = f ? f.family : null;
    if (key === previewed.current) return;
    previewTimer.current = window.setTimeout(() => {
      previewed.current = key;
      onPreview(f ? { family: f.family, style: styleFor(f) } : null);
    }, delay);
  };
  useEffect(() => () => window.clearTimeout(previewTimer.current), []);

  const pick = (f: FontFamily, s = styleFor(f)) => {
    window.clearTimeout(previewTimer.current);
    onPick({ family: f.family, style: s });
  };

  const move = (to: number) => {
    if (!shown.length) return;
    const i = Math.max(0, Math.min(shown.length - 1, to));
    setActive(i);
    setScrollTo(i);
    preview(shown[i], 0);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(active - 1);
    } else if (e.key === "Enter" && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "ArrowRight" && active >= 0 && shown[active] && shown[active].styles.length > 1) {
      const row = document.querySelector<HTMLElement>(`[data-font-row="${CSS.escape(shown[active].family)}"]`);
      if (row) setStylesOf({ family: shown[active], anchor: row });
    }
  };

  return (
    <Popover anchor={anchor} label="Fonts" width={240} onClose={onClose}>
      <div className={styles.picker} data-font-picker="" onKeyDown={onKey} onMouseLeave={() => preview(null, 0)}>
        <div className={styles.search}>
          <SearchField value={query} onChange={setQuery} placeholder="Search fonts" label="Search fonts" autoFocus onExit={(r) => r === "escape" && onClose()} />
        </div>
        <div className={styles.filter}>
          <Select label="Font filter" variant="ghost" width="hug" value={filter} options={FONT_FILTERS.map((f) => ({ value: f.value, label: f.label }))} onChange={(v) => setFilter(v as FontFilter)} data-font-filter="" />
        </div>
        <div className={styles.list} role="listbox" aria-label="Fonts">
          {list === null ? (
            <div className={styles.empty}>Loading fonts…</div>
          ) : shown.length === 0 ? (
            <div className={styles.empty}>{query ? `No fonts match “${query}”` : filter === "file" ? "No fonts in this file" : "No fonts"}</div>
          ) : (
            <VirtualList
              count={shown.length}
              rowHeight={ROW}
              overscan={4}
              scrollToIndex={scrollTo}
              label="Fonts"
              renderRow={(i) => (
                <FontRow
                  family={shown[i]}
                  current={!!family && shown[i].family.toLowerCase() === family.toLowerCase()}
                  active={i === active}
                  stylesOpen={stylesOf?.family.family === shown[i].family}
                  onHover={() => {
                    setActive(i);
                    preview(shown[i]);
                  }}
                  onPick={() => pick(shown[i])}
                  onStyles={(el) => setStylesOf(stylesOf?.family.family === shown[i].family ? null : { family: shown[i], anchor: el })}
                />
              )}
            />
          )}
        </div>
      </div>
      {stylesOf && (
        <StylesMenu
          family={stylesOf.family}
          anchor={stylesOf.anchor}
          current={family && stylesOf.family.family.toLowerCase() === family.toLowerCase() ? style : null}
          onHover={(s) => onPreview?.({ family: stylesOf.family.family, style: s })}
          onPick={(s) => pick(stylesOf.family, s)}
          onClose={() => setStylesOf(null)}
        />
      )}
    </Popover>
  );
}

function FontRow({ family, current, active, stylesOpen, onHover, onPick, onStyles }: {
  family: FontFamily;
  current: boolean;
  active: boolean;
  stylesOpen: boolean;
  onHover: () => void;
  onPick: () => void;
  onStyles: (anchor: HTMLElement) => void;
}) {
  const face = useFontPreview(family);
  return (
    <div
      className={styles.row}
      role="option"
      aria-selected={current}
      data-active={active || undefined}
      data-font-row={family.family}
      data-font-source={family.source}
      onMouseEnter={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className={styles.check}>{current && <Icon name="16.check" />}</span>
      {face === undefined ? (
        <span className={styles.skeleton} aria-label={family.family} />
      ) : (
        <span className={styles.name} style={face ? { fontFamily: `${face}, var(--ds-font-family)` } : undefined} data-font-preview={face ? "" : undefined}>
          {family.family}
        </span>
      )}
      {family.styles.length > 1 && (
        <button
          type="button"
          className={styles.stylesButton}
          aria-label={`${family.family} styles`}
          aria-expanded={stylesOpen}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onStyles(e.currentTarget.closest<HTMLElement>("[data-font-row]") ?? e.currentTarget);
          }}
        >
          <Icon name="16.chevron.right" />
        </button>
      )}
    </div>
  );
}

/** A family's styles, right of its row, each drawn in its own weight and slant when the family's face allows. */
function StylesMenu({ family, anchor, current, onHover, onPick, onClose }: {
  family: FontFamily;
  anchor: HTMLElement;
  current: string | null;
  onHover: (style: string) => void;
  onPick: (style: string) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const face = useFontPreview(family);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const panel = anchor.closest<HTMLElement>("[data-font-picker]")?.getBoundingClientRect() ?? r;
    const h = menu.current?.offsetHeight ?? 200;
    setPos({ left: panel.right + 4, top: Math.max(8, Math.min(r.top - 8, window.innerHeight - 8 - h)) });
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [anchor, onClose]);
  // Only the family's Regular is loaded for a Google preview: its styles show in the UI font then.
  const styled = face && family.source !== "google";
  // Inside the picker's panel (fixed, so not clipped by it): a press on it isn't "outside" the picker.
  return (
    <>
      <div
        ref={menu}
        className={styles.styles}
        role="menu"
        aria-label={`${family.family} styles`}
        data-font-styles={family.family}
        style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "ArrowLeft") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        {family.faces
          .filter((f, i, all) => all.findIndex((x) => x.style === f.style) === i)
          .map((f) => (
            <button
              key={f.style}
              type="button"
              role="menuitemradio"
              aria-checked={current === f.style}
              className={styles.styleItem}
              data-font-style={f.style}
              onMouseEnter={() => onHover(f.style)}
              onClick={() => onPick(f.style)}
            >
              <span className={styles.styleCheck}>{current === f.style && <Icon name="16.check" />}</span>
              <span className={styles.styleName} style={styled ? { fontFamily: `${face}, var(--ds-font-family)`, fontWeight: f.weight, fontStyle: f.italic ? "italic" : "normal" } : undefined}>
                {f.style}
              </span>
            </button>
          ))}
      </div>
    </>
  );
}
