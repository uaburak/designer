/**
 * Create property › Slot, and a slot property's settings, as live Figma's form (popovers/component-create-slot-property.txt,
 * 304 × 626 left of the panel, 4 above the Create property button): "Create property"; Name ("Slot"); Description, the
 * rich-text field of Component configuration (placeholder "How to use this slot"; Bold ⌘B … Code block ⌘⇧⌥C);
 * "Settings": Minimum layers / Maximum layers (120 wide fields, empty = no limit), Only allow preferred instances,
 * By default, display empty slot, By default, fill items on slot's counter axis (disabled with "Slot must have auto
 * layout" until the slot's layer has auto layout; its info icon explains the axis); "Preferred instances" with Learn
 * more and "+" (Select preferred values); the blue "Create property".
 *
 * Creating collects everything and writes it once (components.ts createSlotProperty: one undo step). Editing an
 * existing slot property shows the same form titled "Edit property" (unverified: live has no capture of it) and
 * writes each change as it is made, without the Create button.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Icon, IconButton, NumericInput, Popover, cx, tooltipProps } from "@/ds";
import { useEditor } from "../../controller";
import { createSlotProperty, newSlotName, readC, slotLayerOf, updateProperty, updateSlotSettings, type SlotPropertyForm, type SlotSettingsPatch } from "../../components";
import { assetLabel, guidStr, isPreferred, preferredKey, type BindableField, type CNode, type ComponentPropDef } from "../../model/components";
import { ComponentPicker, useComponentAssets } from "./ComponentPicker";
import { RichTextField } from "./ComponentConfiguration";
import styles from "./SlotProperty.module.css";

/** "Learn more" beside Preferred instances (help.figma.com "Create and use slots"). */
export const SLOT_LEARN_MORE = "https://help.figma.com/hc/en-us/articles/38231200344599";

/** The counter-axis setting's info (live's tooltip on its icon). */
export const COUNTER_AXIS_INFO = "If a slot follows a horizontal flow (x-axis), items will stretch along its height (y-axis).";

/** Whether a layer has auto layout (the counter-axis setting needs it: live "Slot must have auto layout"). */
export const hasAutoLayout = (n: CNode | null): boolean => {
  const mode = (n as { stackMode?: string } | null)?.stackMode;
  return mode === "HORIZONTAL" || mode === "VERTICAL";
};

