/**
 * Components in the Design panel (UI3; live docs/research/figma/live/design/component*.txt, variant*.txt,
 * instance*.txt, nested-instance*.txt; behaviour docs/research/figma/R4-components.md):
 *
 * - an instance: its main's name (the set's for a variant; a click opens the swap menu, ComponentPicker) with More
 *   actions (live popovers/instance-more-actions-menu.txt), "Go to main component" ("From this file"), then one row
 *   per property — the label at 16, the control at 112 (a variant's dropdown, a Boolean's 32 × 16 toggle, a Text's
 *   field, an Instance swap's button), "Apply variable/property to …" ("Apply variable" for a variant) at 208 — and
 *   one block per exposed nested instance;
 * - a main component or a set: one block with the header — the name as a field (13 / 550), then Multi-edit variants
 *   (a set), Add variant, Component configuration (the description and the documentation link), More actions — and
 *   "Properties" with Create property: a 208 × 24 row per property (its type's glyph, "Show icon ・ True"); a click
 *   opens its settings, a double-click on the name renames it, right-click or Delete deletes it (help "Explore
 *   component properties"), hovering shows the handle to reorder;
 * - a variant: the set's name, Multi-edit variants, Select matching layers, Component configuration; "Current
 *   variant" with Select component, a row per property (the name, a button that renames it; the value, a field
 *   with its list and Rename…);
 * - a layer inside a component: the purple "Apply property" button next to the field it binds (visibility, text, a
 *   nested instance), the bound property as a pill (BindButton, used by Appearance, Typography and the instance
 *   header).
 *
 * Everything writes one undo step (components.ts); structural actions are the engine's commands, disabled until it
 * has them.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, Checkbox, ContextMenu, Icon, IconButton, MenuButton, NumericInput, Popover, Select, Switch, TextArea, TextInput, ToggleIconButton, cx, showToast, tooltipProps, type IconName, type MenuEntry } from "@/ds";
import { useEditor, type EditorController } from "../../controller";
import { command, isEnabled, runEditorCommand, shortcutOf } from "../../commands";
import { RESET_PREFIX, runMenuItem } from "../../menus";
import { statusOfTargets, statusTargets } from "../../devStatus";
import { useTopics } from "../../hooks";
import {
  instanceChanges,
  addInstanceToSlot,
  addProperty,
  bindLayer,
  bindPropertyVariable,
  boundProperty,
  canAddProperty,
  clearSlot,
  deleteProperty,
  instanceInfo,
  mainOf,
  nestedInstancesOf,
  owningComponent,
  readC,
  renameVariantValue,
  reorderProperty,
  reorderVariantValues,
  resetSlot,
  setExposed,
  setOf,
  setPropertyValue,
  setVariant,
  setVariantValueOf,
  slotState,
  swapInstance,
  updateProperty,
  updateSlotSettings,
  valueFromLayer,
  variantsOf,
  type InstanceInfo,
  type PropertyRowData,
  type SlotState,
} from "../../components";
import {
  PROPERTY_TYPE_LABEL,
  assetLabel,
  canBind,
  guidStr,
  guidVal,
  hasSlotLimits,
  isComponent,
  isPreferred,
  preferredKey,
  isComponentSet,
  isInstance,
  moveValue,
  parseDerivedId,
  slotGuidelines,
  slotMax,
  slotViolations,
  sortedDefs,
  variantProperties,
  variantToggle,
  variantValues,
  type BindableField,
  type CNode,
  type ComponentAsset,
  type ComponentPropDef,
  type ComponentPropType,
  type ComponentPropValue,
  type GuidValue,
} from "../../model/components";
import { ComponentPicker, useComponentAssets, usePopoverToggle } from "./ComponentPicker";
import { ComponentConfiguration } from "./ComponentConfiguration";
import { ACTION_ICON, actionItem, booleanActions } from "./Header";
import { setMultiEdit, useMultiEdit } from "./multiEdit";
import { BoundPill } from "./Variables";
import { VariablePicker } from "../variables/VariablePicker";
import type { PanelNode } from "./shared";
import styles from "./Component.module.css";
import hstyles from "./Header.module.css";

export const PROPERTY_ICON: Record<ComponentPropType, IconName> = {
  VARIANT: "16.variant",
  BOOL: "16.visible",
  TEXT: "16.text",
  INSTANCE_SWAP: "16.instance",
  SLOT: "16.slot",
};

/** The Create property menu's order (live popovers/component-create-property-menu.txt). */
export const ADD_TYPES: ComponentPropType[] = ["VARIANT", "TEXT", "BOOL", "INSTANCE_SWAP", "SLOT"];

/** What the selection is, for the panel: one instance, component, variant or set (else null). */
export type ComponentSelection = { kind: "instance" | "component" | "variant" | "set"; node: CNode };

/** Re-renders after any document change (component reads span several nodes). */
function useDocVersion(): number {
  const ed = useEditor();
  return useSyncExternalStore(ed.components.subscribe, ed.components.getVersion);
}

export function componentSelection(ed: EditorController, nodes: readonly PanelNode[]): ComponentSelection | null {
  if (nodes.length !== 1) return null;
  const n = readC(ed, nodes[0].guid) ?? (nodes[0] as CNode);
  if (isInstance(n)) return { kind: "instance", node: n };
  if (isComponentSet(n)) return { kind: "set", node: n };
  if (isComponent(n)) return { kind: setOf(ed, n) ? "variant" : "component", node: n };
  return null;
}

// ---- Instance -----------------------------------------------------------------------------------------------------

/** The name an instance's header shows: its main's, or its set's for a variant (live variant-instance: "Chip"). */
export function instanceTitle(ed: EditorController, instance: CNode): string {
  const main = mainOf(ed, instance);
  if (!main) return "Missing component";
  return (setOf(ed, main) ?? main).name ?? "";
}

/** Has the instance a name of its own (not its main's or set's)? Live offers "Reset name" then. */
function renamedInstance(ed: EditorController, instance: CNode): boolean {
  if (instanceChanges(ed, instance).some((g) => g.fields.includes("name"))) return true;
  if (parseDerivedId(instance.guid)) return false;
  const main = mainOf(ed, instance);
  return !!main && (instance.name ?? "") !== ((setOf(ed, main) ?? main).name ?? "");
}

/**
 * The instance's More actions as live (popovers/instance-more-actions-menu.txt, 221 × 309): Toggle ready for dev
 * status · Create component, Detach instance, Reset instance, Reset name (Push changes to main component when there
 * are changes to push) · Use as mask · Union, Subtract, Intersect, Exclude, Flatten — each with its glyph, what can't
 * run left out.
 */
