/**
 * The variable picker (UI3 "Apply variable" / the Libraries list): a search,
 * then the file's variables of the field's type whose scopes allow the field,
 * by collection and group (slash path), each with its value as the layer sees
 * it; the bound one ticked. With `styles` it lists the kind's local styles
 * first ("Apply styles and variables" on Fill / Stroke / Effects / Layout
 * guide / Typography), by folder. `onCreate` adds "+ Create variable" /
 * "Create style" at the bottom.
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  Button,
  Icon,
  IconButton,
  Popover,
  SearchField,
  Select,
  Swatch,
  ToggleIconButton,
  cx,
  tooltipProps,
  type PopoverPlacement,
} from "@/ds";
import type { Color, Guid, Paint } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLibraries, useLocalAssets } from "../../hooks";
import { colorToHex, toPercent } from "../../model/color";
import {
  formatLiteral,
  matchesQuery,
  scopeAllows,
  splitName,
  VAR_TYPE_ICON,
  type Literal,
  type Variable,
  type VarType,
} from "../../model/variables";
import {
  styleLeaf,
  textStyleSummary,
  type Style,
  type StyleKind,
} from "../../model/styles";
import { paintSwatch } from "../../model/paints";
import { resolveAt } from "../../variables";
import { pickRemote, remoteDefaultValue, useRemoteAssets, type RemoteStyle, type RemoteVariable } from "../libraries/remoteAssets";
import styles from "./Variables.module.css";
import { t, useT } from "@/i18n";

export interface VariablePickerProps {
  anchor: HTMLElement | DOMRect | null;
  title?: string;
  placement?: PopoverPlacement;
  /** The types offered (a field takes one; an alias of a variable its own) */
  types: readonly VarType[];
  /** The field's scope (null: every variable of the type) */
  scope?: string | null;
  /** The variable bound now (ticked) */
  current?: Guid | null;
  /** Variables not offered (a variable itself, aliases that would cycle) */
  exclude?: ReadonlySet<Guid>;
  /** The layer the values are shown for (its modes); null: the default modes */
  consumer?: Guid | null;
  onPick: (v: Variable) => void;
  /** Local styles of this kind listed first */
  styleKind?: StyleKind;
  currentStyle?: Guid | null;
  onPickStyle?: (s: Style) => void;
  /** "+ Create style" / "+ Create variable" */
  footer?: ReactNode;
  onClose: () => void;
  /**
   * The colour picker's Libraries tab (live popovers/fill-picker-libraries-tab.txt): the search across, "Variable set"
   * (All libraries…) always shown with "Show as grid", "No colors available" when empty
   */
  colorTab?: boolean;
  /** A styles popover (live: "Effect styles"…): the search across, this text when there are none, "Browse libraries…" */
  stylesTab?: string;
  onBrowse?: () => void;
  /**
   * The prototype's Expression builder (live 2026-10-23, 258 wide): no search of its own — the word being typed in the
   * expression filters the list (`query`); "All libraries" with "+" (create a variable) at the end of its row; the
   * row Enter would pick (`active`) lit; values in the tertiary colour.
   */
  expression?: boolean;
  query?: string;
  active?: Guid | null;
  onCreate?: () => void;
}

export function VariableGlyph({
  type,
  value,
}: {
  type: VarType;
  value?: Literal | null;
}) {
  if (type === "COLOR" && value && typeof value === "object") {
    const c = value as Color;
    // Figma: colour variables show square swatches, colour styles round ones.
    return (
      <span className={styles.pickGlyph}>
        <Swatch
          color={colorToHex(c)}
          opacity={toPercent(c.a ?? 1)}
          shape="square"
          size={14}
        />
      </span>
    );
  }
  return (
    <span className={styles.pickGlyph}>
      <Icon name={VAR_TYPE_ICON[type]} />
    </span>
  );
}

/** A style's glyph: "Ag" for text, its paint for a color style, the effect / layout guide glyphs. */
export function StyleGlyph({ style }: { style: Style }) {
  const ed = useEditor();
  switch (style.kind) {
    case "TEXT":
      return <span className={styles.ag}>Ag</span>;
    case "FILL": {
      const p = style.node.fillPaints?.[0] as Paint | undefined;
      const solid = !p || p.type === "SOLID";
      return (
        <span className={styles.pickGlyph}>
          <Swatch
            color={
              solid
                ? colorToHex(p?.color ?? { r: 1, g: 1, b: 1 })
                : paintSwatch(p as never, ed.images.urlOf(null))
            }
            opacity={toPercent(p?.opacity ?? 1)}
            shape="round"
            size={14}
          />
        </span>
      );
    }
    case "EFFECT":
      return (
        <span className={styles.pickGlyph}>
          <Icon name="16.design" />
        </span>
      );
    case "GRID":
      return (
        <span className={styles.pickGlyph}>
          <Icon name="16.frame" />
        </span>
      );
  }
}

