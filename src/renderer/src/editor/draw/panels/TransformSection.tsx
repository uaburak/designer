/**
 * The Transform section (docs/draw.md §5.5; help.figma.com 31440427042839 "Create patterns with transforms"): "+" is
 * the "Additional transform modifier" menu — Linear repeat, Radial repeat (ADD_TRANSFORM_MODIFIER: the selection goes
 * into a transform group, or a transform group gets one more) —; one row per modifier with its glyph and name (a
 * click opens the "Repeat" popover: Count, Gap in px or %, Axis for Linear, Order), the eye (`visible`), "−" to remove
 * and a grip to reorder; "Apply transforms to selection" under the rows when transform groups are selected.
 * Title "Transform" [unverified]; Order's place in the popover [unverified].
 */
import { t, useT } from "@/i18n";
import { useState } from "react";
import { Button, Icon, IconButton, MenuButton, NumericInput, PanelSection, Popover, SegmentedControl, cx, type ChangeInfo, type MenuEntry } from "@/ds";
import { REPEAT_COUNT_RANGE, type RepeatKind, type RepeatModifierInput } from "@shared/draw/types";
import { useEditor } from "../../controller";
import { applyTransforms } from "../drawTools";
import { PANEL_MENU_GAP, type PanelNode } from "../../panels/design/shared";
import { Grip, useReorder } from "../../panels/design/reorder";
import { addRepeat, gapShown, gapStored, isTransformGroup, moveRepeat, removeRepeat, repeatLabel, repeatsOf, setRepeat } from "./drawPanel";
import design from "../../panels/design/Design.module.css";
import styles from "./DrawPanels.module.css";

const REPEAT_ICON = { LINEAR: "16.repeat.linear", RADIAL: "16.repeat.radial" } as const;

export const TRANSFORM_MENU: MenuEntry[] = [
  { id: "LINEAR", label: "Linear repeat", icon: REPEAT_ICON.LINEAR },
  { id: "RADIAL", label: "Radial repeat", icon: REPEAT_ICON.RADIAL },
];

export function TransformSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const groups = nodes.filter(isTransformGroup);
  // The rows: one transform group selected (several: "+" and Apply only) [ours].
  const group = nodes.length === 1 && groups.length === 1 ? groups[0] : null;
  const repeats = group ? repeatsOf(group) : [];
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const { container, grip, dragging, line } = useReorder((from, to) => group && moveRepeat(ed, group.guid, repeats[from].index, repeats[to].index));
  const shown = open && repeats.find((r) => r.index === open.index);
  return (
    <PanelSection
      title={t("Transform")}
      empty={repeats.length === 0}
      data-transform-section=""
      actions={
        <MenuButton label={t("Additional transform modifier")} tooltip entries={TRANSFORM_MENU} className={design.iconMenu} gap={PANEL_MENU_GAP} align="end" onSelect={(id) => addRepeat(ed, refs, id as RepeatKind)}>
          <Icon name="24.plus.small" />
        </MenuButton>
      }
    >
      {repeats.length > 0 && (
        <div ref={container} className={design.reorderList}>
          {repeats.map(({ index, modifier }, d) => (
            <div key={index} className={cx(design.paintRow, !modifier.visible && design.rowHidden, dragging === d && design.rowDragging)} data-repeat-row={modifier.repeatType} data-reorder-row="">
              {repeats.length > 1 && <Grip {...grip(d)} />}
              <button type="button" className={cx(design.effectField, styles.repeatField)} aria-label={t("{name} settings", { name: t(repeatLabel(modifier.repeatType)) })} aria-expanded={open?.index === index} onClick={(e) => setOpen(open?.index === index ? null : { index, anchor: e.currentTarget })}>
                <span className={styles.repeatGlyph}>
                  <Icon name={REPEAT_ICON[modifier.repeatType]} />
                </span>
                <span className={cx(design.effectLabel, design.effectName)}>{t(repeatLabel(modifier.repeatType))}</span>
              </button>
              <IconButton icon={modifier.visible ? "24.eye.small" : "24.hidden.small"} label={t("Toggle visibility")} tone="secondary" onClick={() => setRepeat(ed, group!.guid, index, { visible: !modifier.visible })} />
              <IconButton icon="24.minus.small" label={t("Remove")} tone="secondary" onClick={() => removeRepeat(ed, group!.guid, index)} />
            </div>
          ))}
          {line !== null && <div className={design.dropLine} style={{ top: line }} />}
        </div>
      )}
      {groups.length > 0 && (
        <div className={styles.applyRow}>
          <Button variant="secondary" className={styles.applyButton} onClick={() => applyTransforms(ed)} data-apply-transforms="">
            {t("Apply transforms to selection")}
          </Button>
        </div>
      )}
      {open && shown && group && (
        <RepeatSettings
          modifier={shown.modifier}
          anchor={open.anchor}
          onChange={(patch, info) => setRepeat(ed, group.guid, shown.index, patch, info)}
          onCancel={() => ed.cancelEdit()}
          onClose={() => setOpen(null)}
        />
      )}
    </PanelSection>
  );
}

