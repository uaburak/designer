/**
 * Text stagger by hand in Motion mode (docs/motion.md §4.10, §6.5; round 8i): for one text layer animated by its own
 * keyframes, its `textElementDelayBehaviour` — **+** turns it on (by character, left to right, 50 ms apart [ours]),
 * then Grouping, Direction (the order) and Stagger (the delay between elements, ms); **−** turns it off. The text's
 * manual tracks then play per element, each `delay` after the one before in the order (MOTION_SET_TEXT_STAGGER). A
 * Text stagger preset keeps its own settings (the Animations section).
 */
import { IconButton, NumericInput, PanelSection, PropertyGrid, PropertyRow, Select } from "@/ds";
import { t, useT } from "@/i18n";
import type { MotionCommandArgs } from "@shared/motion/types";
import { useEditor } from "../../controller";
import type { PanelNode } from "../../panels/design/shared";
import { useMotionModel } from "./AnimationsSection";

type Behaviour = { enabled?: boolean; grouping?: string; delayMs?: number; order?: string };
type StaggerArgs = MotionCommandArgs["MOTION_SET_TEXT_STAGGER"];

const GROUPINGS: [NonNullable<StaggerArgs["grouping"]>, string][] = [["CHARACTER", "Character"], ["CHARACTER_NO_WHITESPACE", "Character (no spaces)"], ["WORD", "Word"], ["LINE", "Line"], ["PARAGRAPH", "Paragraph"]];
const ORDERS: [NonNullable<StaggerArgs["order"]>, string][] = [["LEFT_RIGHT", "Left to right"], ["RIGHT_LEFT", "Right to left"], ["CENTER_OUT", "Center out"], ["RANDOM", "Random"]];

export function TextStaggerSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const model = useMotionModel();
  const n = nodes.length === 1 && nodes[0].type === "TEXT" ? nodes[0] : null;
  const layer = n ? model?.layers.find((l) => l.node === n.guid) : undefined;
  if (!n || !layer?.tracks.length) return null;
  const b = ((n as { textElementDelayBehaviour?: Behaviour }).textElementDelayBehaviour ?? {}) as Behaviour;
  const on = b.enabled === true;
  const set = (patch: Partial<StaggerArgs>) => {
    try {
      ed.engine.runMotionCommand("MOTION_SET_TEXT_STAGGER", { node: n.guid, enabled: true, ...patch });
    } catch {
      // The engine's Motion commands not built in this wasm.
    }
  };
  return (
    <PanelSection
      title={t("Text stagger")}
      empty={!on}
      data-text-stagger
      actions={
        on ? (
          <IconButton icon="24.minus.small" label={t("Remove text stagger")} tone="secondary" onClick={() => set({ enabled: false })} />
        ) : (
          <IconButton icon="24.plus.small" label={t("Add text stagger")} tone="secondary" onClick={() => set({ grouping: (b.grouping as StaggerArgs["grouping"]) ?? "CHARACTER", order: (b.order as StaggerArgs["order"]) ?? "LEFT_RIGHT", delayMs: b.delayMs ?? 50 })} />
        )
      }
    >
      {on && (
        <PropertyGrid labels>
          <PropertyRow labels={[t("Grouping")]}>
            <Select label={t("Grouping")} value={b.grouping ?? "CHARACTER"} options={GROUPINGS.map(([value, label]) => ({ value, label: t(label) }))} onChange={(v) => set({ grouping: v as StaggerArgs["grouping"] })} />
          </PropertyRow>
          <PropertyRow labels={[t("Direction"), t("Stagger")]}>
            <Select label={t("Direction")} value={b.order ?? "LEFT_RIGHT"} options={ORDERS.map(([value, label]) => ({ value, label: t(label) }))} onChange={(v) => set({ order: v as StaggerArgs["order"] })} />
            <NumericInput label={t("Stagger")} unit="ms" precision={0} min={0} value={Math.round(b.delayMs ?? 0)} onChange={(v, info) => {
              if (info.final !== false) set({ delayMs: Math.max(0, v) });
            }} />
          </PropertyRow>
        </PropertyGrid>
      )}
    </PanelSection>
  );
}
