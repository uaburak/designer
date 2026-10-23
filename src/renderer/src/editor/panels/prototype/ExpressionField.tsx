/**
 * An expression as Figma's prototype shows it (help.figma.com 15253194385943; measured live 2026-10-23 on a
 * Conditional): the field — 24 high in the secondary fill — reads its variables as pills (their type glyph, the
 * name, in the surface colour inside a hairline), operators in pink, numbers and words as text, and
 * "Write condition" while empty. A click opens the Expression builder over it (258 wide, 30 to its left): the
 * expression being typed on top after "if" (picked variables become pills, typed operators turn pink after a space,
 * Backspace takes the last piece), then the variable list of the variable picker — "All libraries" and "+" (create a
 * variable), the collections and groups, 32 high rows — filtered by the word being typed; ↑ ↓ and Enter pick a
 * variable, Enter otherwise stores the expression when it parses (model/expressions.ts). One that doesn't stays
 * outlined in red with the reason under it ("Invalid conditional statements will be outlined in red").
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, Popover, cx } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { expressionSegments, formatExpression, parseExpression, type ExpressionSegment, type ExpressionVariable } from "../../model/expressions";
import type { VariableDataJson } from "../../model/prototype";
import { VAR_TYPE_ICON_24, splitName, type Variable } from "../../model/variables";
import { VariableList } from "../variables/VariablePicker";
import styles from "./Prototype.module.css";
import { t, useT } from "@/i18n";

const OPERATOR_WORDS = new Set(["==", "!=", "<", ">", "<=", ">=", "and", "or", "not", "!", "+", "-", "*", "/", "(", ")"]);
const ALL_TYPES = ["BOOLEAN", "FLOAT", "STRING", "COLOR"] as const;

type Var = ExpressionVariable & { type?: string };

/** The expression's pieces: pills, operators and text. `compact`: the action list's (no glyph, operators secondary). */
export function ExpressionPieces({ segments, vars, compact }: { segments: readonly ExpressionSegment[]; vars: readonly Var[]; compact?: boolean }) {
  return (
    <>
      {segments.map((s, k) =>
        s.kind === "var" ? (
          <VariableToken key={k} name={s.text} type={vars.find((v) => v.id === s.id)?.type} compact={compact} />
        ) : (
          <span key={k} className={s.kind === "op" ? (compact ? styles.exprOpCompact : styles.exprOp) : compact ? styles.exprTextCompact : styles.exprText}>
            {s.text}
          </span>
        ),
      )}
    </>
  );
}

function VariableToken({ name, type, compact }: { name: string; type?: string; compact?: boolean }) {
  const glyph = type ? VAR_TYPE_ICON_24[type as keyof typeof VAR_TYPE_ICON_24] : undefined;
  return (
    <span className={cx(styles.exprPill, compact && styles.exprPillCompact)} data-expression-variable={name}>
      {!compact && glyph && <Icon name={glyph} />}
      <span className={styles.exprPillName}>{splitName(name).leaf}</span>
    </span>
  );
}

/** Each variable with its collection's modes (`name:mode`) and type. */
export function useExpressionVariables(vars: readonly { id: Guid; name: string; collectionId?: Guid | null; resolvedType?: string }[]): Var[] {
  const ed = useEditor();
  return useMemo(() => {
    const collections = ed.engine.destroyed ? [] : ed.engine.variableCollections();
    const modes = new Map(collections.map((c) => [c.id, c.modes.map((m) => ({ id: m.modeId, name: m.name }))]));
    return vars.map((v) => ({ ...v, type: v.resolvedType, modes: (v.collectionId && modes.get(v.collectionId)) || [] }));
  }, [ed, vars]);
}

/** The stored expression as text (variables by name, modes `name:mode`). */
export function useExpressionText(data: VariableDataJson | undefined, vars: readonly Var[]): string {
  const modeNames = useMemo(() => new Map(vars.flatMap((v) => (v.modes ?? []).map((m) => [m.id, m.name] as const))), [vars]);
  return formatExpression(data, (id) => vars.find((v) => v.id === id)?.name ?? null, (id) => modeNames.get(id) ?? null);
}