export function VariablePicker({
  anchor,
  title = "Apply variable",
  placement = "left-of-panel",
  onClose,
  ...list
}: VariablePickerProps) {
  useT();
  return (
    <Popover
      anchor={anchor}
      title={t(title)}
      width={240}
      placement={placement}
      onClose={onClose}
      label={t(title)}
    >
      <VariableList {...list} label={t(title)} onDone={onClose} />
    </Popover>
  );
}

export type VariableListProps = Omit<
  VariablePickerProps,
  "anchor" | "title" | "placement" | "onClose"
> & { label?: string; onDone?: () => void };

/** The colour picker's grid / list choice, kept between openings as Figma does */
let lastGrid = false;

/** The picker's search and list, on its own (the colour picker's Libraries tab shows it too). */
export function VariableList({
  types,
  scope = null,
  current,
  exclude,
  consumer = null,
  onPick,
  styleKind,
  currentStyle,
  onPickStyle,
  footer,
  label = "Variables",
  onDone,
  colorTab,
  stylesTab,
  onBrowse,
  expression,
  query: queryFrom,
  active,
  onCreate,
}: VariableListProps) {
  useT();
  const [grid, setGridState] = useState(lastGrid);
  const setGrid = (on: boolean) => setGridState((lastGrid = on));
  const ed = useEditor();
  const onClose = () => onDone?.();
  const title = t(label);
  const a = useLocalAssets();
  const [ownQuery, setQuery] = useState("");
  const query = queryFrom ?? ownQuery;
  const offered = useMemo(
    () =>
      a.variables.filter(
        (v) =>
          types.includes(v.type) &&
          scopeAllows(v.scopes, scope) &&
          !exclude?.has(v.id),
      ),
    [a, types, scope, exclude],
  );
  const values = useMemo(
    () => new Map(offered.map((v) => [v.id, resolveAt(ed, v.id, consumer)])),
    [ed, offered, consumer],
  );
  const found = offered.filter((v) =>
    matchesQuery(v, query, formatLiteral(v.type, values.get(v.id) ?? null)),
  );
  const styleList = styleKind
    ? a.styles.filter(
        (s) =>
          s.kind === styleKind &&
          (!query.trim() ||
            s.name.toLowerCase().includes(query.trim().toLowerCase())),
      )
    : [];
  const byCollection = a.collections
    .map((c) => ({ c, vars: found.filter((v) => v.collection === c.id) }))
    .filter((g) => g.vars.length);
  // The enabled libraries' styles and variables (a pick copies one in first, with what it needs), and the
  // dropdown that narrows the list to one source (Figma's "All libraries" / "Created in this file" / a library).
  const remote = useRemoteAssets();
  const libraryState = useLibraries();
  const [source, setSource] = useState<string>("all");
  const showLocal = source === "all" || source === "local";
  const q = query.trim().toLowerCase();
  const libraries = remote
    .filter((lib) => source === "all" || source === lib.library)
    .map((lib) => {
      const vars = lib.variables.filter((v) => types.includes(v.type) && scopeAllows(v.scopes, scope) && !exclude?.has(v.id) && (!q || v.name.toLowerCase().includes(q) || lib.name.toLowerCase().includes(q)));
      return {
        lib,
        styles: styleKind ? lib.styles.filter((s) => s.kind === styleKind && (!q || s.name.toLowerCase().includes(q))) : [],
        byCollection: lib.collections.map((c) => ({ c, vars: vars.filter((v) => v.collection === c.id) })).filter((g) => g.vars.length),
      };
    })
    .filter((l) => l.styles.length || l.byCollection.length);
  const pickRemoteVariable = (v: RemoteVariable) => {
    onClose();
    void pickRemote(ed, v).then((id) => {
      const local = id ? ed.variables.get().lookup.variable(id) : undefined;
      if (local) onPick(local);
    });
  };
  const pickRemoteStyle = (s: RemoteStyle) => {
    onClose();
    void pickRemote(ed, s).then((id) => {
      const local = id ? ed.variables.get().style(id) : undefined;
      if (local) onPickStyle?.(local);
    });
  };

  const item = (v: Variable | RemoteVariable, collections?: readonly { id: Guid; defaultMode: Guid }[]) => {
    const on = current === v.id;
    const r = "remote" in v ? v : null;
    const value = (r && !r.remote.imported ? (remoteDefaultValue(r, (collections ?? []) as never) as Literal | null) : r ? resolveAt(ed, v.id, consumer) : values.get(v.id)) ?? null;
    const pick = () => {
      if (r) return pickRemoteVariable(r);
      onPick(v);
      onClose();
    };
    if (grid && v.type === "COLOR" && value && typeof value === "object") {
      const c = value as Color;
      return (
        <button key={v.id} type="button" role="menuitemradio" aria-checked={on} aria-label={v.name} data-variable={v.name} data-library={r?.remote.libraryName} className={cx(styles.pickSwatch, on && styles.pickSwatchOn)} {...tooltipProps(splitName(v.name).leaf)} onClick={pick}>
          <Swatch color={colorToHex(c)} opacity={toPercent(c.a ?? 1)} className={styles.pickSwatchChit} />
        </button>
      );
    }
    return (
      <button
        key={v.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        data-variable={v.name}
        data-library={r?.remote.libraryName}
        className={cx(styles.pickItem, on && styles.pickItemOn, active === v.id && styles.pickItemActive)}
        onClick={pick}
      >
        <VariableGlyph type={v.type} value={value} />
        <span className={styles.pickName}>{splitName(v.name).leaf}</span>
        {v.type !== "COLOR" && (
          <span className={styles.pickValue}>
            {formatLiteral(v.type, value)}
          </span>
        )}
      </button>
    );
  };

  const styleItem = (s: Style | RemoteStyle) => {
    const on = currentStyle === s.id;
    const r = "remote" in s ? s : null;
    const pick = () => {
      if (r) return pickRemoteStyle(r);
      onPickStyle?.(s);
      onClose();
    };
    if (grid && s.kind === "FILL") {
      return (
        <button key={s.id} type="button" role="menuitemradio" aria-checked={on} aria-label={s.name} data-style={s.name} data-library={r?.remote.libraryName} className={cx(styles.pickSwatch, styles.pickSwatchRound, on && styles.pickSwatchOn)} {...tooltipProps(styleLeaf(s.name))} onClick={pick}>
          <StyleGlyph style={s} />
        </button>
      );
    }
    return (
      <button
        key={s.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        data-style={s.name}
        data-library={r?.remote.libraryName}
        className={cx(styles.pickItem, on && styles.pickItemOn)}
        onClick={pick}
      >
        <StyleGlyph style={s} />
        <span className={styles.pickName}>{styleLeaf(s.name)}</span>
        {s.kind === "TEXT" && (
          <span className={styles.pickValue}>{textStyleSummary(s.node)}</span>
        )}
      </button>
    );
  };

  // One entry per group, in the order groups first appear: a group whose variables aren't kept together (`space/…`
  // between `color/…` rows) is still listed once.
  const groups = <V extends Variable>(vars: V[]) => {
    const out = new Map<string, { group: string; vars: V[] }>();
    for (const v of vars) {
      const g = splitName(v.name).group;
      const entry = out.get(g);
      if (entry) entry.vars.push(v);
      else out.set(g, { group: g, vars: [v] });
    }
    return [...out.values()];
  };

  const styleFolders = <S extends Style>(list: S[] = styleList as S[]) => {
    const out: { folder: string; list: S[] }[] = [];
    for (const s of list) {
      const f = s.name.includes("/")
        ? s.name.slice(0, s.name.lastIndexOf("/"))
        : "";
      const last = out[out.length - 1];
      if (last && last.folder === f) last.list.push(s);
      else out.push({ folder: f, list: [s] });
    }
    return out;
  };

  // Figma's grid view: each group's swatches six to a row under its heading
  const wrap = (items: ReactNode[]) => (grid ? <div className={styles.swatchGrid}>{items}</div> : items);

  const localStyles = showLocal ? styleList : [];
  const localCollections = showLocal ? byCollection : [];
  const nothing = !localCollections.length && !localStyles.length && !libraries.length;
  const sources = [
    { value: "all", label: t("All libraries") },
    { value: "local", label: t("Created in this file") },
    ...remote.map((lib) => ({ value: lib.library, label: lib.name })),
  ];
  return (
    <div className={cx(styles.picker, colorTab && styles.colorTab, stylesTab && styles.stylesTab, expression && styles.colorTab, expression && styles.expressionTab)} data-variable-picker="">
      {queryFrom === undefined && <div className={styles.pickSearch}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("Search")}
          autoFocus
          // Live (popovers/effect-styles.txt, typography-styles, layout-guide-styles): the styles' search is expanded
          expanded={!!stylesTab || undefined}
        />
      </div>}
      {(libraryState.on || colorTab || expression) && (
        <div className={styles.pickSource}>
          <Select
            label={colorTab ? t("Variable set") : t("Library")}
            variant="outlined"
            width="hug"
            value={sources.some((o) => o.value === source) ? source : "all"}
            options={sources}
            onChange={setSource}
            data-picker-source=""
          />
          {/* Figma's toggle shows the other view: the list glyph in the grid, the grid glyph in the list */}
          {onCreate && <IconButton icon="24.plus" label={t("Create variable")} tone="secondary" onClick={onCreate} />}
          {colorTab && (
            <ToggleIconButton
              icon={grid ? "24.view.list" : "24.view.grid"}
              label={grid ? t("Show as list") : t("Show as grid")}
              tone="secondary"
              pressed={false}
              onPressedChange={() => setGrid(!grid)}
            />
          )}
        </div>
      )}
      <div className={cx(styles.pickList, grid && styles.pickGrid)} role="menu" aria-label={title}>
        {source === "all" && libraries.length > 0 && (localStyles.length > 0 || localCollections.length > 0) && (
          <div className={styles.pickSection}>{t("Created in this file")}</div>
        )}
        {localStyles.length > 0 && (
          <>
            <div className={styles.pickHeader}>{t("Styles")}</div>
            {styleFolders().map((f) => (
              <div key={f.folder || "root"}>
                {f.folder && (
                  <div className={styles.pickGroup}>
                    {f.folder.split("/").join(" / ")}
                  </div>
                )}
                {wrap(f.list.map(styleItem))}
              </div>
            ))}
          </>
        )}
        {localCollections.map(({ c, vars }) => (
          <div key={c.id}>
            <div className={styles.pickHeader}>{c.name}</div>
            {groups(vars).map((g) => (
              <div key={g.group || "root"}>
                {g.group && (
                  <div className={styles.pickGroup}>
                    {g.group.split("/").join(" / ")}
                  </div>
                )}
                {wrap(g.vars.map((v) => item(v)))}
              </div>
            ))}
          </div>
        ))}
        {libraries.map(({ lib, styles: libStyles, byCollection: libCollections }) => (
          <div key={lib.library} data-picker-library={lib.name}>
            <div className={styles.pickSection}>{lib.name}</div>
            {styleFolders(libStyles).map((f) => (
              <div key={`s:${f.folder || "root"}`}>
                {f.folder && <div className={styles.pickGroup}>{f.folder.split("/").join(" / ")}</div>}
                {wrap(f.list.map(styleItem))}
              </div>
            ))}
            {libCollections.map(({ c, vars }) => (
              <div key={c.id}>
                {groups(vars).map((g) => (
                  <div key={g.group || "root"}>
                    <div className={styles.pickGroup}>{[c.name, ...(g.group ? g.group.split("/") : [])].join(" / ")}</div>
                    {wrap(g.vars.map((v) => item(v, lib.collections)))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
        {nothing && (
          stylesTab && !query ? (
            <div className={styles.stylesEmpty}>
              <span>{t(stylesTab)}</span>
              {/* Live: 129 wide at 43, its label at 71 — a 24 glyph before it (which glyph is unverified: the library) */}
              {onBrowse && <Button variant="secondary" icon="24.library" aria-label={t("Browse libraries…")} onClick={onBrowse}>{t("Browse libraries…")}</Button>}
            </div>
          ) : (
          <div className={cx(styles.pickEmpty, colorTab && styles.pickEmptyCentered)}>
            {colorTab && !query
              ? t("No colors available")
              : query
              ? t("No results for “{query}”", { query })
              : a.variables.length || a.styles.length
                ? styleKind
                  ? t("No styles or variables for this property")
                  : t("No variables for this property")
                : styleKind
                  ? t("No styles or variables in this file")
                  : t("No variables in this file")}
          </div>
          )
        )}
      </div>
      {footer && <div className={styles.pickFooter}>{footer}</div>}
    </div>
  );
}

/** "Open variables" as the picker's footer when there is nothing to pick (Figma's empty picker). */
export function OpenVariablesButton({ onDone }: { onDone?: () => void }) {
  useT();
  const ed = useEditor();
  return (
    <Button
      variant="ghost"
      icon="24.variable.small"
      onClick={() => {
        ed.ui.set({ variablesOpen: true });
        onDone?.();
      }}
    >
      {t("Open variables")}
    </Button>
  );
}
