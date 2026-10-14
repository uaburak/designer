// Variables: a collection with a Light and a Dark mode (names, swatches, values), and a card bound to it. The card's
// frame is switched to Dark: its colours change and the mode's column lights up; then it goes back, slowly.
import { useState } from "react";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select } from "@/ds/components/Select";
import { Swatch } from "@/ds/components/Swatch";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, Piece, Selection } from "../collage/kit";
import { noop, PanelColumn } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

type Mode = "Light" | "Dark";

const VARS: [string, string, string][] = [
  ["surface", "#FFFFFF", "#1E1E1E"],
  ["text", "#1E1E1E", "#FFFFFF"],
  ["muted", "#8C8C8C", "#A6A6A6"],
  ["accent", "#0D99FF", "#7CC4FA"],
];

export default function VariablesCollage() {
  const [mode, setMode] = useState<Mode>("Light");
  const [cursor, setCursor] = useState<[number, number, boolean?]>([380, 390]);
  const dark = mode === "Dark";
  const v = (i: number) => VARS[i][dark ? 2 : 1];

  const script = async (run: Run) => {
    await run.wait(1500);
    setCursor([150, 366]);
    await run.wait(1200);
    setCursor([150, 366, true]);
    await run.wait(160);
    setMode("Dark");
    setCursor([150, 366]);
    for (let i = 0; !run.reduced; i++) {
      await run.wait(3600);
      setMode((m) => (m === "Dark" ? "Light" : "Dark"));
    }
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <Piece surface x={24} y={36} w={300} d={0}>
        <div className={styles.varTable} data-mode={mode}>
          <div className={styles.varHead}>
            <span>Name</span>
            <span data-col="Light">Light</span>
            <span data-col="Dark">Dark</span>
          </div>
          {VARS.map(([name, light, darkHex]) => (
            <div key={name} className={styles.varRow}>
              <span className={styles.varName}>
                <Icon name="16.variable.color" />
                {name}
              </span>
              <span data-col="Light">
                <Swatch color={light} />
                {light.slice(1)}
              </span>
              <span data-col="Dark">
                <Swatch color={darkHex} />
                {darkHex.slice(1)}
              </span>
            </div>
          ))}
        </div>
      </Piece>

      <Piece x={208} y={190} w={172} h={150} d={250}>
        <div className={styles.varCard} style={{ background: v(0), color: v(1) }}>
          <span className={styles.varDot} style={{ background: v(3) }} />
          <strong>Weekly plan</strong>
          <span style={{ color: v(2) }}>4 tasks left</span>
          <span className={styles.varBar} style={{ background: v(3) }} />
        </div>
      </Piece>
      <Selection box={{ x: 208, y: 190, w: 172, h: 150 }} />

      <Piece surface x={-44} y={300} w={240} d={400} from="left">
        <PanelColumn>
          <PanelSection title="Appearance">
            <PropertyGrid>
              <PropertyRow span={2}>
                <Select label="Mode" prefix="24.variable.mode.small" value={mode} options={[{ value: "Light", label: "Light" }, { value: "Dark", label: "Dark" }]} onChange={noop} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
        </PanelColumn>
      </Piece>
      <Cursor x={cursor[0]} y={cursor[1]} press={cursor[2]} color={CURSOR.ink} d={500} />
    </Collage>
  );
}
