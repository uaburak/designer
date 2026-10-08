/**
 * Components in the Design panel (UI3; docs/research/figma/R4-components.md):
 *
 * - an instance: the header (◇, the main's name ▾ = the instance menu to swap,
 *   Go to main component, ⋯ = Go to main component / Push changes / Reset ▸ /
 *   Detach instance), then its properties — variant dropdowns, Boolean
 *   toggles, Text fields, Instance swap pickers (preferred first) — and one
 *   block per exposed nested instance;
 * - a main component or a set: the header (◆◆ in purple, Add variant), then
 *   Properties with "+" (Variant, Boolean, Instance swap, Text, Slot): each
 *   property opens its settings (name, default, preferred values), "−"
 *   deletes it; the description;
 * - a variant: "Current variant", its values per property;
 * - a layer inside a component: the purple "Apply property" button next to
 *   the field it binds (visibility, text, a nested instance), the bound
 *   property as a pill (BindButton, used by Appearance, Typography and the
 *   instance header).
 *
 * Everything writes one undo step (components.ts); structural actions are the
 * engine's commands, disabled until it has them.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Icon, IconButton, MenuButton, NumericInput, PanelSection, Popover, Select, Switch, TextArea, TextInput, cx, showToast, tooltipProps, type IconName, type MenuEntry } from "@/ds";
import { useEditor, type EditorController } from "../../controller";
import { command, isEnabled, runEditorCommand, shortcutOf } from "../../commands";
import { commandItem, RESET_PREFIX, runMenuItem } from "../../menus";
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
  setDescription,
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
import { ComponentPicker, useComponentAssets } from "./ComponentPicker";
import { BoundPill } from "./Variables";
import { VariablePicker } from "../variables/VariablePicker";
import vstyles from "../variables/Variables.module.css";
import type { PanelNode } from "./shared";
import styles from "./Component.module.css";

export const PROPERTY_ICON: Record<ComponentPropType, IconName> = {
  VARIANT: "16.variant",
  BOOL: "16.visible",
  TEXT: "16.text",
  INSTANCE_SWAP: "16.instance",
  SLOT: "16.slot",
};

/** The "+" menu's order (Figma's). */
const ADD_TYPES: ComponentPropType[] = ["VARIANT", "BOOL", "INSTANCE_SWAP", "TEXT", "SLOT"];

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

