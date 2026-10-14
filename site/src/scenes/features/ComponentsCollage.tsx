// Components: a Button component set with two variants, an instance of it, and the instance's properties (the
// Design panel's ds Select and Switch). The state is set to Hover, the icon turned on, and the instance follows.
import { useState } from "react";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select } from "@/ds/components/Select";
import { Switch } from "@/ds/components/Switch";
import { TextInput } from "@/ds/components/TextInput";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { BEZIER } from "../runtime/easing";
import { noop, PanelColumn } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

type State = "Default" | "Hover";

const SELECT: [number, number] = [300, 266];
const SWITCH: [number, number] = [234, 320];

export default function ComponentsCollage() {
  const [state, setState] = useState<State>("Default");
  const [icon, setIcon] = useState(false);
  const me = usePointer([360, 380]);

  const script = async (run: Run) => {
    await run.wait(1300);
    await me.click(run, SELECT);
    setState("Hover");
    await run.wait(700);
    await me.click(run, SWITCH);
    setIcon(true);
    // Idle: now and then the state is flipped back and forth from the panel, unhurried
    for (let i = 0; !run.reduced; i++) {
      await run.wait(2600);
      await me.click(run, [SELECT[0] + (i % 2 ? 8 : -6), SELECT[1] + (i % 2 ? 2 : -1)], { ms: 900, ease: BEZIER.standard });
      setState((s) => (s === "Hover" ? "Default" : "Hover"));
      await run.wait(400);
      await me.to(run, [SELECT[0] + 30, SELECT[1] + 70], { ms: 1300, ease: BEZIER.standard });
    }
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <FrameName x={32} y={48} tone="component">
        <span className={styles.compName}>
          <Icon name="16.component.set" /> Button
        </span>
      </FrameName>
      <Piece x={32} y={48} w={196} h={128} d={0} from="fade" className={styles.compSet}>
        <span className={styles.btn} style={{ top: 20 }}>
          <span className={styles.btnLabel}>Sign up</span>
        </span>
        <span className={styles.btn} data-on="" style={{ top: 72 }}>
          <span className={styles.btnLabel}>Sign up</span>
        </span>
      </Piece>
      <FrameName x={32} y={232} tone="component">
        <span className={styles.compName}>
          <Icon name="16.instance" /> Sign up
        </span>
      </FrameName>
      <Piece x={32} y={232} w={156} h={40} d={80}>
        <span className={styles.btn} data-on={state === "Hover" || undefined} data-icon={icon || undefined} style={{ left: 0 }}>
          <span className={styles.btnLabel}>Sign up</span>
          <span className={styles.btnIcon}>
            <Icon name="24.arrow.right" />
          </span>
        </span>
      </Piece>
      <Selection box={{ x: 32, y: 232, w: 156, h: 40 }} tone="component" />

      <Piece surface x={196} y={196} w={240} d={160} from="right">
        <PanelColumn>
          <PanelSection title="Sign up">
            <PropertyGrid labels>
              <PropertyRow label="State" span={2}>
                <Select label="State" value={state} options={[{ value: "Default", label: "Default" }, { value: "Hover", label: "Hover" }]} onChange={noop} />
              </PropertyRow>
              <PropertyRow label="Icon" span={2}>
                <div className={styles.switchRow}>
                  <Switch label="Icon" checked={icon} onChange={noop} />
                </div>
              </PropertyRow>
              <PropertyRow label="Label" span={2}>
                <TextInput label="Label" value="Sign up" />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
        </PanelColumn>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} />
    </Collage>
  );
}