export function ExpressionField({
  label,
  data,
  vars,
  onCommit,
  placeholder = "Write condition",
  prefix = "if",
}: {
  label: string;
  data: VariableDataJson | undefined;
  vars: readonly { id: Guid; name: string; collectionId?: Guid | null; resolvedType?: string }[];
  onCommit: (d: VariableDataJson) => void;
  placeholder?: string;
  prefix?: string;
}) {
  useT();
  const withModes = useExpressionVariables(vars);
  const text = useExpressionText(data, withModes);
  const [open, setOpen] = useState<DOMRect | null>(null);
  const field = useRef<HTMLButtonElement>(null);
  const segments = useMemo(() => expressionSegments(text, withModes), [text, withModes]);
  return (
    <>
      <button
        ref={field}
        type="button"
        className={styles.exprField}
        aria-label={label}
        data-expression=""
        aria-expanded={!!open}
        onClick={() => {
          const r = field.current?.getBoundingClientRect();
          // Live: the builder 30 to the field's left, its expression row level with the field (6 above it)
          if (r) setOpen(new DOMRect(r.left - 30, r.top - 6, 0, 0));
        }}
      >
        {segments.length ? <ExpressionPieces segments={segments} vars={withModes} /> : <span className={styles.exprPlaceholder}>{t(placeholder)}</span>}
      </button>
      {open && (
        <ExpressionBuilder
          anchor={open}
          text={text}
          vars={withModes}
          prefix={prefix}
          placeholder={placeholder}
          onCommit={(d) => {
            onCommit(d);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function ExpressionBuilder({
  anchor,
  text,
  vars,
  prefix,
  placeholder,
  onCommit,
  onClose,
}: {
  anchor: DOMRect;
  text: string;
  vars: readonly Var[];
  prefix: string;
  placeholder: string;
  onCommit: (d: VariableDataJson) => void;
  onClose: () => void;
}) {
  useT();
  const ed = useEditor();
  const a = useLocalAssets();
  const [parts, setParts] = useState<ExpressionSegment[]>(() => expressionSegments(text, vars));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // The variables the typed word matches, in the list's order (collections, then their variables)
  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return [] as Variable[];
    return a.collections.flatMap((c) => a.variables.filter((v) => v.collection === c.id && v.name.toLowerCase().includes(q)));
  }, [a, draft]);
  const active = matches[Math.min(cursor, matches.length - 1)] ?? null;
  const full = () => [...parts.map((p) => p.text), draft].join(" ").trim();
  const commit = () => {
    const input = full();
    if (!input) return onClose();
    const r = parseExpression(input, vars);
    if (!r.ok) return setError(r.error);
    onCommit(r.data);
  };
  const pick = (v: { id: Guid; name: string }) => {
    setParts((p) => [...p, { kind: "var", id: v.id, text: v.name }]);
    setDraft("");
    setCursor(0);
    setError(null);
    input.current?.focus();
  };
  // A word typed and a space after it: an operator turns pink, a variable's whole name becomes its pill
  // (a paste brings several words at once, each its own piece)
  const take = (words: string) => {
    const pieces = words
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w): ExpressionSegment => {
        const v = vars.find((x) => x.name === w);
        return v ? { kind: "var", id: v.id, text: v.name } : OPERATOR_WORDS.has(w.toLowerCase()) ? { kind: "op", text: w } : { kind: "text", text: w };
      });
    setParts((p) => [...p, ...pieces]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!matches.length) return;
      e.preventDefault();
      setCursor((c) => (e.key === "ArrowDown" ? Math.min(c + 1, matches.length - 1) : Math.max(c - 1, 0)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) pick(active);
      else commit();
    } else if (e.key === "Backspace" && !draft && parts.length) {
      e.preventDefault();
      const last = parts[parts.length - 1];
      setParts(parts.slice(0, -1));
      // A pill goes whole; an operator or a word comes back to be edited
      if (last.kind !== "var") setDraft(last.text.slice(0, -1));
      setError(null);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  };
  return (
    <Popover anchor={anchor} placement="bottom-start" gap={0} width={258} onClose={commit} label={t("Expression builder")}>
      <div className={styles.builder} data-expression-builder="">
        <div className={cx(styles.builderHead, error && styles.builderInvalid)} onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
          <span className={styles.builderPrefix}>{prefix}</span>
          <div className={styles.builderExpression}>
            <ExpressionPieces segments={parts} vars={vars} />
            <input
              ref={input}
              className={styles.builderInput}
              aria-label={t("Expression")}
              value={draft}
              placeholder={parts.length ? undefined : t(placeholder)}
              autoFocus
              spellCheck={false}
              onChange={(e) => {
                const value = e.target.value;
                setError(null);
                setCursor(0);
                if (/\s$/.test(value) && value.trim()) {
                  take(value);
                  setDraft("");
                } else setDraft(value.replace(/^\s+/, ""));
              }}
              onKeyDown={onKey}
            />
          </div>
        </div>
        {error && (
          <div className={styles.expressionError} role="alert">
            {t(error)}
          </div>
        )}
        <VariableList
          types={ALL_TYPES as never}
          expression
          query={draft}
          active={active?.id ?? null}
          onPick={(v) => pick(v)}
          onCreate={() => {
            ed.ui.set({ variablesOpen: true });
            onClose();
          }}
        />
      </div>
    </Popover>
  );
}