export function instanceMoreMenu(ed: EditorController, instance: CNode): MenuEntry[] {
  const renamed = renamedInstance(ed, instance);
  const reset = actionItem(ed, "object.reset-all-changes", "Reset instance");
  // (A new name alone isn't pushed: live's renamed instance has no Push changes.)
  const pushable = instanceChanges(ed, instance).some((g) => g.fields.some((f) => f !== "name"));
  const push = pushable && isEnabled(ed, command("object.push-changes")) ? [actionItem(ed, "object.push-changes")] : [];
  const groups: MenuEntry[][] = [
    statusTargets(ed).length ? [{ id: "ready-for-dev", label: "Toggle ready for dev status", icon: ACTION_ICON["ready-for-dev"] }] : [],
    [actionItem(ed, "object.create-component"), actionItem(ed, "object.detach-instance"), { ...reset, disabled: reset.disabled && !renamed }, ...(renamed ? [{ id: "reset-name", label: "Reset name", icon: ACTION_ICON["reset-name"] }] : []), ...push],
    [actionItem(ed, "object.use-as-mask")],
    // Flatten (live): the instance is detached, then flattened.
    booleanActions(ed).map((e) => (e.id === "vector.flatten" && e.disabled && isEnabled(ed, command("object.detach-instance")) ? { ...e, id: "flatten-instance", disabled: false } : e)),
  ];
  return groups.flatMap((g): MenuEntry[] => {
    const shown = g.filter((e) => e === "-" || !("id" in e) || !e.disabled);
    return shown.length ? ["-", ...shown] : [];
  });
}

/** Puts the instance's name back to its main's (one undo step). */
function resetName(ed: EditorController, instance: CNode): void {
  const group = instanceChanges(ed, instance).find((g) => g.fields.includes("name"));
  if (group) {
    void runMenuItem(ed, `${RESET_PREFIX}${group.fields.join(",")}`);
    return;
  }
  const main = mainOf(ed, instance);
  if (main) ed.setProps([instance.guid], { name: (setOf(ed, main) ?? main).name ?? "" }, "Reset name");
}

/** The instance's top: its main's name (the swap menu), More actions, Go to main component, then its properties. */
export function InstanceHeader({ instance }: { instance: CNode }) {
  const ed = useEditor();
  const version = useDocVersion();
  const topics = useTopics(ed.store, ["selection", "undo"]);
  const main = mainOf(ed, instance);
  const [picker, togglePicker, closePicker] = usePopoverToggle<HTMLElement>();
  const goTo = command("object.go-to-main-component");
  // The ⋯ menu's entries change with the document and the selection, not with every re-render of the panel (a drag
  // re-renders it per frame): built once per change.
  const more = useMemo<MenuEntry[]>(() => {
    void version;
    void topics;
    return instanceMoreMenu(ed, instance);
  }, [ed, instance, version, topics]);
  const name = instanceTitle(ed, instance);
  const onMore = (id: string) => {
    if (id === "ready-for-dev") {
      const targets = statusTargets(ed);
      runEditorCommand(ed, statusOfTargets(ed, targets) === "BUILD" ? "object.remove-dev-status" : "object.mark-ready-for-dev");
    } else if (id === "reset-name") resetName(ed, instance);
    else if (id === "flatten-instance")
      ed.batch("Flatten", () => {
        runEditorCommand(ed, "object.detach-instance");
        runEditorCommand(ed, "vector.flatten");
      });
    else if (id === "object.reset-all-changes") {
      const renamed = renamedInstance(ed, instance);
      ed.batch("Reset instance", () => {
        if (isEnabled(ed, command(id))) runEditorCommand(ed, id);
        const now = readC(ed, instance.guid) ?? instance;
        if (renamed && renamedInstance(ed, now)) resetName(ed, now);
      });
    } else void runMenuItem(ed, id);
  };
  const bound = !!(instance as { componentPropRefs?: unknown[] }).componentPropRefs?.length;
  return (
    <div className={styles.instanceHead} data-instance-header="">
      {/* Live: the name at 17 in 13px/550 (no label: the text names it), More actions at 208; under it "Go to main component" */}
      <div className={styles.instanceTitleRow}>
        <button type="button" className={styles.instanceName} data-instance-menu={name} aria-haspopup="dialog" aria-expanded={!!picker} onClick={(e) => togglePicker(e.currentTarget)}>
          <span className={styles.headerText}>{assetLabel(name)}</span>
          <Icon name="16.chevron.down" className={styles.nameChevron} />
        </button>
        <div className={styles.headerActions}>
          {bound && <BindButton layer={instance} field="OVERRIDDEN_SYMBOL_ID" type="INSTANCE_SWAP" />}
          <MenuButton label="More actions" entries={more} className={styles.iconMenu} align="end" menuClassName={hstyles.actionsMenu} onSelect={onMore}>
            <Icon name="24.more" />
          </MenuButton>
        </div>
      </div>
      <button type="button" className={styles.fromRow} aria-label={goTo.label} {...tooltipProps(goTo.label)} disabled={!isEnabled(ed, goTo)} onClick={() => runEditorCommand(ed, goTo.id)}>
        {main ? "From this file" : "Missing component"}
      </button>
      <InstanceProperties instance={instance} />
      {picker && <ComponentPicker anchor={picker} title="Swap instance" current={main?.guid ?? null} onPick={(a) => swapTo(ed, [instance.guid], a, main)} onClose={closePicker} />}
    </div>
  );
}

/** A swap to an asset: a set's variant matching the current one's values where it can, else its default. */
function swapTo(ed: EditorController, refs: string[], a: ComponentAsset, current: CNode | null) {
  let target = a.target;
  if (a.kind === "set" && current) {
    const set = readC(ed, a.id);
    const currentSet = setOf(ed, current);
    if (set && currentSet?.guid === set.guid) target = current.guid;
  }
  swapInstance(ed, refs, target);
}

/** The instance's properties and its exposed nested instances. */
export function InstanceProperties({ instance }: { instance: CNode }) {
  const ed = useEditor();
  const version = useDocVersion();
  const info = useMemo(() => {
    void version;
    return instanceInfo(ed, readC(ed, instance.guid) ?? instance);
  }, [ed, instance, version]);
  if (!info.rows.length && !info.nested.length) return null;
  return (
    <div className={styles.instanceBody} data-instance-properties="">
      <PropertyRows info={info} />
      {info.nested.map((n) => (
        <div key={n.id} className={styles.nested} data-nested-instance={n.id}>
          <div className={styles.nestedHeader}>
            <Icon name="16.instance" className={styles.purpleIcon} />
            <span className={styles.headerText}>{n.name}</span>
          </div>
          <PropertyRows info={n.info} />
        </div>
      ))}
    </div>
  );
}

function PropertyRows({ info }: { info: InstanceInfo }) {
  return (
    <>
      {info.rows.map((r) => (
        <InstancePropertyRow key={`${r.def.type}:${guidStr(r.def.id)}:${r.def.name}`} info={info} row={r} />
      ))}
    </>
  );
}

