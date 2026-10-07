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
  Swatch,
  cx,
  type PopoverPlacement,
} from "@/ds";
import type { Color, Guid, Paint } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
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
    return (
      <span className={styles.pickGlyph}>
        <Swatch
          color={colorToHex(c)}
          opacity={toPercent(c.a ?? 1)}
          shape="round"
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
}: VariableListProps) {
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

  const item = (v: Variable) => {
    const on = current === v.id;
    const value = values.get(v.id) ?? null;
    return (
      <button
        key={v.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        data-variable={v.name}
        className={cx(styles.pickItem, on && styles.pickItemOn)}
        onClick={() => {
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

  const styleItem = (s: Style) => {
    const on = currentStyle === s.id;
    return (
      <button
        key={s.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        data-style={s.name}
        className={cx(styles.pickItem, on && styles.pickItemOn)}
        onClick={() => {
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

  const groups = (vars: Variable[]) => {
    const out: { group: string; vars: Variable[] }[] = [];
    for (const v of vars) {
      const g = splitName(v.name).group;
      const last = out[out.length - 1];
      if (last && last.group === g) last.vars.push(v);
      else out.push({ group: g, vars: [v] });
    }
    return out;
  };

  const styleFolders = () => {
    const out: { folder: string; list: Style[] }[] = [];
    for (const s of styleList) {
      const f = s.name.includes("/")
        ? s.name.slice(0, s.name.lastIndexOf("/"))
        : "";
      const last = out[out.length - 1];
      if (last && last.folder === f) last.list.push(s);
      else out.push({ folder: f, list: [s] });
    }
    return out;
  };

  const nothing = !byCollection.length && !styleList.length;
  return (
    <div className={styles.picker} data-variable-picker="">
      <div className={styles.pickSearch}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search"
          autoFocus
        />
      </div>
      <div className={styles.pickList} role="menu" aria-label={title}>
        {styleList.length > 0 && (
          <>
            <div className={styles.pickHeader}>Local styles</div>
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
        {byCollection.map(({ c, vars }) => (
          <div key={c.id}>
            <div className={styles.pickHeader}>{c.name}</div>
            {groups(vars).map((g) => (
              <div key={g.group || "root"}>
                {g.group && (
                  <div className={styles.pickGroup}>
                    {g.group.split("/").join(" / ")}
                  </div>
                )}
                {g.vars.map(item)}
              </div>
            ))}
          </div>
        ))}
        {nothing && (
          <div className={styles.pickEmpty}>
            {query
              ? `No results for “${query}”`
              : a.variables.length || a.styles.length
                ? styleKind
                  ? "No styles or variables for this property"
                  : "No variables for this property"
                : styleKind
                  ? "No styles or variables in this file"
                  : "No variables in this file"}
          </div>
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
