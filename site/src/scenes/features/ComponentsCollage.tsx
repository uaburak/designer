// Components: a Button component set with two variants (Default, Hover) and an instance of it, selected, with its
// properties in the Design panel. The State property is changed the way the app does it: the field opens its list
// over itself (the ds Menu, as Select draws it), the cursor goes down to Hover, it lights, the list closes on the new
// value and the instance becomes the Hover variant. Then the scene rests (docs/site.md §2.1).
import { useState } from "react";
import { ContextMenu } from "@/ds/components/Menu";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select } from "@/ds/components/Select";
import { TextInput } from "@/ds/components/TextInput";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { noop, PanelColumn } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

const STATES = ["Default", "Hover"] as const;
type State = (typeof STATES)[number];

/** The canvas: the component set and the instance (stage px). */
const SET = { x: 32, y: 56, w: 168, h: 128 };
const INSTANCE = { x: 240, y: 100, w: 128, h: 40 };
/** The panel, and where its State field sits in it (stage px). */
const PANEL = { x: 112, y: 216 };
const FIELD = { x: PANEL.x + 17, y: PANEL.y + 61, w: 184, h: 24 };
/** The list over the field: the current option over the field, each row 24 below the one before. */
const LIST = { x: FIELD.x - 4, y: FIELD.y - 8 };
const rowAt = (i: number): [number, number] => [FIELD.x + 44, FIELD.y + 13 + i * 24];

export default function ComponentsCollage() {
  const [state, setState] = useState<State>("Default");
  const [open, setOpen] = useState(false);
  /** The value when the list opened (its check stays there while it closes). */
  const [listed, setListed] = useState<State>("Default");
  const [lit, setLit] = useState(0);
  const me = usePointer([300, 372]);

  const script = async (run: Run) => {
    await run.wait(1200);
    await me.click(run, [FIELD.x + 40, FIELD.y + 12], { beat: 260 });
    setListed(state);
    setOpen(true);
    await run.wait(650);
    await me.to(run, rowAt(1), { ms: 520 });
    setLit(1);
    await me.click(run, undefined, { beat: 360 });
    setOpen(false);
    setState("Hover");
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <FrameName x={SET.x} y={SET.y} tone="component">
        <span className={styles.compName}>
          <Icon name="16.component.set" /> Button
        </span>
      </FrameName>
      <Piece x={SET.x} y={SET.y} w={SET.w} h={SET.h} d={0} from="fade" className={styles.compSet}>
        <span className={styles.btn} style={{ top: 20 }}>
          Sign up
        </span>
        <span className={styles.btn} data-on="" style={{ top: 68 }}>
          Sign up
        </span>
      </Piece>
      <FrameName x={INSTANCE.x} y={INSTANCE.y} tone="component">
        <span className={styles.compName}>
          <Icon name="16.instance" /> Sign up
        </span>
      </FrameName>
      <Piece x={INSTANCE.x} y={INSTANCE.y} w={INSTANCE.w} h={INSTANCE.h} d={80} from="fade">
        <span className={styles.btn} data-on={state === "Hover" || undefined} style={{ left: 0 }}>
          Sign up
        </span>
      </Piece>
      <Selection box={INSTANCE} tone="component" />

      <Piece surface x={PANEL.x} y={PANEL.y} w={240} d={160}>
        <PanelColumn>
          <PanelSection title="Sign up">
            <PropertyGrid labels>
              <PropertyRow label="State" span={2}>
                <Select label="State" value={state} options={STATES.map((s) => ({ value: s, label: s }))} onChange={noop} />
              </PropertyRow>
              <PropertyRow label="Label" span={2}>
                <TextInput label="Label" value="Sign up" />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
        </PanelColumn>
      </Piece>
      {/* The State field's list, open over it (as Select opens it) */}
      <Piece x={LIST.x} y={LIST.y} show={open} from="fade" z={25} className={styles.list}>
        <ContextMenu key={lit} static at={{ x: 0, y: 0 }} over={{ rect: FIELD as unknown as DOMRect }} minWidth={FIELD.w + 8} highlighted={lit} entries={STATES.map((s) => ({ id: s, label: s, checked: s === listed }))} onSelect={noop} onClose={noop} />
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