/** The variable types each property takes ("Apply variable": a variant's from a string, number or boolean). */
const APPLY_TYPES: Partial<Record<ComponentPropType, ("BOOLEAN" | "STRING" | "FLOAT")[]>> = {
  VARIANT: ["STRING", "FLOAT", "BOOLEAN"],
  BOOL: ["BOOLEAN"],
  TEXT: ["STRING"],
};

/** The 208 button's label (live instance.txt / variant-instance.txt). */
export const applyLabel = (def: Pick<ComponentPropDef, "type" | "name">): string => (def.type === "VARIANT" ? "Apply variable" : `Apply variable/property to ${def.name}`);

function InstancePropertyRow({ info, row }: { info: InstanceInfo; row: PropertyRowData }) {
  const ed = useEditor();
  const { def } = row;
  const labelId = useId();
  const [picker, togglePicker, closePicker] = usePopoverToggle<HTMLElement>();
  const [assign, setAssign] = useState<HTMLElement | null>(null);
  const instance = info.instance;
  const fresh = () => readC(ed, instance.guid) ?? instance;
  const toggle = def.type === "VARIANT" ? variantToggle(row.options ?? []) : null;
  const types = APPLY_TYPES[def.type];
  let control: React.ReactNode;
  if (row.variable && types) {
    // Bound to a variable: its pill (a click picks another, Detach on hover).
    control = <BoundPill id={row.variable} label={def.name} onOpen={(a) => setAssign(a)} onDetach={() => bindPropertyVariable(ed, instance.guid, def.name, null)} />;
  } else
    switch (def.type) {
      case "VARIANT":
        control = toggle ? (
          // True / False, Yes / No, On / Off: a toggle (Figma).
          <Switch label={def.name} className={styles.propSwitch} checked={row.variantValue === toggle.on} onChange={(on) => setVariant(ed, fresh(), def.name, on ? toggle.on : toggle.off)} />
        ) : (
          <Select label={def.name} variant="outlined" value={row.variantValue ?? ""} options={(row.options ?? []).map((v) => ({ value: v, label: v }))} onChange={(v) => setVariant(ed, fresh(), def.name, v)} />
        );
        break;
      case "BOOL":
        control = <Switch label={def.name} className={styles.propSwitch} checked={row.value?.boolValue !== false} onChange={(on) => setPropertyValue(ed, fresh(), def, { boolValue: on })} />;
        break;
      case "TEXT":
        control = <PropertyText labelledBy={labelId} value={row.value?.textValue?.characters ?? ""} onCommit={(v) => setPropertyValue(ed, fresh(), def, { textValue: { characters: v } })} />;
        break;
      case "INSTANCE_SWAP": {
        const current = row.value?.guidValue ? readC(ed, guidStr(row.value.guidValue)) : null;
        control = (
          <>
            <button type="button" className={styles.swapField} aria-labelledby={labelId} data-swap-property={def.name} aria-expanded={!!picker} onClick={(e) => togglePicker(e.currentTarget)}>
              <Icon name="16.instance" className={styles.swapIcon} />
              <span className={styles.headerText}>{current ? assetLabel(current.name ?? "") : "None"}</span>
            </button>
            {picker && (
              <ComponentPicker
                anchor={picker}
                title="Choose instance"
                current={current?.guid ?? null}
                preferredKeys={def.preferredValues?.instanceSwapValues?.map((p) => p.key)}
                onPick={(a) => setPropertyValue(ed, fresh(), def, { guidValue: guidVal(a.target) })}
                onClose={closePicker}
              />
            )}
          </>
        );
        break;
      }
      default:
        control = <SlotControl row={row} />;
    }
  return (
    <div className={styles.propRow} data-property={def.name}>
      <span id={labelId} className={styles.propLabel} title={def.name}>
        {def.name}
      </span>
      <div className={styles.propControl}>{control}</div>
      {types && <IconButton icon="24.variable.small" label={applyLabel(def)} tone="secondary" aria-expanded={!!assign} data-apply-variable={def.name} onClick={(e) => setAssign(assign ? null : e.currentTarget)} />}
      {assign && types && (
        <VariablePicker
          anchor={assign}
          title="Apply variable"
          types={types}
          current={row.variable ?? null}
          consumer={instance.guid.startsWith("I") ? null : instance.guid}
          onPick={(v) => bindPropertyVariable(ed, instance.guid, def.name, v.id)}
          onClose={() => setAssign(null)}
        />
      )}
    </div>
  );
}

/**
 * A Text property's field (live: a textarea 88 × 24 on #383838 that grows with its lines): Enter writes it, ⇧Enter
 * breaks the line, Esc puts it back.
 */
