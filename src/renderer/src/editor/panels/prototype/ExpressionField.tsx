/**
 * An expression typed as text (help.figma.com 15253194385943; model/expressions.ts): Enter (or leaving the field)
 * stores it when it parses; otherwise the field stays outlined in red ("Invalid conditional statements will be
 * outlined in red") with the reason under it. The ⋯ menu inserts a suggested variable or operator ("the selection
 * panel to choose from suggested variables and operators").
 */
import { useState } from "react";
import { Icon, MenuButton, TextInput, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { formatExpression, parseExpression } from "../../model/expressions";
import type { VariableDataJson } from "../../model/prototype";
import styles from "./Prototype.module.css";

const OPERATORS = ["==", "!=", "<", ">", "<=", ">=", "and", "or", "not", "+", "-", "*", "/"];

export function ExpressionField({
  label,
  data,
  vars,
  onCommit,
}: {
  label: string;
  data: VariableDataJson | undefined;
  vars: readonly { id: Guid; name: string }[];
  onCommit: (d: VariableDataJson) => void;
}) {
  const nameOf = (id: Guid) => vars.find((v) => v.id === id)?.name ?? null;
  const stored = formatExpression(data, nameOf);
  const [draft, setDraft] = useState<{ text: string; error: string | null } | null>(null);
  const text = draft?.text ?? stored;
  const commit = (t: string) => {
    if (!t.trim()) {
      setDraft(null);
      return;
    }
    const r = parseExpression(t, vars);
    if (!r.ok) {
      setDraft({ text: t, error: r.error });
      return;
    }
    setDraft(null);
    onCommit(r.data);
  };
  const insert = (piece: string) => {
    const base = text.trim();
    setDraft({ text: base ? `${base} ${piece}` : piece, error: null });
  };
  const entries: MenuEntry[] = [
    { header: "Variables" },
    ...(vars.length ? vars.map((v) => ({ id: `v:${v.id}`, label: v.name })) : [{ id: "none", label: "No variables", disabled: true }]),
    "-",
    { header: "Operators" },
    ...OPERATORS.map((o) => ({ id: `o:${o}`, label: o })),
  ];
  return (
    <div className={styles.expression}>
      <div className={styles.row}>
        <TextInput
          key={draft ? "draft" : stored}
          label={label}
          className={styles.grow}
          value={text}
          placeholder="Expression"
          invalid={!!draft?.error}
          selectAllOnFocus={false}
          onCommit={commit}
          data-expression=""
        />
        <MenuButton
          label="Suggestions"
          entries={entries}
          className={styles.iconMenu}
          onSelect={(id) => {
            if (id.startsWith("v:")) insert(vars.find((v) => v.id === id.slice(2))?.name ?? "");
            else if (id.startsWith("o:")) insert(id.slice(2));
          }}
        >
          <Icon name="24.more" />
        </MenuButton>
      </div>
      {draft?.error && (
        <div className={styles.expressionError} role="alert">
          {draft.error}
        </div>
      )}
    </div>
  );
}