/** The "Repeat" popover (the hands-on project's panel: Count and Gap; Axis for Linear; Order [unverified]). */
export function RepeatSettings({
  modifier,
  anchor,
  onChange,
  onCancel,
  onClose,
  static: isStatic,
}: {
  modifier: RepeatModifierInput;
  anchor: HTMLElement | null;
  onChange: (patch: Partial<RepeatModifierInput>, info: ChangeInfo) => void;
  onCancel: () => void;
  onClose: () => void;
  static?: boolean;
}) {
  useT();
  const pick: ChangeInfo = { final: true, source: "pick" };
  const relative = modifier.unitType === "RELATIVE";
  return (
    <Popover anchor={anchor} title={t("Repeat")} width={240} onClose={onClose} label={t("Repeat")} static={isStatic}>
      <div className={design.settings} data-repeat-settings={modifier.repeatType}>
        <span className={design.settingsLabel}>{t("Count")}</span>
        <NumericInput scrubHandle="previous" label={t("Count")} min={REPEAT_COUNT_RANGE[0]} max={REPEAT_COUNT_RANGE[1]} precision={0} value={modifier.count} onChange={(v, info) => onChange({ count: v }, info)} onCancel={onCancel} />
        <span className={design.settingsLabel}>{t("Gap")}</span>
        <span className={styles.gapField}>
          <NumericInput
            scrubHandle="previous"
            label={t("Gap")}
            unit={relative ? "%" : undefined}
            min={modifier.repeatType === "RADIAL" ? 0 : undefined}
            value={gapShown(modifier)}
            onChange={(v, info) => onChange({ offset: gapStored(v, modifier.unitType) }, info)}
            onCancel={onCancel}
          />
          <SegmentedControl
            label={t("Gap unit")}
            value={modifier.unitType}
            options={[
              { value: "PIXELS", label: "px", tooltip: t("Pixels") },
              { value: "RELATIVE", label: "%", tooltip: t("Percent of the content's size") },
            ]}
            onChange={(v) => v !== modifier.unitType && onChange({ unitType: v as RepeatModifierInput["unitType"], offset: gapStored(gapShown(modifier), v as RepeatModifierInput["unitType"]) }, pick)}
          />
        </span>
        {modifier.repeatType === "LINEAR" && (
          <>
            <span className={design.settingsLabel}>{t("Axis")}</span>
            <SegmentedControl
              label={t("Axis")}
              fullWidth
              value={modifier.axis === "Y" ? "Y" : modifier.axis === "X" ? "X" : ""}
              options={[
                { value: "X", label: t("Horizontal") },
                { value: "Y", label: t("Vertical") },
              ]}
              onChange={(v) => onChange({ axis: v as "X" | "Y" }, pick)}
            />
          </>
        )}
        <span className={design.settingsLabel}>{t("Order")}</span>
        <SegmentedControl
          label={t("Order")}
          fullWidth
          value={modifier.order}
          options={[
            { value: "FORWARD", label: t("Forward") },
            { value: "REVERSE", label: t("Reverse") },
          ]}
          onChange={(v) => onChange({ order: v as RepeatModifierInput["order"] }, pick)}
        />
      </div>
    </Popover>
  );
}
