/**
 * The Admin views' building blocks: the sortable table with its checkboxes, a person's cell, the row menu, and the
 * dialogs every tab uses (confirm, a choice among options, a name, picking people or teams).
 */
import { useMemo, useState, type ReactNode } from "react";
import { Avatar, Button, Checkbox, Dialog, Icon, MenuButton, MIXED, RadioGroup, SearchField, TextInput, type MenuEntry } from "@/ds";
import type { PersonRef } from "@shared/org/types";
import styles from "./Admin.module.css";

export { styles };

export interface Column<T> {
  id: string;
  label: string;
  /** A grid track (px or "1fr"); default "minmax(0, 1fr)" */
  width?: number | string;
  align?: "end";
  /** Sortable: compares two rows */
  compare?: (a: T, b: T) => number;
  render: (row: T) => ReactNode;
}
export type SortState = { column: string; direction: "ascending" | "descending" };

export interface TableProps<T> {
  label: string;
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Checkboxes before the first column */
  selection?: ReadonlySet<string>;
  onSelectionChange?: (next: Set<string>) => void;
  onRowClick?: (row: T) => void;
  muted?: (row: T) => boolean;
  initialSort?: SortState;
  empty?: string;
}

export function Table<T>({ label, rows, columns, rowKey, selection, onSelectionChange, onRowClick, muted, initialSort, empty = "Nothing to show" }: TableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.id === sort.column);
    if (!col?.compare) return rows;
    const out = [...rows].sort(col.compare);
    return sort!.direction === "descending" ? out.reverse() : out;
  }, [rows, columns, sort]);
  const selectable = Boolean(selection && onSelectionChange);
  const template = [selectable ? "24px" : null, ...columns.map((c) => (c.width === undefined ? "minmax(0, 1fr)" : typeof c.width === "number" ? `${c.width}px` : c.width))].filter(Boolean).join(" ");
  const keys = sorted.map(rowKey);
  const chosen = selectable ? keys.filter((k) => selection!.has(k)).length : 0;
  const toggle = (k: string) => {
    const next = new Set(selection);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onSelectionChange!(next);
  };
  return (
    <div role="table" aria-label={label} className={styles.table} data-admin-table={label}>
      <div role="row" className={styles.thead} style={{ gridTemplateColumns: template }}>
        {selectable && (
          <div role="columnheader" className={styles.th}>
            <Checkbox label="Select all" hideLabel checked={chosen === 0 ? false : chosen === keys.length ? true : MIXED} onChange={(on) => onSelectionChange!(on ? new Set(keys) : new Set())} />
          </div>
        )}
        {columns.map((c) => {
          const active = sort?.column === c.id;
          return (
            <div key={c.id} role="columnheader" aria-sort={active ? sort!.direction : c.compare ? "none" : undefined} className={`${styles.th} ${c.align === "end" ? styles.end : ""}`}>
              {c.compare ? (
                <button type="button" className={styles.sort} data-active={active || undefined} onClick={() => setSort(active ? { column: c.id, direction: sort!.direction === "ascending" ? "descending" : "ascending" } : { column: c.id, direction: "ascending" })}>
                  {c.label}
                  {active && <Icon name={sort!.direction === "ascending" ? "16.arrow.up" : "16.arrow.down"} />}
                </button>
              ) : (
                c.label
              )}
            </div>
          );
        })}
      </div>
      {sorted.length === 0 && <div className={styles.empty}>{empty}</div>}
      {sorted.map((row) => {
        const k = rowKey(row);
        const on = selectable && selection!.has(k);
        return (
          <div
            key={k}
            role="row"
            data-row={k}
            aria-selected={on}
            data-muted={muted?.(row) || undefined}
            data-clickable={onRowClick ? "" : undefined}
            className={styles.tr}
            style={{ gridTemplateColumns: template }}
            onClick={onRowClick ? (e) => !(e.target as Element).closest("button,label,input,[role=menu]") && onRowClick(row) : undefined}
          >
            {selectable && (
              <div role="cell" className={styles.td}>
                <Checkbox label="Select" hideLabel checked={on} onChange={() => toggle(k)} />
              </div>
            )}
            {columns.map((c) => (
              <div key={c.id} role="cell" className={`${styles.td} ${c.align === "end" ? styles.end : ""}`}>
                {c.render(row)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export const byText = <T,>(get: (r: T) => string | null | undefined) => (a: T, b: T) => (get(a) ?? "").localeCompare(get(b) ?? "", "en", { sensitivity: "base" });
export const byNumber = <T,>(get: (r: T) => number | null | undefined) => (a: T, b: T) => (get(a) ?? -Infinity) - (get(b) ?? -Infinity);

/** A person: the 24 avatar, the name over the email (a pending invite shows its email alone) */
export function Who({ person, badge }: { person: Pick<PersonRef, "name" | "email" | "picture">; badge?: ReactNode }) {
  return (
    <span className={styles.who}>
      <Avatar name={person.name ?? person.email} src={person.picture ?? undefined} size={24} />
      <span className={styles.whoText}>
        <span className={styles.whoName}>
          {person.name ?? person.email}
          {badge}
        </span>
        {person.name && <span className={styles.whoEmail}>{person.email}</span>}
      </span>
    </span>
  );
}

/** The row's "…" menu */
export function RowMenu({ label, entries, onSelect }: { label: string; entries: MenuEntry[]; onSelect: (id: string) => void }) {
  return (
    <span className={styles.hoverOnly}>
      <MenuButton label={label} entries={entries} onSelect={onSelect} align="end" tooltip={false}>
        <Icon name="24.more" />
      </MenuButton>
    </span>
  );
}

export function ConfirmDialog({ title, body, confirm, destructive, onConfirm, onClose }: { title: string; body: ReactNode; confirm: string; destructive?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={title}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "primary"} onClick={() => { onConfirm(); onClose(); }}>{confirm}</Button>
        </>
      }
    >
      <div className={styles.note}>{body}</div>
    </Dialog>
  );
}

export type Choice = { value: string; label: string; description?: string; disabled?: boolean };

/** One of a few options (a seat, a role, a setting), then Save */
export function ChoiceDialog({ title, label, intro, choices, value, confirm = "Save", onSave, onClose }: { title: string; label: string; intro?: ReactNode; choices: Choice[]; value: string | null; confirm?: string; onSave: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState<string | null>(value);
  return (
    <Dialog
      title={title}
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={v === null} onClick={() => { onSave(v!); onClose(); }}>{confirm}</Button>
        </>
      }
    >
      <div className={styles.form}>
        {intro && <div className={styles.note}>{intro}</div>}
        <RadioGroup label={label} value={v ?? MIXED} options={choices.map((c) => ({ value: c.value, label: c.label, disabled: c.disabled }))} onChange={setV} />
        {choices.find((c) => c.value === v)?.description && <div className={styles.note}>{choices.find((c) => c.value === v)!.description}</div>}
      </div>
    </Dialog>
  );
}

/** A name (Rename…, a new billing group) */
export function NameDialog({ title, label, value = "", confirm, onSave, onClose }: { title: string; label: string; value?: string; confirm: string; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(value);
  return (
    <Dialog
      title={title}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => { onSave(name.trim()); onClose(); }}>{confirm}</Button>
        </>
      }
    >
      <TextInput label={label} value={name} onChange={setName} placeholder={label} autoFocus variant="outlined" />
    </Dialog>
  );
}

export type PickItem = { id: string; label: string; sub?: string; person?: Pick<PersonRef, "name" | "email" | "picture"> };

/** Picks several from a searchable list (workspace admins, members, teams) */
export function PickDialog({ title, items, initial = [], confirm, min = 0, onSave, onClose }: { title: string; items: PickItem[]; initial?: string[]; confirm: string; min?: number; onSave: (ids: string[]) => void; onClose: () => void }) {
  const [chosen, setChosen] = useState(() => new Set(initial));
  const [text, setText] = useState("");
  const q = text.trim().toLowerCase();
  const shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.sub?.toLowerCase().includes(q));
  return (
    <Dialog
      title={title}
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={chosen.size < min} onClick={() => { onSave([...chosen]); onClose(); }}>{confirm}</Button>
        </>
      }
    >
      <div className={styles.form}>
        <SearchField value={text} onChange={setText} placeholder="Search" autoFocus />
        <div className={styles.pickList} role="list">
          {shown.length === 0 && <div className={styles.empty}>No results</div>}
          {shown.map((i) => (
            <div key={i.id} role="listitem" className={styles.pickRow} data-pick={i.id}>
              <Checkbox
                label={i.label}
                hideLabel
                checked={chosen.has(i.id)}
                onChange={(on) => setChosen((s) => {
                  const n = new Set(s);
                  if (on) n.add(i.id);
                  else n.delete(i.id);
                  return n;
                })}
              />
              {i.person ? <Who person={i.person} /> : <span>{i.label}{i.sub && <span className={styles.muted}> · {i.sub}</span>}</span>}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

export function personItem(p: PersonRef): PickItem {
  return { id: p.id, label: p.name ?? p.email, sub: p.email, person: p };
}

/** A label above a control in a dialog */
export function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.fieldLabel}>
      <span className={styles.fieldTitle}>{title}</span>
      {children}
    </div>
  );
}
