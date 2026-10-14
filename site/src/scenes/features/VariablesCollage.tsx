// Variables: a collection with a Light and a Dark mode (names, swatches, values), and a card bound to it. The card's
// frame is switched to Dark: its colours change and the mode's column lights up; then it goes back, slowly.
import { useState } from "react";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select } from "@/ds/components/Select";
import { Swatch } from "@/ds/components/Swatch";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, Piece, Selection, usePointer } from "../collage/kit";
import { BEZIER } from "../runtime/easing";
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

const MODE: [number, number] = [150, 366];

export default function VariablesCollage() {
  const [mode, setMode] = useState<Mode>("Light");
  const me = usePointer([380, 390]);

  const script = async (run: Run) => {
    await run.wait(1400);
    await me.click(run, MODE);
    setMode("Dark");
    // Idle: the mode goes back and forth, slowly, from the same menu
    for (let i = 0; !run.reduced; i++) {
      await me.to(run, [MODE[0] + 40, MODE[1] + 24], { ms: 1200, ease: BEZIER.standard });
      await run.wait(2400);
      await me.click(run, [MODE[0] + (i % 2 ? 6 : -4), MODE[1]], { ms: 900, ease: BEZIER.standard });
      setMode((m) => (m === "Dark" ? "Light" : "Dark"));
    }
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <Piece surface x={24} y={36} w={300} d={0}>
        <div className={styles.varTable} data-mode={mode}>
          <span className={styles.varCol} />
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

      <Piece x={208} y={190} w={172} h={150} d={120}>
        {/* Both modes drawn; the new one cross-fades in (opacity only) */}
        {([1, 2] as const).map((k) => (
          <div key={k} className={styles.varCard} data-dark={k === 2 || undefined} data-on={(k === 2 && mode === "Dark") || undefined} style={{ background: VARS[0][k], color: VARS[1][k] }}>
            <span className={styles.varDot} style={{ background: VARS[3][k] }} />
            <strong>Weekly plan</strong>
            <span style={{ color: VARS[2][k] }}>4 tasks left</span>
            <span className={styles.varBar} style={{ background: VARS[3][k] }} />
          </div>
        ))}
      </Piece>
      <Selection box={{ x: 208, y: 190, w: 172, h: 150 }} />

      <Piece surface x={-44} y={300} w={240} d={200} from="left">
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
      <Cursor {...me.state} color={CURSOR.ink} d={300} />
    </Collage>
  );
}