/** The instance's header row: ◇, the main's name ▾ (the instance menu), Go to main component, ⋯. */
export function InstanceHeader({ instance }: { instance: CNode }) {
  const ed = useEditor();
  const version = useDocVersion();
  const topics = useTopics(ed.store, ["selection", "undo"]);
  const main = mainOf(ed, instance);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const goTo = command("object.go-to-main-component");
  // The ⋯ menu's entries change with the document and the selection, not with every re-render of the panel (a drag
  // re-renders it per frame): built once per change, each item's state from the shared component read.
  // Figma's live "More actions" (popovers/instance-more-actions-menu.txt): Toggle ready for dev status · Create
  // component, Detach instance, Reset instance, Reset name · Use as mask · Union … Flatten. Built once per change.
  const more = useMemo<MenuEntry[]>(() => {
    void version;
    void topics;
    const targets = statusTargets(ed);
    const ready = targets.length > 0 && statusOfTargets(ed, targets) === "BUILD";
    const changes = instanceChanges(ed, instance);
    const nameGroup = changes.find((g) => g.fields.includes("name"));
    const live = (e: MenuEntry) => e === "-" || !("id" in e) || !e.disabled;
    return [
      ...(targets.length ? [{ id: "ready-for-dev", label: "Toggle ready for dev status", checked: ready }, "-" as const] : []),
      ...[commandItem(ed, "object.create-component"), commandItem(ed, "object.detach-instance"), { ...commandItem(ed, "object.reset-all-changes"), label: "Reset instance" }].filter(live),
      ...(nameGroup ? [{ id: `${RESET_PREFIX}${nameGroup.fields.join(",")}`, label: "Reset name" }] : []),
      ...(isEnabled(ed, command("object.push-changes")) ? [commandItem(ed, "object.push-changes")] : []),
      "-",
      ...[commandItem(ed, "object.use-as-mask")].filter(live),
      "-",
      ...[
        commandItem(ed, "vector.union", "Union"),
        commandItem(ed, "vector.subtract", "Subtract"),
        commandItem(ed, "vector.intersect", "Intersect"),
        commandItem(ed, "vector.exclude", "Exclude"),
        commandItem(ed, "vector.flatten"),
      ].filter(live),
    ];
  }, [ed, instance, version, topics]);
  const name = main ? main.name ?? "" : "Missing component";
  const onMore = (id: string) => {
    if (id === "ready-for-dev") {
      const targets = statusTargets(ed);
      runEditorCommand(ed, statusOfTargets(ed, targets) === "BUILD" ? "object.remove-dev-status" : "object.mark-ready-for-dev");
    } else void runMenuItem(ed, id);
  };
  const bound = !!(instance as { componentPropRefs?: unknown[] }).componentPropRefs?.length;
  return (
    <div className={styles.instanceHead} data-instance-header="">
      {/* Figma's live panel: the main's name (13px, the instance menu) and More actions; under it "Go to main component" reading where the main lives */}
      <div className={styles.instanceTitleRow}>
        <button type="button" className={styles.instanceName} aria-label={`Instance menu: ${name}`} aria-expanded={!!picker} onClick={(e) => setPicker(picker ? null : e.currentTarget)}>
          <span className={styles.headerText}>{assetLabel(name)}</span>
          <Icon name="16.chevron.down" className={styles.chevron} />
        </button>
        <div className={styles.headerActions}>
          {bound && <BindButton layer={instance} field="OVERRIDDEN_SYMBOL_ID" type="INSTANCE_SWAP" />}
          <MenuButton label="More actions" entries={more} className={styles.iconMenu} onSelect={onMore}>
            <Icon name="24.more" />
          </MenuButton>
        </div>
      </div>
      <button type="button" className={styles.fromRow} aria-label={goTo.label} {...tooltipProps(goTo.label)} disabled={!isEnabled(ed, goTo)} onClick={() => runEditorCommand(ed, goTo.id)}>
        {main ? "From this file" : "Missing component"}
      </button>
      <InstanceProperties instance={instance} />
      {picker && (
        <ComponentPicker anchor={picker} current={main?.guid ?? null} onPick={(a) => swapTo(ed, [instance.guid], a, main)} onClose={() => setPicker(null)} />
      )}
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

function InstancePropertyRow({ info, row }: { info: InstanceInfo; row: PropertyRowData }) {
  const ed = useEditor();
  const { def } = row;
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [assign, setAssign] = useState<HTMLElement | null>(null);
  const instance = info.instance;
  const toggle = def.type === "VARIANT" ? variantToggle(row.options ?? []) : null;
  let control: React.ReactNode;
  switch (def.type) {
    case "VARIANT":
      // "Assign variable" (help "Modes for variables"): a string, number or boolean variable picks the variant in every
      // mode; bound, the row shows the variable's pill (a click picks another, Detach on hover).
      control = (
        <>
          {row.variable ? (
            <BoundPill id={row.variable} label={def.name} onOpen={(a) => setAssign(a)} onDetach={() => bindPropertyVariable(ed, instance.guid, def.name, null)} />
          ) : toggle ? (
            // True / False, Yes / No, On / Off: a toggle (Figma), still bindable to a variable.
            <div className={vstyles.bindWrap} data-assign-variable={def.name} data-variant-toggle={def.name}>
              <Switch label={def.name} checked={row.variantValue === toggle.on} onChange={(on) => setVariant(ed, readC(ed, instance.guid) ?? instance, def.name, on ? toggle.on : toggle.off)} />
              <button type="button" className={vstyles.applyButton} aria-label="Assign variable" aria-expanded={!!assign} {...tooltipProps("Assign variable")} onClick={(e) => setAssign(e.currentTarget)}>
                <Icon name="24.variable.small" />
              </button>
            </div>
          ) : (
            <div className={vstyles.bindWrap} data-assign-variable={def.name}>
              <Select
                label={def.name}
                variant="outlined"
                value={row.variantValue ?? ""}
                options={(row.options ?? []).map((v) => ({ value: v, label: v }))}
                onChange={(v) => setVariant(ed, readC(ed, instance.guid) ?? instance, def.name, v)}
              />
              <button type="button" className={vstyles.applyButton} aria-label="Assign variable" aria-expanded={!!assign} {...tooltipProps("Assign variable")} onClick={(e) => setAssign(e.currentTarget)}>
                <Icon name="24.variable.small" />
              </button>
            </div>
          )}
          {assign && (
            <VariablePicker
              anchor={assign}
              title="Assign variable"
              types={["STRING", "FLOAT", "BOOLEAN"]}
              current={row.variable ?? null}
              consumer={instance.guid.startsWith("I") ? null : instance.guid}
              onPick={(v) => bindPropertyVariable(ed, instance.guid, def.name, v.id)}
              onClose={() => setAssign(null)}
            />
          )}
        </>
      );
      break;
    case "BOOL":
      control = <Switch label={def.name} checked={row.value?.boolValue !== false} onChange={(on) => setPropertyValue(ed, readC(ed, instance.guid) ?? instance, def, { boolValue: on })} />;
      break;
    case "TEXT":
      control = (
        <TextInput
          label={def.name}
          value={row.value?.textValue?.characters ?? ""}
          onCommit={(v) => setPropertyValue(ed, readC(ed, instance.guid) ?? instance, def, { textValue: { characters: v } })}
        />
      );
      break;
    case "INSTANCE_SWAP": {
      const current = row.value?.guidValue ? readC(ed, guidStr(row.value.guidValue)) : null;
      control = (
        <>
          <button type="button" className={styles.swapField} aria-label={`${def.name}: ${current?.name ?? "None"}`} onClick={(e) => setPicker(picker ? null : e.currentTarget)}>
            <Icon name="16.instance" className={styles.purpleIcon} />
            <span className={styles.headerText}>{current ? assetLabel(current.name ?? "") : "None"}</span>
            <Icon name="16.chevron.down" className={styles.chevron} />
          </button>
          {picker && (
            <ComponentPicker
              anchor={picker}
              title={def.name}
              current={current?.guid ?? null}
              preferredKeys={def.preferredValues?.instanceSwapValues?.map((p) => p.key)}
              onPick={(a) => setPropertyValue(ed, readC(ed, instance.guid) ?? instance, def, { guidValue: guidVal(a.target) })}
              onClose={() => setPicker(null)}
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
      <span className={styles.propLabel} title={def.name}>
        {def.name}
      </span>
      <div className={styles.propControl}>{control}</div>
    </div>
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
  const [picker, setPicker] = useState<HTMLElement | null>(null);
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
      <IconButton icon="24.plus.small" label="Add instances" tone="secondary" aria-expanded={!!picker} onClick={(e) => setPicker(picker ? null : e.currentTarget)} />
      <MenuButton label="More actions" entries={more} className={styles.iconMenu} onSelect={(id) => (id === "reset" ? resetSlot(ed, state.ref) : clearSlot(ed, state.ref))}>
        <Icon name="24.more" />
      </MenuButton>
      {picker && (
        <ComponentPicker anchor={picker} title="Add instances" preferredKeys={preferredKeys} preferredFilter onPick={(a) => addInstanceToSlot(ed, state.ref, a, config)} onClose={() => setPicker(null)} />
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

/** The header for a main component, a variant or a set: the purple glyph and type, Add variant. */
export function ComponentHeader({ sel, actions }: { sel: ComponentSelection; actions?: React.ReactNode }) {
  const ed = useEditor();
  useTopics(ed.store, ["selection", "undo", "structure"]);
  const label = sel.kind === "set" ? "Component set" : sel.kind === "variant" ? "Variant" : "Component";
  const add = command("object.add-variant");
  return (
    <div className={styles.header} data-component-header={sel.kind}>
      <div className={styles.headerLabel}>
        <Icon name={sel.kind === "set" ? "16.component.set" : "16.component"} className={styles.purpleIcon} />
        <span className={cx(styles.headerText, styles.purpleText)}>{label}</span>
      </div>
      <div className={styles.headerActions}>
        <IconButton icon="24.add-variant.small" label={add.label} tone="secondary" disabled={!isEnabled(ed, add)} onClick={() => runEditorCommand(ed, add.id)} />
        {actions}
      </div>
    </div>
  );
}

type EditorTarget = { mode: "create"; type: ComponentPropType; bind?: { layer: CNode; field: BindableField } } | { mode: "edit"; def: ComponentPropDef };

/** Properties of a main component or a set: "+", one row per property, the description. */
export function PropertiesSection({ owner }: { owner: CNode }) {
  const ed = useEditor();
  const version = useDocVersion();
  const fresh = useMemo(() => {
    void version;
    return readC(ed, owner.guid) ?? owner;
  }, [ed, owner, version]);
  const [editing, setEditing] = useState<{ target: EditorTarget; anchor: HTMLElement | null } | null>(null);
  const addRef = useRef<HTMLSpanElement>(null);
  const defs = sortedDefs(fresh.componentPropDefs ?? []);
  const variants = isComponentSet(fresh) ? variantsOf(ed, fresh) : [];
  const variantProps = isComponentSet(fresh) ? variantProperties(fresh, variants) : [];
  const nestedInstances = nestedInstancesOf(ed, fresh);
  const exposed = nestedInstances.filter((n) => n.propsAreBubbled === true);
  const [dragging, setDragging] = useState<ComponentPropDef | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const entries: MenuEntry[] = [
    ...ADD_TYPES.map((t) => ({ id: t, label: PROPERTY_TYPE_LABEL[t], icon: PROPERTY_ICON[t], disabled: !canAddProperty(ed, fresh, t) })),
    ...(nestedInstances.length
      ? ["-" as const, { header: "Expose properties from" }, { id: "submenu:nested", label: "Nested instances", items: nestedInstances.map((n) => ({ id: `expose:${n.guid}`, label: n.name ?? "", checked: n.propsAreBubbled === true })) }]
      : []),
  ];
  const onAdd = (id: string) => {
    if (id.startsWith("expose:")) {
      const n = nestedInstances.find((x) => x.guid === id.slice("expose:".length));
      if (n) setExposed(ed, n, n.propsAreBubbled !== true);
      return;
    }
    setEditing({ target: { mode: "create", type: id as ComponentPropType }, anchor: addRef.current?.querySelector("button") ?? null });
  };
  const summary = (d: ComponentPropDef): string => {
    if (d.type === "VARIANT") return variantProps.find((p) => p.name === d.name)?.values.join(", ") ?? "";
    if (d.type === "BOOL") return d.initialValue?.boolValue === false ? "False" : "True";
    if (d.type === "TEXT") return d.initialValue?.textValue?.characters ?? "";
    if (d.type === "INSTANCE_SWAP") {
      const c = d.initialValue?.guidValue ? readC(ed, guidStr(d.initialValue.guidValue)) : null;
      return c ? assetLabel(c.name ?? "") : "";
    }
    return "";
  };
  return (
    <PanelSection
      title="Properties"
      actions={
        <span ref={addRef} style={{ display: "contents" }}>
          <MenuButton label="Create component property" entries={entries} className={styles.iconMenu} onSelect={onAdd}>
            <Icon name="24.plus.small" />
          </MenuButton>
        </span>
      }
    >
      <div className={styles.defs} data-component-properties="">
        {defs.length === 0 && <div className={styles.empty}>Click + to create a property</div>}
        {defs.map((d) => (
          <div
            key={guidStr(d.id)}
            className={cx(styles.defRow, dragOver === guidStr(d.id) && styles.defDrop)}
            data-property-row={d.name}
            draggable
            onDragStart={(e) => {
              setDragging(d);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              // Within its own group: variant properties always stay above the others (Figma).
              if (!dragging || (dragging.type === "VARIANT") !== (d.type === "VARIANT")) return;
              e.preventDefault();
              setDragOver(guidStr(d.id));
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging && guidStr(dragging.id) !== guidStr(d.id)) reorderProperty(ed, fresh, dragging, d);
              setDragging(null);
              setDragOver(null);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDragOver(null);
            }}
          >
            <button type="button" className={styles.defButton} aria-label={`Edit property ${d.name}`} onClick={(e) => setEditing({ target: { mode: "edit", def: d }, anchor: e.currentTarget })}>
              <Icon name={PROPERTY_ICON[d.type]} className={styles.purpleIcon} />
              <span className={styles.defName}>{d.name}</span>
              <span className={styles.defValue}>{summary(d)}</span>
            </button>
            <IconButton icon="24.minus.small" label={`Delete property ${d.name}`} tone="secondary" disabled={d.type === "VARIANT" && defs.filter((x) => x.type === "VARIANT").length <= 1} onClick={() => deleteProperty(ed, fresh, d)} />
          </div>
        ))}
        {exposed.length > 0 && (
          // Exposed nested instances (help: "appear as a list in the right panel"; hover a name, − stops exposing it).
          <div className={styles.exposedList} data-exposed-instances="">
            {exposed.map((n) => (
              <div key={n.guid} className={styles.defRow} data-exposed-instance={n.name ?? ""}>
                <span className={styles.defButton}>
                  <Icon name="16.instance" className={styles.purpleIcon} />
                  <span className={styles.defName}>{n.name}</span>
                </span>
                <IconButton icon="24.minus.small" label={`Stop exposing ${n.name ?? ""}`} tone="secondary" onClick={() => setExposed(ed, n, false)} />
              </div>
            ))}
          </div>
        )}
        <Description owner={fresh} />
      </div>
      {editing && <PropertyEditor owner={fresh} target={editing.target} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </PanelSection>
  );
}

function Description({ owner }: { owner: CNode }) {
  const ed = useEditor();
  return (
    <div className={styles.description}>
      <TextArea label="Description" value={owner.description ?? ""} placeholder="Add a description" minRows={1} maxRows={6} onCommit={(v) => setDescription(ed, owner, v)} />
    </div>
  );
}

/** "Current variant": the selected variant's value for each of the set's properties. */
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
    <PanelSection title="Current variant">
      <div className={styles.instanceBody} data-current-variant="">
        {data.props.map((p) => (
          <div key={p.name} className={styles.propRow}>
            <span className={styles.propLabel}>{p.name}</span>
            <div className={styles.propControl}>
              <Select label={p.name} variant="outlined" value={data.values.get(p.name) ?? ""} options={p.values.map((x) => ({ value: x, label: x }))} onChange={(x) => setVariantValueOf(ed, data.v, data.set, p.name, x)} />
            </div>
          </div>
        ))}
        <Description owner={data.v} />
      </div>
    </PanelSection>
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
