// Credits and privacy (docs/ai.md §7): Settings › AI in the app's words: the AI balance (monthly credits, what has
// been used, "Stop when credits run out") and the providers (the coding agents on this computer, an image route's key
// kept in the keychain). Runs land in the list and the balance follows.
import { useState } from "react";
import { NumericInput } from "@/ds/components/NumericInput";
import { Switch } from "@/ds/components/Switch";
import { Icon } from "@/ds/icons/Icon";
import { Collage, Piece } from "../collage/kit";
import { noop } from "../collage/ui";
import { mix, type Run } from "../runtime/motion";
import styles from "./ai.module.css";

const MONTHLY = 5000;
const START = 1180;
const RUNS: [string, string, number][] = [
  ["Rename layers", "Claude Code", 2],
  ["Picture: Root Tonic — Post", "Gemini API · Nano Banana Pro", 16],
  ["Frame: Root Tonic — Post", "Claude Code · Sonnet 5.5", 6],
];
const PROVIDERS: [string, string, "on" | "key" | "local"][] = [
  ["Claude Code", "Signed in on this computer", "on"],
  ["Codex", "Signed in on this computer", "on"],
  ["Gemini API", "Saved in your keychain", "key"],
  ["Ollama", "Runs on this computer", "local"],
];

export default function CreditsCollage() {
  const [runs, setRuns] = useState(0);
  const [used, setUsed] = useState(START);

  const script = async (run: Run) => {
    await run.wait(1000);
    let total = START;
    for (let i = 0; i < RUNS.length; i++) {
      await run.wait(900);
      setRuns(i + 1);
      const from = total;
      total += RUNS[i][2];
      await run.tween(600, (t) => setUsed(mix(from, total, t)));
    }
  };

  return (
    <Collage size={[860, 560]} focus={[0.5, 0.5]} safe={560} script={script}>
      <Piece surface x={150} y={40} w={560} d={0} className={styles.settings}>
        <div className={styles.settingsHead}>AI balance</div>
        <div className={styles.settingsRow}>
          <span>Monthly credits</span>
          <div className={styles.settingsField}>
            <NumericInput label="Monthly credits" value={MONTHLY} precision={0} onChange={noop} />
          </div>
        </div>
        <div className={styles.meter}>
          <span className={styles.meterBar}>
            <i style={{ transform: `scaleX(${used / MONTHLY})` }} />
          </span>
          <span className={styles.meterText}>
            {used.toLocaleString("en-US")} of {MONTHLY.toLocaleString("en-US")} credits used this month
          </span>
        </div>
        <div className={styles.runs}>
          {RUNS.map(([what, route, credits], i) => (
            <div key={what} className={styles.runRow} data-out={runs <= i || undefined}>
              <span>{what}</span>
              <span className={styles.runRoute}>{route}</span>
              <span className={styles.runCredits}>{credits} {credits === 1 ? "credit" : "credits"}</span>
            </div>
          ))}
        </div>
        <div className={styles.settingsRow}>
          <span>Stop when credits run out</span>
          <Switch label="Stop when credits run out" checked onChange={noop} />
        </div>
        <div className={styles.settingsHead}>Providers</div>
        {PROVIDERS.map(([name, note, kind]) => (
          <div key={name} className={styles.provider}>
            <span className={styles.providerIcon} data-kind={kind}>
              <Icon name={kind === "key" ? "24.lock.small" : kind === "local" ? "24.offline" : "16.check"} />
            </span>
            <span>{name}</span>
            <span className={styles.runRoute}>{note}</span>
          </div>
        ))}
      </Piece>
    </Collage>
  );
}
