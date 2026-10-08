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
  Popover,
  SearchField,
  Select,
  Swatch,
  ToggleIconButton,
  cx,
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
  return (
    <Popover
      anchor={anchor}
      title={title}
      width={240}
      placement={placement}
      onClose={onClose}
      label={title}
    >
      <VariableList {...list} label={title} onDone={onClose} />
    </Popover>
  );
}

export type VariableListProps = Omit<
  VariablePickerProps,
  "anchor" | "title" | "placement" | "onClose"
> & { label?: string; onDone?: () => void };

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
}: VariableListProps) {
  const [grid, setGrid] = useState(false);
  const ed = useEditor();
  const onClose = () => onDone?.();
  const title = label;
  const a = useLocalAssets();
  const [query, setQuery] = useState("");
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
    return (
      <button
        key={v.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        data-variable={v.name}
        data-library={r?.remote.libraryName}
        className={cx(styles.pickItem, on && styles.pickItemOn)}
        onClick={() => {
          if (r) return pickRemoteVariable(r);
          onPick(v);
          onClose();
        }}
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
    return (
      <button
        key={s.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        data-style={s.name}
        data-library={r?.remote.libraryName}
        className={cx(styles.pickItem, on && styles.pickItemOn)}
        onClick={() => {
          if (r) return pickRemoteStyle(r);
          onPickStyle?.(s);
          onClose();
        }}
      >
        <StyleGlyph style={s} />
        <span className={styles.pickName}>{styleLeaf(s.name)}</span>
        {s.kind === "TEXT" && (
          <span className={styles.pickValue}>{textStyleSummary(s.node)}</span>
        )}
      </button>
    );
  };

  const groups = <V extends Variable>(vars: V[]) => {
    const out: { group: string; vars: V[] }[] = [];
    for (const v of vars) {
      const g = splitName(v.name).group;
      const last = out[out.length - 1];
      if (last && last.group === g) last.vars.push(v);
      else out.push({ group: g, vars: [v] });
    }
    return out;
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

  const localStyles = showLocal ? styleList : [];
  const localCollections = showLocal ? byCollection : [];
  const nothing = !localCollections.length && !localStyles.length && !libraries.length;
  const sources = [
    { value: "all", label: "All libraries" },
    { value: "local", label: "Created in this file" },
    ...remote.map((lib) => ({ value: lib.library, label: lib.name })),
  ];
  return (
    <div className={cx(styles.picker, colorTab && styles.colorTab, stylesTab && styles.stylesTab)} data-variable-picker="">
      <div className={styles.pickSearch}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search"
          autoFocus
        />
      </div>
      {(libraryState.on || colorTab) && (
        <div className={styles.pickSource}>
          <Select
            label={colorTab ? "Variable set" : "Library"}
            variant={colorTab ? "ghost" : "outlined"}
            width="hug"
            value={sources.some((o) => o.value === source) ? source : "all"}
            options={sources}
            onChange={setSource}
            data-picker-source=""
          />
          {colorTab && <ToggleIconButton icon="24.view.grid" label="Show as grid" tone="secondary" pressed={grid} onPressedChange={setGrid} />}
        </div>
      )}
      <div className={cx(styles.pickList, grid && styles.pickGrid)} role="menu" aria-label={title}>
        {source === "all" && libraries.length > 0 && (localStyles.length > 0 || localCollections.length > 0) && (
          <div className={styles.pickSection}>Created in this file</div>
        )}
        {localStyles.length > 0 && (
          <>
            <div className={styles.pickHeader}>Styles</div>
            {styleFolders().map((f) => (
              <div key={f.folder || "root"}>
                {f.folder && (
                  <div className={styles.pickGroup}>
                    {f.folder.split("/").join(" / ")}
                  </div>
                )}
                {f.list.map(styleItem)}
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
                {g.vars.map((v) => item(v))}
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
                {f.list.map(styleItem)}
              </div>
            ))}
            {libCollections.map(({ c, vars }) => (
              <div key={c.id}>
                {groups(vars).map((g) => (
                  <div key={g.group || "root"}>
                    <div className={styles.pickGroup}>{[c.name, ...(g.group ? g.group.split("/") : [])].join(" / ")}</div>
                    {g.vars.map((v) => item(v, lib.collections))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
        {nothing && (
          stylesTab && !query ? (
            <div className={styles.stylesEmpty}>
              <span>{stylesTab}</span>
              {onBrowse && <Button variant="secondary" onClick={onBrowse}>Browse libraries…</Button>}
            </div>
          ) : (
          <div className={cx(styles.pickEmpty, colorTab && styles.pickEmptyCentered)}>
            {colorTab && !query
              ? "No colors available"
              : query
              ? `No results for “${query}”`
              : a.variables.length || a.styles.length
                ? styleKind
                  ? "No styles or variables for this property"
                  : "No variables for this property"
                : styleKind
                  ? "No styles or variables in this file"
                  : "No variables in this file"}
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
      Open variables
    </Button>
  );
}
