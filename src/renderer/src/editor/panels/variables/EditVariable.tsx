/**
 * "Edit variable" (R3-18): Name, Description, the value in every mode,
 * Scoping ("Show in all supported properties" and the type's properties —
 * booleans have none), Code syntax (Web / Android / iOS, "+" adds one) and
 * Hide from publishing. Each change is one undo step.
 */
import { useState } from "react";
import { Checkbox, Icon, IconButton, MenuButton, Popover, TextArea, TextInput, cx, type PopoverPlacement } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { CODE_PLATFORMS, SCOPE_OPTIONS, scopeChecked, toggleScope, VAR_TYPE_LABEL, type CodeSyntaxEntry } from "../../model/variables";
import { renameVariable, updateVariable } from "../../variables";
import { ValueEditor } from "./ValueEditor";
import styles from "./Variables.module.css";
import tableStyles from "./LocalVariables.module.css";

export function EditVariablePopover({ id, anchor, placement = "bottom-start", onClose }: { id: Guid; anchor: HTMLElement | DOMRect | null; placement?: PopoverPlacement; onClose: () => void }) {
  const ed = useEditor();
  const a = useLocalAssets();
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const v = a.lookup.variable(id);
  const c = v ? a.lookup.collection(v.collection) : undefined;
  if (!v || !c) return null;
  const scopes = v.scopes;
  const options = SCOPE_OPTIONS[v.type];
  const all = scopes === null || scopes.includes("ALL_SCOPES");
  const setScope = (scope: string, on: boolean) => updateVariable(ed, id, { scopes: toggleScope(v.type, scopes, scope, on) }, "Edit variable scope");
  const syntax = (platform: CodeSyntaxEntry["platform"]) => v.codeSyntax.find((e) => e.platform === platform);
  const setSyntax = (platform: CodeSyntaxEntry["platform"], value: string | null) => {
    const rest = v.codeSyntax.filter((e) => e.platform !== platform);
    updateVariable(ed, id, { codeSyntax: value === null ? rest : [...rest, { platform, value }] }, "Edit code syntax");
  };
  const shown = (platform: string) => !!syntax(platform as CodeSyntaxEntry["platform"]) || adding.has(platform);
  const missing = CODE_PLATFORMS.filter((p) => !shown(p.platform));
  return (
    <Popover anchor={anchor} title="Edit variable" width={280} placement={placement} onClose={onClose} label="Edit variable">
      <div className={styles.form} data-edit-variable={v.name}>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Name</span>
          <TextInput label="Name" value={v.name} onCommit={(name) => renameVariable(ed, id, name)} autoFocus />
        </div>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Type</span>
          <span>{VAR_TYPE_LABEL[v.type]}</span>
        </div>
        <TextArea label="Description" value={v.description} placeholder="Description" minRows={2} onCommit={(description) => updateVariable(ed, id, { description }, "Edit variable description")} />
        <div className={styles.formSection}>Values</div>
        {c.modes.map((m) => (
          <div key={m.id} className={styles.formRow}>
            <span className={styles.formLabel}>{m.name}</span>
            <ValueEditor variable={v} mode={m.id} collection={c} className={cx(tableStyles.formValue)} />
          </div>
        ))}
        {options.length > 0 && (
          <>
            <div className={styles.formSection}>Scoping</div>
            <Checkbox label="Show in all supported properties" checked={all} onChange={(on) => setScope("ALL_SCOPES", on)} />
            {options.map((o) => (
              <div key={o.scope}>
                <Checkbox label={o.label} checked={scopeChecked(scopes, o.scope)} onChange={(on) => setScope(o.scope, on)} />
                {o.children?.map((ch) => (
                  <div key={ch.scope} className={styles.formIndent}>
                    <Checkbox label={ch.label} checked={scopeChecked(scopes, ch.scope)} onChange={(on) => setScope(ch.scope, on)} />
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
        <div className={styles.formSection}>
          <span>Code syntax</span>
          {missing.length > 0 && (
            <MenuButton label="Add code syntax" entries={missing.map((p) => ({ id: p.platform, label: p.label }))} onSelect={(p) => setAdding(new Set([...adding, p]))}>
              <Icon name="24.plus.small" />
            </MenuButton>
          )}
        </div>
        {CODE_PLATFORMS.filter((p) => shown(p.platform)).map((p) => (
          <div key={p.platform} className={styles.codeRow}>
            <span className={styles.formLabel}>{p.label}</span>
            <TextInput label={`${p.label} code syntax`} value={syntax(p.platform)?.value ?? ""} placeholder={p.platform === "WEB" ? "var(--name)" : "name"} onCommit={(value) => setSyntax(p.platform, value)} />
            <IconButton icon="24.minus.small" label={`Remove ${p.label} code syntax`} tone="secondary" onClick={() => {
                setAdding(new Set([...adding].filter((x) => x !== p.platform)));
                setSyntax(p.platform, null);
              }} />
          </div>
        ))}
        <div className={styles.formSection}>Publishing</div>
        <Checkbox label="Hide from publishing" checked={v.hidden} onChange={(hidden) => updateVariable(ed, id, { hidden }, "Hide from publishing")} />
      </div>
    </Popover>
  );
}