export function SlotPropertyEditor({
  owner,
  def,
  bind,
  anchor,
  onClose,
}: {
  owner: CNode;
  /** null: Create property › Slot */
  def: ComponentPropDef | null;
  bind?: { layer: CNode; field: BindableField };
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const ed = useEditor();
  const assets = useComponentAssets();
  const creating = !def;
  const [form, setForm] = useState<SlotPropertyForm>(() => ({
    name: def?.name ?? newSlotName(owner.componentPropDefs ?? []),
    description: def?.description ?? "",
    minChildren: def?.slotPropConfig?.minChildren ?? null,
    maxChildren: def?.slotPropConfig?.maxChildren ?? null,
    allowPreferredValuesOnly: def?.slotPropConfig?.allowPreferredValuesOnly === true,
    displayByDefault: def?.slotPropConfig?.displayByDefault === true,
    stretchChildOnInsert: def?.slotPropConfig?.stretchChildOnInsert === true,
    preferred: (def?.preferredValues?.instanceSwapValues ?? []).map((p) => ({ type: p.type === "STATE_GROUP" ? "STATE_GROUP" : "COMPONENT", key: p.key })),
  }));
  const formRef = useRef(form);
  const flushDescription = useRef<() => void>(() => {});
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  // The slot's layer (the one the property is applied to): the counter-axis setting needs its auto layout.
  const slotLayer = useMemo(() => (bind ? readC(ed, bind.layer.guid) : def ? slotLayerOf(ed, owner, def) : null), [ed, owner, def, bind]);
  const canStretch = hasAutoLayout(slotLayer);
  const fresh = () => (def ? ((readC(ed, owner.guid)?.componentPropDefs ?? []).find((d) => guidStr(d.id) === guidStr(def.id)) ?? def) : null);
  /** Edits: kept in the form while creating, written at once while editing. */
  const change = (patch: Partial<SlotPropertyForm>) => {
    const next = { ...formRef.current, ...patch };
    formRef.current = next;
    setForm(next);
    const d = fresh();
    if (!d) return;
    if (patch.name !== undefined && patch.name.trim() && patch.name.trim() !== d.name) updateProperty(ed, owner, d, { name: patch.name.trim() }, "Rename property");
    if (patch.description !== undefined) updateProperty(ed, owner, d, { description: patch.description }, "Edit description");
    if (patch.preferred !== undefined) updateProperty(ed, owner, d, { preferredValues: { ...d.preferredValues, instanceSwapValues: patch.preferred } }, "Edit preferred values");
    const settings: SlotSettingsPatch = {};
    if ("minChildren" in patch) settings.minChildren = patch.minChildren;
    if ("maxChildren" in patch) settings.maxChildren = patch.maxChildren;
    if (patch.allowPreferredValuesOnly !== undefined) settings.allowPreferredValuesOnly = patch.allowPreferredValuesOnly;
    if (patch.displayByDefault !== undefined) settings.displayByDefault = patch.displayByDefault;
    if (patch.stretchChildOnInsert !== undefined) settings.stretchChildOnInsert = patch.stretchChildOnInsert;
    if (Object.keys(settings).length) updateSlotSettings(ed, owner, d, settings);
  };
  const create = () => {
    flushDescription.current();
    createSlotProperty(ed, owner, { ...formRef.current, stretchChildOnInsert: canStretch && formRef.current.stretchChildOnInsert }, bind);
    onClose();
  };
  const limit = (key: "minChildren" | "maxChildren", label: string) => (
    <>
      <span className={styles.fieldLabel}>{label}</span>
      <NumericInput
        className={styles.limit}
        label={label}
        value={form[key]}
        min={0}
        max={999}
        precision={0}
        scrub={false}
        onChange={(v, info) => info.final && change({ [key]: Math.max(0, Math.round(v)) })}
        onClear={() => change({ [key]: null })}
      />
    </>
  );
  const preferredLabel = (key: string) => {
    const a = assets.find((x) => isPreferred(x, key));
    return a ? assetLabel(a.name) : "Missing component";
  };
  const title = creating ? "Create property" : "Edit property";
  return (
    <Popover anchor={anchor} title={title} width={304} offsetY={-4} onClose={() => (flushDescription.current(), onClose())} label={title}>
      <div className={styles.form} data-property-editor="SLOT" data-slot-form={creating ? "create" : "edit"}>
        <span className={styles.label}>Name</span>
        <NameField value={form.name} onCommit={(v) => change({ name: v })} />
        <span className={cx(styles.label, styles.gap)}>Description</span>
        <RichTextField value={form.description} placeholder="How to use this slot" flushRef={flushDescription} onCommit={(md) => change({ description: md })} />
        <span className={cx(styles.label, styles.settings)}>Settings</span>
        <div className={styles.rows}>
          {limit("minChildren", "Minimum layers")}
          {limit("maxChildren", "Maximum layers")}
          <div className={styles.check}>
            <Checkbox tone="panel" label="Only allow preferred instances" checked={form.allowPreferredValuesOnly} onChange={(on) => change({ allowPreferredValuesOnly: on })} />
          </div>
          {!creating && form.allowPreferredValuesOnly && form.preferred.length > 0 && (
            <div className={styles.check}>
              <Button
                variant="secondary"
                onClick={() => {
                  // "View layers": the preferred components, selected on the canvas (help "Use slots").
                  const ids = form.preferred.map((p) => assets.find((x) => isPreferred(x, p.key))?.id).filter((x): x is string => !!x);
                  if (ids.length) ed.engine.setSelection(ids);
                }}
              >
                View layers
              </Button>
            </div>
          )}
          <div className={styles.check}>
            <Checkbox tone="panel" label="By default, display empty slot" checked={form.displayByDefault} onChange={(on) => change({ displayByDefault: on })} />
          </div>
          <div className={styles.check} {...(canStretch ? {} : tooltipProps("Slot must have auto layout"))} data-slot-counter-axis={canStretch ? "" : "disabled"}>
            <Checkbox tone="panel" label="By default, fill items on slot's counter axis" disabled={!canStretch} checked={canStretch && form.stretchChildOnInsert} onChange={(on) => change({ stretchChildOnInsert: on })} />
            <span className={styles.info} role="img" aria-label={COUNTER_AXIS_INFO} {...tooltipProps(COUNTER_AXIS_INFO)}>
              <Icon name="16.info" />
            </span>
          </div>
        </div>
        <div className={styles.preferredHeader}>
          <span className={styles.preferredTitle}>Preferred instances</span>
          <a className={styles.learnMore} href={SLOT_LEARN_MORE} target="_blank" rel="noreferrer">
            Learn more
          </a>
          <IconButton icon="24.plus.small" label="Select preferred values" tone="secondary" className={styles.add} aria-expanded={!!picker} onClick={(e) => setPicker(picker ? null : e.currentTarget)} />
        </div>
        {form.preferred.map((p) => (
          <div key={p.key} className={styles.preferredRow} data-slot-preferred={p.key}>
            <Icon name={p.type === "STATE_GROUP" ? "16.component.set" : "16.component"} className={styles.purple} />
            <span className={styles.preferredName}>{preferredLabel(p.key)}</span>
            <IconButton icon="24.minus.small" label="Remove preferred instance" tone="secondary" onClick={() => change({ preferred: form.preferred.filter((x) => x.key !== p.key) })} />
          </div>
        ))}
        {creating && (
          <div className={styles.footer}>
            <Button variant="primary" onClick={create}>
              Create property
            </Button>
          </div>
        )}
      </div>
      {picker && (
        <ComponentPicker
          anchor={picker}
          title="Preferred instances"
          onPick={(a) => {
            if (form.preferred.some((p) => isPreferred(a, p.key))) return;
            change({ preferred: [...form.preferred, { type: a.kind === "set" ? "STATE_GROUP" : "COMPONENT", key: preferredKey(a) }] });
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </Popover>
  );
}

/**
 * The Name field as live draws it (the input itself the 272 × 24 box at 16, 72, its text 8 in): focused and selected
 * on open; Enter or leaving it commits, Esc puts it back (a second Esc reaches the popover: it closes).
 */
function NameField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className={styles.name}
      aria-label="Name"
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || draft !== value) e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape" && draft !== value) {
          e.preventDefault();
          setDraft(value);
        }
      }}
    />
  );
}
