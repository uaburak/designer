/**
 * "Edit variable" (R3-18; atlas 11 §8.4; live 2026-10-19, variables.txt: 280 wide, the tabs "Details" and "Scope" in
 * the 40 header beside Close). Details: Name, Description, "Value" with the value in every mode, Code syntax (Web /
 * Android / iOS, "+" adds one) and Hide from publishing — a label column 16 in, the controls 102 in, 162 wide. Scope:
 * "Show in all supported properties" and the type's properties in Figma's order (numbers: Typography's under their
 * heading) — booleans have none, so only Details. Each change is one undo step.
 */
import { useState } from "react";
import { Checkbox, Icon, IconButton, MenuButton, Popover, Tabs, TextArea, TextInput, cx, type PopoverPlacement } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { CODE_PLATFORMS, SCOPE_OPTIONS, scopeChecked, toggleScope, type CodeSyntaxEntry, type VarType } from "../../model/variables";
import { renameVariable, updateVariable } from "../../variables";
import { ValueEditor } from "./ValueEditor";
import styles from "./Variables.module.css";
import tableStyles from "./LocalVariables.module.css";
import { t, useT } from "@/i18n";

/** The scoping checkboxes of `type` ("Show in all supported properties" first), the Edit variable(s) modals' Scoping. */
export function ScopeChecklist({ type, scopes, onChange }: { type: VarType; scopes: readonly string[] | null; onChange: (scope: string, on: boolean) => void }) {
  useT();
  const all = scopes === null || scopes.includes("ALL_SCOPES");
  return (
    <div className={styles.scopeList} data-scope-list={type}>
      <Checkbox label={t("Show in all supported properties")} checked={all} onChange={(on) => onChange("ALL_SCOPES", on)} />
      {SCOPE_OPTIONS[type].map((o) => (
        <div key={o.scope}>
          {o.section && <div className={styles.scopeSection}>{t(o.section)}</div>}
          <div className={styles.scopeRow}>
            <Checkbox label={t(o.label)} checked={scopeChecked(scopes, o.scope)} onChange={(on) => onChange(o.scope, on)} />
            {o.sublabel && <span className={styles.scopeSublabel}>{t(o.sublabel)}</span>}
          </div>
          {o.children?.map((ch) => (
            <div key={ch.scope} className={styles.formIndent}>
              <Checkbox label={t(ch.label)} checked={scopeChecked(scopes, ch.scope)} onChange={(on) => onChange(ch.scope, on)} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function EditVariablePopover({ id, anchor, placement = "bottom-start", onClose }: { id: Guid; anchor: HTMLElement | DOMRect | null; placement?: PopoverPlacement; onClose: () => void }) {
  useT();
  const ed = useEditor();
  const a = useLocalAssets();
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<"details" | "scoping">("details");
  const v = a.lookup.variable(id);
  const c = v ? a.lookup.collection(v.collection) : undefined;
  if (!v || !c) return null;
  const scoped = SCOPE_OPTIONS[v.type].length > 0;
  const shown = scoped ? tab : "details";
  const setScope = (scope: string, on: boolean) => updateVariable(ed, id, { scopes: toggleScope(v.type, v.scopes, scope, on) }, "Edit variable scope");
  const syntax = (platform: CodeSyntaxEntry["platform"]) => v.codeSyntax.find((e) => e.platform === platform);
  const setSyntax = (platform: CodeSyntaxEntry["platform"], value: string | null) => {
    const rest = v.codeSyntax.filter((e) => e.platform !== platform);
    updateVariable(ed, id, { codeSyntax: value === null ? rest : [...rest, { platform, value }] }, "Edit code syntax");
  };
  const showSyntax = (platform: string) => !!syntax(platform as CodeSyntaxEntry["platform"]) || adding.has(platform);
  const missing = CODE_PLATFORMS.filter((p) => !showSyntax(p.platform));
  return (
    <Popover
      anchor={anchor}
      header={
        <Tabs
          label={t("Edit variable")}
          className={styles.editTabs}
          value={shown}
          tabs={[{ value: "details", label: t("Details") }, ...(scoped ? [{ value: "scoping", label: t("Scope") }] : [])]}
          onChange={(x) => setTab(x as "details" | "scoping")}
        />
      }
      width={280}
      placement={placement}
      onClose={onClose}
      label={t("Edit variable")}
    >
      {shown === "scoping" ? (
        <div className={styles.form} data-edit-variable={v.name} data-tab="scoping">
          <ScopeChecklist type={v.type} scopes={v.scopes} onChange={setScope} />
        </div>
      ) : (
        <div className={styles.editForm} data-edit-variable={v.name} data-tab="details">
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
          {CODE_PLATFORMS.filter((p) => showSyntax(p.platform)).map((p) => (
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
