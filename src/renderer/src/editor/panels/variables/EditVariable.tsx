/**
 * "Edit variable" (R3-18; live 2026-10-19, variables.txt: 280 wide, a 40 header with the tabs "Details" and "Scope"
 * and Close). Details: Name, Description, "Value" with the value in every mode, Code syntax (Web / Android / iOS, "+"
 * adds one) and Hide from publishing — a label column 16 in, the controls 102 in, 162 wide. Scope: "Show in all
 * supported properties" and the type's properties (booleans have none: no Scope tab). Each change is one undo step.
 */
import { useState } from "react";
import { Checkbox, Icon, IconButton, MenuButton, Popover, Tabs, TextArea, TextInput, cx, type PopoverPlacement } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { CODE_PLATFORMS, SCOPE_OPTIONS, scopeChecked, toggleScope, type CodeSyntaxEntry } from "../../model/variables";
import { renameVariable, updateVariable } from "../../variables";
import { ValueEditor } from "./ValueEditor";
import styles from "./Variables.module.css";
import tableStyles from "./LocalVariables.module.css";
import { t, useT } from "@/i18n";

export function EditVariablePopover({ id, anchor, placement = "bottom-start", onClose }: { id: Guid; anchor: HTMLElement | DOMRect | null; placement?: PopoverPlacement; onClose: () => void }) {
  useT();
  const ed = useEditor();
  const a = useLocalAssets();
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<"details" | "scope">("details");
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
  const tabs = [{ value: "details", label: t("Details") }, ...(options.length > 0 ? [{ value: "scope", label: t("Scope") }] : [])];
  return (
    <Popover
      anchor={anchor}
      header={<Tabs label={t("Edit variable")} value={tab} onChange={(next) => setTab(next as "details" | "scope")} tabs={tabs} />}
      width={280}
      placement={placement}
      onClose={onClose}
      label={t("Edit variable")}
    >
      {tab === "scope" && options.length > 0 ? (
        <div className={styles.editScope} data-edit-variable={v.name}>
          <Checkbox label={t("Show in all supported properties")} checked={all} onChange={(on) => setScope("ALL_SCOPES", on)} />
          {options.map((o) => (
            <div key={o.scope}>
              <Checkbox label={t(o.label)} checked={scopeChecked(scopes, o.scope)} onChange={(on) => setScope(o.scope, on)} />
              {o.children?.map((ch) => (
                <div key={ch.scope} className={styles.formIndent}>
                  <Checkbox label={t(ch.label)} checked={scopeChecked(scopes, ch.scope)} onChange={(on) => setScope(ch.scope, on)} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
      <div className={styles.editForm} data-edit-variable={v.name}>
        <div className={styles.editRow}>
          <span className={styles.formLabel}>{t("Name")}</span>
          <TextInput label={t("Name")} variant="outlined" value={v.name} onCommit={(name) => renameVariable(ed, id, name)} autoFocus />
        </div>
        <div className={styles.editRow}>
          <span className={styles.formLabel}>{t("Description")}</span>
          <TextArea label={t("Description")} value={v.description} placeholder={t("How to use this variable")} minRows={2} onCommit={(description) => updateVariable(ed, id, { description }, "Edit variable description")} />
        </div>
        <div className={styles.editSection}>{t("Value")}</div>
        {c.modes.map((m) => (
          <div key={m.id} className={styles.editRow}>
            <span className={styles.formLabel}>{m.name}</span>
            <ValueEditor variable={v} mode={m.id} collection={c} className={cx(tableStyles.formValue)} />
          </div>
        ))}
        <div className={styles.editSection}>
          <span>{t("Code syntax")}</span>
          {missing.length > 0 && (
            <MenuButton label={t("Add code syntax")} entries={missing.map((p) => ({ id: p.platform, label: p.label }))} onSelect={(p) => setAdding(new Set([...adding, p]))}>
              <Icon name="24.plus.small" />
            </MenuButton>
          )}
        </div>
        {CODE_PLATFORMS.filter((p) => shown(p.platform)).map((p) => (
          <div key={p.platform} className={styles.codeRow}>
            <span className={styles.formLabel}>{p.label}</span>
            <TextInput label={t("{platform} code syntax", { platform: p.label })} value={syntax(p.platform)?.value ?? ""} placeholder={p.platform === "WEB" ? "var(--name)" : "name"} onCommit={(value) => setSyntax(p.platform, value)} />
            <IconButton icon="24.minus.small" label={t("Remove {platform} code syntax", { platform: p.label })} tone="secondary" onClick={() => {
                setAdding(new Set([...adding].filter((x) => x !== p.platform)));
                setSyntax(p.platform, null);
              }} />
          </div>
        ))}
        <div className={styles.editCheck}>
          <Checkbox label={t("Hide from publishing")} checked={v.hidden} onChange={(hidden) => updateVariable(ed, id, { hidden }, "Hide from publishing")} />
        </div>
      </div>
      )}
    </Popover>
  );
}