function PropertyText({ value, labelledBy, onCommit }: { value: string; labelledBy: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const text = draft ?? value;
  const lines = Math.min(6, text.split("\n").length);
  return (
    <textarea
      className={styles.propText}
      aria-labelledby={labelledBy}
      rows={1}
      spellCheck={false}
      value={text}
      style={{ height: lines * 16 + 8 }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const typed = e.currentTarget.value;
        const keep = draft !== null && !cancelled.current && typed !== value;
        cancelled.current = false;
        setDraft(null);
        if (keep) onCommit(typed);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * An instance's slot property (help "Create and use slots"): the Limits label when the slot has guidelines (orange
 * when one is broken; a click lists them with a check or a warning), "Add instances" (+: the components, preferred
 * first), and More actions — Reset slot, Delete contents. Going over the maximum shows a toast (limits guide, never
 * block).
 */
function SlotControl({ row }: { row: PropertyRowData }) {
  const ed = useEditor();
  const version = useDocVersion();
  const [picker, togglePicker, closePicker] = usePopoverToggle<HTMLElement>();
  const [limits, setLimits] = useState<HTMLElement | null>(null);
  const state: SlotState | null = useMemo(() => {
    void version;
    return slotState(ed, row);
  }, [ed, row, version]);
  const config = row.def.slotPropConfig;
  const violations = state ? slotViolations(config, state.children, state.preferredCount) : [];
  const over = violations.includes("ABOVE_MAX");
  const wasOver = useRef(over);
  useEffect(() => {
    // The warning at the bottom of the screen when the slot goes over its limit.
    if (over && !wasOver.current) showToast({ message: `“${row.def.name}” has more than ${slotMax(config)} ${slotMax(config) === 1 ? "layer" : "layers"}` });
    wasOver.current = over;
  }, [over, row.def.name, config]);
  if (!state) return <span className={styles.muted}>Slot</span>;
  const preferredKeys = row.def.preferredValues?.instanceSwapValues?.map((p) => p.key);
  const showLimits = hasSlotLimits(config, state.preferredCount);
  const more: MenuEntry[] = [
    { id: "reset", label: "Reset slot" },
    { id: "clear", label: "Delete contents", disabled: state.children.length === 0 },
  ];
  return (
    <div className={styles.slotControl} data-slot-control={row.def.name} data-slot-count={state.children.length} data-slot-violations={violations.join(" ") || undefined}>
      {showLimits ? (
        <button type="button" className={cx(styles.limits, violations.length > 0 && styles.limitsWarning)} aria-expanded={!!limits} data-slot-limits="" onClick={(e) => setLimits(limits ? null : e.currentTarget)}>
          {violations.length > 0 && <Icon name="16.warning" />}
          Limits
        </button>
      ) : (
        <span className={styles.slotCount}>{state.children.length === 1 ? "1 layer" : `${state.children.length} layers`}</span>
      )}
      <IconButton icon="24.plus.small" label="Add instances" tone="secondary" aria-expanded={!!picker} onClick={(e) => togglePicker(e.currentTarget)} />
      <MenuButton label="More actions" entries={more} className={styles.iconMenu} onSelect={(id) => (id === "reset" ? resetSlot(ed, state.ref) : clearSlot(ed, state.ref))}>
        <Icon name="24.more" />
      </MenuButton>
      {picker && (
        <ComponentPicker anchor={picker} title="Add instances" preferredKeys={preferredKeys} preferredFilter onPick={(a) => addInstanceToSlot(ed, state.ref, a, config)} onClose={closePicker} />
      )}
      {limits && (
        <Popover anchor={limits} title="Limits" width={240} onClose={() => setLimits(null)} label="Limits">
          <div className={styles.limitsList} data-slot-guidelines="">
            {slotGuidelines(config, state.children, state.preferredCount).map((g) => (
              <div key={g.text} className={styles.guideline} data-ok={g.ok}>
                <Icon name={g.ok ? "16.check" : "16.warning"} className={g.ok ? styles.guidelineOk : styles.guidelineWarning} />
                <span>{g.text}</span>
              </div>
            ))}
            <div className={styles.muted}>{state.children.length === 1 ? "1 layer in this slot" : `${state.children.length} layers in this slot`}</div>
          </div>
        </Popover>
      )}
    </div>
  );
}

// ---- Main component, set, variant ----------------------------------------------------------------------------------

export type ComponentHeaderAction = "multi-edit" | "add-variant" | "matching" | "configuration" | "more";

/** The header's actions after the name, left to right (live component.txt, component-set.txt, variant.txt). */
export const COMPONENT_HEADER_ACTIONS: Record<Exclude<ComponentSelection["kind"], "instance">, readonly ComponentHeaderAction[]> = {
  component: ["add-variant", "configuration", "more"],
  set: ["multi-edit", "add-variant", "configuration", "more"],
  variant: ["multi-edit", "matching", "configuration"],
};

/**
 * A main component's or set's More actions (not captured live: built like the instance's — Toggle ready for dev
 * status · Use as mask · Union … Flatten —, what can't run left out; unverified).
 */
export function componentMoreMenu(ed: EditorController): MenuEntry[] {
  const groups: MenuEntry[][] = [
    statusTargets(ed).length ? [{ id: "ready-for-dev", label: "Toggle ready for dev status", icon: ACTION_ICON["ready-for-dev"] }] : [],
    [actionItem(ed, "object.use-as-mask")],
    booleanActions(ed),
  ];
  return groups.flatMap((g): MenuEntry[] => {
    const shown = g.filter((e) => e === "-" || !("id" in e) || !e.disabled);
    return shown.length ? ["-", ...shown] : [];
  });
}

/** The layer's name as the header's field (live: 13 / 550 at 16, the field from 8 to 8 before the first button). */
function NameField({ node }: { node: CNode }) {
  const ed = useEditor();
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <input
      className={styles.nameField}
      value={draft ?? node.name ?? ""}
      spellCheck={false}
      data-component-name={node.guid}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        const name = draft?.trim();
        if (!cancelled.current && name && name !== node.name) ed.setProps([node.guid], { name }, "Rename");
        cancelled.current = false;
        setDraft(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * A main component, set or variant: the header (the name, then COMPONENT_HEADER_ACTIONS) and Properties (Current
 * variant for a variant) as one block, the line under it (live: Position's title at 195 after three properties).
 */
export function ComponentBlock({ sel }: { sel: ComponentSelection }) {
  const ed = useEditor();
  useTopics(ed.store, ["selection", "undo", "structure"]);
  const version = useDocVersion();
  const node = useMemo(() => {
    void version;
    return readC(ed, sel.node.guid) ?? sel.node;
  }, [ed, sel.node, version]);
  const set = sel.kind === "set" ? node : sel.kind === "variant" ? setOf(ed, node) : null;
  const multi = useMultiEdit(set?.guid);
  const [config, toggleConfig, closeConfig] = usePopoverToggle<HTMLElement>();
  const kind = sel.kind === "instance" ? "component" : sel.kind;
  const add = command("object.add-variant");
  const matching = command("edit.select-matching");
  const action = (a: ComponentHeaderAction) => {
    switch (a) {
      case "multi-edit":
        return <ToggleIconButton key={a} icon="24.multi-edit.small" label="Multi-edit variants" tone="secondary" pressed={multi} disabled={!set} onPressedChange={(on) => set && setMultiEdit(set.guid, on)} />;
      case "add-variant":
        return <IconButton key={a} icon="24.add-variant.small" label={add.label} tone="secondary" disabled={!isEnabled(ed, add)} onClick={() => runEditorCommand(ed, add.id)} />;
      case "matching":
        return <IconButton key={a} icon="24.select-matching.small" label={matching.label} shortcut={shortcutOf(matching)} tone="secondary" disabled={!isEnabled(ed, matching)} onClick={() => runEditorCommand(ed, matching.id)} />;
      case "configuration":
        return <IconButton key={a} icon="24.adjust.small" label="Component configuration" tone="secondary" aria-expanded={!!config} onClick={(e) => toggleConfig(e.currentTarget)} />;
      case "more":
        return <ComponentMore key={a} />;
    }
  };
  return (
    <div className={styles.componentBlock} data-component-header={sel.kind}>
      <div className={styles.componentHeader}>
        {/* A variant's header names its set (live variant.txt: "Chip") */}
        <NameField node={sel.kind === "variant" ? (set ?? node) : node} />
        {COMPONENT_HEADER_ACTIONS[kind].map(action)}
      </div>
      {sel.kind === "variant" ? <CurrentVariantSection variant={node} /> : <PropertiesSection owner={node} />}
      {config && <ComponentConfiguration owner={node} anchor={config} onClose={closeConfig} />}
    </div>
  );
}

function ComponentMore() {
  const ed = useEditor();
  const entries = componentMoreMenu(ed);
  return (
    <MenuButton
      label="More actions"
      entries={entries.length ? entries : [{ id: "none", label: "No actions", disabled: true }]}
      className={styles.iconMenu}
      align="end"
      menuClassName={hstyles.actionsMenu}
      onSelect={(id) => {
        if (id === "ready-for-dev") runEditorCommand(ed, statusOfTargets(ed, statusTargets(ed)) === "BUILD" ? "object.remove-dev-status" : "object.mark-ready-for-dev");
        else void runMenuItem(ed, id);
      }}
    >
      <Icon name="24.more" />
    </MenuButton>
  );
}

type EditorTarget = { mode: "create"; type: ComponentPropType; bind?: { layer: CNode; field: BindableField } } | { mode: "edit"; def: ComponentPropDef };

/**
 * The Create property menu as live (popovers/component-create-property-menu.txt, 156 wide): the caption "Create
 * property", Variant, Text, Boolean, Instance swap, Slot, then "Expose properties from" › Nested instances.
 */
export function createPropertyMenu(ed: EditorController, owner: CNode, nested: readonly CNode[]): MenuEntry[] {
  return [
    { header: "Create property" },
    ...ADD_TYPES.map((t) => ({ id: t, label: PROPERTY_TYPE_LABEL[t], icon: PROPERTY_ICON[t], disabled: !canAddProperty(ed, owner, t) })),
    "-",
    { header: "Expose properties from" },
    { id: "submenu:nested", label: "Nested instances", icon: "16.instance" as IconName, disabled: !nested.length, items: nested.map((n) => ({ id: `expose:${n.guid}`, label: n.name ?? "", checked: n.propsAreBubbled === true })) },
  ];
}

/** A property row's summary after its name (live: "Show icon ・ True", "State ・ Default, Hover, Pressed"). */
function propertySummary(ed: EditorController, d: ComponentPropDef, variantProps: { name: string; values: string[] }[]): string {
  if (d.type === "VARIANT") return variantProps.find((p) => p.name === d.name)?.values.join(", ") ?? "";
  if (d.type === "BOOL") return d.initialValue?.boolValue === false ? "False" : "True";
  if (d.type === "TEXT") return d.initialValue?.textValue?.characters ?? "";
  if (d.type === "INSTANCE_SWAP") {
    const c = d.initialValue?.guidValue ? readC(ed, guidStr(d.initialValue.guidValue)) : null;
    return c ? assetLabel(c.name ?? "") : "";
  }
  return "";
}

/** A block's title row (live: 11 / 550 secondary at 16, its button at 208, 8 under the header). */
function BlockTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className={styles.blockTitle}>
      <span className={styles.blockTitleText}>{title}</span>
      {children}
    </div>
  );
}

/** Properties of a main component or a set: Create property, then a row per property and per exposed instance. */
export function PropertiesSection({ owner }: { owner: CNode }) {
  const ed = useEditor();
  const version = useDocVersion();
  const fresh = useMemo(() => {
    void version;
    return readC(ed, owner.guid) ?? owner;
  }, [ed, owner, version]);
  const [editing, setEditing] = useState<{ target: EditorTarget; anchor: HTMLElement | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; def?: ComponentPropDef; exposed?: CNode } | null>(null);
  const addRef = useRef<HTMLSpanElement>(null);
  const defs = sortedDefs(fresh.componentPropDefs ?? []);
  const variants = isComponentSet(fresh) ? variantsOf(ed, fresh) : [];
  const variantProps = isComponentSet(fresh) ? variantProperties(fresh, variants) : [];
  const nestedInstances = nestedInstancesOf(ed, fresh);
  const exposed = nestedInstances.filter((n) => n.propsAreBubbled === true);
  const [dragging, setDragging] = useState<ComponentPropDef | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const lastVariant = (d: ComponentPropDef) => d.type === "VARIANT" && defs.filter((x) => x.type === "VARIANT").length <= 1;
  const onAdd = (id: string) => {
    if (id.startsWith("expose:")) {
      const n = nestedInstances.find((x) => x.guid === id.slice("expose:".length));
      if (n) setExposed(ed, n, n.propsAreBubbled !== true);
      return;
    }
    setEditing({ target: { mode: "create", type: id as ComponentPropType }, anchor: addRef.current?.querySelector("button") ?? null });
  };
  return (
    <div className={styles.properties} data-properties-section="">
      <BlockTitle title="Properties">
        <span ref={addRef} className={styles.contents}>
          <MenuButton label="Create property" entries={createPropertyMenu(ed, fresh, nestedInstances)} className={styles.iconMenu} align="end" menuClassName={styles.createPropertyMenu} onSelect={onAdd}>
            <Icon name="24.plus.small" />
          </MenuButton>
        </span>
      </BlockTitle>
      <div className={styles.defs} data-component-properties="">
        {defs.map((d) => {
          const id = guidStr(d.id);
          const summary = propertySummary(ed, d, variantProps);
          return (
            <div
              key={id}
              className={cx(styles.defRow, dragOver === id && styles.defDrop)}
              data-property-row={d.name}
              draggable={renaming !== id}
              onDragStart={(e) => {
                setDragging(d);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                // Within its own group: variant properties always stay above the others (Figma).
                if (!dragging || (dragging.type === "VARIANT") !== (d.type === "VARIANT")) return;
                e.preventDefault();
                setDragOver(id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && guidStr(dragging.id) !== id) reorderProperty(ed, fresh, dragging, d);
                setDragging(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDragOver(null);
              }}
            >
              <span className={styles.defHandle} aria-hidden="true">
                <Icon name="16.drag" />
              </span>
              <button
                type="button"
                className={styles.defButton}
                data-property-def={d.name}
                onClick={(e) => {
                  // (The second click of a double-click renames instead.)
                  if (e.detail > 1 || renaming === id) return;
                  setEditing({ target: { mode: "edit", def: d }, anchor: e.currentTarget });
                }}
                onDoubleClick={() => {
                  setEditing(null);
                  setRenaming(id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, def: d });
                }}
                onKeyDown={(e) => {
                  // Help: select the property and press Delete.
                  if ((e.key === "Delete" || e.key === "Backspace") && renaming !== id && !lastVariant(d)) {
                    e.preventDefault();
                    e.stopPropagation();
                    deleteProperty(ed, fresh, d);
                  }
                }}
              >
                <span className={styles.defIcon} role="img" aria-label={`${PROPERTY_TYPE_LABEL[d.type]} property`}>
                  <Icon name={PROPERTY_ICON[d.type]} />
                </span>
                {renaming === id ? (
                  <RenameInput
                    value={d.name}
                    onDone={(name) => {
                      setRenaming(null);
                      if (name && name !== d.name) updateProperty(ed, fresh, d, { name }, "Rename property");
                    }}
                  />
                ) : (
                  <span className={styles.defName}>{d.name}</span>
                )}
                {summary && renaming !== id && (
                  <>
                    <span className={styles.defSep}>・</span>
                    <span className={styles.defValue}>{summary}</span>
                  </>
                )}
              </button>
            </div>
          );
        })}
        {exposed.map((n) => (
          // Exposed nested instances (help: "appear as a list in the right panel"; right-click stops exposing one).
          <div key={n.guid} className={styles.defRow} data-exposed-instance={n.name ?? ""}>
            <button
              type="button"
              className={styles.defButton}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, exposed: n });
              }}
            >
              <span className={styles.defIcon} role="img" aria-label="Nested instance">
                <Icon name="16.instance" />
              </span>
              <span className={styles.defName}>{n.name}</span>
            </button>
          </div>
        ))}
      </div>
      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          context
          entries={menu.def ? [{ id: "delete", label: "Delete property", disabled: lastVariant(menu.def) }] : [{ id: "unexpose", label: "Stop exposing" }]}
          onSelect={(id) => {
            if (id === "delete" && menu.def) deleteProperty(ed, fresh, menu.def);
            if (id === "unexpose" && menu.exposed) setExposed(ed, menu.exposed, false);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {editing && <PropertyEditor owner={fresh} target={editing.target} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** An in-place rename (Enter / leaving keeps it, Esc drops it). */
function RenameInput({ value, onDone, label }: { value: string; onDone: (value: string | null) => void; label?: string }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v?.trim() || null);
  };
  return (
    <input
      className={styles.renameInput}
      aria-label={label ?? "Property name"}
      value={draft}
      autoFocus
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(draft);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}

/**
 * "Current variant" (live variant.txt): Select component (the set) at 208; a row per property — the name (a button
 * that renames the property) at 8, the value at 108 (a field: type a value to give this variant, its list picks one
 * or Rename… renames this value in every variant).
 */
export function CurrentVariantSection({ variant }: { variant: CNode }) {
  const ed = useEditor();
  const version = useDocVersion();
  const data = useMemo(() => {
    void version;
    const v = readC(ed, variant.guid) ?? variant;
    const set = setOf(ed, v);
    if (!set) return null;
    const props = variantProperties(set, variantsOf(ed, set));
    return { v, set, props, values: variantValues(v, set.componentPropDefs ?? []) };
  }, [ed, variant, version]);
  if (!data) return null;
  return (
    <div className={styles.properties}>
      <BlockTitle title="Current variant">
        <IconButton icon="24.component.small" label="Select component" tone="secondary" onClick={() => ed.engine.setSelection([data.set.guid])} />
      </BlockTitle>
      <div className={styles.variantRows} data-current-variant="">
        {data.props.map((p) => (
          <VariantRow key={p.name} set={data.set} variant={data.v} name={p.name} values={p.values} value={data.values.get(p.name) ?? ""} />
        ))}
      </div>
    </div>
  );
}

function VariantRow({ set, variant, name, values, value }: { set: CNode; variant: CNode; name: string; values: string[]; value: string }) {
  const ed = useEditor();
  const [renamingName, setRenamingName] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState(false);
  const [list, setList] = useState<DOMRect | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const def = set.componentPropDefs?.find((d) => d.type === "VARIANT" && d.name === name);
  const commit = (typed: string) => {
    const next = typed.trim();
    if (!next || next === value) return;
    if (renameValue) renameVariantValue(ed, set, name, value, next);
    else setVariantValueOf(ed, variant, set, name, next);
  };
  return (
    <div className={styles.variantRow} data-variant-property={name}>
      {renamingName ? (
        <span className={styles.variantName}>
          <RenameInput
            value={name}
            label={`Property name for ${name}`}
            onDone={(next) => {
              setRenamingName(false);
              if (next && def && next !== name) updateProperty(ed, set, def, { name: next }, "Rename property");
            }}
          />
        </span>
      ) : (
        <button type="button" className={styles.variantName} aria-label={`Edit property name for ${name}`} onClick={() => setRenamingName(true)}>
          {name}
        </button>
      )}
      <div className={styles.variantValue} aria-label={`Edit property value for ${name}`}>
        <div ref={field} className={styles.variantField}>
          <input
            ref={input}
            className={styles.variantInput}
            aria-label={`Edit property value for ${name}`}
            value={draft ?? value}
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => {
              if (!cancelled.current && draft !== null) commit(e.currentTarget.value);
              cancelled.current = false;
              setDraft(null);
              setRenameValue(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelled.current = true;
                e.currentTarget.blur();
              }
            }}
          />
          <button type="button" className={styles.variantChevron} aria-label={`${name} values`} aria-expanded={!!list} onClick={() => setList(list ? null : (field.current?.getBoundingClientRect() ?? null))}>
            <Icon name="16.chevron.down" />
          </button>
        </div>
      </div>
      {list && (
        <ContextMenu
          at={{ x: list.left, y: list.bottom + 4 }}
          over={{ rect: list, align: "left" }}
          entries={[...values.map((v) => ({ id: `value:${v}`, label: v, checked: v === value })), { id: "rename", label: "Rename…", checked: false }]}
          onSelect={(id) => {
            if (id === "rename") {
              setRenameValue(true);
              setDraft(value);
              requestAnimationFrame(() => input.current?.focus());
            } else setVariantValueOf(ed, variant, set, name, id.slice("value:".length));
          }}
          onClose={() => setList(null)}
        />
      )}
    </div>
  );
}

// ---- The property settings popover (create / edit) ----------------------------------------------------------------

function PropertyEditor({ owner, target, anchor, onClose }: { owner: CNode; target: EditorTarget; anchor: HTMLElement | null; onClose: () => void }) {
  const ed = useEditor();
  const assets = useComponentAssets();
  const type = target.mode === "create" ? target.type : target.def.type;
  const def = target.mode === "edit" ? (owner.componentPropDefs ?? []).find((d) => guidStr(d.id) === guidStr(target.def.id)) ?? target.def : null;
  const layerName = target.mode === "create" ? target.bind?.layer.name : undefined;
  const [name, setName] = useState(def?.name ?? (type === "TEXT" && layerName ? layerName : ""));
  const initial = target.mode === "create" ? (target.bind ? valueFromLayer(target.bind.layer, type) : undefined) : def?.initialValue;
  const [value, setValue] = useState<ComponentPropValue | undefined>(initial ?? (type === "BOOL" ? { boolValue: true } : type === "TEXT" ? { textValue: { characters: "Text" } } : type === "VARIANT" ? { textValue: { characters: "Default" } } : undefined));
  const [picker, setPicker] = useState<{ kind: "value" | "preferred"; anchor: HTMLElement } | null>(null);
  const [applying, setApplying] = useState<HTMLElement | null>(null);
  const [valueDrag, setValueDrag] = useState<number | null>(null);
  const [valueDrop, setValueDrop] = useState<number | null>(null);
  const slot = (def?.slotPropConfig ?? {}) as NonNullable<ComponentPropDef["slotPropConfig"]>;
  // The variable the default is bound to (the def's varValue, an alias).
  const varValue = def?.varValue as { dataType?: string; value?: { alias?: { guid?: GuidValue } } } | undefined;
  const boundDefault = varValue?.dataType === "ALIAS" && varValue.value?.alias?.guid ? guidStr(varValue.value.alias.guid) : null;
  const preferred = def?.preferredValues?.instanceSwapValues ?? [];
  const title = target.mode === "create" ? `Create ${PROPERTY_TYPE_LABEL[type].toLowerCase()} property` : `Edit ${PROPERTY_TYPE_LABEL[type].toLowerCase()} property`;
  const editValue = (v: ComponentPropValue) => {
    setValue(v);
    if (def) updateProperty(ed, owner, def, { initialValue: v }, "Edit property");
  };
  const swapName = value?.guidValue ? readC(ed, guidStr(value.guidValue))?.name : undefined;
  const variants = isComponentSet(owner) && def?.type === "VARIANT" ? variantProperties(owner, variantsOf(ed, owner)).find((p) => p.name === def.name) : undefined;
  return (
    <Popover anchor={anchor} title={title} width={240} onClose={onClose} label={title}>
      <div className={styles.editor} data-property-editor={type}>
        <span className={styles.editorLabel}>Name</span>
        <TextInput
          label="Name"
          value={name}
          placeholder={type === "VARIANT" ? "Property" : "Property 1"}
          autoFocus
          onCommit={(v) => {
            setName(v);
            if (def && v.trim() && v !== def.name) updateProperty(ed, owner, def, { name: v.trim() }, "Rename property");
          }}
        />
        {type === "BOOL" && boundDefault && def && (
          <>
            <span className={styles.editorLabel}>Value</span>
            <BoundPill id={boundDefault} label="Value" onOpen={setApplying} onDetach={() => bindPropertyVariable(ed, owner.guid, def.name, null)} />
          </>
        )}
        {type === "BOOL" && !boundDefault && (
          <>
            <span className={styles.editorLabel}>Value</span>
            <Select
              label="Value"
              value={value?.boolValue === false ? "false" : "true"}
              options={[
                { value: "true", label: "True" },
                { value: "false", label: "False" },
              ]}
              onChange={(v) => editValue({ boolValue: v === "true" })}
            />
          </>
        )}
        {type === "TEXT" && boundDefault && def && (
          <>
            <span className={styles.editorLabel}>Value</span>
            <BoundPill id={boundDefault} label="Value" onOpen={setApplying} onDetach={() => bindPropertyVariable(ed, owner.guid, def.name, null)} />
          </>
        )}
        {type === "TEXT" && !boundDefault && (
          <>
            <span className={styles.editorLabel}>Value</span>
            <TextInput label="Value" value={value?.textValue?.characters ?? ""} onCommit={(v) => editValue({ textValue: { characters: v } })} />
          </>
        )}
        {(type === "BOOL" || type === "TEXT") && def && !boundDefault && (
          // "Apply variable" (help: a boolean variable for a boolean property's default, a string one for a text one).
          <span className={cx(styles.editorWide, styles.editorFooterStart)}>
            <Button variant="secondary" onClick={(e) => setApplying(e.currentTarget)} {...tooltipProps("Apply variable")}>
              <Icon name="24.variable.small" />
              Apply variable
            </Button>
          </span>
        )}
        {applying && def && (
          <VariablePicker
            anchor={applying}
            types={[type === "BOOL" ? "BOOLEAN" : "STRING"]}
            current={boundDefault}
            onPick={(v) => bindPropertyVariable(ed, owner.guid, def.name, v.id)}
            onClose={() => setApplying(null)}
          />
        )}
        {type === "VARIANT" && !def && (
          <>
            <span className={styles.editorLabel}>Value</span>
            <TextInput label="Value" value={value?.textValue?.characters ?? ""} onCommit={(v) => setValue({ textValue: { characters: v } })} />
          </>
        )}
        {type === "VARIANT" && variants && (
          <>
            <span className={cx(styles.editorLabel, styles.editorWide)}>Values</span>
            {variants.values.map((v, i) => (
              // Hover a value to reveal its handle; drag to reorder (help "Create and use variants").
              <div
                key={v}
                className={cx(styles.editorWide, styles.valueRow, valueDrop === i && styles.valueDrop)}
                data-variant-value={v}
                onDragOver={(e) => {
                  if (valueDrag === null) return;
                  e.preventDefault();
                  setValueDrop(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (valueDrag !== null && valueDrag !== i) reorderVariantValues(ed, owner, variants.name, moveValue(variants.values, valueDrag, i));
                  setValueDrag(null);
                  setValueDrop(null);
                }}
              >
                <span
                  className={styles.valueHandle}
                  draggable
                  aria-label={`Reorder ${v}`}
                  onDragStart={(e) => {
                    setValueDrag(i);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setValueDrag(null);
                    setValueDrop(null);
                  }}
                >
                  <Icon name="16.drag" />
                </span>
                <TextInput label={`Value ${v}`} value={v} onCommit={(next) => next.trim() && next !== v && renameVariantValue(ed, owner, variants.name, v, next.trim())} />
              </div>
            ))}
          </>
        )}
        {type === "INSTANCE_SWAP" && (
          <>
            <span className={styles.editorLabel}>Value</span>
            <button type="button" className={styles.swapField} aria-label={`Value: ${swapName ?? "None"}`} onClick={(e) => setPicker({ kind: "value", anchor: e.currentTarget })}>
              <Icon name="16.instance" className={styles.purpleIcon} />
              <span className={styles.headerText}>{swapName ? assetLabel(swapName) : "Choose a component"}</span>
              <Icon name="16.chevron.down" className={styles.chevron} />
            </button>
          </>
        )}
        {(type === "INSTANCE_SWAP" || type === "SLOT") && def && (
          <>
            <span className={cx(styles.editorLabel, styles.editorWide, styles.editorHeader)}>
              Preferred instances
              <IconButton icon="24.plus.small" label="Add preferred instances" tone="secondary" onClick={(e) => setPicker({ kind: "preferred", anchor: e.currentTarget })} />
            </span>
            {preferred.length === 0 && <span className={cx(styles.muted, styles.editorWide)}>None</span>}
            {preferred.map((p) => {
              const a = assets.find((x) => isPreferred(x, p.key));
              return (
                <div key={p.key} className={cx(styles.editorWide, styles.preferredRow)}>
                  <Icon name={a?.kind === "set" ? "16.component.set" : "16.component"} className={styles.purpleIcon} />
                  <span className={styles.headerText}>{a ? assetLabel(a.name) : "Missing component"}</span>
                  <IconButton
                    icon="24.minus.small"
                    label="Remove preferred instance"
                    tone="secondary"
                    onClick={() => updateProperty(ed, owner, def, { preferredValues: { ...def.preferredValues, instanceSwapValues: preferred.filter((x) => x.key !== p.key) } }, "Edit preferred values")}
                  />
                </div>
              );
            })}
          </>
        )}
        {type === "SLOT" && !def && <span className={cx(styles.muted, styles.editorWide)}>Apply it to a frame inside the component.</span>}
        {type === "SLOT" && def && (
          // The slot's settings (help "Use slots"): limits are guidance (a warning past them, never a block); 0 = not set.
          <>
            <div className={styles.editorWide}>
              <TextArea label="Description" value={def.description ?? ""} placeholder="Add a description" minRows={1} maxRows={4} onCommit={(v) => updateProperty(ed, owner, def, { description: v }, "Edit description")} />
            </div>
            <span className={styles.editorLabel}>Minimum layers</span>
            <NumericInput label="Minimum layers" value={slot.minChildren ?? 0} min={0} max={999} onChange={(v, info) => info.final && updateSlotSettings(ed, owner, def, { minChildren: Math.round(v) })} />
            <span className={styles.editorLabel}>Maximum layers</span>
            <NumericInput label="Maximum layers" value={slot.maxChildren ?? 0} min={0} max={999} onChange={(v, info) => info.final && updateSlotSettings(ed, owner, def, { maxChildren: Math.round(v) })} />
            <div className={styles.editorWide}>
              <Checkbox label="Only allow preferred instances" checked={slot.allowPreferredValuesOnly === true} onChange={(on) => updateSlotSettings(ed, owner, def, { allowPreferredValuesOnly: on })} />
            </div>
            {slot.allowPreferredValuesOnly === true && preferred.length > 0 && (
              <div className={styles.editorWide}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    // "View layers": the preferred components, selected on the canvas.
                    const ids = preferred.map((p) => assets.find((x) => isPreferred(x, p.key))?.id).filter((x): x is string => !!x);
                    if (ids.length) ed.engine.setSelection(ids);
                  }}
                >
                  View layers
                </Button>
              </div>
            )}
            <div className={styles.editorWide}>
              <Checkbox label="By default, display empty slots" checked={slot.displayByDefault === true} onChange={(on) => updateSlotSettings(ed, owner, def, { displayByDefault: on })} />
            </div>
            <div className={styles.editorWide}>
              <Checkbox label="By default, fill items on slot's counter-axis" checked={slot.stretchChildOnInsert === true} onChange={(on) => updateSlotSettings(ed, owner, def, { stretchChildOnInsert: on })} />
            </div>
          </>
        )}
        {target.mode === "create" && (
          <div className={cx(styles.editorWide, styles.editorFooter)}>
            <Button
              variant="primary"
              onClick={() => {
                addProperty(ed, owner, type, { name, value, bind: target.bind });
                onClose();
              }}
            >
              Create property
            </Button>
          </div>
        )}
      </div>
      {picker && (
        <ComponentPicker
          anchor={picker.anchor}
          title={picker.kind === "value" ? "Value" : "Preferred instances"}
          current={picker.kind === "value" && value?.guidValue ? guidStr(value.guidValue) : null}
          onPick={(a) => {
            if (picker.kind === "value") editValue({ guidValue: guidVal(a.target) });
            else if (def && !preferred.some((p) => isPreferred(a, p.key)))
              updateProperty(ed, owner, def, { preferredValues: { ...def.preferredValues, instanceSwapValues: [...preferred, { type: a.kind === "set" ? "STATE_GROUP" : "COMPONENT", key: preferredKey(a) }] } }, "Edit preferred values");
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </Popover>
  );
}

// ---- Binding a layer's field to a property ----------------------------------------------------------------------------

/**
 * The "Apply property" button next to a field of a layer inside a main component (Figma's purple bind icon):
 * a menu of the component's properties of the right type (the bound one ticked), Create property…, Detach.
 * Bound, it shows as the property's purple pill. Renders nothing outside components.
 */
export function BindButton({ layer, field, type }: { layer: Pick<CNode, "guid"> & Partial<CNode>; field: BindableField; type: Exclude<ComponentPropType, "VARIANT"> }) {
  const ed = useEditor();
  const version = useDocVersion();
  const [creating, setCreating] = useState<HTMLElement | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const data = useMemo(() => {
    void version;
    const node = readC(ed, layer.guid);
    if (!node || parseDerivedId(node.guid)) return null;
    const owner = owningComponent(ed, node);
    if (!owner || !canBind({ type }, node.type ?? "")) return null;
    const defs = (owner.definer.componentPropDefs ?? []).filter((d) => d.type === type);
    return { node, owner, defs, bound: boundProperty(node, field, owner.definer.componentPropDefs ?? []) };
  }, [ed, layer.guid, field, type, version]);
  if (!data) return null;
  const label = `Apply ${PROPERTY_TYPE_LABEL[type].toLowerCase()} property`;
  const entries: MenuEntry[] = [
    { header: label },
    ...data.defs.map((d) => ({ id: guidStr(d.id), label: d.name, checked: !!data.bound && guidStr(data.bound.id) === guidStr(d.id) })),
    ...(data.defs.length ? ["-" as const] : []),
    { id: "create", label: `Create ${PROPERTY_TYPE_LABEL[type].toLowerCase()} property…` },
    ...(data.bound ? ["-" as const, { id: "detach", label: "Detach property" }] : []),
  ];
  const pick = (id: string) => {
    if (id === "create") return setCreating(wrap.current);
    if (id === "detach") return bindLayer(ed, data.node, field, null);
    const d = data.defs.find((x) => guidStr(x.id) === id);
    if (d) bindLayer(ed, data.node, field, d);
  };
  return (
    <span ref={wrap} className={styles.bindWrap} data-bind={field}>
      {data.bound && (
        <span className={styles.pill} title={`${PROPERTY_TYPE_LABEL[type]} property`}>
          <Icon name={PROPERTY_ICON[type]} />
          <span className={styles.pillText}>{data.bound.name}</span>
        </span>
      )}
      <MenuButton label={label} entries={entries} className={cx(styles.iconMenu, styles.bindButton, data.bound && styles.bindOn)} onSelect={pick}>
        <Icon name="24.component.small" />
      </MenuButton>
      {creating && (
        <PropertyEditor owner={data.owner.definer} target={{ mode: "create", type, bind: { layer: data.node, field } }} anchor={creating} onClose={() => setCreating(null)} />
      )}
    </span>
  );
}
