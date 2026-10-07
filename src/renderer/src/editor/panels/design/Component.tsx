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
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, Icon, IconButton, MenuButton, PanelSection, Popover, Select, Switch, TextArea, TextInput, cx, type IconName, type MenuEntry } from "@/ds";
import { useEditor, type EditorController } from "../../controller";
import { command, isEnabled, runEditorCommand, shortcutOf } from "../../commands";
import { commandItem, resetSubmenu, runMenuItem } from "../../menus";
import { useTopics } from "../../hooks";
import {
  addProperty,
  bindLayer,
  boundProperty,
  canAddProperty,
  deleteProperty,
  instanceInfo,
  mainOf,
  nestedInstancesOf,
  owningComponent,
  readC,
  renameVariantValue,
  setDescription,
  setExposed,
  setOf,
  setPropertyValue,
  setVariant,
  setVariantValueOf,
  swapInstance,
  updateProperty,
  valueFromLayer,
  variantsOf,
  type InstanceInfo,
  type PropertyRowData,
} from "../../components";
import {
  PROPERTY_TYPE_LABEL,
  assetLabel,
  canBind,
  guidStr,
  guidVal,
  isComponent,
  isPreferred,
  preferredKey,
  isComponentSet,
  isInstance,
  parseDerivedId,
  sortedDefs,
  variantProperties,
  variantValues,
  type BindableField,
  type CNode,
  type ComponentAsset,
  type ComponentPropDef,
  type ComponentPropType,
  type ComponentPropValue,
} from "../../model/components";
import { ComponentPicker, useComponentAssets } from "./ComponentPicker";
import type { PanelNode } from "./shared";
import styles from "./Component.module.css";

export const PROPERTY_ICON: Record<ComponentPropType, IconName> = {
  VARIANT: "16.variant",
  BOOL: "16.visible",
  TEXT: "16.text",
  INSTANCE_SWAP: "16.instance",
  SLOT: "16.frame",
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
  useDocVersion();
  useTopics(ed.store, ["selection", "undo"]);
  const main = mainOf(ed, instance);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const goTo = command("object.go-to-main-component");
  const more: MenuEntry[] = [commandItem(ed, "object.go-to-main-component"), commandItem(ed, "object.push-changes"), "-", ...(resetSubmenu(ed) ? [resetSubmenu(ed)!] : []), commandItem(ed, "object.detach-instance")];
  const name = main ? main.name ?? "" : "Missing component";
  return (
    <div className={styles.header} data-instance-header="">
      <button type="button" className={styles.headerName} aria-label={`Instance menu: ${name}`} aria-expanded={!!picker} onClick={(e) => setPicker(picker ? null : e.currentTarget)}>
        <Icon name="16.instance" className={styles.purpleIcon} />
        <span className={styles.headerText}>{assetLabel(name)}</span>
        <Icon name="16.chevron.down" className={styles.chevron} />
      </button>
      <div className={styles.headerActions}>
        <BindButton layer={instance} field="OVERRIDDEN_SYMBOL_ID" type="INSTANCE_SWAP" />
        <IconButton icon="24.go.to.main.component.small" label={goTo.label} shortcut={shortcutOf(goTo)} tone="secondary" disabled={!isEnabled(ed, goTo)} onClick={() => runEditorCommand(ed, goTo.id)} />
        <MenuButton label="More actions" entries={more} className={styles.iconMenu} onSelect={(id) => void runMenuItem(ed, id)}>
          <Icon name="24.more" />
        </MenuButton>
      </div>
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
  const instance = info.instance;
  let control: React.ReactNode;
  switch (def.type) {
    case "VARIANT":
      control = (
        <Select
          label={def.name}
          variant="outlined"
          value={row.variantValue ?? ""}
          options={(row.options ?? []).map((v) => ({ value: v, label: v }))}
          onChange={(v) => setVariant(ed, readC(ed, instance.guid) ?? instance, def.name, v)}
        />
      );
      break;
    case "BOOL":
      control = <Switch label={def.name} checked={row.value?.boolValue !== false} onChange={(on) => setPropertyValue(ed, readC(ed, instance.guid) ?? instance, def, { boolValue: on })} />;
      break;
    case "TEXT":
      control = (
        <TextInput
          label={def.name}
          variant="outlined"
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
      control = <span className={styles.muted}>Slot</span>;
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
          <div key={guidStr(d.id)} className={styles.defRow}>
            <button type="button" className={styles.defButton} aria-label={`Edit property ${d.name}`} onClick={(e) => setEditing({ target: { mode: "edit", def: d }, anchor: e.currentTarget })}>
              <Icon name={PROPERTY_ICON[d.type]} className={styles.purpleIcon} />
              <span className={styles.defName}>{d.name}</span>
              <span className={styles.defValue}>{summary(d)}</span>
            </button>
            <IconButton icon="24.minus.small" label={`Delete property ${d.name}`} tone="secondary" disabled={d.type === "VARIANT" && defs.filter((x) => x.type === "VARIANT").length <= 1} onClick={() => deleteProperty(ed, fresh, d)} />
          </div>
        ))}
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
        {type === "BOOL" && (
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
        {type === "TEXT" && (
          <>
            <span className={styles.editorLabel}>Value</span>
            <TextInput label="Value" value={value?.textValue?.characters ?? ""} onCommit={(v) => editValue({ textValue: { characters: v } })} />
          </>
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
            {variants.values.map((v) => (
              <div key={v} className={styles.editorWide}>
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
        {type === "INSTANCE_SWAP" && def && (
          <>
            <span className={cx(styles.editorLabel, styles.editorWide, styles.editorHeader)}>
              Preferred values
              <IconButton icon="24.plus.small" label="Add preferred values" tone="secondary" onClick={(e) => setPicker({ kind: "preferred", anchor: e.currentTarget })} />
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
                    label="Remove preferred value"
                    tone="secondary"
                    onClick={() => updateProperty(ed, owner, def, { preferredValues: { ...def.preferredValues, instanceSwapValues: preferred.filter((x) => x.key !== p.key) } }, "Edit preferred values")}
                  />
                </div>
              );
            })}
          </>
        )}
        {type === "SLOT" && <span className={cx(styles.muted, styles.editorWide)}>Apply it to a frame inside the component.</span>}
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
          title={picker.kind === "value" ? "Value" : "Preferred values"}
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
