// Components: a Button component set with two variants, an instance of it, and the instance's properties (the
// Design panel's ds Select and Switch). The state is set to Hover, the icon turned on, and the instance follows.
import { useState } from "react";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select } from "@/ds/components/Select";
import { Switch } from "@/ds/components/Switch";
import { TextInput } from "@/ds/components/TextInput";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection } from "../collage/kit";
import { noop, PanelColumn } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

type State = "Default" | "Hover";

export default function ComponentsCollage() {
  const [state, setState] = useState<State>("Default");
  const [icon, setIcon] = useState(false);
  const [cursor, setCursor] = useState<[number, number, boolean?]>([360, 380]);

  const script = async (run: Run) => {
    await run.wait(1400);
    setCursor([300, 266]);
    await run.wait(1200);
    setCursor([300, 266, true]);
    await run.wait(180);
    setState("Hover");
    setCursor([300, 266]);
    await run.wait(1100);
    setCursor([352, 300]);
    await run.wait(1000);
    setCursor([352, 300, true]);
    await run.wait(160);
    setIcon(true);
    setCursor([352, 300]);
    for (let i = 0; !run.reduced; i++) {
      await run.wait(3200);
      setState((s) => (s === "Hover" ? "Default" : "Hover"));
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
          Sign up
        </span>
        <span className={styles.btn} data-hover="" style={{ top: 72 }}>
          Sign up
        </span>
      </Piece>
      <FrameName x={32} y={232} tone="component">
        <span className={styles.compName}>
          <Icon name="16.instance" /> Sign up
        </span>
      </FrameName>
      <Piece x={32} y={232} w={156} h={40} d={200}>
        <span className={styles.btn} data-hover={state === "Hover" || undefined} style={{ position: "static" }}>
          Sign up
          <span className={styles.btnIcon} data-out={!icon || undefined}>
            <Icon name="24.arrow.right" />
          </span>
        </span>
      </Piece>
      <Selection box={{ x: 32, y: 232, w: 156, h: 40 }} tone="component" />

      <Piece surface x={196} y={196} w={240} d={350} from="right">
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
      <Cursor x={cursor[0]} y={cursor[1]} press={cursor[2]} color={CURSOR.ink} d={500} />
    </Collage>
  );
}
