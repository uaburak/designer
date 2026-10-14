// Variables: a card whose colours are variables (its fill is bound to "surface"), selected, and its Appearance in the
// Design panel. The frame's mode is switched from Light to Dark the way the app does it: the Mode field opens its list
// over itself (the ds Menu, as Select draws it), the cursor goes down to Dark, it lights, the list closes on Dark and
// the card takes the Dark values (cross-fading, opacity only). Then the scene rests (docs/site.md §2.1).
import { useState } from "react";
import { ColorInput } from "@/ds/components/ColorInput";
import { ContextMenu } from "@/ds/components/Menu";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select } from "@/ds/components/Select";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { noop, PanelColumn } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

const MODES = ["Light", "Dark"] as const;
type Mode = (typeof MODES)[number];

/** The card's variables: [Light, Dark]. */
const SURFACE = ["#FFFFFF", "#1E1E1E"] as const;
const TEXT = ["#1E1E1E", "#FFFFFF"] as const;
const MUTED = ["#8C8C8C", "#A6A6A6"] as const;
const ACCENT = ["#0D99FF", "#7CC4FA"] as const;

const CARD = { x: 32, y: 56, w: 196, h: 136 };
const PANEL = { x: 112, y: 216 };
/** The Mode field in the panel, and its list over it (stage px). */
const FIELD = { x: PANEL.x + 17, y: PANEL.y + 45, w: 184, h: 24 };
const LIST = { x: FIELD.x - 4, y: FIELD.y - 8 };
const rowAt = (i: number): [number, number] => [FIELD.x + 48, FIELD.y + 13 + i * 24];

export default function VariablesCollage() {
  const [mode, setMode] = useState<Mode>("Light");
  const [open, setOpen] = useState(false);
  const [lit, setLit] = useState(0);
  const me = usePointer([300, 372]);
  const k = mode === "Dark" ? 1 : 0;

  const script = async (run: Run) => {
    await run.wait(1200);
    await me.click(run, [FIELD.x + 52, FIELD.y + 12], { beat: 260 });
    setOpen(true);
    await run.wait(650);
    await me.to(run, rowAt(1), { ms: 520 });
    setLit(1);
    await me.click(run, undefined, { beat: 360 });
    setOpen(false);
    await run.wait(120);
    setMode("Dark");
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <FrameName x={CARD.x} y={CARD.y} selected>
        Card
      </FrameName>
      <Piece x={CARD.x} y={CARD.y} w={CARD.w} h={CARD.h} d={0} from="fade">
        {/* Both modes drawn; the new one cross-fades in (opacity only) */}
        {([0, 1] as const).map((m) => (
          <div key={m} className={styles.varCard} data-dark={m === 1 || undefined} data-on={(m === 1 && k === 1) || undefined} style={{ background: SURFACE[m], color: TEXT[m] }}>
            <span className={styles.varDot} style={{ background: ACCENT[m] }} />
            <strong>Weekly plan</strong>
            <span style={{ color: MUTED[m] }}>4 tasks left</span>
            <span className={styles.varBar} style={{ background: ACCENT[m] }} />
          </div>
        ))}
      </Piece>
      <Selection box={CARD} />

      <Piece surface x={PANEL.x} y={PANEL.y} w={240} d={160}>
        <PanelColumn>
          <PanelSection title="Appearance">
            <PropertyGrid>
              <PropertyRow span={2}>
                <Select label="Mode" prefix="24.variable.mode.small" value={mode} options={MODES.map((m) => ({ value: m, label: m }))} onChange={noop} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
          <PanelSection title="Fill">
            <PropertyGrid>
              <PropertyRow span={2}>
                <ColorInput label="Fill" color={SURFACE[k]} opacity={100} valueLabel="surface" onColor={noop} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
        </PanelColumn>
      </Piece>
      {/* The Mode field's list, open over it (as Select opens it) */}
      <Piece x={LIST.x} y={LIST.y} show={open} from="fade" z={25} className={styles.list}>
        <ContextMenu key={lit} static at={{ x: 0, y: 0 }} over={{ rect: FIELD as unknown as DOMRect }} minWidth={FIELD.w + 8} highlighted={lit} entries={MODES.map((m) => ({ id: m, label: m, checked: m === "Light" }))} onSelect={noop} onClose={noop} />
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
