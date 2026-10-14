// Credits and privacy (docs/ai.md §7): Settings › AI as the app lays it out (settings/AiTab.tsx with its own CSS
// modules): the AI balance (the month's credits used of the monthly allowance, "Stop when credits run out") and the
// providers. One action: Text's provider opens its list over the field and a local model, Ollama, is picked.
import { useRef, useState } from "react";
import { Select } from "@/ds/components/Select";
import { Switch } from "@/ds/components/Switch";
import ai from "@/settings/AiTab.module.css";
import base from "@/settings/Settings.module.css";
import { Collage, CURSOR, Cursor, Piece, usePointer } from "../collage/kit";
import { noop } from "../collage/ui";
import { BEZIER } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { highlight, optionOf, pointOf } from "../together/pick";
import picks from "../together/together.module.css";
import styles from "./ai.module.css";

const USED = 1184;
const MONTHLY = 5000;
const TEXT = [{ value: "", label: "Automatic" }, "-" as const, { value: "claude-code", label: "Claude Code" }, { value: "codex", label: "Codex" }, { value: "antigravity", label: "Antigravity" }, { value: "ollama", label: "Ollama" }];
const IMAGES = [{ value: "gemini-images", label: "Gemini API" }];

export default function CreditsCollage() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("claude-code");
  const me = usePointer([700, 520]);
  const rowRef = useRef<HTMLDivElement>(null);

  const script = async (run: Run) => {
    await run.wait(1300);
    const field = pointOf(rowRef.current?.querySelector('[data-ds="Select"] button'), [0.4, 0.55]);
    if (field) await me.click(run, field, { beat: 260 });
    setOpen(true);
    await run.wait(550);
    const option = optionOf(rowRef.current, "Ollama");
    const at = pointOf(option, [0.35, 0.55]);
    if (at) await me.to(run, at, { ms: 620, ease: BEZIER.standard });
    highlight(option);
    await me.click(run, undefined, { beat: 320 });
    setText("ollama");
    setOpen(false);
  };

  return (
    <Collage size={[860, 560]} focus={[0.5, 0.5]} safe={600} script={script}>
      <Piece surface x={150} y={56} w={560} d={0} className={styles.settings}>
        <section className={base.section}>
          <h3 className={base.heading}>AI balance</h3>
          <div className={ai.meter}>
            <p className={ai.meterText}>
              {USED.toLocaleString("en-US")} of {MONTHLY.toLocaleString("en-US")} credits used this month
            </p>
            <div className={ai.bar}>
              <div className={ai.fill} style={{ width: `${(USED / MONTHLY) * 100}%` }} />
            </div>
            <p className={ai.caption}>{(MONTHLY - USED).toLocaleString("en-US")} credits remaining · Resets November 1</p>
          </div>
          <div className={ai.row}>
            <span className={ai.rowText}>
              <span>Stop when credits run out</span>
              <span className={ai.caption}>AI features stop until your credits reset. Turned off, you’re only warned.</span>
            </span>
            <Switch size="large" label="Stop when credits run out" checked onChange={noop} />
          </div>
        </section>
        <hr className={`${base.divider} ${styles.settingsDivider}`} />
        <section className={base.section}>
          <h3 className={base.heading}>Providers</h3>
          <div ref={rowRef} className={`${ai.row} ${picks.overField} ${styles.providerRow}`} style={{ ["--over" as string]: "41px" }}>
            <span className={ai.rowText}>
              <span>Text</span>
              <span className={ai.caption}>Rename layers, writing, Add interactions and First Draft. Automatic uses the first connected agent.</span>
            </span>
            <span className={ai.controls}>
              <Select label="Text provider" value={text} options={TEXT} onChange={noop} width={160} static={open} />
            </span>
          </div>
          <div className={ai.row}>
            <span className={ai.rowText}>
              <span>Images</span>
              <span className={ai.caption}>Make an image, Edit image with prompt and Expand.</span>
            </span>
            <span className={ai.controls}>
              <Select label="Image provider" value="gemini-images" options={IMAGES} onChange={noop} width={160} />
            </span>
          </div>
        </section>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
