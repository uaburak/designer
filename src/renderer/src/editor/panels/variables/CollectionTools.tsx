/**
 * The Local variables window's smaller dialogs (R3-21, help "Create and manage variables and collections"):
 * - "Reorder collections": the collections listed in order, dragged (or moved with the arrows) into place, and
 *   "Sort A to Z";
 * - "Edit variables": a selection of variables' Scope and Hide from publishing at once (Figma's bulk edit).
 */
import { useState } from "react";
import { Button, Checkbox, IconButton, Popover, cx } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { SCOPE_OPTIONS, scopeChecked, toggleScope } from "../../model/variables";
import { moveCollection, sortCollections, updateVariables } from "../../variables";
import styles from "./Variables.module.css";
import tableStyles from "./LocalVariables.module.css";

export function ReorderCollectionsPopover({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const ed = useEditor();
  const a = useLocalAssets();
  const [drag, setDrag] = useState<{ id: Guid; over: number } | null>(null);
  const list = a.collections;
  return (
    <Popover anchor={anchor} title="Reorder collections" width={260} placement="bottom-start" onClose={onClose} label="Reorder collections">
      <div className={styles.form} data-reorder-collections="">
        {list.map((c, i) => (
          <div
            key={c.id}
            className={cx(tableStyles.reorderRow, drag?.over === i && tableStyles.reorderOver)}
            draggable
            data-reorder-row={c.name}
            onDragStart={() => setDrag({ id: c.id, over: i })}
            onDragOver={(e) => {
              e.preventDefault();
              if (drag) setDrag({ ...drag, over: i });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag) moveCollection(ed, drag.id, i);
              setDrag(null);
            }}
            onDragEnd={() => setDrag(null)}
          >
            <span className={tableStyles.reorderName}>{c.name}</span>
            <IconButton icon="16.arrow.up" label={`Move ${c.name} up`} tone="secondary" disabled={i === 0} onClick={() => moveCollection(ed, c.id, i - 1)} />
            <IconButton icon="16.arrow.down" label={`Move ${c.name} down`} tone="secondary" disabled={i === list.length - 1} onClick={() => moveCollection(ed, c.id, i + 1)} />
          </div>
        ))}
        <Button variant="secondary" onClick={() => sortCollections(ed)}>
          Sort A to Z
        </Button>
      </div>
    </Popover>
  );
}

export function EditVariablesPopover({ ids, anchor, onClose }: { ids: readonly Guid[]; anchor: HTMLElement | DOMRect | null; onClose: () => void }) {
  const ed = useEditor();
  const a = useLocalAssets();
  const vars = ids.map((id) => a.lookup.variable(id)).filter((v) => !!v);
  if (!vars.length) return null;
  const type = vars.every((v) => v.type === vars[0].type) ? vars[0].type : null;
  const options = type ? SCOPE_OPTIONS[type] : [];
  const scopes = vars[0].scopes;
  const all = scopes === null || scopes.includes("ALL_SCOPES");
  const setScope = (scope: string) => (on: boolean) => type && updateVariables(ed, ids, { scopes: toggleScope(type, scopes, scope, on) });
  const hidden = vars.every((v) => v.hidden);
  return (
    <Popover anchor={anchor} title={`Edit ${vars.length} variables`} width={280} placement="bottom-start" onClose={onClose} label="Edit variables">
      <div className={styles.form} data-edit-variables={vars.length}>
        {options.length > 0 ? (
          <>
            <div className={styles.formSection}>Scoping</div>
            <Checkbox label="Show in all supported properties" checked={all} onChange={setScope("ALL_SCOPES")} />
            {options.map((o) => (
              <div key={o.scope}>
                <Checkbox label={o.label} checked={scopeChecked(scopes, o.scope)} onChange={setScope(o.scope)} />
                {o.children?.map((ch) => (
                  <div key={ch.scope} className={styles.formIndent}>
                    <Checkbox label={ch.label} checked={scopeChecked(scopes, ch.scope)} onChange={setScope(ch.scope)} />
                  </div>
                ))}
              </div>
            ))}
          </>
        ) : (
          type === null && <span className={tableStyles.muted}>Scoping is available for variables of one type</span>
        )}
        <div className={styles.formSection}>Publishing</div>
        <Checkbox label="Hide from publishing" checked={hidden} onChange={(on) => updateVariables(ed, ids, { hidden: on })} />
      </div>
    </Popover>
  );
}
